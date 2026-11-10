'use strict';
/**
 * Local message store.
 *
 * WhatsApp delivers each message to this linked device once. History sync
 * only arrives on the device's first connections after linking (Baileys skips
 * it once creds.accountSyncCounter > 0), and later messages arrive as live or
 * offline deliveries that the server forgets once this device has sent its
 * receipt, which Baileys does before handing the message to us. Anything a
 * process receives and does not save is gone, so every connected run saves
 * what it receives here and reads are served from here.
 *
 * Holds message text and media keys: as private as auth/ (directory 700,
 * files 600), never logged. One writer at a time (the session lock); readers
 * see whole files because every write is a rename.
 */

const fs = require('fs');
const path = require('path');

const MAX_MESSAGES_PER_CHAT = 5000;
// Reactions and votes waiting for a message that is not stored yet.
const MAX_PENDING = 5000;
// WAMessageStubType: deleted for everyone, by the sender (REVOKE) or by a
// group admin (ADMIN_REVOKE).
const REVOKE_STUB = 1;
const ADMIN_REVOKE_STUB = 132;
const DELETED_STUBS = new Set([REVOKE_STUB, ADMIN_REVOKE_STUB]);
// ProtocolMessage.Type, as numbers or (from JSON) names.
const PROTO_REVOKE = new Set([0, 'REVOKE']);
const PROTO_EDIT = new Set([14, 'MESSAGE_EDIT']);
// Chats kept in memory at once; the rest stay on disk until needed.
const MAX_LOADED_CHATS = 40;
const SKIP_CHATS = new Set(['status@broadcast']);
// Content keys that ride along with the real content and never are it.
const WRAPPER_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
// Message types that are events about other messages, not messages to show.
const EVENT_TYPES = new Set(['protocolMessage', 'reactionMessage', 'pollUpdateMessage', 'encReactionMessage', 'keepInChatMessage']);
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];
const POLL_TYPES = ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3'];

/** Unix seconds from a number, numeric string, Long, or a JSON-serialized Long. */
function toUnix(ts) {
  if (ts && typeof ts === 'object') {
    if (typeof ts.toNumber === 'function') return ts.toNumber();
    if ('low' in ts) return (ts.low >>> 0) + (ts.high || 0) * 2 ** 32;
  }
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
}

function toISO(unix) {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

/** The inner content, unwrapped from ephemeral / view-once / edited containers. */
function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 5; i++) {
    const inner = (m.ephemeralMessage && m.ephemeralMessage.message)
      || (m.viewOnceMessage && m.viewOnceMessage.message)
      || (m.viewOnceMessageV2 && m.viewOnceMessageV2.message)
      || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message)
      || (m.editedMessage && m.editedMessage.message);
    if (!inner) break;
    m = inner;
  }
  return m;
}

function contentType(message) {
  return Object.keys(unwrap(message)).find((k) => !WRAPPER_KEYS.has(k)) || null;
}

function messageText(msg) {
  const m = unwrap(msg && msg.message);
  if (typeof m.conversation === 'string' && m.conversation) return m.conversation;
  if (m.extendedTextMessage && m.extendedTextMessage.text) return m.extendedTextMessage.text;
  for (const k of ['imageMessage', 'videoMessage', 'documentMessage']) {
    if (m[k] && m[k].caption) return m[k].caption;
  }
  const poll = POLL_TYPES.map((k) => m[k]).find(Boolean);
  if (poll && poll.name) return `[poll] ${poll.name}`;
  const type = contentType(msg && msg.message);
  return type ? `[media: ${type}]` : '[empty message]';
}

function contextInfo(message) {
  const m = unwrap(message);
  const type = contentType(message);
  return (type && m[type] && m[type].contextInfo) || null;
}

function hasMedia(message) {
  const m = unwrap(message);
  return MEDIA_TYPES.some((k) => m[k]);
}

function isPoll(message) {
  const m = unwrap(message);
  return POLL_TYPES.some((k) => m[k]);
}

/**
 * A poll vote as plain data. Decrypted votes and history-sync votes are
 * protobuf objects whose toJSON turns the option hashes into base64 strings,
 * which would no longer match the options after a save and reload.
 */
function plainPollUpdate(u) {
  const k = u.pollUpdateMessageKey || {};
  const opts = (u.vote && u.vote.selectedOptions) || [];
  return {
    pollUpdateMessageKey: {
      remoteJid: k.remoteJid, id: k.id, fromMe: !!k.fromMe,
      ...(k.participant ? { participant: k.participant } : {}),
      ...(k.participantAlt ? { participantAlt: k.participantAlt } : {}),
    },
    vote: { selectedOptions: opts.map((o) => Buffer.from(o)) },
    senderTimestampMs: toUnix(u.senderTimestampMs),
  };
}

const isLid = (jid) => typeof jid === 'string' && /@(hosted\.)?lid$/.test(jid);
const isUserJid = (jid) => typeof jid === 'string' && /@(s\.whatsapp\.net|hosted|lid|hosted\.lid)$/.test(jid);
/** A user JID without its device part (123:4@lid -> 123@lid). */
const bareJid = (jid) => (typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : jid);

/**
 * A reaction as plain data. History sync delivers them on the message
 * (WebMessageInfo.reactions); live ones come as reaction events. `key` is the
 * reaction message's own key, so its participant (or, in a 1:1 chat, its
 * remoteJid) is the person who reacted. Empty text means the reaction was removed.
 */
