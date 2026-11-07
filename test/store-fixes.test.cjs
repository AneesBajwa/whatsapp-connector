'use strict';
/**
 * Store fixes, checked against the REAL Baileys pieces where the stub would
 * hide the problem:
 * - a poll saved from a decoded protobuf message keeps a working secret after
 *   a reload (proto toJSON turns bytes into base64 strings)
 * - edits and deletes that the library's event buffer folds into their target
 *   message (each reconnect's offline batch) are attributed and checked
 * - LID/phone aliases never tie the owner's JIDs to someone else
 * - status@broadcast reactions are not kept waiting forever
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baileys = require('@whiskeysockets/baileys');
const { createStore } = require('../lib/message-store.cjs');
const { applyVoteMessages } = require('../lib/polls.cjs');

const G = '120363000000000001@g.us';
const A = '111@lid'; // a member, sender of the messages
const B = '222@lid'; // another member
const ME_PN = '15559999999@s.whatsapp.net';
const ME_LID = '999999@lid';
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-fix-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const open = (dir, extra = {}) => createStore(dir, {
  BufferJSON: baileys.BufferJSON,
  meJid: () => ME_PN,
  meLid: () => ME_LID,
  aggregatePoll: (message, updates) => baileys.getAggregateVotesInPollMessage({ message, pollUpdates: updates }, ME_PN),
  ...extra,
});

// ---------------------------------------------------------------- polls

test('polls: a vote on a poll reloaded from disk (decoded protobuf) still decrypts', () => withDir((dir) => {
  const secret = crypto.randomBytes(32);
  const wire = baileys.proto.Message.encode({
    pollCreationMessageV3: { name: 'Saturday?', options: [{ optionName: 'Yes' }, { optionName: 'No' }], selectableOptionsCount: 1 },
    messageContextInfo: { messageSecret: secret },
  }).finish();
  let store = open(dir);
  store.addMessages([{ key: { remoteJid: G, id: 'POLL1', fromMe: false, participant: A }, messageTimestamp: 1000, message: baileys.proto.Message.decode(wire) }]);
  store.flush();

  store = open(dir); // a restart
  const sign = Buffer.concat([Buffer.from('POLL1'), Buffer.from(A), Buffer.from(B), Buffer.from('Poll Vote'), new Uint8Array([1])]);
  const key = baileys.hmacSign(sign, baileys.hmacSign(secret, new Uint8Array(32), 'sha256'), 'sha256');
  const iv = crypto.randomBytes(12);
  const plain = baileys.proto.Message.PollVoteMessage.encode({ selectedOptions: [baileys.sha256(Buffer.from('Yes'))] }).finish();
  const vote = {
    key: { remoteJid: G, id: 'V1', fromMe: false, participant: B }, messageTimestamp: 2000,
    message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: 'POLL1', fromMe: false, participant: A }, vote: { encPayload: baileys.aesEncryptGCM(plain, key, iv, Buffer.from(`POLL1\u0000${B}`)), encIv: iv }, senderTimestampMs: 2000000 } },
  };
  const diag = {};
  applyVoteMessages({ baileys, store, messages: [vote], meIds: [ME_PN], diag });
  assert.deepEqual(diag, { pollVotes: 1 });
  assert.deepEqual(store.pollTally(store.get(G, 'POLL1')).options.map((o) => [o.name, o.votes]), [['Yes', 1], ['No', 0]]);
}));

// ---------------------------------------------------------------- folded edits and deletes

/** Feed events through the real event buffer the way Baileys does during an offline batch. */
function buffered(store, emit) {
  const ev = baileys.makeEventBuffer(silent);
  ev.on('messages.upsert', ({ messages }) => store.addMessages(messages));
  ev.on('messaging-history.set', ({ messages }) => store.addMessages(messages));
  ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const edited = u.update.message && u.update.message.editedMessage && u.update.message.editedMessage.message;
      if (edited) store.applyEdit(u.key.remoteJid, u.key.id, edited, u.key);
      else if (u.update.message === null && u.update.messageStubType === 1) store.markDeleted(u.key.remoteJid, u.key.id, u.key);
    }
  });
  ev.buffer();
  emit(ev);
  ev.flush();
}
const msgA = (id, text, ts) => ({ key: { remoteJid: G, id, fromMe: false, participant: A }, message: { conversation: text }, messageTimestamp: ts, pushName: 'Ann' });
/** Upsert of the delete message, then processMessage's update (process-message.js REVOKE). */
function emitDelete(ev, { by, ownId, targetId, targetSender }) {
  const delKey = { remoteJid: G, id: ownId, fromMe: false, participant: by };
  const target = by === targetSender ? { remoteJid: G, id: targetId, fromMe: true } : { remoteJid: G, id: targetId, fromMe: false, participant: targetSender };
  ev.emit('messages.upsert', { messages: [{ key: delKey, message: { protocolMessage: { type: 0, key: target } }, messageTimestamp: 3000 }], type: 'append' });
  ev.emit('messages.update', [{ key: { ...delKey, id: targetId }, update: { message: null, messageStubType: 1, key: delKey } }]);
}
function emitEdit(ev, { by, ownId, targetId, text }) {
  const editKey = { remoteJid: G, id: ownId, fromMe: false, participant: by };
  const editedMessage = { conversation: text };
  ev.emit('messages.upsert', { messages: [{ key: editKey, message: { protocolMessage: { type: 14, key: { remoteJid: G, id: targetId, fromMe: true }, editedMessage } }, messageTimestamp: 5000 }], type: 'append' });
  ev.emit('messages.update', [{ key: { ...editKey, id: targetId }, update: { message: { editedMessage: { message: editedMessage } }, messageTimestamp: 5000 } }]);
}

