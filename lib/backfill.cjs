'use strict';
/**
 * Ask the phone for older messages of one chat (WhatsApp's on-demand history
 * sync). The reply arrives as a history-sync event, maybe after this call
 * returns or even in a later run; the store keeps it either way.
 *
 * Each request names an anchor, the oldest message this device has for the
 * chat, and the phone answers with up to 50 messages before it. Paging stops
 * at the cutoff, once the target message is stored, or when a page brings
 * nothing new.
 *
 * A chat with no stored message has no anchor. Baileys cannot list a chat's
 * messages, or learn its latest message id, from the server: the chat list
 * only arrives through history sync and app-state sync, and neither carries
 * message ids for a chat this device never received. So the first request
 * for an unseen chat is a bootstrap: anchored on "now" with no message id,
 * sent for the chat's JID and then, for a 1:1 chat, its other form (phone
 * number <-> LID), because the phone files the chat under one of them.
 *
 * Whether the phone answers an anchorless request is not documented. When no
 * messages come back, the result's `impossible` says so and why, so a caller
 * can tell "could not check" apart from "no messages". The chat becomes
 * fetchable as soon as any message of it is stored: a late reply to this
 * request, or a new message in the chat, gives the next read an anchor. A
 * failed bootstrap is not retried for BOOTSTRAP_RETRY_MS (per listener run).
 *
 * The outcome is returned, never written to the shared rt.diag: in the
 * listener, reads and the prompt engine's backfills run side by side.
 */

const { isLid, isUserJid, bareJid } = require('./message-store.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_SIZE = 50;
const ALIAS_LOOKUP_MS = 5000;
const BOOTSTRAP_RETRY_MS = 10 * 60000;
const ON_DEMAND = '6'; // proto.HistorySync.HistorySyncType.ON_DEMAND

const errorText = (e) => (e && e.message ? e.message : String(e));
// Per runtime: chats whose bootstrap failed recently -> { at, impossible }.
const failedBootstraps = new WeakMap();

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]);
}

/**
 * The chat's other JID (LID <-> phone number): from the store, else from the
 * session's own mapping (the phone-number lookup may ask the server). Saved
 * in the store so later reads, including --cached ones, merge both.
 */
async function lookupAlias(rt, jid, out = {}) {
  const known = rt.store.alias(jid);
  if (known || !isUserJid(jid)) return known || null;
  const lm = rt.sock && rt.sock.signalRepository && rt.sock.signalRepository.lidMapping;
  const fn = lm && (isLid(jid) ? lm.getPNForLID : lm.getLIDForPN);
  if (typeof fn !== 'function') return null;
  try {
    const alt = await withTimeout(fn.call(lm, jid), ALIAS_LOOKUP_MS);
    if (!alt) return null;
    rt.store.setAlias(jid, bareJid(alt));
    return rt.store.alias(jid);
  } catch (e) {
    out.aliasLookupError = errorText(e);
    return null;
  }
}

/**
 * Resolves true as soon as count() is above `before`, false after `ms`.
 * Checked on each 'history' and 'messages' event (the runtime emits them
 * after the store is updated), so nothing polls.
 */
function waitForMore(rt, count, before, ms) {
  if (count() > before) return Promise.resolve(true);
  const events = rt && rt.events;
  if (!events) return sleep(ms).then(() => count() > before);
  return new Promise((resolve) => {
    let timer = null;
    const check = () => { if (count() > before) done(true); };
    function done(value) {
      clearTimeout(timer);
      events.removeListener('history', check);
      events.removeListener('messages', check);
      resolve(value);
    }
    events.on('history', check);
    events.on('messages', check);
    timer = setTimeout(() => done(count() > before), ms);
  });
}

/** Send one history request; returns its request id (the phone's reply names it). */
async function request(rt, key, timestampMs) {
  rt.diag.backfillRequests = (rt.diag.backfillRequests || 0) + 1;
  // The request field is oldestMsgTimestampMs: milliseconds, not seconds.
  return rt.sock.fetchMessageHistory(PAGE_SIZE, key, timestampMs);
}

const onDemandReplies = (diag) => (diag.historySyncTypes && (diag.historySyncTypes[ON_DEMAND] || diag.historySyncTypes.ON_DEMAND)) || 0;

