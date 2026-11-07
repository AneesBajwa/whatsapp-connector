'use strict';
/**
 * Offline tests for the Nov 6 update: reactions in read/search output,
 * backfill for chats never seen in the store (with LID <-> phone aliases),
 * and the edit / delete commands.
 *
 * Like the other suites, each test runs a copy of the kit in a temp folder
 * against the Baileys stub; nothing touches WhatsApp or the real auth/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createKit, waMessage, nowSec, QR_LINKED } = require('./helpers/harness.cjs');

const GROUP = '120363000000000009@g.us';
const DM_LID = '900000000000001@lid';
const DM_PN = '15550000001@s.whatsapp.net';
const ME = '1@s.whatsapp.net';
const R = { sam: '201@lid', ray: '202@lid', ben: '203@lid', tia: '204@lid', max: '205@lid' };

function withKit(fn) {
  const kit = createKit({ creds: QR_LINKED });
  try {
    return fn(kit);
  } finally {
    kit.cleanup();
  }
}

/** Write a chat's store file directly, as an earlier version left it on disk. */
function writeStoreChat(kit, jid, entries) {
  const dir = kit.path('store/messages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${encodeURIComponent(jid)}.json`), JSON.stringify(entries));
}

function writeContacts(kit, contacts) {
  fs.mkdirSync(kit.path('store'), { recursive: true });
  fs.writeFileSync(kit.path('store/contacts.json'), JSON.stringify(contacts));
}

function storedEntry({ chat, id, text, ts, fromMe = true, sentByConnector = false, raw = undefined, from = null }) {
  return {
    id, chatJid: chat, timestamp: new Date(ts * 1000).toISOString(), timestampUnix: ts,
    senderJid: fromMe ? chat : from, senderName: null, fromMe, type: 'conversation', text,
    ...(sentByConnector ? { sentByConnector: true } : {}),
    ...(raw !== undefined ? { raw } : { raw: { key: { remoteJid: chat, id, fromMe }, message: { conversation: text }, messageTimestamp: ts } }),
  };
}

const reaction = (reactor, emoji, ms, id = `RX${reactor}${ms}`) => ({
  key: { remoteJid: GROUP, fromMe: false, id, participant: reactor }, text: emoji, senderTimestampMs: String(ms),
});

const historyRequests = (kit) => kit.events()
  .filter((e) => e.startsWith('historyRequestArgs '))
  .map((e) => JSON.parse(e.slice('historyRequestArgs '.length)));

// ---------------------------------------------------------------- reactions

test('read: a tracker stored before this update shows its reactions, with names where known', () => withKit((kit) => {
  const ts = nowSec() - 3600;
  // As the VM's store holds it: reactions only inside raw, timestamps as strings.
  writeStoreChat(kit, GROUP, [storedEntry({
    chat: GROUP, id: 'TRACKER1', text: 'Tracker: reply ✅ when done', ts,
    raw: {
      key: { remoteJid: GROUP, id: 'TRACKER1', fromMe: true },
      message: { conversation: 'Tracker: reply ✅ when done' },
      messageTimestamp: ts,
      reactions: [
        reaction(R.sam, '✅', 1000), reaction(R.ray, '✅', 2000), reaction(R.ben, '👍', 3000),
        reaction(R.tia, '✅', 4000), reaction(R.max, '✅', 5000),
      ],
    },
  })]);
  writeContacts(kit, { [R.sam]: 'Sam', [R.ray]: 'Ray', [R.ben]: 'Ben', [R.tia]: 'Tia' });

  for (const args of [['read', '--jid', GROUP, '--cached'], ['read', '--jid', GROUP, '--no-backfill']]) {
    const r = kit.cli(args);
    assert.equal(r.exit, 0, r.stderr);
    const m = r.result.messages.find((x) => x.id === 'TRACKER1');
    assert.equal(m.raw, undefined, 'raw is never printed');
    assert.deepEqual(m.reactions.map((x) => [x.participant, x.participantName, x.emoji, x.timestampMs]), [
      [R.sam, 'Sam', '✅', 1000],
      [R.ray, 'Ray', '✅', 2000],
      [R.ben, 'Ben', '👍', 3000],
      [R.tia, 'Tia', '✅', 4000],
      [R.max, null, '✅', 5000], // not in contacts: the caller maps it
    ]);
    assert.equal(m.reactions.filter((x) => x.emoji === '✅').length, 4);
  }
}));

test('read: live reactions are kept, one per person; a new one replaces, an empty one removes', () => withKit((kit) => {
  kit.queue([
    waMessage({ chat: GROUP, id: 'M1', text: 'who is in?', from: R.sam, name: 'Sam' }),
    waMessage({ chat: GROUP, id: 'M0', text: 'hi', from: R.ray, name: 'Ray', ts: nowSec() - 10 }),
  ]);
  kit.queue([{ __reaction: [
    { key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ray, '✅', 1000) },
    { key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ben, '✅', 1100) },
    { key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ray, '👍', 1200) },
    { key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ben, '', 1300) },
    // An older reaction arriving late never overrides a newer one.
    { key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ray, '❤️', 900) },
  ] }]);
  assert.equal(kit.cli(['status']).exit, 0);
  const r = kit.cli(['read', '--jid', GROUP, '--cached']);
  const m1 = r.result.messages.find((x) => x.id === 'M1');
  assert.deepEqual(m1.reactions.map((x) => [x.participant, x.participantName, x.emoji]), [[R.ray, 'Ray', '👍']]);
  assert.deepEqual(r.result.messages.find((x) => x.id === 'M0').reactions, [], 'no reactions: an empty list');
}));

