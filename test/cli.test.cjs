'use strict';
/**
 * Offline tests for bin/whatsapp-cli.cjs in one-shot mode (no listener).
 *
 * These never touch WhatsApp or the kit's auth/: each test runs a copy of the
 * kit in a temp folder against the Baileys stub in test/helpers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createKit, waMessage, deadPid, QR_LINKED } = require('./helpers/harness.cjs');

function runCli(args, { sim = {}, creds, rawCreds } = {}) {
  const kit = createKit({ creds, rawCreds });
  try {
    const r = kit.cli(args, { sim, timeout: 10000 });
    return {
      exit: r.exit,
      stderr: r.stderr,
      result: r.result,
      sockets: kit.count('socket'),
      qrs: kit.count('qr'),
      codeRequests: kit.count('requestPairingCode'),
      savedCreds: !rawCreds && kit.exists('auth/creds.json') ? kit.readJson('auth/creds.json') : null,
      lateKeyMode: kit.mode('auth/late-key.json'),
      authMode: kit.mode('auth'),
      credsMode: kit.mode('auth/creds.json'),
    };
  } finally {
    kit.cleanup();
  }
}

/** Run a scenario against one kit that persists between CLI runs. */
function withKit(opts, fn) {
  const kit = createKit({ creds: QR_LINKED, ...opts });
  try {
    return fn(kit);
  } finally {
    kit.cleanup();
  }
}

const CODE_LINKED = { ...QR_LINKED, registered: true };
const CODE_REQUESTED_ONLY = { registered: false, me: { id: '1@s.whatsapp.net', name: '~' } };
const STALE_VERSION = { version: [2, 3000, 1043857760], isLatest: false, error: { message: 'fetch failed' } };
const GROUP = '120363000000000001@g.us';
const ALICE = '111@lid';

// ---------------------------------------------------------------- pairing

test('pair-qr: restart after a scan reconnects once without a second QR and reports paired', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: ['open'] } });
  assert.equal(r.result.paired, true);
  assert.equal(r.exit, 0);
  assert.equal(r.sockets, 2);
  assert.equal(r.qrs, 1);
});

test('pair-qr: the login is on disk once paired is reported', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: ['open'] } });
  assert.equal(r.result.paired, true);
  assert.ok(r.savedCreds.account, 'creds.json should hold the linked account');
});

test('pair-qr: an expired QR fails with its status code and does not reconnect', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'qr-expires' } });
  assert.equal(r.result.paired, false);
  assert.equal(r.result.statusCode, 408);
  assert.equal(r.exit, 1);
  assert.equal(r.sockets, 1);
});

test('pair-qr: a failed login after the restart reports the failure and keeps the saved login', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: [500] } });
  assert.equal(r.result.paired, false);
  assert.equal(r.result.statusCode, 500);
  assert.equal(r.exit, 1);
  assert.equal(r.sockets, 2);
  assert.ok(r.savedCreds.account, 'the saved login must survive so it can be retried');
});

test('pair-qr: a second restart stops instead of looping', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: [515, 'open'] } });
  assert.equal(r.result.paired, false);
  assert.equal(r.result.statusCode, 515);
  assert.equal(r.exit, 1);
  assert.equal(r.sockets, 2);
});

test('pair-qr: refuses before connecting when the version fetch fell back to the bundled one', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: ['open'], version: STALE_VERSION } });
  assert.equal(r.exit, 1);
  assert.equal(r.sockets, 0);
  assert.match(r.stderr, /refusing to pair/);
});

test('pair-qr: an already linked session is confirmed by connecting, with no QR', () => {
  const r = runCli(['pair-qr'], { sim: { logins: ['open'] }, creds: QR_LINKED });
  assert.equal(r.result.paired, true);
  assert.equal(r.result.alreadyRegistered, true);
  assert.equal(r.qrs, 0);
});

test('pair-qr: an already linked session that cannot connect is not reported as paired', () => {
  const r = runCli(['pair-qr'], { sim: { logins: [401] }, creds: CODE_LINKED });
  assert.equal(r.result.paired, false);
  assert.equal(r.result.statusCode, 401);
  assert.equal(r.exit, 1);
});

test('pair-qr: auth folder and creds file stay private', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', logins: ['open'] } });
  assert.equal(r.authMode, 0o700);
  assert.equal(r.credsMode, 0o600);
});

test('pair: restart after the phone code reconnects and reports paired', () => {
  const r = runCli(['pair', '--phone', '15550000000'], { sim: { logins: ['open'] } });
  assert.equal(r.result.paired, true);
  assert.equal(r.exit, 0);
  assert.equal(r.sockets, 2);
});

