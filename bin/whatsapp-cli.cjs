#!/usr/bin/env node
/**
 * custom.whatsapp — WhatsApp CLI built on Baileys (linked-device protocol).
 *
 * Commands: status, pair, pair-qr, sync, chats, read, search, download, send, edit, delete, react, reply, escalate, watchlist.
 * The CLI itself has no approval logic: the approval gate lives in the
 * assistant workflow, and Muse only invokes `send` after the user's explicit
 * approval for that send.
 *
 * Reads are served from a local message store (../store/). WhatsApp delivers
 * each message to this device once (history sync only on the first
 * connections after linking, later messages as deliveries the server drops
 * once receipted), so every connected run saves what it receives there.
 *
 * One process per session: connected commands take ../session.lock and wait
 * for it (--lock-wait, default 120 s).
 *
 * Session credentials live in ../auth/. That directory is the login: chmod
 * 700/600, never copied into chat, logs, docs, or any other machine.
 * Deleting it unlinks the connector. Never call sock.logout().
 *
 * Usage:
 *   node whatsapp-cli.cjs status
 *   node whatsapp-cli.cjs pair [--phone <number with country code, digits only>]
 *   node whatsapp-cli.cjs pair-qr
 *   node whatsapp-cli.cjs sync
 *   node whatsapp-cli.cjs chats
 *   node whatsapp-cli.cjs read --jid <jid> [--days 30] [--limit 2000] [--no-backfill] [--backfill-wait <s>] [--cached]
 *   node whatsapp-cli.cjs search (--query "words" | --query-file <path>) [--jid <jid>] [--days 90] [--limit 50]
 *   node whatsapp-cli.cjs download --jid <jid> --id <message-id> [--out <path>]
 *   node whatsapp-cli.cjs send --jid <jid> --text "..."
 *   node whatsapp-cli.cjs send --jid <jid> --file newsletter.pdf [--caption "..."]
 *   node whatsapp-cli.cjs edit --jid <jid> --id <message-id> (--text "..." | --text-file <path>)
 *   node whatsapp-cli.cjs delete --jid <jid> --id <message-id>
 *     (edit and delete only touch messages the connector itself sent: edit
 *      text messages within 15 minutes, delete for everyone within 60 hours)
 *   node whatsapp-cli.cjs react --jid <jid> --id <message-id> --emoji ✅ [--participant <sender jid>]
 *   node whatsapp-cli.cjs reply --jid <jid> --id <prompt-id> (--text "..." | --text-file <path>) [--keep-open]
 *   node whatsapp-cli.cjs escalate --jid <jid> --id <prompt-id> (--text "what to check" | --text-file <path>)
 *     (hands a prompt that needs a live check to the main agent: writes
 *      requests/escalations/<file> (Kind: escalation), sets ⏳, posts nothing;
 *      off unless muse-config.json has "escalation": { "enabled": true })
 *   node whatsapp-cli.cjs reply ... --after-escalation   (the main agent's answer to an escalated prompt)
 *   node whatsapp-cli.cjs watchlist list | add --jid <jid> [--name "..."] | remove --jid <jid>
 *     (add/remove only apply when muse-config.json has "allChats": false; by
 *      default @agent works in every chat. list also shows allChats)
 *   node whatsapp-cli.cjs delivery status | report [--since <ISO time>] [--limit N] | flush
 *     (push delivery of requests/ to Muse: how it is set up and doing, one
 *      row per file pushed, or "deliver what is waiting now" (listener only).
 *      Needs no WhatsApp connection)
 * Options for connected commands: [--lock-wait <s>] [--sync-wait <s>]
 *
 * JSON goes to stdout; diagnostics go to stderr, and connected commands also
 * include a `diag` object in their JSON. Exit codes:
 *   0 ok, 1 error, 2 needs pairing (no linked session, or logged out).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const net = require('net');
const { acquireLock } = require('../lib/session-lock.cjs');
const { createRuntime, kitPaths, disconnectStatus, errorMessage, storePollOptions, isLinked } = require('../lib/runtime.cjs');
const { runCommand, validateArgs, searchStore, buildReadResult, readOptions, resolveDownloadFileName } = require('../lib/commands.cjs');
const { loadConfig } = require('../lib/config.cjs');
const { createStateBook } = require('../lib/state-book.cjs');
const { createAudit } = require('../lib/audit.cjs');
const { createStore, messageText, toUnix, toISO: unixToISO } = require('../lib/message-store.cjs');
const { parseArgs, seconds } = require('../lib/args.cjs');
const ipc = require('../lib/ipc.cjs');
const { createDelivery, ledgerSummary, ledgerReport } = require('../lib/delivery.cjs');
const { onCreated } = require('../lib/request-files.cjs');

const ROOT = path.join(__dirname, '..');
const COMMANDS = ['status', 'pair', 'pair-qr', 'sync', 'chats', 'read', 'search', 'download', 'send', 'edit', 'delete', 'react', 'reply', 'escalate', 'watchlist', 'delivery'];
const DEFAULT_LOCK_WAIT_S = 120;
const DEFAULT_SYNC_WAIT_S = 45;

function log(...args) {
  console.error('[wa]', ...args);
}

function toISO(ts) {
  return unixToISO(toUnix(ts));
}

/** Exit once stdout has drained, so large JSON is never cut off on a pipe. */
function exitWhenFlushed(code) {
  process.stdout.write('', () => process.exit(code));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until `pred()` is true, polling every 250ms, or throw after timeoutMs. */
async function waitFor(pred, timeoutMs, what) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * --text-file <path>: read the text from a file (relative to this process's
 * directory), so message text never has to pass through a shell command line.
 * Returns argv with the file's contents as --text, ready for the listener.
 */
const FILE_FLAGS = { '--text-file': '--text', '--query-file': '--query' };

function inlineTextFile(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const flag = Object.keys(FILE_FLAGS).find((f) => a === f || a.startsWith(`${f}=`));
    if (flag) {
      const file = a === flag ? argv[++i] : a.slice(flag.length + 1);
      out.push(FILE_FLAGS[flag], fs.readFileSync(path.resolve(file), 'utf8').replace(/\n+$/, ''));
    } else {
      out.push(a);
    }
  }
  return out;
}