test('read: reactions that arrive on the message itself (history sync) are kept even without raw', () => withKit((kit) => {
  kit.queue([{ ...waMessage({ chat: GROUP, id: 'H1', text: 'from history', from: R.sam, name: 'Sam' }), reactions: [reaction(R.tia, '✅', 7000)] }]);
  kit.cli(['status']);
  const m = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages[0];
  assert.deepEqual(m.reactions.map((x) => [x.participant, x.emoji, x.timestampMs]), [[R.tia, '✅', 7000]]);
}));

test('react: the connector\'s own reaction shows on the message as fromMe', () => withKit((kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'M1', text: 'done?', from: R.sam, name: 'Sam' })]);
  kit.cli(['status']);
  assert.equal(kit.cli(['react', '--jid', GROUP, '--id', 'M1', '--emoji', '👀']).exit, 0);
  const m = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages[0];
  assert.equal(m.reactions.length, 1);
  assert.equal(m.reactions[0].emoji, '👀');
  assert.equal(m.reactions[0].fromMe, true);
}));

test('search: results carry reactions too', () => withKit((kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'M1', text: 'tracker for friday', from: R.sam, name: 'Sam' })]);
  kit.queue([{ __reaction: [{ key: { remoteJid: GROUP, id: 'M1', fromMe: false, participant: R.sam }, reaction: reaction(R.ray, '✅', 1000) }] }]);
  kit.cli(['status']);
  const r = kit.cli(['search', '--query', 'tracker']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.result.results[0].reactions.map((x) => [x.participant, x.emoji]), [[R.ray, '✅']]);
}));

// ---------------------------------------------------------------- backfill

test('read: a chat never seen in the store is bootstrapped with an anchorless history request', () => withKit((kit) => {
  const before = Date.now();
  const r = kit.cli(['read', '--jid', DM_LID, '--days', '3', '--backfill-wait', '3'], {
    sim: { backfill: [
      waMessage({ chat: DM_LID, id: 'ASK1', text: 'can you confirm?', fromMe: true, ts: nowSec() - 86400 }),
      waMessage({ chat: DM_LID, id: 'ANS1', text: 'confirmed', from: DM_LID, name: 'Tom', ts: nowSec() - 80000 }),
    ] },
  });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['ASK1', 'ANS1']);
  const [first] = historyRequests(kit);
  assert.equal(first.key.remoteJid, DM_LID);
  assert.equal(first.key.id, undefined, 'no anchor message id');
  assert.ok(first.timestampMs >= before && first.timestampMs <= Date.now(), 'anchored on now, in milliseconds');
  assert.equal(r.result.diag.backfillBootstrap.chatJid, DM_LID);
  assert.equal(r.result.diag.backfillImpossible, undefined);
}));

