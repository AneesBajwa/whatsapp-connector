'use strict';
/**
 * Poll votes with the REAL Baileys crypto (not the stub): a vote is encrypted
 * exactly as a WhatsApp client does, then decrypted and tallied by the
 * connector's own code, including a save/reload of the store through the real
 * BufferJSON. Baileys 7.0.0-rc14 ships with its own vote decryption commented
 * out, so this path is the connector's responsibility.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baileys = require('@whiskeysockets/baileys');
const { createStore } = require('../lib/message-store.cjs');
const { decryptPollVote } = require('../lib/polls.cjs');

const GROUP = '120363000000000001@g.us';
const ALICE_LID = '111111@lid';
const ALICE_PN = '15550000001@s.whatsapp.net';
const BOB_LID = '222222@lid';
const BOB_PN = '15550000002@s.whatsapp.net';
const ME_PN = '15559999999@s.whatsapp.net';
const ME_LID = '999999@lid';

const optionHash = (name) => baileys.sha256(Buffer.from(name));

/** Encrypt a vote the way the voter's WhatsApp client does. */
function encryptVote({ secret, pollId, creatorJid, voterJid, options }) {
  const sign = Buffer.concat([Buffer.from(pollId), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from('Poll Vote'), new Uint8Array([1])]);
  const key0 = baileys.hmacSign(secret, new Uint8Array(32), 'sha256');
  const key = baileys.hmacSign(sign, key0, 'sha256');
  const iv = crypto.randomBytes(12);
  const plain = baileys.proto.Message.PollVoteMessage.encode({ selectedOptions: options.map(optionHash) }).finish();
  return { encPayload: baileys.aesEncryptGCM(plain, key, iv, Buffer.from(`${pollId}\u0000${voterJid}`)), encIv: iv };
}

function setup(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-poll-test-'));
  try {
    const opts = {
      BufferJSON: baileys.BufferJSON,
      aggregatePoll: (message, updates) => baileys.getAggregateVotesInPollMessage({ message, pollUpdates: updates }, ME_PN),
    };
    const store = createStore(dir, opts);
    const secret = crypto.randomBytes(32);
    store.addMessages([{
      key: { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: ALICE_LID, participantAlt: ALICE_PN },
      pushName: 'Alice',
      messageTimestamp: 1000,
      message: {
        pollCreationMessageV3: { name: 'Coming Saturday?', options: [{ optionName: 'Yes' }, { optionName: 'No' }], selectableOptionsCount: 1 },
        messageContextInfo: { messageSecret: secret },
      },
    }]);
    store.upsertContacts([{ id: BOB_PN, notify: 'Bob' }, { id: ALICE_PN, notify: 'Alice' }]);
    return fn({ store, secret, dir, opts });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function voteMessage({ id, secret, creatorJid, voterJid, options, key }) {
  return {
    key: { remoteJid: GROUP, id, fromMe: false, ...key },
    messageTimestamp: 2000,
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: GROUP, id: 'POLL1', fromMe: false, participant: ALICE_LID },
        vote: encryptVote({ secret, pollId: 'POLL1', creatorJid, voterJid, options }),
        senderTimestampMs: 2000000,
      },
    },
  };
}

test('polls: a real encrypted vote is decrypted and tallied', () => setup(({ store, secret }) => {
  const vote = voteMessage({ id: 'V1', secret, creatorJid: ALICE_LID, voterJid: BOB_LID, options: ['Yes'], key: { participant: BOB_LID, participantAlt: BOB_PN } });
  const result = decryptPollVote(baileys, store, vote, [ME_PN, ME_LID]);
  assert.ok(result && result.update, 'decrypted');
  store.applyPollUpdates(result.pollJid, result.pollId, [result.update]);
  const tally = store.pollTally(store.get(GROUP, 'POLL1'));
  assert.equal(tally.question, 'Coming Saturday?');
  assert.deepEqual(tally.options.map((o) => [o.name, o.votes]), [['Yes', 1], ['No', 0]]);
  assert.deepEqual(tally.options[0].voters, ['Bob']);
}));

test('polls: votes encrypted with phone-number JIDs are found too', () => setup(({ store, secret }) => {
  const vote = voteMessage({ id: 'V1', secret, creatorJid: ALICE_PN, voterJid: BOB_PN, options: ['No'], key: { participant: BOB_LID, participantAlt: BOB_PN } });
  const result = decryptPollVote(baileys, store, vote, [ME_PN, ME_LID]);
  assert.ok(result && result.update, 'decrypted');
}));

test('polls: a changed vote replaces the earlier one, and tallies survive a store reload', () => setup(({ store, secret, dir, opts }) => {
  const key = { participant: BOB_LID, participantAlt: BOB_PN };
  for (const [id, options, ms] of [['V1', ['Yes'], 1], ['V2', ['No'], 2]]) {
    const m = voteMessage({ id, secret, creatorJid: ALICE_LID, voterJid: BOB_LID, options, key });
    m.message.pollUpdateMessage.senderTimestampMs = ms;
    const r = decryptPollVote(baileys, store, m, [ME_PN]);
    store.applyPollUpdates(r.pollJid, r.pollId, [r.update]);
  }
  store.flush();
  const reloaded = createStore(dir, opts);
  const tally = reloaded.pollTally(reloaded.get(GROUP, 'POLL1'));
  assert.deepEqual(tally.options.map((o) => [o.name, o.votes]), [['Yes', 0], ['No', 1]]);
}));

test('polls: a vote for a poll that is not stored is reported, not guessed', () => setup(({ store, secret }) => {
  const vote = voteMessage({ id: 'V1', secret, creatorJid: ALICE_LID, voterJid: BOB_LID, options: ['Yes'], key: { participant: BOB_LID } });
  vote.message.pollUpdateMessage.pollCreationMessageKey.id = 'UNKNOWN';
  const result = decryptPollVote(baileys, store, vote, [ME_PN]);
  assert.equal(result.update, undefined);
  assert.equal(result.reason, 'poll_not_stored');
}));

test('polls: a vote that fails to decrypt is reported, not counted', () => setup(({ store }) => {
  const vote = voteMessage({ id: 'V1', secret: crypto.randomBytes(32), creatorJid: ALICE_LID, voterJid: BOB_LID, options: ['Yes'], key: { participant: BOB_LID } });
  const result = decryptPollVote(baileys, store, vote, [ME_PN]);
  assert.equal(result.update, undefined);
  assert.equal(result.reason, 'decrypt_failed');
}));
