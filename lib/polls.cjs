'use strict';
/**
 * Poll votes. Each vote arrives as an encrypted pollUpdateMessage whose key
 * is derived from the poll's messageSecret plus the creator's and voter's
 * JIDs. Baileys 7.0.0-rc14 has its own vote decryption commented out
 * (Utils/process-message.js), so without this every poll would read 0 votes.
 *
 * With LID addressing it is not certain which JID form (LID or phone number)
 * the voter's client used, so every known form is tried; AES-GCM
 * authentication rejects the wrong ones.
 */

const { unwrap, toUnix } = require('./message-store.cjs');

/**
 * Bytes from what the store gives back. A poll saved from a live message was a
 * protobuf object, whose toJSON turns bytes into base64 strings before the
 * store's own Buffer handling sees them: after a reload (a restart, or the
 * chat dropping out of memory) the secret is a base64 string.
 */
function toBytes(v) {
  if (!v) return null;
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (v.type === 'Buffer' && v.data !== undefined) return Buffer.from(v.data, typeof v.data === 'string' ? 'base64' : undefined);
  return Buffer.from(v);
}

function forms(baileys, list) {
  const norm = typeof baileys.jidNormalizedUser === 'function' ? baileys.jidNormalizedUser : (j) => j;
  return [...new Set(list.filter(Boolean).map((j) => norm(j)).filter(Boolean))];
}

/**
 * Returns { pollJid, pollId, update } on success, or { reason } when the
 * vote cannot be counted ('poll_not_stored' | 'poll_deleted' | 'no_secret' | 'decrypt_failed').
 * Returns null for a message that is not a vote.
 */
function decryptPollVote(baileys, store, msg, meIds) {
  const content = unwrap(msg && msg.message);
  const pu = content.pollUpdateMessage;
  if (!pu || !pu.vote || !pu.pollCreationMessageKey) return null;
  const creationKey = pu.pollCreationMessageKey;
  const pollJid = creationKey.remoteJid || msg.key.remoteJid;
  const pollId = creationKey.id;
  const found = store.findInChat ? store.findInChat(pollJid, pollId) : null;
  const poll = found ? found.entry : store.get(pollJid, pollId);
  if (poll && poll.deleted) return { pollJid, pollId, reason: 'poll_deleted' };
  if (!poll || !poll.raw) return { pollJid, pollId, reason: 'poll_not_stored' };
  const secret = toBytes(poll.raw.message && poll.raw.message.messageContextInfo && poll.raw.message.messageContextInfo.messageSecret);
  if (!secret || !secret.length) return { pollJid, pollId, reason: 'no_secret' };

  const creators = forms(baileys, poll.fromMe
    ? meIds
    : [poll.raw.key.participant, poll.raw.key.participantAlt, creationKey.participant, poll.senderJid, poll.senderAltJid]);
  const voters = forms(baileys, msg.key.fromMe
    ? meIds
    : [msg.key.participant, msg.key.participantAlt, msg.key.remoteJid, msg.key.remoteJidAlt]);

  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      try {
        const enc = { encPayload: toBytes(pu.vote.encPayload), encIv: toBytes(pu.vote.encIv) };
        const vote = baileys.decryptPollVote(enc, { pollCreatorJid, pollMsgId: pollId, pollEncKey: secret, voterJid });
        return {
          pollJid,
          pollId,
          update: { pollUpdateMessageKey: msg.key, vote, senderTimestampMs: toUnix(pu.senderTimestampMs) },
        };
      } catch { /* wrong JID form: try the next */ }
    }
  }
  return { pollJid, pollId, reason: 'decrypt_failed' };
}

/**
 * Decrypt and record every vote among `messages`. A vote whose poll is not
 * stored yet is kept (encrypted) in the store's pending list and decrypted
 * when the poll arrives: addMessages hands such votes back as `pendingVotes`.
 */
function applyVoteMessages({ baileys, store, messages, meIds, diag }) {
  for (const msg of messages || []) {
    const r = decryptPollVote(baileys, store, msg, meIds);
    if (!r) continue;
    if (r.update) {
      store.applyPollUpdates(r.pollJid, r.pollId, [r.update]);
      diag.pollVotes = (diag.pollVotes || 0) + 1;
    } else if (r.reason === 'poll_not_stored' && store.addPendingVote && store.addPendingVote(r.pollJid, r.pollId, msg)) {
      diag.pollVotesPending = (diag.pollVotesPending || 0) + 1;
    } else {
      diag.pollVotesNotCounted = diag.pollVotesNotCounted || {};
      diag.pollVotesNotCounted[r.reason] = (diag.pollVotesNotCounted[r.reason] || 0) + 1;
    }
  }
}

module.exports = { decryptPollVote, applyVoteMessages, toBytes };
