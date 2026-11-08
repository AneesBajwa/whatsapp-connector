'use strict';
/**
 * Push delivery: Muse is woken the moment a file lands in requests/, by the
 * process that wrote it. Nothing scans the folder on an interval.
 *
 * Every new file the connector writes for Muse (prompts, watch requests,
 * alerts and lifecycle events in requests/, escalations in
 * requests/escalations/) is handed over by running the command configured
 * for its target in muse-config.json:
 *
 *   "delivery": {
 *     "enabled": true,
 *     "commands": {
 *       "request":    ["/abs/path/wake-worker.sh", "{file}"],
 *       "escalation": ["/abs/path/wake-main-agent.sh", "{file}"]
 *     },
 *     "timeoutSeconds": 30
 *   }
 *
 * Placeholders in the arguments: {file} (absolute path), {name} (path under
 * requests/), {kind} (question, watch-change, alert, lifecycle, escalation)
 * and {target} (request or escalation). The same values are in the
 * environment as WA_DELIVERY_FILE, _NAME, _KIND and _TARGET, with
 * _ATTEMPT, _WRITTEN_AT and _REDELIVERY. No shell is involved, so a value can
 * never become a command. Exit 0 means "Muse has it"; anything else (or no
 * exit within timeoutSeconds) is a failure and is retried.
 *
 * The command runs as a child of the writer (inside the listener's service,
 * so systemd stops whatever it leaves running when the listener stops): it
 * must hand the file to Muse and return, never run the agent itself. Its
 * stderr goes to a file, not a pipe, so a hand-off it leaves running in the
 * background never holds the push open; the exit status alone decides.
 *
 * Once per file: each file gets a marker in requests/.delivery/, created
 * exclusively (O_EXCL) by whichever process delivers it, so two processes can
 * never both deliver one file and a restart never delivers it again. Only the
 * listener retries a failure (2 s, 10 s, 30 s, 2 min, 5 min, then every
 * 15 min, for up to 24 hours), with a single one-shot timer armed for the
 * next due retry. At start-up the listener delivers what it finds
 * undelivered: files written while it was down, and claims a crash left
 * open (a claim still young enough to belong to a live process is checked
 * again, once, when it would turn stale). Two cases can reach Muse twice,
 * because the command may have handed the file over before it ended: a
 * claim a crash left open, and a retry after a command that timed out or was
 * killed by a signal. Those deliveries carry WA_DELIVERY_REDELIVERY=1, and the
 * request file's Status line (and `reply`, which refuses a second answer)
 * keeps the prompt from being answered twice.
 *
 * Starting point: push begins the first time the listener starts with
 * delivery enabled (requests/.delivery/.enabled-at). Files already in
 * requests/ then were handled by whatever woke Muse before, so they are marked
 * "baseline" and never pushed; the same after a run with delivery turned off.
 * Nothing older than 7 days is ever pushed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { writeAtomic, ensurePrivateDir } = require('./message-store.cjs');
const { NO_AUDIT } = require('./audit.cjs');

const DIR = '.delivery';
const ENABLED_AT = '.enabled-at';
const DISABLED = '.disabled';
const TARGETS = ['request', 'escalation'];
const RETRY_DELAYS_MS = [2000, 10000, 30000, 120000, 300000, 900000];
const GIVE_UP_AFTER_MS = 24 * 3600 * 1000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const STALE_MARGIN_MS = 60000;
// On the way out (a stop or a crash), within systemd's TimeoutStopSec.
const EXIT_PATH_TIMEOUT_MS = 8000;

const iso = (ms) => new Date(ms).toISOString();

/** This machine's boot: a claim from another boot belongs to a process that is gone. */
function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* not Linux */ }
  return `boot-${Math.round((Date.now() - os.uptime() * 1000) / 60000)}`;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Which command a file goes to: top-level *.md -> request, escalations/*.md -> escalation. */
function routeOf(rel) {
  const parts = String(rel).split(path.sep).join('/').split('/');
  const md = (n) => /\.md$/.test(n) && !n.startsWith('.');
  if (parts.length === 1 && md(parts[0])) return 'request';
  if (parts.length === 2 && parts[0] === 'escalations' && md(parts[1])) return 'escalation';
  return null;
}

function kindOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.subarray(0, n).toString('utf8').match(/^Kind: (.+)$/m);
    return m ? m[1].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

const markerFile = (requestsDir, rel) => path.join(requestsDir, DIR, `${encodeURIComponent(rel)}.json`);

function readMarker(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Empty or cut short: a process died between creating the claim and writing it.
    return e.code === 'ENOENT' ? null : { state: 'unreadable' };
  }
}

/** Create the marker only if no process has one for this file. */
function claimNew(file, body) {
  try {
    fs.writeFileSync(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/** Every file in requests/ that a command can be woken for, as paths under requests/. */
function listFiles(requestsDir) {
  const out = [];
  for (const sub of ['', 'escalations']) {
    let names = [];
    try { names = fs.readdirSync(path.join(requestsDir, sub)); } catch { continue; }
    for (const n of names) {
      const rel = sub ? `${sub}/${n}` : n;
      if (routeOf(rel)) out.push(rel);
    }
  }
  return out;
}

/**
 * @param standalone  a process other than the listener (the CLI, a script):
 *   delivers what it writes, synchronously, and never retries or scans.
 */
function createDelivery({
  root, config, log = () => {}, audit = NO_AUDIT, now = () => Date.now(), standalone = false,
  retryDelaysMs = RETRY_DELAYS_MS, exitTimeoutMs = EXIT_PATH_TIMEOUT_MS,
}) {
  const requestsDir = path.join(root, 'requests');
  const dir = path.join(requestsDir, DIR);
  const settings = (config && config.delivery) || {};
  const enabled = !!settings.enabled;
  const commands = settings.commands || {};
  const timeoutMs = Math.max(1000, (Number(settings.timeoutSeconds) || 30) * 1000);
  const boot = bootId();
  const queues = { request: new Map(), escalation: new Map() };
  const running = { request: null, escalation: null };
  const inFlight = new Set();
  const retries = new Map(); // rel -> { target, dueAt, reason: 'retry' | 'stale' }
  const warned = new Set();
  let retryTimer = null;
  let retryAt = 0;
  let sync = standalone;
  let stopped = false;
  // The listener decides once, in init(); another process checks each time.
  let activeFlag = null;
  const active = () => (activeFlag !== null ? activeFlag : enabled && fs.existsSync(path.join(dir, ENABLED_AT)));

  function argvFor(target, vars) {
    const cmd = commands[target];
    if (!Array.isArray(cmd) || !cmd.length) return null;
    return cmd.map((a) => String(a).replace(/\{(file|name|kind|target)\}/g, (_, k) => vars[k]));
  }

  /**
   * Claim the file and say how to deliver it, or null when it is not ours to
   * deliver (already delivered, claimed by another process, gone).
   * reason: 'new' (claim exclusively), 'retry' or 'stale' (listener only).
   */
  function prepare(rel, target, reason) {
    const file = path.join(requestsDir, rel);
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const mfile = markerFile(requestsDir, rel);
    const t = now();
    const kind = kindOf(file);
    let prev = null;
    if (reason === 'new') {
      prev = { attempts: 0, writtenAt: iso(st.mtimeMs) };
      const body = { file: rel, target, kind, state: 'delivering', pid: process.pid, boot, claimedAt: iso(t), writtenAt: prev.writtenAt, attempts: 1 };
      if (!claimNew(mfile, body)) return null;
    } else {
      prev = readMarker(mfile);
      if (!prev) return null;
      // Only what is still undelivered: another process may have finished it meanwhile.
      if (reason === 'retry' && prev.state !== 'failed') return null;
      if (reason === 'stale') {
        if (prev.state !== 'delivering' && prev.state !== 'unreadable') return null;
        if (!isStale(prev, mfile, t)) {
          // Still young enough to be a live process's push: look again when it would turn stale.
          armStaleCheck(rel, target, prev, mfile);
          return null;
        }
      }
      const writtenAt = prev.writtenAt || iso(st.mtimeMs);
      if (t - Date.parse(writtenAt) > GIVE_UP_AFTER_MS) {
        writeAtomic(mfile, JSON.stringify({ ...prev, file: rel, target, kind, state: 'abandoned', abandonedAt: iso(t) }));
        audit.record('delivery_abandoned', { target, kind, attempts: prev.attempts || 0 });
        log(`delivery: gave up on ${rel} after ${prev.attempts || 0} attempt(s) over 24 hours: ${prev.error || 'unknown error'}`);
        return null;
      }
      writeAtomic(mfile, JSON.stringify({
        ...prev, file: rel, target, kind, state: 'delivering', pid: process.pid, boot, claimedAt: iso(t), writtenAt,
        attempts: (prev.attempts || 0) + 1, redelivery: reason === 'stale' || !!prev.redelivery || !!prev.uncertain,
        nextAt: undefined, unrouted: undefined, uncertain: undefined,
      }));
      prev = { ...prev, writtenAt };
    }
    const attempt = (prev.attempts || 0) + 1;
    const redelivery = reason === 'stale' || !!prev.redelivery || !!prev.uncertain;
    const vars = { file, name: rel, kind, target };
    const argv = argvFor(target, vars);
    const env = {
      ...process.env,
      WA_DELIVERY_FILE: file,
      WA_DELIVERY_NAME: rel,
      WA_DELIVERY_KIND: kind,
      WA_DELIVERY_TARGET: target,
      WA_DELIVERY_ATTEMPT: String(attempt),
      WA_DELIVERY_WRITTEN_AT: prev.writtenAt,
      WA_DELIVERY_REDELIVERY: redelivery ? '1' : '0',
    };
    return { rel, target, kind, mfile, argv, env, attempt, redelivery, writtenAt: prev.writtenAt, claimedAt: t };
  }

  /** uncertain: the command may have handed the file over before it ended (timed out, killed). */
  function finish(job, ok, error, { uncertain = false } = {}) {
    const t = now();
    const base = {
      file: job.rel, target: job.target, kind: job.kind, writtenAt: job.writtenAt, attempts: job.attempt, ...(job.redelivery ? { redelivery: true } : {}),
    };
    if (ok) {
      const ms = t - Date.parse(job.writtenAt);
      writeAtomic(job.mfile, JSON.stringify({ ...base, state: 'delivered', deliveredAt: iso(t), ms, commandMs: t - job.claimedAt }));
      retries.delete(job.rel);
      audit.record('delivered', { target: job.target, kind: job.kind, ms, attempt: job.attempt, ...(job.redelivery ? { redelivery: true } : {}) });
      log(`delivery: ${job.rel} -> ${job.target} in ${ms} ms${job.attempt > 1 ? ` (attempt ${job.attempt})` : ''}`);
      return;
    }
    const unrouted = !job.argv;
    const delay = retryDelaysMs[Math.min(job.attempt - 1, retryDelaysMs.length - 1)];
    const nextAt = t + delay;
    writeAtomic(job.mfile, JSON.stringify({
      ...base, state: 'failed', error: String(error).slice(0, 300), failedAt: iso(t), nextAt: iso(nextAt),
      ...(unrouted ? { unrouted: true } : {}), ...(uncertain ? { uncertain: true } : {}),
    }));
    audit.record('delivery_failed', { target: job.target, kind: job.kind, attempt: job.attempt, unrouted });
    if (unrouted) {
      // Only a restart reads the config again: retried then, not on a timer.
      if (!warned.has(job.target)) log(`delivery: warning: no delivery.commands.${job.target} in muse-config.json; ${job.target} files wait until it is set and the listener restarts`);
      warned.add(job.target);
      return;
    }
    log(`delivery: warning: ${job.rel} -> ${job.target} failed (attempt ${job.attempt}): ${error}${standalone ? '' : `; retrying in ${Math.round(delay / 1000)} s`}`);
    if (!standalone) {
      retries.set(job.rel, { target: job.target, dueAt: nextAt, reason: 'retry' });
      armRetry();
    }
  }

  let sinkSeq = 0;
  /** The command's stderr, in a file: unlike a pipe, nothing it leaves running can hold the push open. */
  function stderrSink() {
    const file = path.join(dir, `.stderr-${process.pid}-${++sinkSeq}`);
    let fd = null;
    try { ensurePrivateDir(dir); fd = fs.openSync(file, 'w', 0o600); } catch { fd = null; }
    return {
      stdio: fd === null ? 'ignore' : fd,
      lastLine() {
        try { return fs.readFileSync(file, 'utf8').slice(-600).trim().split('\n').pop() || ''; } catch { return ''; }
      },
      close() {
        if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; }
        try { fs.unlinkSync(file); } catch { /* gone */ }
      },
    };
  }

  const exitText = (code, signal, last) => `exit ${code === null ? signal : code}${last ? `: ${last}` : ''}`;

  function runSync(job, limitMs) {
    if (!job.argv) return finish(job, false, `no delivery.commands.${job.target} configured`);
    const err = stderrSink();
    let r;
    try {
      r = spawnSync(job.argv[0], job.argv.slice(1), {
        cwd: root, env: job.env, stdio: ['ignore', 'ignore', err.stdio], timeout: limitMs, killSignal: 'SIGKILL',
      });
    } catch (e) {
      r = { error: e };
    }
    const last = err.lastLine();
    err.close();
    if (r.error && r.error.code === 'ETIMEDOUT') return finish(job, false, `timed out after ${Math.round(limitMs / 1000)} s`, { uncertain: true });
    if (r.error) return finish(job, false, r.error.message);
    return finish(job, r.status === 0, exitText(r.status, r.signal, last), { uncertain: r.status === null });
  }

  function runAsync(job) {
    if (!job.argv) {
      finish(job, false, `no delivery.commands.${job.target} configured`);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const err = stderrSink();
      let settled = false;
      let child;
      const done = (ok, error, opts) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err.close();
        try {
          finish(job, ok, error, opts);
        } catch (e) {
          log(`delivery: warning: could not record ${job.rel}: ${e.message}`);
          // Its claim names this process: look at it again once it would be stale.
          retries.set(job.rel, { target: job.target, dueAt: now() + STALE_MARGIN_MS, reason: 'stale' });
          armRetry();
        }
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        done(false, `timed out after ${Math.round(timeoutMs / 1000)} s`, { uncertain: true });
      }, timeoutMs);
      try {
        child = spawn(job.argv[0], job.argv.slice(1), { cwd: root, env: job.env, stdio: ['ignore', 'ignore', err.stdio] });
      } catch (e) {
        done(false, e.message);
        return;
      }
      child.on('error', (e) => done(false, e.message));
      // 'exit', not 'close': a hand-off the command leaves running may keep
      // its stdio open for a long time; the command itself is done.
      child.on('exit', (code, signal) => done(code === 0, exitText(code, signal, err.lastLine()), { uncertain: code === null }));
    });
  }

  async function drain(target) {
    const q = queues[target];
    while (q.size) {
      const [rel, reason] = q.entries().next().value;
      q.delete(rel);
      inFlight.add(rel);
      try {
        const job = prepare(rel, target, reason);
        if (job) await runAsync(job);
      } catch (e) {
        log(`delivery: warning: ${rel}: ${e && e.message ? e.message : e}`);
      } finally {
        inFlight.delete(rel);
      }
    }
  }

  function enqueue(rel, target, reason) {
    if (inFlight.has(rel) || queues[target].has(rel)) return false;
    queues[target].set(rel, reason);
    if (!running[target]) {
      // Next turn of the event loop: whatever wrote the file finishes its
      // own bookkeeping (state saved) before Muse can act on it.
      running[target] = new Promise((r) => setImmediate(r)).then(() => drain(target)).finally(() => { running[target] = null; });
    }
    return true;
  }

  function armRetry() {
    if (stopped || standalone || !retries.size) return;
    const due = Math.min(...[...retries.values()].map((r) => r.dueAt));
    if (retryTimer && retryAt <= due) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryAt = due;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const t = now();
      for (const [rel, r] of retries) {
        if (r.dueAt <= t) {
          retries.delete(rel);
          enqueue(rel, r.target, r.reason || 'retry');
        }
      }
      armRetry();
    }, Math.max(0, Math.min(due - now(), 2 ** 31 - 1)));
    if (retryTimer.unref) retryTimer.unref();
  }

  function isStale(m, mfile, t) {
    if (m.state === 'unreadable') {
      try { return t - fs.statSync(mfile).mtimeMs > STALE_MARGIN_MS; } catch { return false; }
    }
    if (m.boot !== boot) return true;
    // This run's own claim, and not running: both callers skip files that are
    // in flight (reconcile) or are the one being prepared now (drain).
    if (m.pid === process.pid) return true;
    if (!pidAlive(m.pid)) return true;
    return t - Date.parse(m.claimedAt) > timeoutMs + STALE_MARGIN_MS;
  }

  /** When a claim that is not stale yet would be. */
  function staleAt(m, mfile) {
    if (m.state === 'unreadable') {
      try { return fs.statSync(mfile).mtimeMs + STALE_MARGIN_MS + 1; } catch { return now() + STALE_MARGIN_MS; }
    }
    const claimed = Date.parse(m.claimedAt);
    return (Number.isFinite(claimed) ? claimed : now()) + timeoutMs + STALE_MARGIN_MS + 1;
  }

  /** One look, at the moment a young claim would turn stale (listener only). */
  function armStaleCheck(rel, target, m, mfile) {
    if (standalone || stopped) return;
    const existing = retries.get(rel);
    const dueAt = staleAt(m, mfile);
    if (existing && existing.dueAt <= dueAt) return;
    retries.set(rel, { target, dueAt, reason: 'stale' });
    armRetry();
  }

  return {
    get active() { return active(); },

    /**
     * Listener start-up. With delivery on: start pushing; the first time (or
     * after a run with it off), mark what is already there as handled.
     * With it off: remember that, so files written meanwhile are never
     * pushed later.
     */
    init() {
      if (!enabled) {
        activeFlag = false;
        if (fs.existsSync(dir)) {
          try { fs.writeFileSync(path.join(dir, DISABLED), `${iso(now())}\n`, { mode: 0o600 }); } catch { /* best effort */ }
        }
        return { active: false, baselined: 0 };
      }
      ensurePrivateDir(requestsDir);
      ensurePrivateDir(dir);
      const first = !fs.existsSync(path.join(dir, ENABLED_AT));
      const wasOff = fs.existsSync(path.join(dir, DISABLED));
      let baselined = 0;
      if (first || wasOff) {
        const at = iso(now());
        for (const rel of listFiles(requestsDir)) {
          if (claimNew(markerFile(requestsDir, rel), { file: rel, target: routeOf(rel), state: 'baseline', at })) baselined++;
        }
        if (first) fs.writeFileSync(path.join(dir, ENABLED_AT), `${at}\n`, { mode: 0o600 });
        try { fs.unlinkSync(path.join(dir, DISABLED)); } catch { /* was not there */ }
        log(`delivery: push ${first ? 'turned on' : 'back on'}; ${baselined} file(s) already in requests/ marked as handled`);
      }
      activeFlag = true;
      for (const t of TARGETS) {
        if (!Array.isArray(commands[t]) || !commands[t].length) log(`delivery: note: no delivery.commands.${t}: ${t} files are not pushed`);
      }
      return { active: true, baselined };
    },

    /** request-files.cjs calls this for every file it creates. */
    notify(dirAbs, name) {
      if (stopped || !active()) return;
      const rel = path.relative(requestsDir, path.join(dirAbs, name)).split(path.sep).join('/');
      const target = routeOf(rel);
      if (!target) return;
      if (sync) {
        if (inFlight.has(rel)) return;
        const job = prepare(rel, target, 'new');
        if (job) runSync(job, standalone ? timeoutMs : Math.min(timeoutMs, exitTimeoutMs));
        return;
      }
      enqueue(rel, target, 'new');
    },

    /**
     * Listener only: deliver what is undelivered (files no process claimed,
     * claims a dead process left, failures due for a retry). At start-up,
     * and on request (`delivery flush`); never on a timer.
     */
    reconcile() {
      if (standalone || !active()) return { queued: 0 };
      const t = now();
      let queued = 0;
      for (const rel of listFiles(requestsDir)) {
        const target = routeOf(rel);
        if (inFlight.has(rel) || queues[target].has(rel)) continue;
        const mfile = markerFile(requestsDir, rel);
        const m = readMarker(mfile);
        if (!m) {
          let st;
          try { st = fs.statSync(path.join(requestsDir, rel)); } catch { continue; }
          if (!st.isFile()) continue;
          if (t - st.mtimeMs > MAX_AGE_MS) {
            claimNew(mfile, { file: rel, target, state: 'baseline', at: iso(t), note: 'older than 7 days when found' });
            continue;
          }
          if (enqueue(rel, target, 'new')) queued++;
        } else if (m.state === 'failed') {
          if (m.unrouted || !m.nextAt || Date.parse(m.nextAt) <= t) {
            retries.delete(rel);
            if (enqueue(rel, target, 'retry')) queued++;
          } else {
            retries.set(rel, { target, dueAt: Date.parse(m.nextAt), reason: 'retry' });
          }
        } else if (m.state === 'delivering' || m.state === 'unreadable') {
          if (isStale(m, mfile, t)) {
            if (enqueue(rel, target, 'stale')) queued++;
          } else {
            armStaleCheck(rel, target, m, mfile);
          }
        }
      }
      armRetry();
      return { queued };
    },

    /** From now on deliver synchronously (exit paths: the process is about to end). */
    setSync(on) { sync = !!on; },

    /** Resolves when nothing is queued or running. */
    async idle() {
      for (;;) {
        const pending = TARGETS.map((t) => running[t]).filter(Boolean);
        if (!pending.length) return;
        await Promise.allSettled(pending);
      }
    },

    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}

