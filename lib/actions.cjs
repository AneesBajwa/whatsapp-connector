'use strict';
/**
 * Things the connector sends: messages and reactions. Every send registers
 * its message id first, so the copy WhatsApp echoes back is recognised as
 * the connector's own and never mistaken for a prompt.
 */

/** Send through the session and store the result as sent by the connector. */
async function sendAndStore(rt, jid, content, options = {}) {
  const gen = rt.baileys.generateMessageIDV2;
  const messageId = typeof gen === 'function' ? gen(rt.me()) : undefined;
  if (messageId) rt.store.markOutgoing(messageId);
  const result = await rt.sock.sendMessage(jid, content, { ...options, ...(messageId ? { messageId } : {}) });
  if (result) rt.store.addMessages([result], { sentByConnector: true });
  rt.store.flush();
  return result;
}

/**
 * The key a reaction must carry: the stored message's own key when we have
 * it, else one built from what is known. A group message from someone else
 * needs its sender (participant); returns null when that is unknown.
 */
function reactionKey(store, jid, id, participant) {
  const isGroup = jid.endsWith('@g.us');
  // A 1:1 chat may be stored under its other JID (LID <-> phone number).
  const found = store.findInChat ? store.findInChat(jid, id) : null;
  const entry = found ? found.entry : store.get(jid, id);
  const clean = (k) => {
    const key = { remoteJid: k.remoteJid, id: k.id, fromMe: !!k.fromMe };
    if (k.participant) key.participant = k.participant;
    return key;
  };
  if (participant) return clean({ remoteJid: jid, id, fromMe: false, participant });
  if (entry && entry.raw && entry.raw.key) return clean(entry.raw.key);
  if (entry) {
    return clean({ remoteJid: jid, id, fromMe: entry.fromMe, participant: isGroup && !entry.fromMe ? entry.senderJid : undefined });
  }
  if (isGroup) return null;
  return clean({ remoteJid: jid, id, fromMe: false });
}

/** Download media; lets WhatsApp re-upload media whose link has expired (older than ~2 weeks). */
function downloadMedia(rt, msg) {
  const ctx = rt.sock && typeof rt.sock.updateMediaMessage === 'function'
    ? { reuploadRequest: rt.sock.updateMediaMessage, logger: rt.logger }
    : undefined;
  return rt.baileys.downloadMediaMessage(msg, 'buffer', {}, ctx);
}

/** One reaction per account per message: a new one replaces the previous. */
async function sendReaction(rt, jid, key, emoji) {
  return sendAndStore(rt, jid, { react: { text: emoji, key } });
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function isSingleEmoji(s) {
  if (typeof s !== 'string' || !s || s.length > 32) return false;
  return [...segmenter.segment(s)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}

module.exports = { sendAndStore, reactionKey, sendReaction, isSingleEmoji, downloadMedia };