test('folded delete by the sender: the target is deleted under its own id, with no stray entry', () => withDir((dir) => {
  const store = open(dir);
  buffered(store, (ev) => {
    ev.emit('messages.upsert', { messages: [msgA('M2', 'bring snacks', 1001)], type: 'append' });
    emitDelete(ev, { by: A, ownId: 'DEL1', targetId: 'M2', targetSender: A });
  });
  const list = store.messages(G);
  assert.deepEqual(list.map((m) => m.id), ['M2']);
  assert.equal(list[0].deleted, true);
  assert.equal(list[0].senderJid, A);
  assert.equal(list[0].timestampUnix, 1001, 'keeps the original time');
  assert.equal(list[0].deletedBy, undefined);
}));

test('folded delete by someone else: stored under the right id, marked with who deleted it', () => withDir((dir) => {
  const store = open(dir);
  buffered(store, (ev) => {
    ev.emit('messages.upsert', { messages: [msgA('M2', 'bring snacks', 1001)], type: 'append' });
    emitDelete(ev, { by: B, ownId: 'DEL1', targetId: 'M2', targetSender: A });
  });
  const list = store.messages(G);
  assert.deepEqual(list.map((m) => m.id), ['M2']);
  assert.equal(list[0].senderJid, A);
  assert.equal(list[0].deletedBy, B);
}));

test('folded edits: the sender\'s is applied; someone else\'s is flagged, not passed off as the sender\'s', () => withDir((dir) => {
  const store = open(dir);
  buffered(store, (ev) => {
    ev.emit('messages.upsert', { messages: [msgA('M1', 'meet at 6', 1000), msgA('M3', 'see you', 1002)], type: 'append' });
    emitEdit(ev, { by: A, ownId: 'ED1', targetId: 'M1', text: 'meet at 7' });
    emitEdit(ev, { by: B, ownId: 'ED2', targetId: 'M3', text: 'cancelled' });
  });
  const m1 = store.get(G, 'M1');
  assert.equal(m1.text, 'meet at 7');
  assert.equal(m1.edited, true);
  const m3 = store.get(G, 'M3');
  assert.notEqual(m3.text, 'cancelled');
  assert.equal(m3.editRejected, true);
}));

