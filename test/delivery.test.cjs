'use strict';
/**
 * Push delivery (lib/delivery.cjs): every new file for Muse is handed over the
 * moment it is written, once, by the process that wrote it.
 *
 * The "Muse" here is a fake wake command (a node script) that logs each call.
 * Module tests drive lib/delivery.cjs directly; listener tests run the real
 * listener against the stub library. Nothing touches WhatsApp or a real VM.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createKit, waMessage, waitUntil, cliAsync, deadPid, QR_LINKED, KIT_ROOT } = require('./helpers/harness.cjs');
const { createDelivery, readLedger, ledgerSummary, ledgerReport } = require('../lib/delivery.cjs');
const { writeOnce, onCreated } = require('../lib/request-files.cjs');
const { applyRetention } = require('../lib/health.cjs');
const { loadConfig } = require('../lib/config.cjs');

const GROUP = '120363000000000001@g.us';
const CONFIG = { watchlist: [{ jid: GROUP, name: 'Test Group' }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the fake Muse

const WAKE_SCRIPT = `'use strict';
const fs = require('fs');
const [log, target, name, kind] = process.argv.slice(2);
const behavior = (() => { try { return JSON.parse(fs.readFileSync(log + '.behavior.json', 'utf8')); } catch { return {}; } })();
const countFile = log + '.count';
let n = 0;
try { n = Number(fs.readFileSync(countFile, 'utf8')) || 0; } catch {}
fs.writeFileSync(countFile, String(n + 1));
const line = (o) => fs.appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, call: n + 1, target, name, kind,
  attempt: Number(process.env.WA_DELIVERY_ATTEMPT), redelivery: process.env.WA_DELIVERY_REDELIVERY === '1',
  file: process.env.WA_DELIVERY_FILE, ...o }) + '\\n');
line({ phase: 'start' });
const fail = n < (behavior.failFirst || 0);
const wait = n < (behavior.sleepFirst || 0) ? behavior.sleepMs || 0 : (behavior.sleepAlwaysMs || 0);
// A command that starts something in the background and exits: the
// background process keeps this one's stderr open after it is gone.
if (behavior.holdStderrMs) {
  require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + behavior.holdStderrMs + ')'],
    { detached: true, stdio: ['ignore', 'ignore', 'inherit'] }).unref();
}
setTimeout(() => { line({ phase: 'done', ok: !fail }); process.exit(fail ? 1 : 0); }, wait);
`;

/** A fake wake command in `dir`: calls() lists what it was woken for. */
function fakeMuse(dir) {
  const script = path.join(dir, 'fake-wake.cjs');
  const log = path.join(dir, 'wake.log');
  fs.writeFileSync(script, WAKE_SCRIPT);
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const argv = [process.execPath, script, log, '{target}', '{name}', '{kind}'];
  return {
    log,
    calls: () => read().filter((c) => c.phase === 'start'),
    done: () => read().filter((c) => c.phase === 'done'),
    behave: (b) => fs.writeFileSync(`${log}.behavior.json`, JSON.stringify(b)),
    delivery: (extra = {}) => ({ enabled: true, commands: { request: argv, escalation: argv }, timeoutSeconds: 5, ...extra }),
    argv,
  };
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-delivery-test-'));
  fs.mkdirSync(path.join(root, 'requests'), { mode: 0o700 });
  return root;
}

/** One delivery "process" for a module test, wired to writeOnce like the listener does. */
function start(root, delivery, opts = {}) {
  const d = createDelivery({ root, config: { delivery }, ...opts });
  d.init();
  onCreated((dir, name) => d.notify(dir, name));
  return d;
}

const marker = (root, rel) => readLedger(root).find((r) => r.file === rel);
const req = (root) => path.join(root, 'requests');
const body = (kind) => `# test\n\nStatus: pending\nKind: ${kind}\n`;