function plainReaction(r) {
  const k = (r && r.key) || {};
  return {
    key: {
      remoteJid: k.remoteJid, id: k.id, fromMe: !!k.fromMe,
      ...(k.participant ? { participant: k.participant } : {}),
      ...(k.participantAlt ? { participantAlt: k.participantAlt } : {}),
    },
    text: (r && r.text) || '',
    senderTimestampMs: toUnix(r && r.senderTimestampMs),
  };
}

/**
 * Merge reactions, one per person: the later one wins (on a tie, the one
 * from `incoming`). Removals are kept as empty-text entries so an older
 * reaction cannot come back. Returns { list, changed }.
 */
function mergeReactions(base, incoming, author) {
  const byAuthor = new Map();
  for (const r of base || []) byAuthor.set(author(r), r);
  let changed = false;
  for (const raw of incoming || []) {
    const r = plainReaction(raw);
    const a = author(r);
    const prev = byAuthor.get(a);
    if (prev && Number(prev.senderTimestampMs || 0) > Number(r.senderTimestampMs || 0)) continue;
    if (prev && prev.text === r.text && Number(prev.senderTimestampMs || 0) === Number(r.senderTimestampMs || 0)) continue;
    byAuthor.set(a, r);
    changed = true;
  }
  return { list: [...byAuthor.values()], changed };
}

/**
 * An encrypted poll vote as plain data, so it survives a save and reload
 * (the protobuf toJSON would turn its bytes into base64 strings).
 */
function plainVoteMessage(msg) {
  const k = msg.key || {};
  const pu = unwrap(msg.message).pollUpdateMessage || {};
  const ck = pu.pollCreationMessageKey || {};
  const pick = (o, names) => Object.fromEntries(names.filter((n) => o[n] !== undefined && o[n] !== null).map((n) => [n, o[n]]));
  return {
    key: { ...pick(k, ['remoteJid', 'id', 'participant', 'participantAlt', 'remoteJidAlt']), fromMe: !!k.fromMe },
    messageTimestamp: toUnix(msg.messageTimestamp),
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: { ...pick(ck, ['remoteJid', 'id', 'participant']), fromMe: !!ck.fromMe },
        vote: { encPayload: Buffer.from(pu.vote.encPayload), encIv: Buffer.from(pu.vote.encIv) },
        senderTimestampMs: toUnix(pu.senderTimestampMs),
      },
    },
  };
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
}

