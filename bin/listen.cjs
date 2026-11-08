#!/usr/bin/env node
/**
 * Push listener for the WhatsApp connector.
 *
 * Holds the one WhatsApp connection for this session, so messages arrive the
 * moment they are sent instead of being polled for. Everything received is
 * saved to the store, and the CLI's commands (status, chats, read, send, ...)
 * are answered over the local control socket (listener.sock) instead of each
 * opening its own connection, which would replace this one.
 *
 * Run it as a supervised service (see deploy/). It never pairs: with no linked
 * session in auth/ it exits with code 2. It holds session.lock for its whole
 * life, so a second listener or a one-shot CLI run can never connect alongside it.
 *
 * Event-driven throughout; nothing here runs on an interval:
 * - messages arrive as events from WhatsApp; each @agent prompt becomes a
 *   request file, pushed to Muse the moment it is written (lib/delivery.cjs,
 *   when delivery is on);
 * - the store is saved shortly after each change;
 * - prompt expiry is one timer for the next open prompt's deadline;
 * - the outage alert is one deadline, armed while disconnected;
 * - the WhatsApp version is refreshed when reconnecting;
 * - retention runs at start-up and after a save once a day has passed.
 * The one periodic timer is the lifecycle heartbeat (lib/lifecycle.cjs): it
 * writes down that the listener is alive, so the next run can tell how long
 * nothing listened after a sudden kill. It reads and waits for nothing.
 *
 * Exit codes: 0 stopped by a signal, 1 error, 2 no linked session, 3 another
 * listener already holds the session (neither 2 nor 3 is restarted by systemd).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { acquireLock, readHolder, holderAlive } = require('../lib/session-lock.cjs');
const { createRuntime, kitPaths, errorMessage, FATAL_REASONS } = require('../lib/runtime.cjs');
const { runCommand, buildReadResult, readOptions } = require('../lib/commands.cjs');
const { parseArgs } = require('../lib/args.cjs');
const { loadConfig, loadDeliverySettings, DEFAULTS } = require('../lib/config.cjs');
const { createStateBook } = require('../lib/state-book.cjs');
const { createPromptEngine } = require('../lib/prompts.cjs');
const { createAudit } = require('../lib/audit.cjs');
const { createHealthMonitor, applyRetention, promptStats } = require('../lib/health.cjs');
const { createLifecycle, writeEvent } = require('../lib/lifecycle.cjs');
const { createDelivery, ledgerSummary, ledgerReport } = require('../lib/delivery.cjs');
const { onCreated } = require('../lib/request-files.cjs');
const { enableAutoFlush } = require('../lib/message-store.cjs');
const ipc = require('../lib/ipc.cjs');

const ROOT = path.join(__dirname, '..');
// A change is saved this long after it happens; later changes ride along.
const STORE_SAVE_DELAY_MS = 250;
const RETENTION_EVERY_MS = 24 * 3600 * 1000;
const COMMAND_OPEN_WAIT_MS = 30000;
// Missed prompts are reported once the first offline batch has gone quiet:
// Baileys decrypts queued messages after the end-of-offline signal.
const MISSED_QUIET_MS = 5000;
const MISSED_MAX_WAIT_MS = 3 * 60000;
const STOP_WAIT_MS = 5000;
const STOP_FLUSH_MS = 2000;
const EXIT_ANOTHER_LISTENER = 3;

// Set as early as possible in main(), so a failure during start-up is
// reported (and pushed) as a crash event too.
let lifecycleRef = null;
let deliveryRef = null;

function log(...args) {
  console.error(`[listener ${new Date().toISOString()}]`, ...args);
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/** The config to run with when muse-config.json is invalid: defaults, but still able to push. */
function fallbackConfig() {
  return { ...DEFAULTS, delivery: loadDeliverySettings(ROOT) || DEFAULTS.delivery };
}