async function withRoot(fn) {
  const root = tmpRoot();
  try { await fn(root, fakeMuse(root)); } finally { onCreated(null); fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- module

test('delivery: a new file is pushed once, with its path, kind and target, the moment it is written', () => withRoot(async (root, muse) => {
  const d = start(root, muse.delivery());
  const t0 = Date.now();
  writeOnce(req(root), '20261107T120000Z-chat-P1.md', body('question'));
  await d.idle();
  const [call, ...more] = muse.calls();
  assert.equal(more.length, 0);
  assert.deepEqual([call.target, call.name, call.kind, call.attempt, call.redelivery], ['request', '20261107T120000Z-chat-P1.md', 'question', 1, false]);
  assert.equal(call.file, path.join(req(root), '20261107T120000Z-chat-P1.md'));
  assert.ok(call.at - t0 < 1500, `woken ${call.at - t0} ms after the write`);
  const m = marker(root, '20261107T120000Z-chat-P1.md');
  assert.equal(m.state, 'delivered');
  assert.ok(Number.isFinite(m.ms));
  // Announced again (a second hook call, a reconcile): nothing more is run.
  d.notify(req(root), '20261107T120000Z-chat-P1.md');
  d.reconcile();
  await d.idle();
  assert.equal(muse.calls().length, 1);
  console.log(`# delivery: write -> wake in ${call.at - t0} ms`);
}));

test('delivery: escalations go to the escalation command, everything else to the request command', () => withRoot(async (root, muse) => {
  const d = start(root, muse.delivery());
  writeOnce(path.join(req(root), 'escalations'), '20261107T120000Z-P1.md', body('escalation'));
  writeOnce(req(root), '20261107T120001Z-alert-x.md', body('alert'));
  fs.mkdirSync(path.join(req(root), 'attachments'), { recursive: true });
  writeOnce(path.join(req(root), 'attachments'), 'photo.jpg', 'x'); // not for Muse to be woken for
  await d.idle();
  const calls = muse.calls().map((c) => [c.target, c.name, c.kind]).sort();
  assert.deepEqual(calls, [
    ['escalation', 'escalations/20261107T120000Z-P1.md', 'escalation'],
    ['request', '20261107T120001Z-alert-x.md', 'alert'],
  ]);
}));

test('delivery: the first start marks the files already there as handled, and never pushes them', () => withRoot(async (root, muse) => {
  fs.writeFileSync(path.join(req(root), 'old-1.md'), body('question'));
  fs.writeFileSync(path.join(req(root), 'old-2.md'), body('lifecycle'));
  const d = createDelivery({ root, config: { delivery: muse.delivery() } });
  assert.equal(d.init().baselined, 2);
  d.reconcile();
  await d.idle();
  assert.equal(muse.calls().length, 0);
  assert.equal(marker(root, 'old-1.md').state, 'baseline');
}));

test('delivery: a failed push is retried until it goes through; a hanging one times out first', () => withRoot(async (root, muse) => {
  muse.behave({ failFirst: 2 });
  const d = start(root, muse.delivery(), { retryDelaysMs: [100, 100, 100] });
  writeOnce(req(root), 'P1.md', body('question'));
  await waitUntil(() => marker(root, 'P1.md')?.state === 'delivered', { what: 'delivered after retries' });
  assert.deepEqual(muse.calls().map((c) => c.attempt), [1, 2, 3]);
  assert.equal(marker(root, 'P1.md').attempts, 3);

  fs.rmSync(muse.log + '.count');
  muse.behave({ sleepFirst: 1, sleepMs: 4000 });
  const slow = start(root, muse.delivery({ timeoutSeconds: 1 }), { retryDelaysMs: [100] });
  writeOnce(req(root), 'P2.md', body('question'));
  await waitUntil(() => marker(root, 'P2.md')?.state === 'delivered', { what: 'delivered after a timeout', timeout: 8000 });
  assert.equal(marker(root, 'P2.md').attempts, 2);
  // The timed-out run may have woken Muse before it was stopped: the retry says so.
  assert.deepEqual(muse.calls().filter((c) => c.name === 'P2.md').map((c) => c.redelivery), [false, true]);
  slow.stop();
  d.stop();
}));

test('delivery: a command that exits but leaves a background process holding its output is delivered once, without waiting for it', () => withRoot(async (root, muse) => {
  muse.behave({ holdStderrMs: 3000 });
  const d = start(root, muse.delivery({ timeoutSeconds: 1 }), { retryDelaysMs: [100] });
  writeOnce(req(root), 'P1.md', body('question'));
  await waitUntil(() => marker(root, 'P1.md')?.state === 'delivered', { what: 'delivered', timeout: 5000 });
  const m = marker(root, 'P1.md');
  assert.equal(m.attempts, 1, 'no timeout, no retry');
  assert.ok(m.ms < 1000, `delivered in ${m.ms} ms, not when the background process ended`);
  await sleep(1500); // past the 1 s timeout: nothing more runs
  assert.equal(muse.calls().length, 1);
  assert.deepEqual(fs.readdirSync(path.join(req(root), '.delivery')).filter((f) => f.startsWith('.stderr-')), [], 'no output file left behind');
  d.stop();
}));

test('delivery: a claim whose marker cannot be read is looked at again once it is old enough, and delivered once, as a redelivery', () => withRoot(async (root, muse) => {
  start(root, muse.delivery()).stop();
  onCreated(null);
  fs.writeFileSync(path.join(req(root), 'P1.md'), body('question'));
  // A marker cut short (a crash mid-write, a full disk), and still young: 59.5 s
  // old against the 60 s margin, so it is not stale when the listener starts.
  const mfile = path.join(req(root), '.delivery', `${encodeURIComponent('P1.md')}.json`);
  fs.writeFileSync(mfile, '{"file":"P1.md","sta');
  const young = (Date.now() - 59500) / 1000;
  fs.utimesSync(mfile, young, young);
  const d = createDelivery({ root, config: { delivery: muse.delivery() } });
  d.init();
  assert.equal(d.reconcile().queued, 0, 'not stale yet');
  await waitUntil(() => marker(root, 'P1.md')?.state === 'delivered', { what: 'delivered once the claim turned stale', timeout: 5000 });
  const [call, ...more] = muse.calls();
  assert.equal(more.length, 0);
  assert.equal(call.redelivery, true);
  d.stop();
}));

test('delivery: a restart pushes what was written but never pushed, and never repeats what was', () => withRoot(async (root, muse) => {
  const first = start(root, muse.delivery());
  writeOnce(req(root), 'P1.md', body('question'));
  await first.idle();
  first.stop();
  onCreated(null);
  // Written while no listener ran (a crash between the write and the push).
  fs.writeFileSync(path.join(req(root), 'P2.md'), body('question'));
  const second = createDelivery({ root, config: { delivery: muse.delivery() } });
  second.init();
  assert.equal(second.reconcile().queued, 1);
  await second.idle();
  assert.deepEqual(muse.calls().map((c) => c.name), ['P1.md', 'P2.md']);
  const third = createDelivery({ root, config: { delivery: muse.delivery() } });
  third.init();
  assert.equal(third.reconcile().queued, 0);
}));

test('delivery: a push cut short by a crash is delivered again once, marked as a redelivery', () => withRoot(async (root, muse) => {
  start(root, muse.delivery()).stop();
  onCreated(null);
  fs.writeFileSync(path.join(req(root), 'P1.md'), body('question'));
  // What a listener killed mid-push leaves: its claim, by a process that is gone.
  fs.writeFileSync(path.join(req(root), '.delivery', `${encodeURIComponent('P1.md')}.json`), JSON.stringify({
    file: 'P1.md', target: 'request', state: 'delivering', pid: deadPid(), boot: 'another-boot', claimedAt: new Date().toISOString(), writtenAt: new Date().toISOString(), attempts: 1,
  }));
  const d = createDelivery({ root, config: { delivery: muse.delivery() } });
  d.init();
  d.reconcile();
  await d.idle();
  const [call] = muse.calls();
  assert.equal(call.redelivery, true);
  assert.equal(call.attempt, 2);
  assert.equal(marker(root, 'P1.md').state, 'delivered');
  const again = createDelivery({ root, config: { delivery: muse.delivery() } });
  again.init();
  again.reconcile();
  await again.idle();
  assert.equal(muse.calls().length, 1);
}));

test('delivery: two processes delivering the same file run the command once', () => withRoot(async (root, muse) => {
  start(root, muse.delivery()).stop();
  onCreated(null);
  fs.writeFileSync(path.join(req(root), 'P1.md'), body('question'));
  muse.behave({ sleepAlwaysMs: 300 });
  const lib = path.join(KIT_ROOT, 'lib', 'delivery.cjs');
  const script = `const { createDelivery } = require(${JSON.stringify(lib)});
    createDelivery({ root: ${JSON.stringify(root)}, config: { delivery: ${JSON.stringify(muse.delivery())} }, standalone: true })
      .notify(${JSON.stringify(req(root))}, 'P1.md');`;
  const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
    spawn(process.execPath, ['-e', script], { stdio: 'ignore' }).on('exit', resolve);
  }));
  await Promise.all(runs);
  assert.equal(muse.calls().length, 1);
  assert.equal(marker(root, 'P1.md').state, 'delivered');
}));

