'use strict';
/**
 * Things the connector sends: messages and reactions. Every send registers
 * its message id first, so the copy WhatsApp echoes back is recognised as
 * the connector's own and never mistaken for a prompt.
 */

const SERVER_ACK_TIMEOUT_MS = 20000;

// What the server's error acks mean (codes as the library names them).
const ACK_ERRORS = {
  463: 'no privacy token for this 1:1 chat (WhatsApp refuses it from this linked device; a message from the phone in that chat, or a retry later, may clear it)',
  479: 'stanza rejected (stale device session or bad addressing)',
};

/**
 * Wait for the server's ack of message `id`. The library writes the message
 * to the socket and returns without waiting, and reports a rejection only as
 * a messages.update with status ERROR, so a refused 1:1 message would
 * otherwise look sent. Listen before sending: the ack can come back at once.
 * Returns null when the socket offers no frame events (nothing to wait on).
 */
function serverAck(rt, id, timeoutMs = SERVER_ACK_TIMEOUT_MS) {
  const ws = rt.sock && rt.sock.ws;
  if (!id || !ws || typeof ws.on !== 'function') return null;
  let onAck;
  let timer;
  const promise = new Promise((resolve) => {
    onAck = (node) => {
      const a = (node && node.attrs) || {};
      if (a.id !== id) return;
      resolve(a.error ? { error: String(a.error) } : { ok: true });
    };
    ws.on('CB:ack,class:message', onAck);
    timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  });
  const cancel = () => {
    clearTimeout(timer);
    (ws.off || ws.removeListener).call(ws, 'CB:ack,class:message', onAck);
  };
  return { promise: promise.finally(cancel), cancel };
}

/**
 * Send through the session and store the result as sent by the connector.
 * With { confirm: true } it also waits for WhatsApp's ack and throws when the
 * server rejects the message or never confirms it; a rejected message is not
 * stored as sent by the connector.
 */
async function sendAndStore(rt, jid, content, options = {}) {
  const { confirm = false, ...sendOptions } = options;
  const gen = rt.baileys.generateMessageIDV2;
  const messageId = typeof gen === 'function' ? gen(rt.me()) : undefined;
  if (messageId) rt.store.markOutgoing(messageId);
  const ack = confirm ? serverAck(rt, messageId) : null;
  let result;
  try {
    result = await rt.sock.sendMessage(jid, content, { ...sendOptions, ...(messageId ? { messageId } : {}) });
  } catch (e) {
    if (ack) ack.cancel();
    throw e;
  }
  const outcome = ack ? await ack.promise : { ok: true };
  if (outcome.error) {
    if (messageId) rt.store.markSendFailed(jid, messageId, outcome.error);
    rt.store.flush();
    const why = ACK_ERRORS[outcome.error] ? `: ${ACK_ERRORS[outcome.error]}` : '';
    const err = new Error(`WhatsApp rejected message ${messageId} to ${jid} (error ${outcome.error}${why}); it was not delivered`);
    err.code = 'SEND_REJECTED';
    throw err;
  }
  if (result) rt.store.addMessages([result], { sentByConnector: true });
  rt.store.flush();
  if (outcome.timeout) {
    const err = new Error(`message ${messageId} to ${jid} was written but WhatsApp did not acknowledge it within ${SERVER_ACK_TIMEOUT_MS / 1000}s; check the phone before sending it again`);
    err.code = 'SEND_UNCONFIRMED';
    throw err;
  }
  return result;
}

/**
 * The JID a `send` goes to, or { error }. A phone number must include its
 * country code: 6477733430 is +64 777 33430 in New Zealand, not +1 647-773-3430.
 * Bare digits (spaces, dashes, a leading + allowed) become
 * <digits>@s.whatsapp.net. A phone-number JID is refused when the store knows
 * the same number with a leading 1 but not the number as given (a dropped
 * North American country code), and when WhatsApp reports no account for
 * it. Groups and LIDs pass through unchanged.
 */
async function resolveRecipient(rt, input) {
  let jid = String(input || '').trim();
  if (/^\+?[\d\s().-]+$/.test(jid)) jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  if (!jid.endsWith('@s.whatsapp.net')) return { jid };
  const digits = jid.split('@')[0].split(':')[0];
  if (!/^\d{6,15}$/.test(digits)) return { error: `send: ${input} is not a valid phone number` };
  const { store } = rt;
  // Known from the phone (a LID pair or a contact name); a chat entry alone
  // does not count, since a send to a wrong number creates one.
  const known = (j) => !!(store.alias(j) || store.contactName(j));
  const withOne = `1${digits}@s.whatsapp.net`;
  if (digits.length === 10 && !known(jid) && known(withOne)) {
    return { error: `send: ${digits} has no country code; WhatsApp would read it as +${digits}, another country. The known contact is 1${digits} (${store.contactName(withOne) || store.alias(withOne)}): send to --jid 1${digits}` };
  }
  if (rt.sock && typeof rt.sock.onWhatsApp === 'function') {
    let found;
    try {
      found = await rt.sock.onWhatsApp(jid);
    } catch (e) {
      if (known(jid)) return { jid };
      return { error: `send: could not check that +${digits} is on WhatsApp (${e && e.message ? e.message : e}); not sending to an unverified number` };
    }
    if (!(found || []).some((r) => r && r.exists)) {
      return { error: `send: +${digits} has no WhatsApp account; check the number and include its country code (e.g. 1 for Canada/US)` };
    }
  }
  return { jid };
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

module.exports = { sendAndStore, resolveRecipient, reactionKey, sendReaction, isSingleEmoji, downloadMedia, SERVER_ACK_TIMEOUT_MS };
