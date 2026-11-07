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
 * Exit codes: 0 stopped by a signal, 1 error, 2 no linked session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { acquireLock, readHolder, holderAlive } = require('../lib/session-lock.cjs');
const { createRuntime, kitPaths, errorMessage, FATAL_REASONS } = require('../lib/runtime.cjs');
const { runCommand, buildReadResult, readOptions } = require('../lib/commands.cjs');
const { parseArgs } = require('../lib/args.cjs');
const { loadConfig, DEFAULTS } = require('../lib/config.cjs');
const { createStateBook } = require('../lib/state-book.cjs');
const { createPromptEngine } = require('../lib/prompts.cjs');
const { createAudit } = require('../lib/audit.cjs');
const { createHealthMonitor, applyRetention, promptStats } = require('../lib/health.cjs');
const { createLifecycle, writeEvent } = require('../lib/lifecycle.cjs');
const ipc = require('../lib/ipc.cjs');

const ROOT = path.join(__dirname, '..');
const STORE_FLUSH_MS = 2000;
const VERSION_REFRESH_MS = 6 * 3600 * 1000;
const COMMAND_OPEN_WAIT_MS = 30000;
// Missed prompts are reported once the first offline batch has gone quiet:
// Baileys decrypts queued messages after the end-of-offline signal.
const MISSED_QUIET_MS = 5000;
const MISSED_MAX_WAIT_MS = 3 * 60000;

// Set as early as possible in main(), so a failure during start-up is
// reported as a crash event too.
let lifecycleRef = null;

function log(...args) {
  console.error(`[listener ${new Date().toISOString()}]`, ...args);
}

async function takeLock(paths) {
  for (;;) {
    const holder = readHolder(paths.lock);
    if (holder && holder.label === 'listener' && holderAlive(holder)) {
      log(`another listener is already running (pid ${holder.pid}); exiting`);
      process.exit(1);
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
    try { config = loadConfig(ROOT, { log }); } catch { /* the event still goes out, with the defaults */ }
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

  // The lifecycle first: everything after this can fail, and a failure must
  // reach Muse as an event, not only the journal.
  let config = null;
  let configError = null;
  try { config = loadConfig(ROOT, { log }); } catch (e) { configError = e; }
  const audit = createAudit(paths.audit);
  // With an unreadable config, events still go out, using the built-in defaults.
  const lifecycle = createLifecycle({ root: ROOT, config: config || DEFAULTS, log, audit });
  lifecycleRef = lifecycle;
  let onFatalError = (e) => {
    log(`unexpected error during start-up: ${errorMessage(e)}`);
    lifecycle.stopped('crashed', errorMessage(e));
    process.exit(1);
  };
  process.on('uncaughtException', (e) => onFatalError(e));
  if (configError) throw configError;

  const rt = await createRuntime({ root: ROOT, command: 'listen', mode: 'listener', log });
  if (!rt.isLinked()) cannotStart();
  await rt.resolveVersion();

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
  });
  rt.events.on('disconnected', () => {
    log('disconnected; reconnecting');
    lifecycle.setListening(false);
    if (gapSince === null) gapSince = Math.floor(Date.now() / 1000);
  });
  let lastAppendAt = 0;
  rt.events.on('messages', (messages, type) => {
    lastMessageAt = new Date().toISOString();
    if (type === 'append') lastAppendAt = Date.now();
    prompts.handleMessages(messages);
  });
  rt.events.on('edited', (targets) => prompts.handleEdits(targets));
  // After each (re)connect has delivered what was queued: pick up prompts
  // that reached the store while the listener was not running.
  rt.events.on('drained', () => {
    prompts.scanStore();
    if (gapSince === null) return;
    const since = gapSince;
    gapSince = null;
    // Wait until the offline batch has stopped arriving (a long outage can
    // mean hundreds of queued messages), then report.
    const drainedAt = Date.now();
    const report = () => {
      const settling = Date.now() - lastAppendAt < MISSED_QUIET_MS && Date.now() - drainedAt < MISSED_MAX_WAIT_MS;
      if (settling) {
        const t = setTimeout(report, 1000);
        if (t.unref) t.unref();
        return;
      }
      Promise.resolve(prompts.scanStore()).then(() => {
        const fresh = prompts.missedPrompts(since).filter((m) => !book.marked(`missed:${m.chatJid}/${m.id}`));
        if (!fresh.length) return;
        for (const m of fresh) book.mark(`missed:${m.chatJid}/${m.id}`);
        book.save();
        lifecycle.missedPrompts(fresh, (jid) => rt.store.chatName(jid));
      }).catch((e) => log(`warning: missed-prompt check failed: ${errorMessage(e)}`));
    };
    const t = setTimeout(report, MISSED_QUIET_MS);
    if (t.unref) t.unref();
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
  });

  async function handleRequest({ argv = [], cwd = ROOT } = {}) {
    const args = parseArgs(argv);
    const command = args._[0];
    if (command === 'pair' || command === 'pair-qr') {
      return { exit: 1, out: [], err: ['error: the listener is running and holds the session; stop the listener service before pairing'] };
    }
    if (rt.fatalCode === 401) {
      return { exit: 2, out: [{ connected: false, needsPairing: true, reason: 'logged_out' }], err: [] };
    }
    if (command === 'status') {
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

  const server = await ipc.serve(paths.socket, handleRequest);
  const flushTimer = setInterval(() => {
    try { rt.store.flush(); } catch (e) { log(`warning: could not save the message store: ${errorMessage(e)}`); }
  }, STORE_FLUSH_MS);
  const runRetention = () => {
    try { applyRetention({ rt, config, root: ROOT, audit }); } catch (e) { log(`warning: retention failed: ${errorMessage(e)}`); }
  };
  runRetention();
  const retentionTimer = setInterval(runRetention, 24 * 3600 * 1000);
  const healthTimer = setInterval(() => health.check(),
    Math.max(500, Math.min(30000, (config.health.alertAfterMinutes * 60000) / 4)));
  const expiryTimer = setInterval(() => prompts.checkExpired(),
    Math.max(1000, Math.min(60000, (config.expireAfterMinutes * 60000) / 4)));
  const versionTimer = setInterval(() => {
    rt.resolveVersion().catch((e) => log(`warning: version refresh failed: ${errorMessage(e)}`));
  }, VERSION_REFRESH_MS);
  log(`listening (pid ${process.pid})`);
  lifecycle.started();

  let stopping = false;
  const stop = async (why, code = 0, error = null) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    lifecycle.stopped(why === 'error' ? 'crashed' : why, error);
    clearInterval(flushTimer);
    clearInterval(retentionTimer);
    clearInterval(healthTimer);
    clearInterval(expiryTimer);
    clearInterval(versionTimer);
    try { server.close(); } catch { /* ignore */ }
    await Promise.race([prompts.idle(), new Promise((r) => setTimeout(r, 5000))]);
    try { fs.unlinkSync(paths.socket); } catch { /* ignore */ }
    await rt.shutdown();
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
  if (lifecycleRef) lifecycleRef.stopped('crashed', errorMessage(e));
  process.exit(1);
});