/** Every marker, newest first: what was delivered, when, and how fast. */
function readLedger(root) {
  const dir = path.join(root, 'requests', DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const m = readMarker(path.join(dir, n)) || {};
    let rel = m.file;
    if (!rel) { try { rel = decodeURIComponent(n.slice(0, -5)); } catch { rel = n; } }
    rows.push({ ...m, file: rel });
  }
  const at = (r) => Date.parse(r.deliveredAt || r.failedAt || r.claimedAt || r.writtenAt || r.at || 0) || 0;
  return rows.sort((a, b) => at(b) - at(a));
}

/** `delivery status`: the push set-up and how it is doing. */
function ledgerSummary(root, config, { recent = 10 } = {}) {
  const settings = (config && config.delivery) || {};
  const rows = readLedger(root);
  const counts = {};
  for (const r of rows) counts[r.state || 'unknown'] = (counts[r.state || 'unknown'] || 0) + 1;
  const delivered = rows.filter((r) => r.state === 'delivered' && Number.isFinite(r.ms)).map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => (delivered.length ? delivered[Math.min(delivered.length - 1, Math.ceil((p / 100) * delivered.length) - 1)] : null);
  let enabledAt = null;
  try { enabledAt = fs.readFileSync(path.join(root, 'requests', DIR, ENABLED_AT), 'utf8').trim(); } catch { /* never on */ }
  return {
    enabled: !!settings.enabled,
    active: !!settings.enabled && !!enabledAt,
    enabledAt,
    targets: Object.fromEntries(TARGETS.map((t) => [t, Array.isArray((settings.commands || {})[t]) && settings.commands[t].length > 0])),
    counts,
    latencyMs: { median: pct(50), p95: pct(95), max: delivered.length ? delivered[delivered.length - 1] : null, count: delivered.length },
    failing: rows.filter((r) => ['failed', 'abandoned'].includes(r.state)).map(({ file, target, state, attempts, error, nextAt }) => ({ file, target, state, attempts, error, nextAt })),
    recent: rows.filter((r) => r.state !== 'baseline').slice(0, recent),
  };
}

/** `delivery report`: one row per file, newest first; since: ISO time or ms. */
function ledgerReport(root, { since = null, limit = 200 } = {}) {
  const from = since === null || since === undefined ? null : (Number.isFinite(Number(since)) ? Number(since) : Date.parse(since));
  const rows = readLedger(root).filter((r) => r.state !== 'baseline')
    .filter((r) => from === null || !Number.isFinite(from) || Date.parse(r.writtenAt || r.at || 0) >= from);
  return {
    since: from !== null && Number.isFinite(from) ? iso(from) : null,
    count: rows.length,
    rows: rows.slice(0, limit).map(({ file, target, kind, state, attempts, writtenAt, deliveredAt, ms, redelivery, error }) => ({
      file, target, kind, state, attempts, writtenAt, deliveredAt, ms, ...(redelivery ? { redelivery } : {}), ...(error ? { error } : {}),
    })),
  };
}

module.exports = {
  createDelivery, readLedger, ledgerSummary, ledgerReport, routeOf, TARGETS, DIR, RETRY_DELAYS_MS, GIVE_UP_AFTER_MS, MAX_AGE_MS,
};