test('read: when the phone ignores an anchorless request, the diag says the chat could not be checked', () => withKit((kit) => {
  const r = kit.cli(['read', '--jid', DM_LID, '--backfill-wait', '1'], { sim: { backfillNeedsAnchor: true } });
  assert.equal(r.exit, 0);
  assert.equal(r.result.count, 0);
  assert.equal(r.result.partial, true);
  const why = r.result.diag.backfillImpossible;
  assert.equal(why.reason, 'no_reply');
  assert.deepEqual(why.triedJids, [DM_LID]);
  assert.match(why.detail, /unchecked/);
}));

test('read: when the phone answers with nothing, the diag says so', () => withKit((kit) => {
  const r = kit.cli(['read', '--jid', DM_LID, '--backfill-wait', '1'], { sim: { backfillReply: 'empty' } });
  assert.equal(r.result.count, 0);
  assert.equal(r.result.diag.backfillImpossible.reason, 'phone_sent_no_messages');
}));

test('read: a phone-number JID finds a chat the phone files under its LID, and the alias is remembered', () => withKit((kit) => {
  const r = kit.cli(['read', '--jid', DM_PN, '--backfill-wait', '2'], {
    sim: {
      lidMap: { [DM_LID]: DM_PN },
      backfillOnlyFor: DM_LID,
      backfill: [waMessage({ chat: DM_LID, id: 'ASK1', text: 'can you confirm?', fromMe: true, ts: nowSec() - 600 })],
    },
  });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.result.messages.map((m) => m.id), ['ASK1']);
  assert.deepEqual(historyRequests(kit).slice(0, 2).map((q) => q.key.remoteJid), [DM_PN, DM_LID]);
  assert.equal(r.result.diag.aliasJid, DM_LID);
  // Later reads by either JID, even without a session, see the same chat.
  assert.deepEqual(kit.cli(['read', '--jid', DM_PN, '--cached']).result.messages.map((m) => m.id), ['ASK1']);
  assert.deepEqual(kit.cli(['read', '--jid', DM_LID, '--cached']).result.messages.map((m) => m.id), ['ASK1']);
}));

test('read: a chat with stored messages still pages back from its oldest one', () => withKit((kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'NEW1', text: 'latest', from: R.sam, name: 'Sam', ts: nowSec() - 60 })]);
  kit.cli(['status']);
  const r = kit.cli(['read', '--jid', GROUP, '--backfill-wait', '1'], {
    sim: { backfill: [waMessage({ chat: GROUP, id: 'OLD1', text: 'older', from: R.ray, name: 'Ray', ts: nowSec() - 7200 })] },
  });
  assert.deepEqual(r.result.messages.map((m) => m.id), ['OLD1', 'NEW1']);
  const [first] = historyRequests(kit);
  assert.equal(first.key.id, 'NEW1');
  assert.equal(r.result.diag.backfillBootstrap, undefined);
}));

// ---------------------------------------------------------------- edit / delete

test('edit: changes a message the connector sent, and read shows the new text', () => withKit((kit) => {
  const sent = kit.cli(['send', '--jid', DM_PN, '--text', 'meeting at 5']);
  assert.equal(sent.exit, 0, sent.stderr);
  const id = sent.result.id;
  const r = kit.cli(['edit', '--jid', DM_PN, '--id', id, '--text', 'meeting at 6']);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.result, { edited: true, jid: DM_PN, id, text: 'meeting at 6' });
  const last = kit.sends().pop();
  assert.deepEqual(last.content, { text: 'meeting at 6', edit: { remoteJid: DM_PN, id, fromMe: true } });
  const m = kit.cli(['read', '--jid', DM_PN, '--cached']).result.messages.find((x) => x.id === id);
  assert.equal(m.text, 'meeting at 6');
  assert.equal(m.edited, true);
  assert.equal(kit.cli(['read', '--jid', DM_PN, '--cached']).result.count, 1, 'no second message');
}));