test('delivery: turned off, then on again: files written while it was off are never pushed', () => withRoot(async (root, muse) => {
  start(root, muse.delivery()).stop();
  onCreated(null);
  const off = createDelivery({ root, config: { delivery: { ...muse.delivery(), enabled: false } } });
  off.init();
  onCreated((dir, name) => off.notify(dir, name));
  writeOnce(req(root), 'while-off.md', body('question'));
  onCreated(null);
  const on = createDelivery({ root, config: { delivery: muse.delivery() } });
  assert.equal(on.init().baselined, 1);
  on.reconcile();
  await on.idle();
  assert.equal(muse.calls().length, 0);
}));

test('delivery: nothing older than 7 days is ever pushed', () => withRoot(async (root, muse) => {
  start(root, muse.delivery()).stop();
  onCreated(null);
  const file = path.join(req(root), 'ancient.md');
  fs.writeFileSync(file, body('question'));
  const old = (Date.now() - 8 * 86400000) / 1000;
  fs.utimesSync(file, old, old);
  const d = createDelivery({ root, config: { delivery: muse.delivery() } });
  d.init();
  assert.equal(d.reconcile().queued, 0);
  assert.equal(marker(root, 'ancient.md').state, 'baseline');
}));

test('delivery: with no command for a target, nothing runs and the file waits for the next start', () => withRoot(async (root, muse) => {
  const only = { ...muse.delivery(), commands: { request: muse.argv } };
  const d = start(root, only);
  writeOnce(path.join(req(root), 'escalations'), 'E1.md', body('escalation'));
  await d.idle();
  assert.equal(muse.calls().length, 0);
  assert.equal(marker(root, 'escalations/E1.md').state, 'failed');
  assert.equal(marker(root, 'escalations/E1.md').unrouted, true);
  d.stop();
  onCreated(null);
  const fixed = createDelivery({ root, config: { delivery: muse.delivery() } });
  fixed.init();
  fixed.reconcile();
  await fixed.idle();
  assert.deepEqual(muse.calls().map((c) => c.target), ['escalation']);
}));