/**
 * listener.autostart (an empty marker created by
 * deploy/install-listener.sh --cli-fallback) means the listener is meant to
 * be running. A command that finds it not running runs that installer (the
 * fixed path, never a command read from a file) and then goes through the
 * listener: an event-driven fallback for when nothing brought the listener
 * back after a VM replacement. Skipped for an unlinked session, and tried at
 * most once every 5 minutes, so a listener that cannot start never makes
 * every command slow or noisy. Returns true once the listener accepts
 * connections; otherwise the command runs one-shot as before.
 */
const REVIVE_EVERY_MS = 5 * 60 * 1000;

function canConnect(sockPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) { resolve(false); return; }
    const conn = net.connect(sockPath);
    const done = (ok) => { conn.destroy(); resolve(ok); };
    conn.setTimeout(1000, () => done(false));
    conn.on('connect', () => done(true));
    conn.on('error', () => done(false));
  });
}

async function reviveListener(paths) {
  if (!fs.existsSync(path.join(ROOT, 'listener.autostart'))) return false;
  let creds = null;
  try { creds = JSON.parse(fs.readFileSync(path.join(paths.auth, 'creds.json'), 'utf8')); } catch { /* no session */ }
  if (!isLinked(creds)) return false;
  const stampFile = path.join(ROOT, '.listener-revive-at');
  try {
    const age = Date.now() - fs.statSync(stampFile).mtimeMs;
    // A stamp from the future (a replacement VM whose clock is behind) counts as old.
    if (age >= 0 && age < REVIVE_EVERY_MS) return false;
  } catch { /* never tried */ }
  try { fs.writeFileSync(stampFile, new Date().toISOString(), { mode: 0o600 }); } catch { /* best effort */ }
  const script = path.join(ROOT, 'deploy', 'install-listener.sh');
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const argv = asRoot ? [script, '--reason', 'cli'] : ['sudo', '-n', script, '--reason', 'cli'];
  log('the listener is not running; starting it (listener.autostart)');
  const started = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, timeout: 120000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n').pop() || (r.error && r.error.message) || `exit ${r.status}`;
    log(`could not start the listener (${why}); running this command on its own connection`);
    return false;
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await canConnect(paths.socket)) {
      log(`listener started in ${Math.round((Date.now() - started) / 1000)}s`);
      return true;
    }
    await sleep(250);
  }
  log('the listener did not come up in time; running this command on its own connection');
  return false;
}