test('folded delete split across a history set and an upsert batch is still repaired', () => withDir((dir) => {
  const store = open(dir);
  const ev = baileys.makeEventBuffer(silent);
  ev.on('messaging-history.set', ({ messages }) => store.addMessages(messages));
  ev.on('messages.upsert', ({ messages }) => store.addMessages(messages));
  ev.buffer();
  ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [msgA('M2', 'old news', 900)], syncType: 6, isLatest: false });
  emitDelete(ev, { by: A, ownId: 'DEL9', targetId: 'M2', targetSender: A });
  ev.flush();
  const list = store.messages(G);
  assert.deepEqual(list.map((m) => m.id), ['M2']);
  assert.equal(list[0].deleted, true);
}));

test('a live edit from someone else never wipes a valid earlier edit', () => withDir((dir) => {
  const store = open(dir);
  store.addMessages([msgA('M1', 'meet at 6', 1000)]);
  assert.equal(store.applyEdit(G, 'M1', { conversation: 'meet at 7' }, { remoteJid: G, id: 'ED1', fromMe: false, participant: A }), true);
  // B's bogus edit: its protocol message is upserted, then rejected by applyEdit.
  store.addMessages([{ key: { remoteJid: G, id: 'ED2', fromMe: false, participant: B }, message: { protocolMessage: { type: 14, key: { remoteJid: G, id: 'M1', fromMe: true }, editedMessage: { conversation: 'hacked' } } }, messageTimestamp: 6000 }]);
  assert.equal(store.applyEdit(G, 'M1', { conversation: 'hacked' }, { remoteJid: G, id: 'M1', fromMe: false, participant: B }), false);
  assert.equal(store.get(G, 'M1').text, 'meet at 7');
}));

test('a history copy of an admin delete (stub 132) is stored as deleted', () => withDir((dir) => {
  const store = open(dir);
  store.addMessages([{ key: { remoteJid: G, id: 'M5', fromMe: false, participant: A }, message: null, messageStubType: 132, messageTimestamp: 1000 }]);
  assert.equal(store.get(G, 'M5').deleted, true);
}));

// ---------------------------------------------------------------- aliases

test('aliases: the owner\'s own messages never teach a pair, and the owner\'s JIDs pair only with each other', () => withDir((dir) => {
  const store = open(dir);
  const DM = '555@lid';
  // A message the owner sent from the phone: Baileys may put the owner's own PN in remoteJidAlt.
  store.addMessages([{ key: { remoteJid: DM, id: 'S1', fromMe: true, remoteJidAlt: ME_PN }, message: { conversation: 'note' }, messageTimestamp: 1000 }]);
  assert.equal(store.alias(DM), null);
  assert.equal(store.alias(ME_PN), null);
  store.setAlias(DM, ME_PN);
  assert.equal(store.alias(DM), null, 'a contact never pairs with the owner');
  store.setAlias(ME_LID, ME_PN);
  assert.equal(store.alias(ME_PN), ME_LID);
}));

test('aliases: a new pair replaces the old one in both directions', () => withDir((dir) => {
  const store = open(dir);
  store.setAlias('1@lid', '15550000001@s.whatsapp.net');
  store.setAlias('1@lid', '15550000002@s.whatsapp.net');
  assert.equal(store.alias('1@lid'), '15550000002@s.whatsapp.net');
  assert.equal(store.alias('15550000001@s.whatsapp.net'), null, 'no stale reverse entry');
}));

// ---------------------------------------------------------------- status updates

test('reactions and votes on status updates are not kept waiting', () => withDir((dir) => {
  const store = open(dir);
  store.applyReaction('status@broadcast', 'ST1', { key: { remoteJid: 'status@broadcast', id: 'R1', participant: A }, text: '❤️', senderTimestampMs: 1 });
  store.applyPollUpdates('status@broadcast', 'ST2', []);
  assert.equal(store.pendingCount(), 0);
}));