function readJson(file, fallback, reviver) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'), reviver);
  } catch {
    return fallback;
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createStore(dir, {
  BufferJSON, readOnly = false, aggregatePoll = null, meJid = () => null, meLid = () => null, maxLoadedChats = MAX_LOADED_CHATS,
} = {}) {
  const replacer = BufferJSON && BufferJSON.replacer;
  const reviver = BufferJSON && BufferJSON.reviver;
  const messagesDir = path.join(dir, 'messages');
  const chatsFile = path.join(dir, 'chats.json');
  const contactsFile = path.join(dir, 'contacts.json');
  const aliasesFile = path.join(dir, 'aliases.json');

  const chats = readJson(chatsFile, {});
  const contacts = readJson(contactsFile, {});
  // A person's two JIDs: phone number <-> LID, both directions. WhatsApp
  // may file the same 1:1 chat or sender under either form.
  const aliases = readJson(aliasesFile, {});
  // Reactions and poll votes whose message is not stored yet, applied when it
  // arrives: "<chat>|<id>" -> { jid, id, at, reactions, pollUpdates, votes }.
  const pendingFile = path.join(dir, 'pending.json');
  const pending = readJson(pendingFile, {}, reviver);
  let pendingDirty = false;
  const loaded = new Map(); // jid -> Map(id -> stored message), least recently used first
  const sortedCache = new Map(); // jid -> messages in time order, until the chat changes
  const dirty = new Set();
  const outgoing = new Set(); // ids this process is about to send
  let chatsDirty = false;
  let contactsDirty = false;
  let aliasesDirty = false;

  const chatFile = (jid) => path.join(messagesDir, `${encodeURIComponent(jid)}.json`);

  function load(jid) {
    let map = loaded.get(jid);
    if (map) {
      loaded.delete(jid); // move to most recently used
    } else {
      map = new Map(readJson(chatFile(jid), [], reviver).map((m) => [m.id, m]));
    }
    loaded.set(jid, map);
    evict(jid);
    return map;
  }

  /**
   * Drop least recently used chats from memory: never one with unsaved
   * changes, and never `keep` (the chat a caller is about to change).
   */
  function evict(keep = null) {
    if (loaded.size <= maxLoadedChats) return;
    for (const jid of loaded.keys()) {
      if (loaded.size <= maxLoadedChats) break;
      if (jid === keep || dirty.has(jid)) continue;
      loaded.delete(jid);
      sortedCache.delete(jid);
    }
  }

  function changed(jid) {
    dirty.add(jid);
    sortedCache.delete(jid);
  }

  function touchChat(jid, unix) {
    const c = chats[jid] || (chats[jid] = { jid, name: null, isGroup: jid.endsWith('@g.us') });
    if (unix && (!c.lastMessageAt || unix > c.lastMessageAt)) c.lastMessageAt = unix;
    chatsDirty = true;
  }

  function setContact(jid, name) {
    if (!jid || !name || contacts[jid] === name) return;
    contacts[jid] = name;
    contactsDirty = true;
  }

  /**
   * Record that two JIDs are the same person: one phone-number JID, one LID.
   * The account's own JIDs pair only with each other: a wrong pair there would
   * merge the owner's chats with someone else's. A new pair replaces any older
   * pair of either JID, so a stale reverse entry never lingers.
   */
  function setAlias(a, b) {
    a = bareJid(a);
    b = bareJid(b);
    if (!isUserJid(a) || !isUserJid(b) || a === b || isLid(a) === isLid(b)) return;
    const mine = [meJid(), meLid()].filter(Boolean).map(bareJid);
    if (mine.includes(a) !== mine.includes(b)) return;
    if (aliases[a] === b && aliases[b] === a) return;
    for (const j of [a, b]) {
      const old = aliases[j];
      if (old && aliases[old] === j) delete aliases[old];
    }
    aliases[a] = b;
    aliases[b] = a;
    aliasesDirty = true;
  }

  /** The other JID of the same person (LID <-> phone number), or null. */
  function alias(jid) {
    return (jid && aliases[bareJid(jid)]) || null;
  }

  function noteKeyAliases(key) {
    // On the owner's own messages the "alt" JID can be the owner's, not the
    // chat's (Baileys takes the sender's alt first): never learn from those.
    if (!key || key.fromMe) return;
    if (!String(key.remoteJid || '').endsWith('@g.us')) setAlias(key.remoteJid, key.remoteJidAlt);
    setAlias(key.participant, key.participantAlt);
  }

  /** One identity per person for reactions, preferring the LID form. */
  function reactionAuthor(r) {
    const k = (r && r.key) || {};
    if (k.fromMe) return 'me';
    const ids = [k.participant, k.participantAlt].filter(Boolean).map(bareJid);
    const who = ids.length ? ids : [bareJid(k.remoteJid)].filter(Boolean);
    return who.find(isLid) || who.map(alias).find(isLid) || who[0] || 'unknown';
  }

  const pendingKey = (jid, id) => `${bareJid(jid)}|${id}`;

  /** The pending record for a message, created on first use. Bounded: the oldest go first. */
  function pendingFor(jid, id) {
    if (SKIP_CHATS.has(jid)) return { reactions: [], pollUpdates: [], votes: [] }; // never stored: never applied
    const k = pendingKey(jid, id);
    if (!pending[k]) {
      const keys = Object.keys(pending);
      if (keys.length >= MAX_PENDING) {
        keys.sort((a, b) => (pending[a].at || 0) - (pending[b].at || 0));
        for (const old of keys.slice(0, keys.length - MAX_PENDING + 1)) delete pending[old];
      }
      pending[k] = { jid: bareJid(jid), id, at: Math.floor(Date.now() / 1000) };
    }
    pendingDirty = true;
    return pending[k];
  }

  /** Remove and return what was waiting for this message (under its chat or the chat's alias). */
  function takePending(jid, id) {
    let found = null;
    for (const j of [jid, alias(jid)].filter(Boolean)) {
      const k = pendingKey(j, id);
      const p = pending[k];
      if (!p) continue;
      delete pending[k];
      pendingDirty = true;
      found = found
        ? {
          reactions: [...(found.reactions || []), ...(p.reactions || [])],
          pollUpdates: [...(found.pollUpdates || []), ...(p.pollUpdates || [])],
          votes: [...(found.votes || []), ...(p.votes || [])],
        }
        : p;
    }
    return found;
  }

  /** Keep an encrypted vote whose poll is not stored yet; it is decrypted when the poll arrives. */
  function addPendingVote(jid, id, msg) {
    if (!jid || !id || !msg || !msg.key || SKIP_CHATS.has(jid)) return false;
    let vote;
    try { vote = plainVoteMessage(msg); } catch { return false; }
    const p = pendingFor(jid, id);
    p.votes = (p.votes || []).filter((v) => v.key.id !== vote.key.id);
    p.votes.push(vote);
    return true;
  }

  function pendingCount() {
    return Object.keys(pending).length;
  }

  function normalize(msg) {
    const key = msg.key;
    const unix = toUnix(msg.messageTimestamp);
    const type = contentType(msg.message);
    const ctx = contextInfo(msg.message);
    const quotedType = ctx && ctx.quotedMessage ? contentType(ctx.quotedMessage) : null;
    const keepRaw = hasMedia(msg.message) || isPoll(msg.message) || !!key.fromMe
      || (ctx && ctx.quotedMessage && hasMedia(ctx.quotedMessage));
    const entry = {
      id: key.id,
      chatJid: key.remoteJid,
      timestamp: toISO(unix),
      timestampUnix: unix,
      senderJid: key.participant || key.remoteJid || null,
      senderAltJid: key.participantAlt || key.remoteJidAlt || undefined,
      senderName: msg.pushName || null,
      fromMe: !!key.fromMe,
      type,
      text: messageText(msg),
    };
    if (ctx && ctx.stanzaId) {
      entry.quoted = {
        id: ctx.stanzaId,
        senderJid: ctx.participant || null,
        text: ctx.quotedMessage ? messageText({ message: ctx.quotedMessage }) : null,
        type: quotedType,
      };
    }
    if (ctx && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) entry.mentions = ctx.mentionedJid;
    // History sync delivers polls with their votes already decrypted.
    if (Array.isArray(msg.pollUpdates) && msg.pollUpdates.length) entry.pollUpdates = msg.pollUpdates.map(plainPollUpdate);
    // History sync (and the library's event buffer) put reactions on the
    // message itself. Kept as plain data whether or not raw is kept.
    if (Array.isArray(msg.reactions) && msg.reactions.length) {
      entry.reactions = mergeReactions([], msg.reactions, reactionAuthor).list;
    }
    // A copy that already carries an edit (history sync, or the library
    // folding an edit into a message it was still holding back).
    if (msg.message && msg.message.editedMessage) entry.edited = true;
    // A message deleted for everyone arrives as a stub with no content.
    if (DELETED_STUBS.has(Number(msg.messageStubType)) && !msg.message) {
      entry.deleted = true;
      entry.text = '[deleted]';
      if (msg.deletedByOther) entry.deletedBy = msg.deletedByOther;
      return entry;
    }
    if (msg.editRejected) {
      entry.edited = false;
      entry.editRejected = true;
    }
    if (keepRaw) entry.raw = msg;
    return entry;
  }

  /**
   * Save received messages. Returns { added, updated }. Placeholders (no
   * decrypted content yet) are replaced when the real message arrives.
   */
  function addMessages(list, { sentByConnector = false } = {}) {
    let added = 0;
    let updated = 0;
    // Encrypted votes that were waiting for a poll in this batch; the caller
    // decrypts them (it holds the session's identities).
    const pendingVotes = [];
    const pollUpdatesDue = [];
    // Merged deletes by someone other than the sender, of a message stored
    // here with its content: the caller checks them like a live delete
    // (sender, or group admin) before anything is wiped.
    const unverifiedDeletes = [];
    const folded = foldedChanges(list);
    const arrived = (jid, entry) => {
      const p = takePending(jid, entry.id);
      if (!p) return;
      if (p.reactions && p.reactions.length) {
        entry.reactions = mergeReactions(entry.reactions, p.reactions, reactionAuthor).list;
      }
      if (p.pollUpdates && p.pollUpdates.length) pollUpdatesDue.push([jid, entry.id, p.pollUpdates]);
      if (p.votes && p.votes.length) pendingVotes.push(...p.votes);
    };
    for (let msg of list || []) {
      let key = msg && msg.key;
      if (!key || !key.remoteJid || !key.id || SKIP_CHATS.has(key.remoteJid)) continue;
      noteKeyAliases(key);
      const repaired = repairFolded(msg, folded);
      if (repaired === null) continue;
      msg = repaired;
      key = msg.key;
      const type = contentType(msg.message);
      if (msg.message && !type) continue; // only wrapper keys: nothing to show
      if (type && EVENT_TYPES.has(type)) continue;
      const entry = normalize(msg);
      if (sentByConnector || outgoing.has(entry.id)) entry.sentByConnector = true;
      const map = load(key.remoteJid);
      const prev = map.get(entry.id);
      if (!prev) {
        map.set(entry.id, entry);
        arrived(key.remoteJid, entry);
        added++;
      } else if (!prev.type && entry.type) {
        const next = {
          ...entry,
          // An edit that arrived before the message itself (onto the
          // placeholder of a message that failed to decrypt) still applies.
          ...(prev.edited && !entry.edited ? { text: prev.text, edited: true, editedAt: prev.editedAt } : {}),
          sentByConnector: prev.sentByConnector || entry.sentByConnector,
          pollUpdates: prev.pollUpdates || entry.pollUpdates,
          reactions: prev.reactions ? mergeReactions(prev.reactions, entry.reactions, reactionAuthor).list : entry.reactions,
        };
        map.set(entry.id, next);
        arrived(key.remoteJid, next);
        updated++;
      } else {
        // Already stored: a later copy (history sync, a re-delivery) can still
        // carry new information.
        let touched = false;
        if (entry.sentByConnector && !prev.sentByConnector) {
          prev.sentByConnector = true;
          touched = true;
        }
        if (entry.deleted && !prev.deleted) {
          const revoke = msg.revokeInfo;
          if (revoke && !fromSender(prev, revoke.by)) {
            unverifiedDeletes.push({ jid: key.remoteJid, id: entry.id, by: revoke.by });
          } else {
            Object.assign(prev, { deleted: true, deletedAt: new Date().toISOString(), text: '[deleted]' });
            if (entry.deletedBy) prev.deletedBy = entry.deletedBy;
            delete prev.raw;
            delete prev.pollUpdates;
            delete prev.mentions;
            touched = true;
          }
        }
        if (entry.reactions) {
          const merged = mergeReactions(prev.reactions, entry.reactions, reactionAuthor);
          if (merged.changed) {
            prev.reactions = merged.list;
            touched = true;
          }
        }
        if (!touched) continue;
        updated++;
      }
      if (!entry.fromMe) {
        setContact(entry.senderJid, entry.senderName);
        setContact(entry.senderAltJid, entry.senderName);
      }
      touchChat(key.remoteJid, entry.timestampUnix);
      changed(key.remoteJid);
    }
    for (const [jid, id, updates] of pollUpdatesDue) applyPollUpdates(jid, id, updates);
    reconcileStrays(folded, unverifiedDeletes);
    return { added, updated, pendingVotes, unverifiedDeletes };
  }

  /**
   * One rule for a delete message (key `by`, the deleter) naming `target`
   * (a key from the deleter's side: fromMe there means their own message).
   * Returns the target's sender and, when it is not the deleter, who deleted it.
   */
  function deleteParties(by, target) {
    if (target.fromMe) return { sender: { fromMe: !!by.fromMe, participant: by.participant }, deletedBy: null };
    return {
      sender: { fromMe: false, participant: target.participant },
      deletedBy: by.fromMe ? 'me' : (by.participant || by.remoteJid || null),
    };
  }

  /**
   * The same folding, when the folded target and the edit/delete message came
   * in different events of one flush (e.g. the target in a history set): fix
   * what an earlier call stored.
   */
  function reconcileStrays({ revokes, edits }, unverifiedDeletes = []) {
    for (const [ownId, { by, target }] of revokes) {
      if (!target || target.id === ownId) continue;
      // The chat as this device files it: the delete message's own key. The
      // key inside the delete is from the deleter's side (in a 1:1 chat it
      // names the owner's JID).
      const chat = by.remoteJid || target.remoteJid;
      if (!chat) continue;
      const map = load(chat);
      const stray = map.get(ownId);
      if (!stray || !stray.deleted || stray.type) continue;
      map.delete(ownId); // the folded copy under the delete's own id: never a real message
      changed(chat);
      const existing = map.get(target.id);
      if (existing && !existing.deleted) {
        // A real copy is stored: wipe it only after the same check as a live delete.
        if (!fromSender(existing, by)) {
          unverifiedDeletes.push({ jid: chat, id: target.id, by });
          continue;
        }
      }
      const { sender, deletedBy } = deleteParties(by, target);
      const entry = existing || {
        id: target.id, chatJid: chat, timestamp: stray.timestamp, timestampUnix: stray.timestampUnix,
        senderJid: sender.fromMe ? null : (sender.participant || chat), senderName: null, fromMe: !!sender.fromMe, type: null,
      };
      Object.assign(entry, { deleted: true, deletedAt: new Date().toISOString(), text: '[deleted]' });
      delete entry.raw;
      if (deletedBy) entry.deletedBy = deletedBy;
      map.set(target.id, entry);
    }
    for (const [k, { editor, text }] of edits) {
      const [chat, id] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const found = findInChat(chat, id);
      // Only a target that took on this very edit's text was folded; a
      // rejected live edit never changed the stored text.
      if (!found || !found.entry.edited || found.entry.text !== text || fromSender(found.entry, editor)) continue;
      Object.assign(found.entry, { edited: false, editRejected: true, text: '[original text unavailable: replaced by an edit from someone other than the sender]' });
      delete found.entry.raw;
      changed(found.jid);
    }
  }

  /**
   * Edits and deletes among a batch of upserts. While the library holds back
   * events (each reconnect's offline batch, history sync), it applies an edit
   * or delete straight onto the target message it is holding
   * (Object.assign(target, update) in Baileys' event buffer):
   *   delete: the target's key becomes the delete message's own key (wrong
   *           id, sender = the deleter) and its content is dropped;
   *   edit:   the target's content and timestamp become the edit's.
   * The edit/delete protocol messages come in the same batch, so they tell us
   * the real target and who made the change.
   */
  function foldedChanges(list) {
    const revokes = new Map(); // the delete message's own id -> { by, target }
    const edits = new Map(); // "<chat>|<target id>" -> { editor: the editor's key, text: the edited text }
    for (const m of list || []) {
      const pm = m && m.message && unwrap(m.message).protocolMessage;
      if (!pm || !pm.key || !pm.key.id || !m.key) continue;
      if (PROTO_REVOKE.has(pm.type) || (pm.type === undefined && !pm.editedMessage)) revokes.set(m.key.id, { by: m.key, target: pm.key });
      else if (PROTO_EDIT.has(pm.type)) {
        edits.set(`${m.key.remoteJid}|${pm.key.id}`, { editor: m.key, text: pm.editedMessage ? messageText({ message: pm.editedMessage }) : null });
      }
    }
    return { revokes, edits };
  }

  /**
   * Undo the library's folding for one message. Returns the message to store,
   * or null to skip it. A change from someone other than the sender cannot be
   * undone (the library already dropped the original content), so it is
   * stored as such rather than as if the sender had made it.
   */
  function repairFolded(msg, { revokes, edits }) {
    const key = msg.key;
    if (!msg.message && DELETED_STUBS.has(Number(msg.messageStubType)) && revokes.has(key.id)) {
      const { by, target } = revokes.get(key.id);
      if (target.id === key.id) return msg; // the delete message itself: not a folded target
      const { sender, deletedBy } = deleteParties(by, target);
      const fixed = {
        ...msg,
        key: { remoteJid: key.remoteJid, id: target.id, fromMe: !!sender.fromMe, ...(sender.participant ? { participant: sender.participant } : {}) },
        revokeInfo: { by },
      };
      if (deletedBy) fixed.deletedByOther = deletedBy;
      return fixed;
    }
    const top = msg.message || {};
    if (top.editedMessage) {
      const edit = edits.get(`${key.remoteJid}|${key.id}`);
      const editor = edit && edit.editor;
      if (editor && !fromSender({ fromMe: !!key.fromMe, chatJid: key.remoteJid, senderJid: key.participant || key.remoteJid, senderAltJid: key.participantAlt || key.remoteJidAlt }, editor)) {
        // An edit from someone else: clients ignore it, but the library has
        // already replaced the original text.
        return { ...msg, message: { conversation: '[original text unavailable: replaced by an edit from someone other than the sender]' }, editRejected: true };
      }
    }
    return msg;
  }

  /** Register an id before sending so its echo is recognised as ours. */
  function markOutgoing(id) {
    outgoing.add(id);
  }

  /**
   * A send WhatsApp refused: the library's local copy stays, but no longer
   * counts as sent by the connector, and carries the server's error code.
   */
  function markSendFailed(jid, id, error) {
    outgoing.delete(id);
    const found = findInChat(jid, id);
    if (!found) return false;
    delete found.entry.sentByConnector;
    found.entry.sendFailed = String(error);
    changed(found.jid);
    return true;
  }

  function upsertChats(list) {
    for (const c of list || []) {
      if (!c || !c.id || SKIP_CHATS.has(c.id)) continue;
      touchChat(c.id);
      if (c.name || c.subject) chats[c.id].name = c.name || c.subject;
      if (Number.isFinite(c.unreadCount)) chats[c.id].unreadCount = c.unreadCount;
    }
  }

  function upsertGroups(groups) {
    for (const [jid, g] of Object.entries(groups || {})) {
      touchChat(jid);
      if (g && g.subject) chats[jid].name = g.subject;
    }
  }

  function upsertContacts(list) {
    for (const c of list || []) {
      if (!c || !c.id) continue;
      setContact(c.id, c.name || c.notify || c.verifiedName);
      // History-sync contacts carry the chat's other JID form.
      setAlias(c.id, c.lid);
      setAlias(c.id, c.phoneNumber);
    }
  }

  /** LID <-> phone-number pairs: [{ lid, pn }] as Baileys reports them. */
  function addAliases(pairs) {
    for (const p of pairs || []) if (p) setAlias(p.lid, p.pn);
  }

  /** The chat's messages in time order (cached until the chat changes; do not mutate). */
  function messages(jid) {
    const map = load(jid);
    let list = sortedCache.get(jid);
    if (!list) {
      list = [...map.values()].sort((a, b) => (a.timestampUnix - b.timestampUnix) || (a.id < b.id ? -1 : 1));
      sortedCache.set(jid, list);
    }
    return list;
  }

  function get(jid, id) {
    return load(jid).get(id) || null;
  }

  /**
   * A chat's messages in time order, including any filed under the other
   * JID of the same person (a 1:1 chat can be stored as both phone number
   * and LID). Groups have no alias, so this is messages(jid) for them.
   */
  function chatMessages(jid) {
    const own = messages(jid);
    const alt = alias(jid);
    if (!alt) return own;
    const other = messages(alt);
    if (!other.length) return own;
    if (!own.length) return other;
    const ids = new Set(own.map((m) => m.id));
    return [...own, ...other.filter((m) => !ids.has(m.id))]
      .sort((a, b) => (a.timestampUnix - b.timestampUnix) || (a.id < b.id ? -1 : 1));
  }

  /** A stored message by id, looking under the chat's alias too. */
  function findInChat(jid, id) {
    const own = get(jid, id);
    if (own) return { jid, entry: own };
    const alt = alias(jid);
    const other = alt ? get(alt, id) : null;
    return other ? { jid: alt, entry: other } : null;
  }

  function contactName(jid) {
    if (!jid) return null;
    return contacts[jid] || contacts[alias(jid)] || null;
  }

  /**
   * Record a live reaction on the message it targets. One per person: a new
   * one replaces their previous, an empty one removes it. Returns false when
   * the target message is not stored yet; the reaction then waits for it.
   */
  function applyReaction(jid, id, reaction) {
    if (!jid || !id || !reaction || SKIP_CHATS.has(jid)) return false;
    noteKeyAliases(reaction.key);
    const found = findInChat(jid, id);
    if (!found) {
      // Kept until the message arrives (e.g. through a backfill).
      const p = pendingFor(jid, id);
      p.reactions = mergeReactions(p.reactions, [reaction], reactionAuthor).list;
      return false;
    }
    const merged = mergeReactions(found.entry.reactions, [reaction], reactionAuthor);
    if (merged.changed) {
      found.entry.reactions = merged.list;
      dirty.add(found.jid);
    }
    return true;
  }

  /**
   * Whether the key of an edit or delete comes from the stored message's own
   * sender. WhatsApp clients ignore an edit or delete from anyone else; so
   * does the store.
   */
  function fromSender(entry, key) {
    if (!key) return true;
    if (!!key.fromMe !== !!entry.fromMe) return false;
    if (entry.fromMe) return true;
    const sender = new Set([entry.senderJid, entry.senderAltJid, alias(entry.senderJid)].filter(Boolean).map(bareJid));
    const isGroup = String(entry.chatJid || '').endsWith('@g.us');
    const who = (isGroup
      ? [key.participant, key.participantAlt]
      : [key.participant || key.remoteJid, key.participantAlt, key.remoteJidAlt]).filter(Boolean).map(bareJid);
    return who.some((j) => sender.has(j) || sender.has(alias(j)));
  }

  /**
   * Apply an edit to a stored message: its text becomes the edited text.
   * `key` is the edit's own key (who sent it). Returns false when the message
   * is not stored or the edit is not from its sender.
   */
  function applyEdit(jid, id, message, key = null) {
    const found = findInChat(jid, id);
    if (!found || found.entry.deleted || !fromSender(found.entry, key)) return false;
    found.entry.text = messageText({ message });
    found.entry.edited = true;
    found.entry.editedAt = new Date().toISOString();
    changed(found.jid);
    if (chats[found.jid]) {
      chats[found.jid].lastEditAt = Math.floor(Date.now() / 1000);
      chatsDirty = true;
    }
    return true;
  }

  /**
   * Mark a stored message deleted for everyone: its text and media keys are
   * dropped, as WhatsApp drops them on every device. Same sender rule as
   * edits, unless the caller has checked otherwise (a group admin's delete,
   * passed with key null and `deletedBy`).
   */
  function markDeleted(jid, id, key = null, { deletedBy = null } = {}) {
    const found = findInChat(jid, id);
    if (!found || !fromSender(found.entry, key)) return false;
    const e = found.entry;
    e.deleted = true;
    e.deletedAt = new Date().toISOString();
    if (deletedBy) e.deletedBy = deletedBy;
    e.text = '[deleted]';
    delete e.raw;
    delete e.pollUpdates;
    delete e.mentions;
    changed(found.jid);
    return true;
  }

  /**
   * The current reactions on a stored message, oldest first:
   * [{ participant, participantName, emoji, timestampMs, fromMe? }].
   * Merges reactions kept in raw (stored before reactions were kept on their
   * own) with the ones recorded since; removed reactions are left out.
   */
  function reactionList(entry) {
    if (!entry) return [];
    const fromRaw = entry.raw && Array.isArray(entry.raw.reactions) ? entry.raw.reactions : [];
    let list = mergeReactions([], fromRaw, reactionAuthor).list;
    if (Array.isArray(entry.reactions) && entry.reactions.length) {
      list = mergeReactions(list, entry.reactions, reactionAuthor).list;
    }
    return list
      .filter((r) => r.text)
      .map((r) => {
        const k = r.key || {};
        if (k.fromMe) {
          const me = meJid();
          return { participant: me || null, participantName: contactName(me), emoji: r.text, timestampMs: r.senderTimestampMs || null, fromMe: true };
        }
        const participant = k.participant || k.remoteJid || null;
        return {
          participant,
          participantName: contactName(participant) || contactName(k.participantAlt) || null,
          emoji: r.text,
          timestampMs: r.senderTimestampMs || null,
        };
      })
      .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
  }

  function chatName(jid) {
    return (chats[jid] && chats[jid].name) || null;
  }

  /** Every chat with stored messages or chat info. */
  function chatJids() {
    const jids = new Set(Object.keys(chats));
    try {
      for (const f of fs.readdirSync(messagesDir)) {
        if (f.endsWith('.json')) jids.add(decodeURIComponent(f.slice(0, -5)));
      }
    } catch { /* no messages yet */ }
    for (const jid of loaded.keys()) jids.add(jid);
    return [...jids];
  }

  /**
   * Chats with a message stored, or a stored message edited, at or after
   * `sinceUnix` (from chat info, so no chat file is read): where to look for
   * recent prompts.
   */
  function chatsActiveSince(sinceUnix) {
    return Object.keys(chats).filter((jid) => Math.max(chats[jid].lastMessageAt || 0, chats[jid].lastEditAt || 0) >= sinceUnix);
  }

  function chatList() {
    return Object.values(chats)
      .map((c) => ({ jid: c.jid, name: c.name || contacts[c.jid] || null, unreadCount: c.unreadCount || 0, isGroup: !!c.isGroup, lastMessageAt: toISO(c.lastMessageAt) }))
      .sort((a, b) => (a.name || a.jid).localeCompare(b.name || b.jid));
  }

  /**
   * Record decrypted poll votes on the poll message. Each voter counts once:
   * a later vote replaces their earlier one, and an empty vote removes it.
   */
  function applyPollUpdates(jid, id, updates) {
    if (SKIP_CHATS.has(jid)) return false;
    const found = findInChat(jid, id);
    if (!found) {
      const p = pendingFor(jid, id);
      p.pollUpdates = [...(p.pollUpdates || []), ...(updates || []).map(plainPollUpdate)];
      return false;
    }
    const entry = found.entry;
    jid = found.jid;
    // Same voter identity the library's tally uses (getKeyAuthor).
    const author = (u) => {
      const k = u.pollUpdateMessageKey || {};
      return (k.fromMe ? meJid() : k.participantAlt || k.participant || k.remoteJid) || 'unknown';
    };
    const byAuthor = new Map((entry.pollUpdates || []).map((u) => [author(u), u]));
    for (const raw of updates || []) {
      const u = plainPollUpdate(raw);
      const a = author(u);
      const prev = byAuthor.get(a);
      if (prev && Number(prev.senderTimestampMs || 0) > Number(u.senderTimestampMs || 0)) continue;
      const selected = u.vote && u.vote.selectedOptions;
      if (selected && selected.length) byAuthor.set(a, u);
      else byAuthor.delete(a);
    }
    entry.pollUpdates = [...byAuthor.values()];
    dirty.add(jid);
    return true;
  }

  /** { question, options: [{ name, votes, voters }], totalVoters } for a poll, else null. */
  function pollTally(entry) {
    if (!entry || !entry.raw || !isPoll(entry.raw.message)) return null;
    const message = unwrap(entry.raw.message);
    const poll = POLL_TYPES.map((k) => message[k]).find(Boolean);
    let tally;
    try {
      tally = aggregatePoll ? aggregatePoll(message, entry.pollUpdates || []) : null;
    } catch {
      tally = null;
    }
    if (!tally) tally = (poll.options || []).map((o) => ({ name: o.optionName || '', voters: [] }));
    const voters = new Set();
    const options = tally.map((o) => {
      for (const v of o.voters) voters.add(v);
      return { name: o.name, votes: o.voters.length, voters: o.voters.map((v) => contactName(v) || v) };
    });
    return { question: poll.name || '', options, totalVoters: voters.size };
  }

  /** Drop messages older than the cutoff from every chat. Returns how many. */
  function purgeOlderThan(cutoffUnix) {
    let removed = 0;
    for (const [k, p] of Object.entries(pending)) {
      if ((p.at || 0) < cutoffUnix) {
        delete pending[k];
        pendingDirty = true;
      }
    }
    for (const jid of chatJids()) {
      if (dirty.size >= maxLoadedChats) flush(); // keep memory bounded during the sweep
      const map = load(jid);
      for (const [id, m] of map) {
        if (m.timestampUnix && m.timestampUnix < cutoffUnix) {
          map.delete(id);
          removed++;
          changed(jid);
        }
      }
    }
    return removed;
  }

  function markDirty(jid) {
    dirty.add(jid);
  }

  function flush() {
    if (readOnly) return;
    if (!dirty.size && !chatsDirty && !contactsDirty && !aliasesDirty && !pendingDirty) return;
    ensurePrivateDir(dir);
    ensurePrivateDir(messagesDir);
    for (const jid of [...dirty]) {
      let list = messages(jid);
      if (list.length > MAX_MESSAGES_PER_CHAT) list = list.slice(list.length - MAX_MESSAGES_PER_CHAT);
      writeAtomic(chatFile(jid), JSON.stringify(list, replacer));
      dirty.delete(jid);
    }
    evict();
    if (chatsDirty) writeAtomic(chatsFile, JSON.stringify(chats));
    if (contactsDirty) writeAtomic(contactsFile, JSON.stringify(contacts));
    if (aliasesDirty) writeAtomic(aliasesFile, JSON.stringify(aliases));
    if (pendingDirty) writeAtomic(pendingFile, JSON.stringify(pending, replacer));
    pendingDirty = false;
    chatsDirty = false;
    contactsDirty = false;
    aliasesDirty = false;
  }

  return {
    dir,
    addMessages,
    markOutgoing,
    markSendFailed,
    upsertChats,
    upsertGroups,
    upsertContacts,
    addAliases,
    setAlias,
    alias,
    messages,
    chatMessages,
    get,
    findInChat,
    applyReaction,
    reactionList,
    applyEdit,
    markDeleted,
    isFromSender: fromSender,
    addPendingVote,
    pendingCount,
    contactName,
    chatName,
    chatList,
    chatJids,
    chatsActiveSince,
    purgeOlderThan,
    applyPollUpdates,
    pollTally,
    markDirty,
    flush,
    isDirty: () => dirty.size > 0 || chatsDirty || contactsDirty || aliasesDirty || pendingDirty,
    loadedChats: () => loaded.size,
  };
}

/**
 * Save the store soon after each change (write-behind) instead of on a timer:
 * the first change arms one save delayMs later, and later changes ride along
 * with it. Nothing runs while nothing changes. Every method of the store
 * object is wrapped, so a change made through any holder of the object (the
 * runtime keeps the same one) counts. A failed save is tried again after
 * retryMs, and only while there is unsaved data.
 *
 * onFlushed() runs after each automatic save (the listener checks there
 * whether retention is due).
 */
function enableAutoFlush(store, { delayMs = 250, retryMs = 5000, onError = () => {}, onFlushed = () => {} } = {}) {
  const flush = store.flush;
  let timer = null;
  let stopped = false;
  const arm = (ms) => {
    if (stopped || timer || !store.isDirty()) return;
    timer = setTimeout(run, ms);
  };
  function run() {
    timer = null;
    try {
      flush();
    } catch (e) {
      onError(e);
      arm(retryMs);
      return;
    }
    try { onFlushed(); } catch (e) { onError(e); }
  }
  const skip = new Set(['flush', 'isDirty', 'loadedChats']);
  for (const [name, fn] of Object.entries(store)) {
    if (typeof fn !== 'function' || skip.has(name)) continue;
    store[name] = function changesSave(...args) {
      const result = fn.apply(this, args);
      arm(delayMs);
      return result;
    };
  }
  // An explicit save makes the pending one unnecessary.
  store.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  };
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get pending() { return !!timer; },
  };
}

module.exports = {
  createStore, enableAutoFlush, plainPollUpdate, plainReaction, plainVoteMessage, DELETED_STUBS, messageText, contentType, contextInfo, unwrap, hasMedia, isPoll, toUnix, toISO,
  ensurePrivateDir, writeAtomic, readJson, isLid, isUserJid, bareJid,
};
