'use strict';
/**
 * The listener runs on events, not clocks: the store is saved when it
 * changes, expiry fires at each prompt's own deadline, the WhatsApp version
 * is refreshed on reconnect, and the one periodic timer left is the
 * lifecycle heartbeat. Stubbed library, temp folders, no WhatsApp.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKit, waMessage, waitUntil, cliAsync, QR_LINKED, KIT_ROOT } = require('./helpers/harness.cjs');
const { createStore, enableAutoFlush } = require('../lib/message-store.cjs');

const GROUP = '120363000000000001@g.us';
const ALICE = '111@lid';
const CONFIG = { watchlist: [{ jid: GROUP, name: 'Test Group' }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mine = (id, text) => waMessage({ chat: GROUP, id, text, fromMe: true });
const alice = (id, text) => waMessage({ chat: GROUP, id, text, from: ALICE, name: 'Alice' });
const requestFiles = (kit) => (kit.exists('requests') ? fs.readdirSync(kit.path('requests')).filter((f) => f.endsWith('.md') && !f.includes('-lifecycle-')) : []);
const reactions = (kit) => kit.sends().filter((s) => s.content.react).map((s) => s.content.react.text);

async function connected(kit) {
  await waitUntil(async () => kit.exists('listener.sock') && (await cliAsync(kit, ['status'])).result?.connected === true,
    { what: 'listener to connect', timeout: 10000 });
}

async function withListener({ config = CONFIG, sim = {} } = {}, fn) {
  const kit = createKit({ creds: QR_LINKED, config });
  const listener = kit.startListener({ sim });
  try {
    await connected(kit);
    await fn(kit, listener);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
}

/** Newest modification time of the message store's chat files. */
function storeMtime(kit) {
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== 'wa-version.json') newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  if (kit.exists('store')) walk(kit.path('store'));
  return newest;
}

// ---------------------------------------------------------------- no silent timers