test('pair: refuses to start without --phone (there is no default number)', () => {
  const r = runCli(['pair'], { sim: { logins: ['open'] } });
  assert.equal(r.exit, 1);
  assert.equal(r.codeRequests, 0);
  assert.match(r.stderr, /pair requires --phone/);
});

test('pair: never requests a code over a QR-linked session', () => {
  const r = runCli(['pair', '--phone', '15550000000'], { creds: QR_LINKED });
  assert.equal(r.codeRequests, 0);
  assert.equal(r.result.paired, true);
  assert.equal(r.savedCreds.me.name, 'x');
});

test('pair-qr: a reconnect that cannot start still reports paired:false and keeps the saved login', () => {
  const r = runCli(['pair-qr'], { sim: { registration: 'scan', throwOnSocket: 1 } });
  assert.equal(r.result && r.result.paired, false);
  assert.equal(r.exit, 1);
  assert.ok(r.savedCreds.account, 'the saved login must survive so it can be retried');
});

test('pair-qr: key files written while shutting down end up private', () => {
  const r = runCli(['pair-qr'], { sim: { logins: ['open'], writeKeyOnEnd: true }, creds: QR_LINKED });
  assert.equal(r.lateKeyMode, 0o600);
});

test('an unreadable auth state never advises deleting auth/', () => {
  const r = runCli(['pair-qr'], { rawCreds: '{not json' });
  assert.equal(r.exit, 1);
  assert.doesNotMatch(r.stderr, /delete/i);
});

// ---------------------------------------------------------------- status

test('status: a QR-linked session connects', () => {
  const r = runCli(['status'], { sim: { logins: ['open'] }, creds: QR_LINKED });
  assert.equal(r.result.connected, true);
  assert.equal(r.exit, 0);
});

test('status: a session linked by phone code connects', () => {
  const r = runCli(['status'], { sim: { logins: ['open'] }, creds: CODE_LINKED });
  assert.equal(r.result.connected, true);
  assert.equal(r.exit, 0);
});

test('status: no saved login needs pairing, without connecting to WhatsApp', () => {
  const r = runCli(['status']);
  assert.equal(r.result.needsPairing, true);
  assert.equal(r.exit, 2);
  assert.equal(r.sockets, 0);
});

test('status: a phone code that was requested but never completed needs pairing', () => {
  const r = runCli(['status'], { creds: CODE_REQUESTED_ONLY });
  assert.equal(r.result.needsPairing, true);
  assert.equal(r.exit, 2);
});

test('status: a linked session still works when the version fetch fell back', () => {
  const r = runCli(['status'], { sim: { logins: ['open'], version: STALE_VERSION }, creds: QR_LINKED });
  assert.equal(r.result.connected, true);
  assert.equal(r.exit, 0);
});

test('status: a dropped connection is retried before giving up', () => {
  const r = runCli(['status'], { sim: { logins: [428, 'open'] }, creds: QR_LINKED });
  assert.equal(r.result.connected, true);
  assert.equal(r.exit, 0);
  assert.equal(r.sockets, 2);
});

test('status: a logged-out session is reported at once and not retried', () => withKit({}, (kit) => {
  const r = kit.cli(['status'], { sim: { logins: [401] } });
  assert.equal(r.result.needsPairing, true);
  assert.equal(r.exit, 2);
  assert.equal(kit.count('socket'), 1);
  assert.ok(r.ms < 8000, `took ${r.ms}ms`);
}));

// ---------------------------------------------------------------- read path

test('read: returns messages that an earlier run received', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'hello', from: ALICE, name: 'Alice' })]);
  assert.equal(kit.cli(['status']).exit, 0);
  const r = kit.cli(['read', '--jid', GROUP, '--no-backfill']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['A1']);
}));

test('read: returns promptly once offline delivery is done, with no history sync', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'hello', from: ALICE, name: 'Alice' })]);
  const r = kit.cli(['read', '--jid', GROUP, '--no-backfill']);
  assert.equal(r.exit, 0);
  assert.equal(r.result.count, 1);
  assert.ok(r.ms < 8000, `took ${r.ms}ms`);
}));

test('read: offline delivery that never finishes gives a partial result with diagnostics', () => withKit({}, (kit) => {
  const r = kit.cli(['read', '--jid', GROUP, '--no-backfill', '--sync-wait', '2'], { sim: { drain: 'never' } });
  assert.equal(r.exit, 0);
  assert.equal(r.result.partial, true);
  assert.equal(r.result.diag.offlineDrained, false);
  assert.ok(r.ms < 8000, `took ${r.ms}ms`);
}));

test('read: diagnostics explain an empty result', () => withKit({}, (kit) => {
  const r = kit.cli(['read', '--jid', GROUP, '--no-backfill']);
  assert.equal(r.result.count, 0);
  const d = r.result.diag;
  assert.equal(d.historyEvents, 0);
  assert.equal(d.offlineDrained, true);
  assert.equal(d.opens, 1);
  assert.equal(d.versionIsLatest, true);
  assert.equal(typeof d.version, 'string');
  assert.equal(typeof d.storeMessages, 'number');
}));