test('delivery: status and report show what went where and how fast', () => withRoot(async (root, muse) => {
  const d = start(root, muse.delivery());
  writeOnce(req(root), 'P1.md', body('question'));
  await d.idle();
  const s = ledgerSummary(root, { delivery: muse.delivery() });
  assert.equal(s.active, true);
  assert.deepEqual(s.targets, { request: true, escalation: true });
  assert.equal(s.counts.delivered, 1);
  assert.equal(s.latencyMs.count, 1);
  const r = ledgerReport(root, { since: new Date(Date.now() - 60000).toISOString() });
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].file, 'P1.md');
}));

test('delivery: retention keeps a marker while its file exists, and removes it once the file is gone', () => withRoot(async (root, muse) => {
  const d = start(root, muse.delivery());
  writeOnce(req(root), 'keep.md', body('question'));
  writeOnce(req(root), 'gone.md', body('question'));
  await d.idle();
  const markerFile = path.join(req(root), '.delivery', `${encodeURIComponent('keep.md')}.json`);
  const old = (Date.now() - 200 * 86400000) / 1000;
  fs.utimesSync(markerFile, old, old); // an old marker of a file still there
  fs.rmSync(path.join(req(root), 'gone.md'));
  const rt = { store: { purgeOlderThan: () => 0, flush() {} } };
  const r = applyRetention({ rt, config: { retentionDays: 90 }, root });
  assert.equal(r.markersRemoved, 1);
  assert.ok(fs.existsSync(markerFile));
  assert.equal(marker(root, 'gone.md'), undefined);
}));