test('edit: an edited reply keeps the reply prefix', () => withKit((kit) => {
  writeStoreChat(kit, GROUP, [storedEntry({ chat: GROUP, id: 'REPLY1', text: 'Muse: 3 people said yes', ts: nowSec() - 60, sentByConnector: true })]);
  const r = kit.cli(['edit', '--jid', GROUP, '--id', 'REPLY1', '--text', '4 people said yes']);
  assert.equal(r.exit, 0, r.stderr);
  assert.equal(r.result.text, 'Muse: 4 people said yes');
}));

test('edit: refuses messages the connector did not send, older than 15 minutes, or not text', () => withKit((kit) => {
  writeStoreChat(kit, GROUP, [
    storedEntry({ chat: GROUP, id: 'OWNER1', text: 'typed on the phone', ts: nowSec() - 60 }),
    storedEntry({ chat: GROUP, id: 'OLD1', text: 'Muse: old', ts: nowSec() - 20 * 60, sentByConnector: true }),
    { ...storedEntry({ chat: GROUP, id: 'DOC1', text: '[media: documentMessage]', ts: nowSec() - 60, sentByConnector: true }), type: 'documentMessage' },
  ]);
  const sendsBefore = kit.sends().length;
  const cases = [
    ['OWNER1', /not sent by the connector/],
    ['OLD1', /within 15 minutes/],
    ['DOC1', /only text messages/],
    ['MISSING', /not in the store/],
  ];
  for (const [id, why] of cases) {
    const r = kit.cli(['edit', '--jid', GROUP, '--id', id, '--text', 'x']);
    assert.equal(r.exit, 1, id);
    assert.match(r.stderr, why, id);
  }
  assert.equal(kit.sends().length, sendsBefore, 'nothing was sent');
  assert.match(kit.cli(['edit', '--jid', GROUP, '--id', 'OWNER1']).stderr, /requires --text/);
}));

test('delete: removes a message the connector sent, for everyone', () => withKit((kit) => {
  const id = kit.cli(['send', '--jid', GROUP, '--text', 'wrong chat, sorry']).result.id;
  const r = kit.cli(['delete', '--jid', GROUP, '--id', id]);
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(r.result, { deleted: true, jid: GROUP, id });
  assert.deepEqual(kit.sends().pop().content, { delete: { remoteJid: GROUP, id, fromMe: true } });
  const m = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages.find((x) => x.id === id);
  assert.equal(m.deleted, true);
  assert.equal(m.text, '[deleted]');
  const again = kit.cli(['delete', '--jid', GROUP, '--id', id]);
  assert.equal(again.exit, 1);
  assert.match(again.stderr, /already deleted/);
}));

test('delete: refuses the owner\'s own messages and anything older than 60 hours', () => withKit((kit) => {
  writeStoreChat(kit, GROUP, [
    storedEntry({ chat: GROUP, id: 'OWNER1', text: 'typed on the phone', ts: nowSec() - 60 }),
    storedEntry({ chat: GROUP, id: 'OLD1', text: 'Muse: old', ts: nowSec() - 61 * 3600, sentByConnector: true }),
  ]);
  assert.match(kit.cli(['delete', '--jid', GROUP, '--id', 'OWNER1']).stderr, /not sent by the connector/);
  assert.match(kit.cli(['delete', '--jid', GROUP, '--id', 'OLD1']).stderr, /within 60 hours/);
  assert.equal(kit.sends().length, 0);
}));

