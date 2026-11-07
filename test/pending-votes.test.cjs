'use strict';
/**
 * Poll votes that arrive before their poll, with the REAL Baileys crypto:
 * the encrypted vote waits in the store's pending list (surviving a save and
 * reload through the real BufferJSON) and is decrypted once the poll arrives.
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

const GROUP = '120363000000000001@g.us';
const ALICE_LID = '111111@lid';
const ALICE_PN = '15550000001@s.whatsapp.net';
const BOB_LID = '222222@lid';
const BOB_PN = '15550000002@s.whatsapp.net';
const ME_PN = '15559999999@s.whatsapp.net';

const optionHash = (name) => baileys.sha256(Buffer.from(name));

function encryptVote({ secret, pollId, creatorJid, voterJid, options }) {
  const sign = Buffer.concat([Buffer.from(pollId), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from('Poll Vote'), new Uint8Array([1])]);
  const key0 = baileys.hmacSign(secret, new Uint8Array(32), 'sha256');
  const key = baileys.hmacSign(sign, key0, 'sha256');
  const iv = crypto.randomBytes(12);
  const plain = baileys.proto.Message.PollVoteMessage.encode({ selectedOptions: options.map(optionHash) }).finish();
  return { encPayload: baileys.aesEncryptGCM(plain, key, iv, Buffer.from(`${pollId}\u0000${voterJid}`)), encIv: iv };
}

const pollMessage = (secret) => ({
  key: { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: ALICE_LID, participantAlt: ALICE_PN },
  pushName: 'Alice',
  messageTimestamp: 1000,
  message: {
    pollCreationMessageV3: { name: 'Coming Saturday?', options: [{ optionName: 'Yes' }, { optionName: 'No' }], selectableOptionsCount: 1 },
    messageContextInfo: { messageSecret: secret },
  },
});

const voteMessage = (secret) => ({
  key: { remoteJid: GROUP, id: 'V1', fromMe: false, participant: BOB_LID, participantAlt: BOB_PN },
  messageTimestamp: 2000,
  message: {
    pollUpdateMessage: {
      pollCreationMessageKey: { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: ALICE_LID },
      vote: encryptVote({ secret, pollId: 'POLL1', creatorJid: ALICE_LID, voterJid: BOB_LID, options: ['Yes'] }),
      senderTimestampMs: 2000000,
    },
  },
});

function withStoreDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pending-test-'));
  const opts = {
    BufferJSON: baileys.BufferJSON,
    aggregatePoll: (message, updates) => baileys.getAggregateVotesInPollMessage({ message, pollUpdates: updates }, ME_PN),
  };
  try {
    return fn({ dir, open: () => createStore(dir, opts) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pending votes: a vote that arrives before its poll is counted once the poll arrives, across a restart', () => withStoreDir(({ open }) => {
  const secret = crypto.randomBytes(32);
  const diag = {};
  let store = open();
  applyVoteMessages({ baileys, store, messages: [voteMessage(secret)], meIds: [ME_PN], diag });
  assert.equal(diag.pollVotesPending, 1);
  assert.equal(diag.pollVotesNotCounted, undefined);
  store.flush();

  store = open(); // as after a listener restart
  assert.equal(store.pendingCount(), 1);
  const r = store.addMessages([pollMessage(secret)]);
  assert.equal(r.pendingVotes.length, 1);
  applyVoteMessages({ baileys, store, messages: r.pendingVotes, meIds: [ME_PN], diag });
  assert.equal(diag.pollVotes, 1);
  const tally = store.pollTally(store.get(GROUP, 'POLL1'));
  assert.deepEqual(tally.options.map((o) => [o.name, o.votes]), [['Yes', 1], ['No', 0]]);
  assert.equal(store.pendingCount(), 0);
}));

test('pending votes: already-decrypted updates for a missing poll are applied when it arrives', () => withStoreDir(({ open }) => {
  const secret = crypto.randomBytes(32);
  const store = open();
  const update = { pollUpdateMessageKey: { remoteJid: GROUP, id: 'V9', fromMe: false, participant: BOB_LID }, vote: { selectedOptions: [optionHash('No')] }, senderTimestampMs: 5 };
  assert.equal(store.applyPollUpdates(GROUP, 'POLL1', [update]), false);
  store.addMessages([pollMessage(secret)]);
  const tally = store.pollTally(store.get(GROUP, 'POLL1'));
  assert.deepEqual(tally.options.map((o) => [o.name, o.votes]), [['Yes', 0], ['No', 1]]);
}));

test('pending list: old entries are purged with the message retention', () => withStoreDir(({ open }) => {
  const store = open();
  store.applyReaction(GROUP, 'GONE', { key: { remoteJid: GROUP, id: 'R1', participant: BOB_LID }, text: '✅', senderTimestampMs: 1 });
  assert.equal(store.pendingCount(), 1);
  store.purgeOlderThan(Math.floor(Date.now() / 1000) + 10);
  assert.equal(store.pendingCount(), 0);
}));