async function takeLock(paths) {
  for (;;) {
    const holder = readHolder(paths.lock);
    if (holder && holder.label === 'listener' && holderAlive(holder)) {
      log(`another listener is already running (pid ${holder.pid}); exiting`);
      process.exit(EXIT_ANOTHER_LISTENER);
    }
    try {
      return await acquireLock(paths.lock, { waitMs: 30000, label: 'listener' });
    } catch (e) {
      if (e.code !== 'SESSION_BUSY') throw e;
      log(`waiting for the session lock: ${e.message}`);
    }
  }
}

async function main() {
  // Everything the listener creates (store, requests, socket) is private.
  process.umask(0o077);
  const paths = kitPaths(ROOT);
  // Never create auth/: without a linked session there is nothing to listen with.
  const cannotStart = () => {
    let config = DEFAULTS;
    try { config = loadConfig(ROOT, { log }); } catch { config = fallbackConfig(); }
    // Pushed before exiting: nothing restarts a listener that has no session.
    onCreated(createDelivery({ root: ROOT, config, log, standalone: true }).notify);
    writeEvent({
      root: ROOT, config, log, event: 'cannot-start', title: 'WhatsApp listener cannot start', notify: true,
      lines: [
        'There is no linked WhatsApp session in auth/, and the listener never pairs, so it is not running and will not restart by itself.',
        `${(config && config.ownerName) || 'The owner'} links the device again from home with pair-qr; then start the service.`,
      ],
    });
    log('no linked session in auth/; the listener never pairs. Link the device first.');
    process.exit(2);
  };
  if (!fs.existsSync(path.join(paths.auth, 'creds.json'))) cannotStart();
  const lock = await takeLock(paths);

  // Delivery and the lifecycle first: everything after this can fail, and a
  // failure must reach Muse as an event, not only the journal.
  let config = null;
  let configError = null;
  try { config = loadConfig(ROOT, { log }); } catch (e) { configError = e; }
  // With an unreadable config, events still go out, using the built-in defaults.
  const effective = config || fallbackConfig();
  const audit = createAudit(paths.audit);
  const delivery = createDelivery({ root: ROOT, config: effective, log, audit });
  deliveryRef = delivery;
  onCreated((dir, name) => delivery.notify(dir, name));
  try { delivery.init(); } catch (e) { log(`warning: delivery could not start: ${errorMessage(e)}`); }
  const lifecycle = createLifecycle({ root: ROOT, config: effective, log, audit });
  lifecycleRef = lifecycle;
  let onFatalError = (e) => {
    log(`unexpected error during start-up: ${errorMessage(e)}`);
    delivery.setSync(true);
    lifecycle.stopped('crashed', errorMessage(e));
    process.exit(1);
  };
  process.on('uncaughtException', (e) => onFatalError(e));
  if (configError) throw configError;
  // Pushed now: files written while no listener ran, and pushes a crash cut short.
  delivery.reconcile();

  const rt = await createRuntime({ root: ROOT, command: 'listen', mode: 'listener', log });
  if (!rt.isLinked()) cannotStart();
  await rt.resolveVersion();

  let lastRetentionAt = 0;
  const runRetention = () => {
    lastRetentionAt = Date.now();
    try { applyRetention({ rt, config, root: ROOT, audit }); } catch (e) { log(`warning: retention failed: ${errorMessage(e)}`); }
  };
  const autosave = enableAutoFlush(rt.store, {
    delayMs: STORE_SAVE_DELAY_MS,
    onError: (e) => log(`warning: could not save the message store: ${errorMessage(e)}`),
    // Retention is time-based but needs no timer: a day after the last run,
    // the next save runs it (and every start-up does).
    onFlushed: () => {
      if (lastRetentionAt && Date.now() - lastRetentionAt >= RETENTION_EVERY_MS) {
        lastRetentionAt = Date.now();
        setImmediate(runRetention);
      }
    },
  });

  const book = createStateBook(paths.state);
  const prompts = createPromptEngine({ rt, book, config, root: ROOT, log, audit });
  const health = createHealthMonitor({ rt, config, root: ROOT, audit, log });
  log(config.allChats
    ? `listening in every chat for @${config.triggerWord} from the account owner`
    : `watching ${config.watchlist.length} chat(s) for @${config.triggerWord} from the account owner`);

  let lastMessageAt = null;
  // Prompts can go unheard from the last time a run was connected, and
  // again from each disconnect: after every reconnect, once the queued
  // messages have arrived, prompts from the gap that are too old to answer
  // are reported (each once).
  let gapSince = lifecycle.unheardSince();
  rt.events.on('open', () => {
    log('connected to WhatsApp');
    lifecycle.setListening(true);
    // Connected, so ⌛ can be sent: expire what ran out while not connected,
    // then keep one timer armed for the next deadline.
    prompts.startExpiry();
  });
  rt.events.on('disconnected', () => {
    log('disconnected; reconnecting');
    lifecycle.setListening(false);
    if (gapSince === null) gapSince = Math.floor(Date.now() / 1000);
  });
  rt.events.on('messages', (messages) => {
    lastMessageAt = new Date().toISOString();
    prompts.handleMessages(messages);
  });
  rt.events.on('edited', (targets) => prompts.handleEdits(targets));
  // After each (re)connect has delivered what was queued: pick up prompts
  // that reached the store while the listener was not running.
  rt.events.on('drained', () => {
    prompts.scanStore();
    prompts.checkExpired();
    if (gapSince === null) return;
    const since = gapSince;
    gapSince = null;
    // Report once the offline batch has stopped arriving (a long outage can
    // mean hundreds of queued messages): a quiet period, restarted by each
    // new batch, and at most MISSED_MAX_WAIT_MS in all.
    const drainedAt = Date.now();
    let quiet = null;
    const onBatch = (_messages, type) => { if (type === 'append') arm(); };
    function arm() {
      if (quiet) clearTimeout(quiet);
      const left = MISSED_MAX_WAIT_MS - (Date.now() - drainedAt);
      quiet = setTimeout(report, Math.max(0, Math.min(MISSED_QUIET_MS, left)));
      if (quiet.unref) quiet.unref();
    }
    function report() {
      rt.events.removeListener('messages', onBatch);
      Promise.resolve(prompts.scanStore()).then(() => {
        const fresh = prompts.missedPrompts(since).filter((m) => !book.marked(`missed:${m.chatJid}/${m.id}`));
        if (!fresh.length) return;
        for (const m of fresh) book.mark(`missed:${m.chatJid}/${m.id}`);
        book.save();
        lifecycle.missedPrompts(fresh, (jid) => rt.store.chatName(jid));
      }).catch((e) => log(`warning: missed-prompt check failed: ${errorMessage(e)}`));
    }
    rt.events.on('messages', onBatch);
    arm();
  });
  prompts.recoverPending();
  rt.events.on('fatal', (code) => {
    lifecycle.setListening(false);
    log(`session closed with status ${code} (${FATAL_REASONS[code] || 'fatal'}); not reconnecting. Fix the cause, then restart the service.`);
  });
  await rt.start();

  const listenerInfo = () => ({
    pid: process.pid,
    startedAt: new Date(rt.startedAt).toISOString(),
    uptimeS: Math.round((Date.now() - rt.startedAt) / 1000),
    connectionState: rt.connectionState,
    connectedSince: rt.connectionState === 'open' && rt.openedAt ? new Date(rt.openedAt).toISOString() : null,
    reconnects: rt.diag.reconnects,
    lastMessageAt,
    stats: promptStats(book),
    delivery: { enabled: !!effective.delivery.enabled, active: delivery.active },
    nextExpiryAt: prompts.nextExpiryAt ? new Date(prompts.nextExpiryAt).toISOString() : null,
  });

  function deliveryCommand(args) {
    const sub = args._[1] || 'status';
    if (sub === 'flush') {
      // Not active here (turned on after this listener started): say so, and
      // the caller (bin/lifecycle-event.cjs) pushes the file by itself.
      if (!delivery.active) return { exit: 1, out: [{ flushed: false, active: false }], err: ['delivery: not active in this listener; restart it to pick up the delivery settings'] };
      return { exit: 0, out: [{ flushed: true, ...delivery.reconcile() }], err: [] };
    }
    if (sub === 'report') return { exit: 0, out: [ledgerReport(ROOT, { since: args.since || null, limit: Number.isFinite(args.limit) ? args.limit : 200 })], err: [] };
    return { exit: 0, out: [ledgerSummary(ROOT, effective)], err: [] };
  }

  async function answer({ argv = [], cwd = ROOT } = {}) {
    const args = parseArgs(argv);
    const command = args._[0];
    if (command === 'pair' || command === 'pair-qr') {
      return { exit: 1, out: [], err: ['error: the listener is running and holds the session; stop the listener service before pairing'] };
    }
    if (command === 'delivery') return deliveryCommand(args);
    if (rt.fatalCode === 401) {
      return { exit: 2, out: [{ connected: false, needsPairing: true, reason: 'logged_out' }], err: [] };
    }
    if (command === 'status') {
      health.check(); // on demand: an outage alert is never later than this
      const connected = rt.connectionState === 'open';
      const body = { connected, me: rt.me(), listener: listenerInfo(), diag: rt.diag };
      if (!connected) body.reason = FATAL_REASONS[rt.fatalCode] || 'reconnecting';
      return { exit: connected ? 0 : 1, out: [body], err: [] };
    }
    if (command === 'read' && args.cached) {
      if (!args.jid) return { exit: 1, out: [], err: ['read requires --jid <jid>'] };
      return { exit: 0, out: [{ ...buildReadResult(rt.store, args.jid, readOptions(args)), cached: true }], err: [] };
    }
    if (rt.connectionState !== 'open') {
      if (rt.fatalCode) {
        const reason = FATAL_REASONS[rt.fatalCode] || 'fatal';
        return { exit: 1, out: [{ connected: false, reason }], err: [`error: session closed (${reason}); the listener is not reconnecting`] };
      }
      try {
        await rt.waitForOpen(COMMAND_OPEN_WAIT_MS);
      } catch {
        return { exit: 1, out: [], err: ['error: not connected to WhatsApp (the listener is reconnecting); try again shortly'] };
      }
    }
    return runCommand(rt, command, args, {
      cwd, book, config, root: ROOT, audit, onWatchlistChange: (list) => prompts.setWatchlist(list),
    });
  }

  async function handleRequest(req) {
    try {
      return await answer(req);
    } finally {
      // A reply, escalation or reaction may have changed a prompt's deadline.
      prompts.scheduleExpiry();
    }
  }

  const server = await ipc.serve(paths.socket, handleRequest);
  runRetention();
  log(`listening (pid ${process.pid})`);
  lifecycle.started();

  let stopping = false;
  const stop = async (why, code = 0, error = null) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    prompts.stopTimers();
    health.stop();
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(paths.socket); } catch { /* ignore */ }
    const settle = (ms) => Promise.race([Promise.all([prompts.idle(), delivery.idle()]), sleep(ms)]);
    // Prompt handling and pushes in flight finish first (bounded).
    await settle(STOP_WAIT_MS);
    // Then the store and the session keys are saved, before anything else
    // can hold the process up past systemd's stop timeout.
    await rt.shutdown();
    autosave.stop();
    // What the shutdown released (held-back events) is handled and pushed;
    // then the stop event itself is pushed, synchronously, before the exit.
    await settle(STOP_FLUSH_MS);
    delivery.setSync(true);
    lifecycle.stopped(why === 'error' ? 'crashed' : why, error);
    delivery.stop();
    lock.release();
    process.exit(code);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  onFatalError = (e) => {
    log(`unexpected error: ${errorMessage(e)}`);
    stop('error', 1, errorMessage(e));
  };
  process.on('unhandledRejection', (e) => log(`warning: unhandled rejection: ${errorMessage(e)}`));
}

main().catch((e) => {
  log(`error: ${errorMessage(e)}`);
  if (deliveryRef) deliveryRef.setSync(true);
  if (lifecycleRef) lifecycleRef.stopped('crashed', errorMessage(e));
  process.exit(1);
});