test('incoming edits and deletes from the sender are applied; ones from anyone else are ignored', () => withKit((kit) => {
  kit.queue([
    waMessage({ chat: GROUP, id: 'A1', text: 'party at 7', from: R.sam, name: 'Sam' }),
    waMessage({ chat: GROUP, id: 'A2', text: 'bring snacks', from: R.sam, name: 'Sam' }),
  ]);
  const edit = (id, by, text) => ({ key: { remoteJid: GROUP, id, fromMe: false, participant: by }, update: { message: { editedMessage: { message: { conversation: text } } } } });
  const del = (id, by) => ({ key: { remoteJid: GROUP, id, fromMe: false, participant: by }, update: { message: null, messageStubType: 1 } });
  kit.queue([{ __update: [edit('A1', R.ray, 'party cancelled'), edit('A1', R.sam, 'party at 8'), del('A2', R.ray)] }]);
  kit.cli(['status']);
  let msgs = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages;
  assert.equal(msgs.find((m) => m.id === 'A1').text, 'party at 8');
  assert.equal(msgs.find((m) => m.id === 'A2').text, 'bring snacks');
  kit.queue([{ __update: [del('A2', R.sam)] }]);
  kit.cli(['status']);
  msgs = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages;
  assert.equal(msgs.find((m) => m.id === 'A2').deleted, true);
}));

// ---------------------------------------------------------------- round 2: pending, admin deletes, diag

test('a reaction to a message not stored yet waits, and shows once the message arrives (even in a later run)', () => withKit((kit) => {
  kit.queue([{ __reaction: [{ key: { remoteJid: GROUP, id: 'LATE1', fromMe: false, participant: R.sam }, reaction: reaction(R.ray, '✅', 1000) }] }]);
  const first = kit.cli(['status']);
  assert.equal(first.result.diag.reactionsPending, 1);
  assert.ok(kit.exists('store/pending.json'));
  kit.queue([waMessage({ chat: GROUP, id: 'LATE1', text: 'tracker from before', from: R.sam, name: 'Sam', ts: nowSec() - 3600 })]);
  kit.cli(['status']);
  const m = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages.find((x) => x.id === 'LATE1');
  assert.deepEqual(m.reactions.map((x) => [x.participant, x.emoji]), [[R.ray, '✅']]);
  assert.deepEqual(kit.readJson('store/pending.json'), {}, 'applied reactions leave the pending list');
}));

test('a group admin can delete someone else\'s message; a non-admin cannot', () => withKit((kit) => {
  kit.queue([
    waMessage({ chat: GROUP, id: 'A1', text: 'spam link', from: R.sam, name: 'Sam' }),
    waMessage({ chat: GROUP, id: 'A2', text: 'normal message', from: R.sam, name: 'Sam' }),
  ]);
  const del = (id, by) => ({ key: { remoteJid: GROUP, id, fromMe: false, participant: by }, update: { message: null, messageStubType: 1 } });
  kit.queue([{ __update: [del('A1', R.ray), del('A2', R.ben)] }]);
  kit.cli(['status'], { sim: { groupMeta: { [GROUP]: { id: GROUP, participants: [{ id: R.ray, admin: 'admin' }, { id: R.ben, admin: null }, { id: R.sam, admin: null }] } } } });
  const msgs = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages;
  const a1 = msgs.find((m) => m.id === 'A1');
  assert.equal(a1.deleted, true);
  assert.equal(a1.deletedBy, R.ray);
  assert.equal(msgs.find((m) => m.id === 'A2').text, 'normal message');
}));

test('a history copy of a message deleted for everyone marks it deleted', () => withKit((kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'oops', from: R.sam, name: 'Sam' })]);
  kit.cli(['status']);
  kit.queue([
    { key: { remoteJid: GROUP, id: 'A1', fromMe: false, participant: R.sam }, messageTimestamp: nowSec(), message: null, messageStubType: 1 },
    { key: { remoteJid: GROUP, id: 'B1', fromMe: false, participant: R.ray }, messageTimestamp: nowSec(), message: null, messageStubType: 1 },
  ]);
  kit.cli(['status']);
  const msgs = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages;
  for (const id of ['A1', 'B1']) {
    const m = msgs.find((x) => x.id === id);
    assert.equal(m.deleted, true, id);
    assert.equal(m.text, '[deleted]', id);
  }
}));

