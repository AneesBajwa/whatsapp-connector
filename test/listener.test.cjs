'use strict';
/**
 * Offline tests for bin/listen.cjs (the push listener) and the CLI talking to
 * it over the local control socket. Same stub and temp-folder pattern as the
 * CLI tests: nothing here touches WhatsApp or the real kit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createKit, waMessage, waitUntil, cliAsync, QR_LINKED } = require('./helpers/harness.cjs');

const GROUP = '120363000000000001@g.us';
const ALICE = '111@lid';

async function withListener({ sim = {}, creds = QR_LINKED, waitConnected = true } = {}, fn) {
  const kit = createKit({ creds });
  const listener = kit.startListener({ sim });
  try {
    if (waitConnected) {
      await waitUntil(async () => kit.exists('listener.sock') && (await cliAsync(kit, ['status'])).result?.connected === true,
        { what: 'listener to connect', timeout: 10000 });
    }
    await fn(kit, listener);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
}

test('listener: CLI commands are answered over the local socket with one WhatsApp connection', () => withListener({}, async (kit) => {
  const status = await cliAsync(kit, ['status']);
  assert.equal(status.exit, 0);
  assert.equal(status.result.connected, true);
  assert.equal(typeof status.result.listener.pid, 'number');
  assert.equal((await cliAsync(kit, ['chats'])).exit, 0);
  assert.equal((await cliAsync(kit, ['read', '--jid', GROUP, '--no-backfill'])).exit, 0);
  assert.equal(kit.count('socket'), 1);
}));

test('listener: a message is stored the moment it arrives', () => withListener({}, async (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'L1', text: 'live hello', from: ALICE, name: 'Alice' })]);
  const r = await waitUntil(async () => {
    const res = await cliAsync(kit, ['read', '--jid', GROUP, '--no-backfill']);
    return res.result && res.result.count === 1 ? res : null;
  }, { what: 'the live message', timeout: 5000 });
  assert.equal(r.result.messages[0].text, 'live hello');
}));

test('listener: send goes out over the listener\'s connection', () => withListener({}, async (kit) => {
  const r = await cliAsync(kit, ['send', '--jid', GROUP, '--text', 'hello']);
  assert.equal(r.exit, 0);
  assert.equal(r.result.sent, true);
  assert.equal(kit.sends().length, 1);
  assert.equal(kit.count('socket'), 1);
}));

test('listener: pairing is refused while the listener holds the session', () => withListener({}, async (kit) => {
  const r = await cliAsync(kit, ['pair-qr']);
  assert.equal(r.exit, 1);
  assert.match(r.stderr, /listener/);
  assert.equal(kit.count('socket'), 1);
}));

test('listener: reconnects by itself after a dropped connection', () => withListener({ sim: { dropOnce: { afterMs: 400, code: 428 } } }, async (kit) => {
  await waitUntil(() => kit.count('socket') === 2, { what: 'a reconnect', timeout: 8000 });
  await waitUntil(async () => (await cliAsync(kit, ['status'])).result?.connected === true, { what: 'reconnected status' });
}));

test('listener: stops, and says why, when another copy replaces the session', () => withListener({ sim: { dropOnce: { afterMs: 400, code: 440 } } }, async (kit) => {
  const r = await waitUntil(async () => {
    const res = await cliAsync(kit, ['status']);
    return res.result && res.result.reason === 'connection_replaced' ? res : null;
  }, { what: 'the replaced status' });
  assert.equal(r.exit, 1);
  assert.equal(r.result.connected, false);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(kit.count('socket'), 1, 'must not reconnect and fight the other copy');
}));

test('listener: a logged-out session reports that it needs pairing', () => withListener({ sim: { dropOnce: { afterMs: 400, code: 401 } } }, async (kit) => {
  const r = await waitUntil(async () => {
    const res = await cliAsync(kit, ['status']);
    return res.exit === 2 ? res : null;
  }, { what: 'needsPairing' });
  assert.equal(r.result.needsPairing, true);
  assert.equal(r.result.reason, 'logged_out');
}));

test('listener: a second listener will not start', () => withListener({}, async (kit) => {
  const second = kit.startListener();
  const { code } = await second.exited;
  assert.equal(code, 1);
  assert.equal(kit.count('socket'), 1);
}));

test('listener: SIGTERM stops it cleanly, keeping what it received', () => withListener({}, async (kit, listener) => {
  kit.queue([waMessage({ chat: GROUP, id: 'L1', text: 'before stop', from: ALICE, name: 'Alice' })]);
  await waitUntil(() => kit.queueEmpty(), { what: 'delivery' });
  const { code } = await listener.stop();
  assert.equal(code, 0);
  assert.equal(kit.exists('session.lock'), false);
  assert.equal(kit.exists('listener.sock'), false);
  const r = await cliAsync(kit, ['read', '--jid', GROUP, '--cached']);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['L1']);
}));

test('listener: the control socket is private', () => withListener({}, async (kit) => {
  assert.equal(kit.mode('listener.sock'), 0o600);
}));

test('listener: refuses to start without a linked session, and never pairs', async () => {
  const kit = createKit();
  try {
    const listener = kit.startListener();
    const { code } = await listener.exited;
    assert.equal(code, 2);
    assert.equal(kit.count('socket'), 0);
  } finally {
    kit.cleanup();
  }
});

test('CLI uses its own connection when no listener is running, even with a stale socket file', async () => {
  const kit = createKit({ creds: QR_LINKED });
  try {
    fs.writeFileSync(kit.path('listener.sock'), '');
    const r = await cliAsync(kit, ['status']);
    assert.equal(r.exit, 0);
    assert.equal(r.result.connected, true);
    assert.equal(kit.count('socket'), 1);
  } finally {
    kit.cleanup();
  }
});

test('listener: messages still held back when the connection drops are saved, not lost', () => withListener({
  sim: { drain: 'buffered', dropOnce: { afterMs: 400, code: 428 } },
  waitConnected: false,
}, async (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'H1', text: 'held back', from: ALICE, name: 'Alice' })]);
  await waitUntil(() => kit.count('socket') === 2, { what: 'reconnect', timeout: 8000 });
  const r = await waitUntil(async () => {
    const res = await cliAsync(kit, ['read', '--jid', GROUP, '--cached']);
    return res.result && res.result.count === 1 ? res : null;
  }, { what: 'held message in the store', timeout: 6000 });
  assert.equal(r.result.messages[0].id, 'H1');
}));
