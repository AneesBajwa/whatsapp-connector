'use strict';
/** Offline tests for listener health alerts, retention and latency stats. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createKit, waMessage, waitUntil, cliAsync, nowSec, QR_LINKED } = require('./helpers/harness.cjs');

const GROUP = '120363000000000001@g.us';
const ALICE = '111@lid';
const CONFIG = { watchlist: [{ jid: GROUP, name: 'Test Group' }] };

const alerts = (kit) => (kit.exists('requests') ? fs.readdirSync(kit.path('requests')) : [])
  .filter((f) => f.endsWith('.md'))
  .map((f) => fs.readFileSync(kit.path(`requests/${f}`), 'utf8'))
  .filter((b) => /^Kind: alert$/m.test(b));

async function withListener({ config = CONFIG, sim = {}, before } = {}, fn) {
  const kit = createKit({ creds: QR_LINKED, config });
  if (before) before(kit);
  const listener = kit.startListener({ sim });
  try {
    await waitUntil(() => kit.exists('listener.sock'), { what: 'listener socket', timeout: 10000 });
    await fn(kit, listener);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
}

test('health: an outage longer than the threshold alerts the owner, and so does the recovery', () => withListener({
  config: { ...CONFIG, health: { alertAfterMinutes: 0.01 } },
  sim: { dropOnce: { afterMs: 300, code: 428 } },
}, async (kit) => {
  await waitUntil(() => alerts(kit).some((a) => /not connected to WhatsApp/.test(a)), { what: 'outage alert', timeout: 10000 });
  await waitUntil(() => alerts(kit).some((a) => /back online/.test(a)), { what: 'recovery alert', timeout: 10000 });
}));

test('health: a logged-out session alerts at once that it needs linking again', () => withListener({
  sim: { dropOnce: { afterMs: 300, code: 401 } },
}, async (kit) => {
  const [alert] = await waitUntil(() => { const a = alerts(kit); return a.length ? a : null; }, { what: 'logged-out alert' });
  assert.match(alert, /logged out/);
  assert.match(alert, /link/i);
}));

test('health: a session replaced by another copy alerts at once', () => withListener({
  sim: { dropOnce: { afterMs: 300, code: 440 } },
}, async (kit) => {
  const [alert] = await waitUntil(() => { const a = alerts(kit); return a.length ? a : null; }, { what: 'replaced alert' });
  assert.match(alert, /another copy/i);
}));

test('retention: messages older than the retention period are deleted from the store', () => withListener({
  config: { ...CONFIG, retentionDays: 1 },
  before: (kit) => {
    kit.queue([
      waMessage({ chat: GROUP, id: 'OLD', text: 'ancient', from: ALICE, name: 'Alice', ts: nowSec() - 5 * 86400 }),
      waMessage({ chat: GROUP, id: 'NEW', text: 'recent', from: ALICE, name: 'Alice' }),
    ]);
    kit.cli(['status']);
  },
}, async (kit) => {
  await waitUntil(async () => {
    const r = await cliAsync(kit, ['read', '--jid', GROUP, '--cached', '--days', '100000']);
    return r.result && r.result.messages.map((m) => m.id).join() === 'NEW';
  }, { what: 'old message purged' });
}));

test('stats: status reports prompt counts and how fast 👀 and replies went out', () => withListener({}, async (kit) => {
  await waitUntil(async () => (await cliAsync(kit, ['status'])).result?.connected === true, { what: 'connected' });
  kit.queue([waMessage({ chat: GROUP, id: 'P1', text: '@agent ping', fromMe: true })]);
  await waitUntil(() => kit.exists('requests') && fs.readdirSync(kit.path('requests')).some((f) => f.endsWith('.md') && !f.includes('-lifecycle-')), { what: 'request' });
  await cliAsync(kit, ['reply', '--jid', GROUP, '--id', 'P1', '--text', 'pong']);
  const r = await cliAsync(kit, ['status']);
  const stats = r.result.listener.stats;
  assert.equal(stats.prompts, 1);
  assert.equal(stats.answered, 1);
  assert.equal(typeof stats.ackMs.median, 'number');
  assert.equal(typeof stats.replyMs.median, 'number');
}));