test('timers: setInterval is used only for the lifecycle heartbeat', () => {
  const found = [];
  for (const sub of ['bin', 'lib']) {
    for (const name of fs.readdirSync(path.join(KIT_ROOT, sub))) {
      if (!name.endsWith('.cjs')) continue;
      const lines = fs.readFileSync(path.join(KIT_ROOT, sub, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bsetInterval\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${sub}/${name}:${i + 1}`);
      });
    }
  }
  assert.equal(found.length, 1, `setInterval calls: ${found.join(', ')}`);
  assert.match(found[0], /^lib\/lifecycle\.cjs:/);
  assert.match(fs.readFileSync(path.join(KIT_ROOT, 'lib', 'lifecycle.cjs'), 'utf8'), /HEARTBEAT_MS\s*=\s*60\s*\*\s*1000|HEARTBEAT_MS\s*=\s*60000/);
});

// ---------------------------------------------------------------- store saved on write

test('store: changes are saved shortly after they happen, and an idle store is never rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-autoflush-test-'));
  try {
    const store = createStore(dir);
    let saves = 0;
    const auto = enableAutoFlush(store, { delayMs: 50, onFlushed: () => { saves++; } });
    store.addMessages([{ key: { remoteJid: 'g@g.us', id: 'A', fromMe: false, participant: '1@lid' }, messageTimestamp: 1000, message: { conversation: 'x' } }]);
    store.addMessages([{ key: { remoteJid: 'g@g.us', id: 'B', fromMe: false, participant: '1@lid' }, messageTimestamp: 1001, message: { conversation: 'y' } }]);
    assert.equal(auto.pending, true, 'one save armed for the burst');
    return sleep(200).then(() => {
      assert.equal(saves, 1, 'the burst is saved once');
      assert.deepEqual(createStore(dir).messages('g@g.us').map((m) => m.id), ['A', 'B'], 'on disk');
      store.messages('g@g.us'); // a read changes nothing
      assert.equal(auto.pending, false);
      return sleep(200);
    }).then(() => {
      assert.equal(saves, 1, 'nothing saved while idle');
      auto.stop();
    });
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500).unref();
  }
});

test('listener: a received message is on disk within a second, and nothing is rewritten while idle', () => withListener({}, async (kit) => {
  const t0 = Date.now();
  kit.queue([alice('M1', 'hello')]);
  await waitUntil(async () => {
    const r = await cliAsync(kit, ['read', '--jid', GROUP, '--cached']);
    return r.result && r.result.messages.some((m) => m.id === 'M1');
  }, { what: 'message on disk', every: 50, timeout: 5000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `on disk after ${ms} ms`);
  await sleep(800); // let the start-up writes settle
  const before = storeMtime(kit);
  await sleep(2500); // longer than the old 2 s flush interval
  assert.equal(storeMtime(kit), before, 'the idle store was not rewritten');
  console.log(`# timers: message -> on disk in ${ms} ms`);
}));

// ---------------------------------------------------------------- expiry at the deadline

// No context asked of the phone (contextMessages: 0), so the request file is
// written right away; the stub phone never answers, and the listener would
// wait for it a few seconds first.
const QUICK = {};
const WINDOW_MS = 3000;
const EXPIRY = { ...CONFIG, expireAfterMinutes: WINDOW_MS / 60000, contextMessages: 0 };

test('expiry: an unanswered prompt gets ⌛ at its own deadline, and status shows the next one', () => withListener({
  config: EXPIRY, sim: QUICK,
}, async (kit) => {
  const sent = Date.now();
  kit.queue([mine('P1', '@agent anyone?')]);
  await waitUntil(() => requestFiles(kit).length && reactions(kit).includes('👀'), { what: 'request + 👀', every: 50 });
  const status = await cliAsync(kit, ['status']);
  const next = Date.parse(status.result.listener.nextExpiryAt);
  assert.ok(Number.isFinite(next), 'a deadline is scheduled');
  assert.ok(next - sent >= WINDOW_MS && next - sent < WINDOW_MS + 1500, `deadline ${next - sent} ms after the prompt was sent`);
  await waitUntil(() => reactions(kit).includes('⌛'), { what: '⌛', every: 50, timeout: 6000 });
  const late = Date.now() - next;
  assert.ok(late < 1000, `⌛ ${late} ms after the deadline`);
  const after = await cliAsync(kit, ['status']);
  assert.equal(after.result.listener.nextExpiryAt, null, 'nothing left to expire');
  console.log(`# timers: ⌛ ${late} ms after the deadline`);
}));

test('expiry: answering a prompt cancels its deadline', () => withListener({
  config: EXPIRY, sim: QUICK,
}, async (kit) => {
  kit.queue([mine('P1', '@agent ping')]);
  await waitUntil(() => requestFiles(kit).length && reactions(kit).includes('👀'), { what: 'request + 👀', every: 50 });
  assert.ok((await cliAsync(kit, ['status'])).result.listener.nextExpiryAt);
  assert.equal((await cliAsync(kit, ['reply', '--jid', GROUP, '--id', 'P1', '--text', 'pong'])).exit, 0);
  assert.equal((await cliAsync(kit, ['status'])).result.listener.nextExpiryAt, null);
  await sleep(WINDOW_MS + 500);
  assert.ok(!reactions(kit).includes('⌛'));
}));

test('expiry: a prompt whose deadline passed while the listener was down expires as soon as it is back', async () => {
  const kit = createKit({ creds: QR_LINKED, config: EXPIRY });
  try {
    let listener = kit.startListener({ sim: QUICK });
    await connected(kit);
    kit.queue([mine('P1', '@agent still there?')]);
    await waitUntil(() => requestFiles(kit).length && reactions(kit).includes('👀'), { what: 'request + 👀', every: 50 });
    await listener.stop();
    assert.ok(!reactions(kit).includes('⌛'), 'not expired before the stop');
    await sleep(WINDOW_MS + 500); // the deadline passes with no listener running
    listener = kit.startListener({ sim: QUICK });
    const t0 = Date.now();
    await waitUntil(() => reactions(kit).includes('⌛'), { what: '⌛ after restart', every: 50, timeout: 8000 });
    console.log(`# timers: overdue prompt expired ${Date.now() - t0} ms after the restart`);
    const [file] = requestFiles(kit);
    assert.match(fs.readFileSync(kit.path(`requests/${file}`), 'utf8'), /^Status: expired$/m);
    await listener.stop();
  } finally {
    kit.cleanup();
  }
});

test('expiry: a deadline that passes while WhatsApp is disconnected waits for the reconnect, then the prompt gets its ⌛', () => withListener({
  // Connected, then dropped at 2 s; the first reconnect fails, the second (about 7 s later) works.
  config: EXPIRY, sim: { dropOnce: { afterMs: 2000, code: 428 }, logins: ['open', 408, 'open'] },
}, async (kit) => {
  kit.queue([mine('P1', '@agent are you there?')]);
  await waitUntil(() => requestFiles(kit).length && reactions(kit).includes('👀'), { what: 'request + 👀', every: 50 });
  const deadline = Date.parse((await cliAsync(kit, ['status'])).result.listener.nextExpiryAt);
  await waitUntil(async () => (await cliAsync(kit, ['status'])).result?.connected === false, { what: 'disconnected', every: 100 });
  await sleep(Math.max(0, deadline - Date.now()) + 800); // the deadline passes with no connection
  const st = await cliAsync(kit, ['status']);
  assert.equal(st.result.connected, false, 'still disconnected after the deadline');
  const [file] = requestFiles(kit);
  assert.doesNotMatch(fs.readFileSync(kit.path(`requests/${file}`), 'utf8'), /^Status: expired$/m, 'not expired while it could not react');
  assert.ok(!reactions(kit).includes('⌛'));
  await waitUntil(() => reactions(kit).includes('⌛'), { what: '⌛ after the reconnect', every: 100, timeout: 20000 });
  assert.ok(kit.count('socket') >= 3, 'after the reconnect');
  assert.match(fs.readFileSync(kit.path(`requests/${file}`), 'utf8'), /^Status: expired$/m);
}));

// ---------------------------------------------------------------- version on reconnect

// The version only matters when connecting: each reconnect re-resolves it,
// from store/wa-version.json while that is under 6 h old, else from the web.
const ageVersionCache = (kit, hours) => {
  const cache = kit.readJson('store/wa-version.json');
  fs.writeFileSync(kit.path('store/wa-version.json'), JSON.stringify({ ...cache, fetchedAt: Date.now() - hours * 3600000 }));
};

test('version: a reconnect fetches it again once the cached one is over 6 h old, and nothing fetches it on a clock', () => withListener({
  sim: { dropOnce: { afterMs: 3000, code: 428 } },
}, async (kit) => {
  assert.equal(kit.count('versionFetch'), 1, 'fetched at start-up');
  ageVersionCache(kit, 7);
  await waitUntil(() => kit.count('socket') >= 2, { what: 'reconnect', timeout: 15000 });
  await connected(kit);
  assert.equal(kit.count('versionFetch'), 2, 'fetched again for the reconnect');
  assert.equal((await cliAsync(kit, ['status'])).result.diag.versionSource, 'fetched');
  await sleep(2000);
  assert.equal(kit.count('versionFetch'), 2, 'no fetch while connected');
}));

test('version: a reconnect within 6 h of the last fetch uses the cached one', () => withListener({
  sim: { dropOnce: { afterMs: 3000, code: 428 } },
}, async (kit) => {
  assert.equal(kit.count('versionFetch'), 1);
  ageVersionCache(kit, 1);
  await waitUntil(() => kit.count('socket') >= 2, { what: 'reconnect', timeout: 15000 });
  await connected(kit);
  assert.equal(kit.count('versionFetch'), 1);
  assert.equal((await cliAsync(kit, ['status'])).result.diag.versionSource, 'cached');
}));