test('delivery config: commands must be lists starting with an absolute path, for known targets', () => {
  const root = tmpRoot();
  try {
    const load = (delivery) => { fs.writeFileSync(path.join(root, 'muse-config.json'), JSON.stringify({ delivery })); return loadConfig(root); };
    assert.equal(load(undefined).delivery.enabled, false);
    assert.throws(() => load({ enabled: true }), /needs delivery.commands.request/);
    assert.throws(() => load({ enabled: true, commands: { request: ['wake.sh'] } }), /absolute path/);
    assert.throws(() => load({ enabled: true, commands: { request: '/bin/wake {file}' } }), /list of strings/);
    assert.throws(() => load({ enabled: true, commands: { request: ['/bin/true'], other: ['/bin/true'] } }), /unknown target/);
    assert.throws(() => load({ enabled: 'yes', commands: {} }), /true or false/);
    assert.equal(load({ enabled: true, commands: { request: ['/bin/true', '{file}'] } }).delivery.timeoutSeconds, 30);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the listener

const mine = (id, text) => waMessage({ chat: GROUP, id, text, fromMe: true });
const promptFiles = (kit) => (kit.exists('requests') ? fs.readdirSync(kit.path('requests')).filter((f) => f.endsWith('.md') && !f.includes('-lifecycle-')) : []);

/** A kit whose config pushes to a fake Muse in the kit folder. */
function pushKit({ config = CONFIG, creds = QR_LINKED, delivery = {} } = {}) {
  const kit = createKit({ creds, config });
  const muse = fakeMuse(kit.dir);
  fs.writeFileSync(kit.path('muse-config.json'), JSON.stringify({ ...config, delivery: muse.delivery(delivery) }));
  return { kit, muse };
}

/**
 * After a SIGKILL the dead listener's socket file is still there; wait for
 * the new one to be serving it, or `status` falls through to a one-shot run
 * that waits on the session lock the new listener holds.
 */
async function restarted(kit, listener) {
  await waitUntil(() => listener.log().includes(`listening (pid ${listener.child.pid})`), { what: 'new listener serving its socket', timeout: 10000 });
  await connected(kit);
}

async function connected(kit) {
  await waitUntil(async () => kit.exists('listener.sock') && (await cliAsync(kit, ['status'])).result?.connected === true,
    { what: 'listener to connect', timeout: 10000 });
}

test('listener: a prompt is pushed to Muse once, as soon as its request file is written', async () => {
  const { kit, muse } = pushKit();
  const listener = kit.startListener();
  try {
    await connected(kit);
    // The listener's own started event went out the same way.
    await waitUntil(() => muse.calls().some((c) => c.kind === 'lifecycle'), { what: 'started event pushed' });
    kit.queue([mine('P1', '@agent what is on today?')]);
    const [file] = await waitUntil(() => { const f = promptFiles(kit); return f.length ? f : null; }, { what: 'request file' });
    const call = await waitUntil(() => muse.calls().find((c) => c.name === file), { what: 'prompt pushed' });
    const writtenAt = fs.statSync(kit.path(`requests/${file}`)).mtimeMs;
    const latency = call.at - writtenAt;
    assert.equal(call.kind, 'question');
    assert.equal(call.target, 'request');
    assert.ok(latency < 1500, `pushed ${Math.round(latency)} ms after the file was written`);
    await sleep(1500);
    assert.equal(muse.calls().filter((c) => c.name === file).length, 1, 'once');
    const report = await cliAsync(kit, ['delivery', 'report']);
    assert.equal(report.exit, 0);
    assert.equal(report.result.rows.find((r) => r.file === file).state, 'delivered');
    console.log(`# delivery: prompt request file -> wake in ${Math.round(latency)} ms`);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
});

test('listener: a restarted listener never pushes a prompt again, and a second answer is refused', async () => {
  const { kit, muse } = pushKit();
  try {
    let listener = kit.startListener();
    await connected(kit);
    kit.queue([mine('P1', '@agent first')]);
    const [file] = await waitUntil(() => { const f = promptFiles(kit); return f.length ? f : null; }, { what: 'request file' });
    await waitUntil(() => muse.calls().some((c) => c.name === file), { what: 'pushed' });
    assert.equal((await cliAsync(kit, ['reply', '--jid', GROUP, '--id', 'P1', '--text', 'answer'])).exit, 0);
    await listener.stop();
    // The clean stop's own event was pushed before the process ended.
    assert.ok(muse.calls().some((c) => c.kind === 'lifecycle' && /-lifecycle-stopped-/.test(c.name)), 'stop event pushed on the way out');
    listener = kit.startListener();
    await connected(kit);
    await waitUntil(() => muse.calls().filter((c) => /-lifecycle-started-/.test(c.name)).length === 2, { what: 'second start pushed' });
    await sleep(1000);
    assert.equal(muse.calls().filter((c) => c.name === file).length, 1, 'the prompt is not pushed again');
    const again = await cliAsync(kit, ['reply', '--jid', GROUP, '--id', 'P1', '--text', 'answer again']);
    assert.equal(again.exit, 1);
    assert.match(again.stderr, /already answered/);
    await listener.stop();
  } finally {
    kit.cleanup();
  }
});

test('listener: killed in the middle of a push, the restarted listener delivers it again once, as a redelivery', async () => {
  const { kit, muse } = pushKit();
  try {
    let listener = kit.startListener();
    await connected(kit);
    await waitUntil(() => muse.calls().some((c) => c.kind === 'lifecycle'), { what: 'started event pushed' });
    // From now on the fake Muse takes 3 s per wake, so the next push is still running when the listener dies.
    muse.behave({ sleepAlwaysMs: 3000 });
    kit.queue([mine('P1', '@agent slow one')]);
    const [file] = await waitUntil(() => { const f = promptFiles(kit); return f.length ? f : null; }, { what: 'request file' });
    await waitUntil(() => muse.calls().some((c) => c.name === file), { what: 'push started' });
    listener.child.kill('SIGKILL');
    await listener.exited;
    muse.behave({});
    listener = kit.startListener();
    await restarted(kit, listener);
    const redo = await waitUntil(() => muse.calls().find((c) => c.name === file && c.redelivery), { what: 'redelivery', timeout: 10000 });
    assert.equal(redo.attempt, 2);
    await waitUntil(async () => (await cliAsync(kit, ['delivery', 'report'])).result.rows.find((r) => r.file === file)?.state === 'delivered', { what: 'delivered' });
    await sleep(1000);
    assert.equal(muse.calls().filter((c) => c.name === file).length, 2, 'the cut-short push and one redelivery, nothing more');
    const started = fs.readdirSync(kit.path('requests')).filter((f) => f.includes('-lifecycle-started-')).sort();
    assert.match(fs.readFileSync(kit.path(`requests/${started.at(-1)}`), 'utf8'), /ended without a clean stop/);
    await listener.stop();
  } finally {
    kit.cleanup();
  }
});

test('listener: an escalation is pushed to the escalation command', async () => {
  const { kit, muse } = pushKit({ config: { ...CONFIG, escalation: { enabled: true } } });
  const listener = kit.startListener();
  try {
    await connected(kit);
    kit.queue([mine('P1', '@agent is the portal showing my booking?')]);
    await waitUntil(() => promptFiles(kit).length > 0, { what: 'request file' });
    const r = await cliAsync(kit, ['escalate', '--jid', GROUP, '--id', 'P1', '--text', 'check the booking portal']);
    assert.equal(r.exit, 0, r.stderr);
    const call = await waitUntil(() => muse.calls().find((c) => c.target === 'escalation'), { what: 'escalation pushed' });
    assert.equal(call.kind, 'escalation');
    assert.match(call.name, /^escalations\//);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
});

test('lifecycle-event: pushed by the script itself with no listener, and by the listener when one runs', async () => {
  const { kit, muse } = pushKit();
  try {
    let listener = kit.startListener();
    await connected(kit);
    await listener.stop(); // delivery is now set up (requests/.delivery/)
    const event = () => kit.run('bin/lifecycle-event.cjs', ['--event', 'listener-installed', '--title', 'test', '--line', 'x']);
    const a = event();
    assert.equal(a.exit, 0, a.stderr);
    const nameA = a.stdout.trim();
    const byScript = await waitUntil(() => muse.calls().find((c) => c.name === nameA), { what: 'pushed by the script' });
    listener = kit.startListener();
    await connected(kit);
    await sleep(1100); // a different second, so the event gets a new name
    const b = await new Promise((resolve) => {
      require('node:child_process').execFile(process.execPath, ['bin/lifecycle-event.cjs', '--event', 'listener-installed', '--title', 'test', '--line', 'y'],
        { cwd: kit.dir, env: { PATH: process.env.PATH, WA_SIM: '{}', WA_SIM_LOG: kit.path('sim.log'), WA_SIM_QUEUE: kit.path('sim-queue') } },
        (error, stdout) => resolve({ error, stdout }));
    });
    assert.ifError(b.error);
    const nameB = b.stdout.trim();
    const byListener = await waitUntil(() => muse.calls().find((c) => c.name === nameB), { what: 'pushed via the listener' });
    assert.notEqual(byScript.name, byListener.name);
    const status = await cliAsync(kit, ['status']);
    assert.equal(readLedger(kit.dir).find((r) => r.file === nameB).state, 'delivered');
    assert.ok(status.result.listener.delivery.active);
    assert.equal(muse.calls().filter((c) => c.name === nameB).length, 1);
    await listener.stop();
  } finally {
    kit.cleanup();
  }
});

test('listener: with no linked session it pushes the cannot-start event before exiting', async () => {
  const { kit, muse } = pushKit({ creds: null });
  try {
    // Delivery was set up by an earlier run.
    fs.mkdirSync(kit.path('requests/.delivery'), { recursive: true });
    fs.writeFileSync(kit.path('requests/.delivery/.enabled-at'), new Date().toISOString());
    const listener = kit.startListener();
    const { code } = await listener.exited;
    assert.equal(code, 2);
    assert.ok(muse.calls().some((c) => /-lifecycle-cannot-start-/.test(c.name)));
  } finally {
    kit.cleanup();
  }
});

test('listener: a start-up crash over an invalid setting is still pushed', async () => {
  const { kit, muse } = pushKit();
  try {
    fs.mkdirSync(kit.path('requests/.delivery'), { recursive: true });
    fs.writeFileSync(kit.path('requests/.delivery/.enabled-at'), new Date().toISOString());
    const config = JSON.parse(fs.readFileSync(kit.path('muse-config.json'), 'utf8'));
    fs.writeFileSync(kit.path('muse-config.json'), JSON.stringify({ ...config, allChats: 'yes' }));
    const listener = kit.startListener();
    const { code } = await listener.exited;
    assert.equal(code, 1);
    const call = muse.calls().find((c) => /-lifecycle-crashed-/.test(c.name));
    assert.ok(call, 'crash event pushed');
  } finally {
    kit.cleanup();
  }
});

test('delivery status works with no listener running, from the files on disk', async () => {
  const { kit } = pushKit();
  try {
    const r = await cliAsync(kit, ['delivery', 'status']);
    assert.equal(r.exit, 0, r.stderr);
    assert.equal(r.result.enabled, true);
    assert.equal(r.result.active, false, 'not active until a listener has started with it');
    assert.equal(r.result.listenerRunning, false);
    const flush = await cliAsync(kit, ['delivery', 'flush']);
    assert.equal(flush.exit, 1);
    assert.equal(kit.count('socket'), 0, 'no WhatsApp connection for a delivery command');
  } finally {
    kit.cleanup();
  }
});