async function main() {
  let argv;
  try {
    argv = inlineTextFile(process.argv.slice(2));
  } catch (e) {
    console.error(`error: could not read --text-file: ${errorMessage(e)}`);
    process.exit(1);
  }
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || !COMMANDS.includes(command)) {
    console.error(`Usage: whatsapp-cli.cjs <${COMMANDS.join('|')}> [--jid <jid>] [--days N] [--limit N] [--phone <digits>] [--text "..."] [--file <path>] [--caption "..."] [--id <message-id>] [--out <path>] [--cached] [--no-backfill] [--backfill-wait <s>] [--emoji <emoji>] [--participant <jid>] [--keep-open] [--after-escalation] [--lock-wait <s>] [--sync-wait <s>]`);
    process.exit(1);
  }
  const problem = validateArgs(command, args);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const paths = kitPaths(ROOT);

  // Search reads the store alone: no session, no lock, no network.
  if (command === 'search') {
    const store = createStore(paths.store, { readOnly: true, ...storePollOptions(ROOT) });
    const { days, limit } = readOptions(args, { days: 90, limit: 50 });
    console.log(JSON.stringify(searchStore(store, { query: args.query, jid: args.jid || null, days, limit })));
    exitWhenFlushed(0);
    return;
  }

  // Delivery needs no session: the listener answers it, or the files on disk do.
  if (command === 'delivery') {
    const reply = await ipc.request(paths.socket, { argv, cwd: process.cwd() }, { timeoutMs: 30000 });
    if (reply) {
      for (const line of reply.err || []) console.error(line);
      for (const obj of reply.out || []) console.log(JSON.stringify(obj));
      exitWhenFlushed(Number.isInteger(reply.exit) ? reply.exit : 1);
      return;
    }
    const sub = args._[1] || 'status';
    if (sub === 'flush') {
      console.error('error: the listener is not running; it delivers what is waiting when it starts');
      process.exit(1);
    }
    let config;
    try { config = loadConfig(ROOT, { log }); } catch (e) { console.error(`error: ${errorMessage(e)}`); process.exit(1); }
    const out = sub === 'report'
      ? ledgerReport(ROOT, { since: args.since || null, limit: Number.isFinite(args.limit) ? args.limit : 200 })
      : { ...ledgerSummary(ROOT, config), listenerRunning: false };
    console.log(JSON.stringify(out));
    exitWhenFlushed(0);
    return;
  }

  // A running listener holds the session: hand the command to it.
  if (!(command === 'read' && args.cached)) {
    let reply = await ipc.request(paths.socket, { argv, cwd: process.cwd() });
    if (!reply && command !== 'pair' && command !== 'pair-qr' && await reviveListener(paths)) {
      reply = await ipc.request(paths.socket, { argv, cwd: process.cwd() });
    }
    if (reply) {
      for (const line of reply.err || []) console.error(line);
      for (const obj of reply.out || []) console.log(JSON.stringify(obj));
      exitWhenFlushed(Number.isInteger(reply.exit) ? reply.exit : 1);
      return;
    }
  }

  // Served from the store alone: no session, no lock, no network.
  if (command === 'read' && args.cached) {
    if (!args.jid) {
      console.error('read requires --jid <jid>');
      process.exit(1);
    }
    const store = createStore(paths.store, { readOnly: true, ...storePollOptions(ROOT) });
    console.log(JSON.stringify({ ...buildReadResult(store, args.jid, readOptions(args)), cached: true }));
    exitWhenFlushed(0);
    return;
  }

  const pairing = command === 'pair' || command === 'pair-qr';
  try {
    await acquireLock(paths.lock, { waitMs: seconds(args.lockWait, DEFAULT_LOCK_WAIT_S) * 1000, label: command });
  } catch (e) {
    if (e.code === 'SESSION_BUSY') {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const rt = await createRuntime({ root: ROOT, command, mode: 'oneshot', log });
  const finish = async (code, obj) => {
    if (obj) console.log(JSON.stringify(obj));
    await rt.shutdown();
    log(`diag ${JSON.stringify(rt.diag)}`);
    exitWhenFlushed(code);
  };

  // Every other command needs a linked session. Check before any network use,
  // so asking about an unlinked session never opens a registration connection.
  if (!pairing && !rt.isLinked()) {
    console.log(JSON.stringify({ connected: false, needsPairing: true }));
    process.exit(2);
  }
  if (command === 'pair' && rt.isLinked()) {
    console.log(JSON.stringify({ paired: true, alreadyRegistered: true }));
    process.exit(0);
  }

  // Pairing with the stale bundled version is proven to get terminated at
  // registration, so refuse to burn a pairing attempt (and feed the rate
  // limit) when the version fetch fails. Linked commands may proceed.
  const version = await rt.resolveVersion();
  if (!version.isLatest && pairing) {
    console.error('error: could not fetch the current WhatsApp version; refusing to pair with the stale bundled version. Retry when the version fetch works.');
    process.exit(1);
  }

  await rt.start();

  try {
    if (command === 'pair') {
      const phone = String(args.phone).replace(/\D/g, '');
      // The pairing IQ must go over an open socket: wait for open first, then
      // let the Noise handshake settle.
      if (typeof rt.sock.waitForSocketOpen === 'function') await rt.sock.waitForSocketOpen();
      await sleep(2000);
      const rawCode = (await rt.sock.requestPairingCode(phone)) || rt.state.creds.pairingCode;
      const code = rawCode && rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
      console.log(JSON.stringify({ pairingCode: code, phone }));
      log('Enter this code on the phone: WhatsApp > Linked devices > Link device > Link with phone number instead.');
      await waitFor(() => rt.connectionState === 'open', 150000, 'pairing to complete');
      await rt.saveCredsLocked();
      await finish(0, { paired: true, me: rt.me() });
      return;
    }

    if (command === 'pair-qr') {
      // A saved login still has to connect: paired:true must only ever mean
      // an open connection, or a dead session would be reported as linked.
      const alreadyLinked = rt.isLinked();
      if (!alreadyLinked) log('QR pairing: scan the printed QR on the phone: WhatsApp > Linked devices > Link a device.');
      // The restart WhatsApp asks for after a scan is handled by the runtime;
      // any other close ends this attempt, with its status code in the output.
      const qrStart = Date.now();
      let paired = false;
      while (Date.now() - qrStart < 300000) {
        if (rt.connectionState === 'open') { paired = true; break; }
        if (rt.connectionState === 'close') break;
        await sleep(500);
      }
      if (!paired) {
        await finish(1, {
          paired: false,
          reason: rt.connectionState === 'close' ? 'connection_closed' : 'timeout',
          statusCode: disconnectStatus(rt.lastDisconnect),
          lastQrAt: rt.latestQrAt,
        });
        return;
      }
      await rt.saveCredsLocked();
      await finish(0, { paired: true, ...(alreadyLinked ? { alreadyRegistered: true } : {}), me: rt.me() });
      return;
    }

    await rt.waitForOpen(90000);
    await rt.waitForSync(seconds(args.syncWait, DEFAULT_SYNC_WAIT_S) * 1000);
    const needsState = ['react', 'reply', 'escalate', 'watchlist', 'send', 'edit', 'delete'].includes(command);
    const config = needsState ? loadConfig(ROOT, { log }) : null;
    // No listener: a file this run writes for Muse (an escalation) is pushed by this run.
    if (config) onCreated(createDelivery({ root: ROOT, config, log, standalone: true }).notify);
    const res = await runCommand(rt, command, args, {
      cwd: process.cwd(),
      book: needsState ? createStateBook(paths.state) : null,
      config,
      audit: createAudit(paths.audit),
    });
    for (const line of res.err) console.error(line);
    for (const obj of res.out) console.log(JSON.stringify(obj));
    await finish(res.exit);
  } catch (e) {
    if (disconnectStatus(rt.lastDisconnect) === 401) {
      await finish(2, { connected: false, needsPairing: true, reason: 'logged_out' });
      return;
    }
    console.error(`error: ${errorMessage(e)}`);
    await finish(1);
  }
}

if (require.main === module) {
  // Errors thrown outside the command (auth load, socket creation, proxy
  // setup) would otherwise surface as unhandled rejections.
  main().catch((e) => {
    const msg = errorMessage(e);
    console.error(`error: ${msg}`);
    if (/Unexpected token|JSON|creds/i.test(msg)) {
      console.error('hint: the auth state may be unreadable. Keep auth/ and report this error; removing it would force a new device link.');
    }
    process.exit(1);
  });
}

module.exports = { parseArgs, messageText, toISO, resolveDownloadFileName };