test('read: the diag names the phone\'s reply to our request when it answers with nothing', () => withKit((kit) => {
  const r = kit.cli(['read', '--jid', DM_LID, '--backfill-wait', '1'], { sim: { backfillReply: 'empty' } });
  const why = r.result.diag.backfillImpossible;
  assert.equal(why.reason, 'phone_sent_no_messages');
  assert.deepEqual(why.requestIds, ['REQ1']);
  assert.deepEqual(why.phoneReplies, [{ history: true, messages: 0, response: false }]);
}));

// ---------------------------------------------------------------- round 3

test('the owner\'s own delete of someone else\'s group message (as admin) is applied', () => withKit((kit) => {
  kit.queue([waMessage({ chat: GROUP, id: 'A1', text: 'spam link', from: R.sam, name: 'Sam' })]);
  kit.queue([{ __update: [{ key: { remoteJid: GROUP, id: 'A1', fromMe: true }, update: { message: null, messageStubType: 1 } }] }]);
  kit.cli(['status']);
  const m = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages.find((x) => x.id === 'A1');
  assert.equal(m.deleted, true);
  assert.equal(m.deletedBy, 'me');
}));

test('listener: an unseen chat that could not be bootstrapped is not asked again for a while, and status stays clean', async () => {
  const { cliAsync: run, waitUntil: until } = require('./helpers/harness.cjs');
  const kit = createKit({ creds: QR_LINKED });
  const listener = kit.startListener({ sim: { backfillReply: 'none' } });
  try {
    await until(async () => kit.exists('listener.sock') && (await run(kit, ['status'])).result?.connected === true, { what: 'listener', timeout: 10000 });
    const first = await run(kit, ['read', '--jid', DM_LID, '--backfill-wait', '1'], { timeout: 30000 });
    assert.equal(first.result.diag.backfillImpossible.reason, 'no_reply');
    const asked = kit.count('historyRequest');
    const second = await run(kit, ['read', '--jid', DM_LID, '--backfill-wait', '1'], { timeout: 30000 });
    assert.equal(second.result.diag.backfillImpossible.reason, 'no_reply');
    assert.ok(second.result.diag.backfillImpossible.retryAfterS > 0);
    assert.equal(kit.count('historyRequest'), asked, 'no new request to the phone');
    const status = await run(kit, ['status']);
    assert.equal(status.result.diag.backfillImpossible, undefined, 'a read\'s outcome never lingers in status');
  } finally {
    await listener.stop();
    kit.cleanup();
  }
});

// ---------------------------------------------------------------- round 5

test('a folded delete of a stored message is applied after the admin check, and left alone for a non-admin', () => withKit((kit) => {
  kit.queue([
    waMessage({ chat: GROUP, id: 'M1', text: 'spam link', from: R.sam, name: 'Sam' }),
    waMessage({ chat: GROUP, id: 'M2', text: 'normal', from: R.sam, name: 'Sam' }),
  ]);
  kit.cli(['status']);
  const folded = (ownId, target, by) => [
    { key: { remoteJid: GROUP, id: ownId, fromMe: false, participant: by }, message: null, messageStubType: 1, messageTimestamp: nowSec() },
    { key: { remoteJid: GROUP, id: ownId, fromMe: false, participant: by }, message: { protocolMessage: { type: 0, key: { remoteJid: GROUP, id: target, fromMe: false, participant: R.sam } } }, messageTimestamp: nowSec() },
  ];
  kit.queue([...folded('DEL1', 'M1', R.ray), ...folded('DEL2', 'M2', R.ben)]);
  kit.cli(['status'], { sim: { groupMeta: { [GROUP]: { id: GROUP, participants: [{ id: R.ray, admin: 'admin' }, { id: R.ben, admin: null }] } } } });
  const msgs = kit.cli(['read', '--jid', GROUP, '--cached']).result.messages;
  assert.equal(msgs.find((m) => m.id === 'M1').deleted, true);
  assert.equal(msgs.find((m) => m.id === 'M1').deletedBy, R.ray);
  assert.equal(msgs.find((m) => m.id === 'M2').text, 'normal');
  assert.ok(!msgs.some((m) => m.id === 'DEL1' || m.id === 'DEL2'), 'no stray entries');
}));