test('read --cached: serves the store without connecting', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'hello', from: ALICE, name: 'Alice' })]);
  kit.cli(['status']);
  const before = kit.count('socket');
  const r = kit.cli(['read', '--jid', GROUP, '--cached']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['A1']);
  assert.equal(kit.count('socket'), before);
}));

test('status: messages still held back by the library at exit are saved', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'hello', from: ALICE, name: 'Alice' })]);
  kit.cli(['status', '--sync-wait', '1'], { sim: { drain: 'buffered' } });
  const r = kit.cli(['read', '--jid', GROUP, '--cached']);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['A1']);
}));

test('read: a placeholder is replaced when the real message arrives later', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', from: ALICE, name: 'Alice', message: null })]);
  kit.cli(['status']);
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'the real text', from: ALICE, name: 'Alice' })]);
  kit.cli(['status']);
  const r = kit.cli(['read', '--jid', GROUP, '--cached']);
  assert.equal(r.result.count, 1);
  assert.equal(r.result.messages[0].text, 'the real text');
}));

test('read: a sender without a push name gets the name seen earlier', () => withKit({}, (kit) => {
  kit.queue([
    waMessage({ chat: GROUP, id: 'A1', text: 'hi', from: ALICE, name: 'Alice', ts: 1000 }),
    waMessage({ chat: GROUP, id: 'A2', text: 'again', from: ALICE, name: undefined, ts: 1001 }),
  ]);
  kit.cli(['status']);
  const r = kit.cli(['read', '--jid', GROUP, '--cached', '--days', '100000']);
  assert.deepEqual(r.result.messages.map((m) => m.senderName), ['Alice', 'Alice']);
}));

test('chats: lists the account\'s groups from the server when no history arrives', () => withKit({}, (kit) => {
  const r = kit.cli(['chats'], { sim: { groups: { [GROUP]: { id: GROUP, subject: 'Group One' } } } });
  assert.equal(r.exit, 0);
  assert.ok(r.result.chats.some((c) => c.jid === GROUP && c.name === 'Group One'));
  assert.ok(r.ms < 8000, `took ${r.ms}ms`);
}));

test('send: the sent message is stored as sent by the connector', () => withKit({}, (kit) => {
  const s = kit.cli(['send', '--jid', GROUP, '--text', 'hi all']);
  assert.equal(s.exit, 0);
  const r = kit.cli(['read', '--jid', GROUP, '--cached']);
  assert.equal(r.result.messages.length, 1);
  assert.equal(r.result.messages[0].sentByConnector, true);
}));

// ---------------------------------------------------------------- session lock, store, version

test('a second copy waits for the session lock, then gives up without connecting', () => withKit({}, (kit) => {
  fs.writeFileSync(kit.path('session.lock'), JSON.stringify({ pid: process.pid, label: 'test' }));
  const r = kit.cli(['status', '--lock-wait', '1']);
  assert.equal(r.exit, 1);
  assert.match(r.stderr, /session busy/);
  assert.equal(kit.count('socket'), 0);
}));

test('a lock left behind by a dead process is taken over', () => withKit({}, (kit) => {
  fs.writeFileSync(kit.path('session.lock'), JSON.stringify({ pid: deadPid(), label: 'crashed' }));
  const r = kit.cli(['status', '--lock-wait', '1']);
  assert.equal(r.exit, 0);
  assert.equal(r.result.connected, true);
  assert.equal(kit.exists('session.lock'), false, 'the lock is released on exit');
}));

test('a recently fetched WhatsApp version is reused instead of fetched every run', () => withKit({}, (kit) => {
  kit.cli(['status']);
  kit.cli(['status']);
  assert.equal(kit.count('versionFetch'), 1);
}));

test('the message store is private', () => withKit({}, (kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'hello', from: ALICE, name: 'Alice' })]);
  kit.cli(['status']);
  assert.equal(kit.mode('store'), 0o700);
  for (const f of fs.readdirSync(kit.path('store/messages'))) {
    assert.equal(kit.mode(`store/messages/${f}`), 0o600, f);
  }
}));

test('a lock from before the last reboot is taken over even if its pid is alive now', () => withKit({}, (kit) => {
  fs.writeFileSync(kit.path('session.lock'), JSON.stringify({ pid: process.pid, label: 'listener', bootTime: 1, startedAt: '2020-01-01T00:00:00Z' }));
  const r = kit.cli(['status', '--lock-wait', '1']);
  assert.equal(r.exit, 0);
  assert.equal(r.result.connected, true);
}));