test('folded 1:1 delete split across a history set and an upsert is repaired under the chat this device uses', () => withDir((dir) => {
  const store = open(dir);
  const C = '333@lid';
  const ev = baileys.makeEventBuffer(silent);
  ev.on('messaging-history.set', ({ messages }) => store.addMessages(messages));
  ev.on('messages.upsert', ({ messages }) => store.addMessages(messages));
  ev.buffer();
  ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [{ key: { remoteJid: C, id: 'M2', fromMe: false }, message: { conversation: 'old' }, messageTimestamp: 900 }], syncType: 6, isLatest: false });
  // The contact deletes their own message: the key inside names the chat from their side (our JID).
  const delKey = { remoteJid: C, id: 'DEL9', fromMe: false };
  ev.emit('messages.upsert', { messages: [{ key: delKey, message: { protocolMessage: { type: 0, key: { remoteJid: ME_PN, id: 'M2', fromMe: true } } }, messageTimestamp: 3000 }], type: 'append' });
  ev.emit('messages.update', [{ key: { ...delKey, id: 'M2' }, update: { message: null, messageStubType: 1, key: delKey } }]);
  ev.flush();
  assert.deepEqual(store.messages(C).map((m) => [m.id, !!m.deleted]), [['M2', true]]);
  assert.equal(store.messages(ME_PN).length, 0);
}));

test('a folded delete by someone else of a message stored with its content is handed back for the admin check, not wiped', () => withDir((dir) => {
  const store = open(dir);
  store.addMessages([msgA('M2', 'keep me', 1001)]); // stored earlier, with content
  // Later: a history copy of M2 arrives with B's delete folded into it.
  const r = store.addMessages([
    { key: { remoteJid: G, id: 'DEL1', fromMe: false, participant: B }, message: null, messageStubType: 1, messageTimestamp: 1001 },
    { key: { remoteJid: G, id: 'DEL1', fromMe: false, participant: B }, message: { protocolMessage: { type: 0, key: { remoteJid: G, id: 'M2', fromMe: false, participant: A } } }, messageTimestamp: 3000 },
  ]);
  assert.equal(store.get(G, 'M2').text, 'keep me');
  assert.equal(store.get(G, 'DEL1'), null, 'no stray entry');
  assert.deepEqual(r.unverifiedDeletes.map((d) => [d.jid, d.id, d.by.participant]), [[G, 'M2', B]]);
}));

test('an edit that reached a placeholder survives the real message arriving', () => withDir((dir) => {
  const store = open(dir);
  // The owner's message failed to decrypt: a placeholder (no content) is stored.
  store.addMessages([{ key: { remoteJid: G, id: 'T1', fromMe: true }, messageStubType: 2, messageTimestamp: 1000 }]);
  assert.equal(store.applyEdit(G, 'T1', { conversation: '@agent who is coming?' }, { remoteJid: G, id: 'T1', fromMe: true }), true);
  // The retried original arrives with the pre-edit text.
  store.addMessages([{ key: { remoteJid: G, id: 'T1', fromMe: true }, message: { conversation: '@agnet who is coming?' }, messageTimestamp: 1000 }]);
  const entry = store.get(G, 'T1');
  assert.equal(entry.text, '@agent who is coming?');
  assert.equal(entry.edited, true);
}));

test('an edit marks its chat active, so a recent-prompt scan finds it', () => withDir((dir) => {
  const store = open(dir);
  store.addMessages([{ key: { remoteJid: G, id: 'T1', fromMe: true }, message: { conversation: '@agnet hi' }, messageTimestamp: 1000 }]);
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(store.chatsActiveSince(now - 60), []);
  store.applyEdit(G, 'T1', { conversation: '@agent hi' }, { remoteJid: G, id: 'T1', fromMe: true });
  assert.deepEqual(store.chatsActiveSince(now - 60), [G]);
}));