/** First page for a chat with nothing stored. Returns true once messages arrived. */
async function bootstrap(rt, jid, { pageWaitMs }, out) {
  const { store, diag } = rt;
  if (!rt.sock || typeof rt.sock.fetchMessageHistory !== 'function') {
    out.impossible = { reason: 'not_connected', detail: 'no open session to ask the phone for history' };
    return false;
  }
  const alt = await lookupAlias(rt, jid, out);
  const candidates = [jid, alt].filter(Boolean);
  const tried = [];
  const requestIds = [];
  const repliesBefore = onDemandReplies(diag);
  // Chats that history replies brought while we waited, in case the phone
  // filed this chat under a JID we could not map.
  const otherChats = new Set();
  const onHistory = (messages) => {
    for (const m of messages || []) {
      const j = m && m.key && m.key.remoteJid;
      if (j && !candidates.includes(j)) otherChats.add(j);
    }
  };
  if (rt.events) rt.events.on('history', onHistory);
  try {
    for (const chatJid of candidates) {
      tried.push(chatJid);
      try {
        // No anchor message: ask for the messages before "now".
        const id = await request(rt, { remoteJid: chatJid, fromMe: false }, Date.now());
        if (id) requestIds.push(id);
      } catch (e) {
        out.error = errorText(e);
        out.impossible = { reason: 'request_failed', detail: out.error, triedJids: tried };
        return false;
      }
      if (await waitForMore(rt, () => store.chatMessages(jid).length, 0, pageWaitMs)) {
        out.bootstrap = { anchoredOn: 'now', chatJid, triedJids: tried };
        return true;
      }
    }
  } finally {
    if (rt.events) rt.events.removeListener('history', onHistory);
  }
  // Prefer the phone's own word: a reply that names one of our request ids.
  // Without one, fall back to "some on-demand history arrived meanwhile".
  // (Whether the phone's reply carries our request id is not documented.)
  const replies = requestIds
    .map((id) => (typeof rt.peerReply === 'function' ? rt.peerReply(id) : null))
    .filter(Boolean);
  const answered = replies.length > 0 || onDemandReplies(diag) > repliesBefore;
  out.impossible = {
    reason: answered ? 'phone_sent_no_messages' : 'no_reply',
    detail: answered
      ? 'no message of this chat is stored, so the request had no anchor; the phone answered without any messages for it. Either the chat has no history on the phone, or the phone does not serve requests without an anchor. Treat the result as unchecked, not as "no messages".'
      : `no message of this chat is stored, so the request had no anchor, and the phone sent nothing back within ${Math.round(pageWaitMs / 1000)}s per try. The chat's history cannot be pulled until one of its messages is stored (a late reply to this request, or any new message in the chat). Treat the result as unchecked, not as "no messages".`,
    triedJids: tried,
    requestIds,
    phoneReplies: replies.map((r) => ({ history: !!r.history, messages: r.messages || 0, response: !!r.response })),
    ...(otherChats.size ? { replyChats: [...otherChats] } : {}),
  };
  return false;
}

/**
 * Returns { added, impossible?, bootstrap?, error?, aliasLookupError? }.
 * `impossible` is set when the chat has nothing stored and no history could
 * be pulled; the caller must report that, not "no messages".
 */
async function backfill(rt, jid, { cutoffUnix = 0, targetId = null, maxPages = 5, pageWaitMs = 15000 } = {}) {
  const { store } = rt;
  const out = {};
  const count = () => store.chatMessages(jid).length;
  const hasTarget = () => targetId && store.findInChat(jid, targetId);
  const startCount = count();
  let pages = maxPages;
  if (startCount === 0) {
    const failures = failedBootstraps.get(rt) || new Map();
    failedBootstraps.set(rt, failures);
    const last = failures.get(jid);
    if (last && Date.now() - last.at < BOOTSTRAP_RETRY_MS) {
      // Asked recently and got nothing: do not ask the phone again yet.
      return { added: 0, impossible: { ...last.impossible, retryAfterS: Math.ceil((last.at + BOOTSTRAP_RETRY_MS - Date.now()) / 1000) } };
    }
    if (!(await bootstrap(rt, jid, { pageWaitMs }, out))) {
      if (out.impossible && out.impossible.reason !== 'not_connected') failures.set(jid, { at: Date.now(), impossible: out.impossible });
      return { added: 0, ...out };
    }
    failures.delete(jid);
    pages--;
  } else if (isUserJid(jid)) {
    await lookupAlias(rt, jid, out); // so a 1:1 chat filed under both JIDs reads as one
  }
  for (let page = 0; page < pages; page++) {
    if (hasTarget()) break;
    const list = store.chatMessages(jid);
    const oldest = list[0];
    if (!oldest || oldest.timestampUnix <= cutoffUnix) break;
    const before = list.length;
    try {
      await request(rt, { remoteJid: oldest.chatJid || jid, id: oldest.id, fromMe: oldest.fromMe }, oldest.timestampUnix * 1000);
    } catch (e) {
      out.error = errorText(e);
      break;
    }
    if (!(await waitForMore(rt, count, before, pageWaitMs))) break;
  }
  return { added: count() - startCount, ...out };
}

module.exports = { backfill, lookupAlias, BOOTSTRAP_RETRY_MS };
