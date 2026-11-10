'use strict';
/**
 * Commands that run against an open session. The one-shot CLI and the
 * listener both call runCommand(), so a command returns the same JSON and
 * exit code whichever process runs it.
 *
 * Each command returns { exit, out: [json objects for stdout], err: [lines for stderr] }.
 */

const fs = require('fs');
const path = require('path');
const { hasMedia } = require('./message-store.cjs');
const { sendAndStore, resolveRecipient, sendReaction, reactionKey, isSingleEmoji, downloadMedia } = require('./actions.cjs');
const { replyToPrompt, escalatePrompt, noteReaction, changeWatchlist, hasPrefix, withPrefix } = require('./prompts.cjs');
const { saveWatchlist, JID_PATTERN } = require('./config.cjs');
const { NO_AUDIT } = require('./audit.cjs');
const { backfill } = require('./backfill.cjs');
const { mediaInfo } = require('./media.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WhatsApp's own limits: edits within 15 minutes of sending, delete for
// everyone within about 2.5 days. Later attempts are refused here rather
// than sent and silently ignored by the phones.
const EDIT_WINDOW_S = 15 * 60;
const DELETE_WINDOW_S = 60 * 3600;
const EDITABLE_TYPES = new Set(['conversation', 'extendedTextMessage']);

function readOptions(args, defaults = { days: 30, limit: 2000 }) {
  const days = Number.isFinite(args.days) && args.days > 0 ? args.days : defaults.days;
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : defaults.limit;
  return { days, limit };
}

/**
 * A stored message as `read` and `search` print it: no raw payload or
 * internal fields. `reactions` is always present (empty when there are
 * none), so a caller can tell "no reactions" from an older connector that
 * never reported them.
 */
function presentMessage(store, m, extras = {}) {
  const { timestampUnix, raw, senderAltJid, pollUpdates, sentByConnector, reactions, ...rest } = m;
  const out = {
    ...rest,
    senderName: rest.senderName || store.contactName(rest.senderJid) || store.contactName(senderAltJid) || null,
    reactions: store.reactionList(m),
    ...extras,
  };
  const poll = store.pollTally(m);
  if (poll) out.poll = poll;
  if (sentByConnector) out.sentByConnector = true;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function buildReadResult(store, jid, { days, limit, notDrained = false, present = (m) => presentMessage(store, m) }) {
  const cutoffUnix = Math.floor(Date.now() / 1000) - days * 86400;
  const all = store.chatMessages(jid);
  const inRange = all.filter((m) => m.timestampUnix >= cutoffUnix);
  // Partial when full coverage cannot be confirmed: offline delivery not
  // finished, nothing stored, or the oldest stored message is newer than the cutoff.
  const partial = notDrained || all.length === 0 || all[0].timestampUnix > cutoffUnix;
  const truncated = inRange.length > limit;
  const window = truncated ? inRange.slice(inRange.length - limit) : inRange;
  const messages = window.map(present);
  return {
    jid,
    days,
    messages,
    count: messages.length,
    totalInRange: inRange.length,
    truncated,
    oldestTimestamp: messages.length ? messages[0].timestamp : null,
    partial,
  };
}

/**
 * Resolve the filename for a downloaded message. An explicit --out wins.
 * Otherwise the message's own filename is sanitized to its basename (a
 * sender-controlled filename must never carry path separators), else a
 * generated <jid>_<id>.<ext> name is used. Auto-derived names never
 * overwrite: a counter is appended while the name exists.
 */
function resolveDownloadFileName({ jid, id, mediaFileName, ext, out, exists = fs.existsSync }) {
  if (out) return out;
  let name = mediaFileName
    ? path.basename(mediaFileName)
    : `${jid.replace(/[^A-Za-z0-9]/g, '_')}_${id}.${ext}`;
  if (!name || name === '.' || name === '..') {
    name = `${jid.replace(/[^A-Za-z0-9]/g, '_')}_${id}.${ext}`;
  }
  if (exists(name)) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const suffix = dot > 0 ? name.slice(dot) : '';
    let n = 1;
    while (exists(`${base}-${n}${suffix}`)) n++;
    name = `${base}-${n}${suffix}`;
  }
  return name;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Messages containing every word of the query (any case, any accents), newest first. */
function searchStore(store, { query, jid = null, days, limit }) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const hits = [];
  const lists = jid ? [store.chatMessages(jid)] : store.chatJids().map((j) => store.messages(j));
  for (const list of lists) {
    for (const m of list) {
      if (m.timestampUnix >= cutoff && terms.every((t) => fold(m.text).includes(t))) hits.push(m);
    }
  }
  hits.sort((a, b) => b.timestampUnix - a.timestampUnix);
  const results = hits.slice(0, limit).map((m) => ({ ...presentMessage(store, m), chatName: store.chatName(m.chatJid) }));
  return { query, jid, days, results, count: results.length, totalMatches: hits.length, truncated: hits.length > limit };
}

/**
 * Argument problems that need no session: checked by the CLI before it
 * connects, and again by runCommand. Returns an error line or null.
 */
function validateArgs(command, args) {
  if (command === 'pair' && !String(args.phone || '').replace(/\D/g, '')) return 'pair requires --phone <number with country code, digits only>, or use pair-qr';
  if (command === 'react') {
    if (!args.jid || !args.id) return 'react requires --jid <jid> --id <message-id> --emoji <emoji>';
    if (!isSingleEmoji(args.emoji)) return 'react: --emoji must be a single emoji';
  }
  if (command === 'escalate') {
    if (!args.jid || !args.id) return 'escalate requires --jid <jid> --id <prompt-message-id> (--text "what to check" | --text-file <path>)';
    if (!args.text || !String(args.text).trim()) return 'escalate requires --text "what to check" or --text-file <path>';
  }
  if (command === 'reply') {
    if (!args.jid || !args.id) return 'reply requires --jid <jid> --id <prompt-message-id> --text "..."';
    if (!args.text || !String(args.text).trim()) return 'reply requires --text "..."';
  }
  if (command === 'edit') {
    if (!args.jid || !args.id) return 'edit requires --jid <jid> --id <message-id> (--text "..." | --text-file <path>)';
    if (!args.text || !String(args.text).trim()) return 'edit requires --text "..." or --text-file <path>';
  }
  if (command === 'delete' && (!args.jid || !args.id)) return 'delete requires --jid <jid> --id <message-id>';
  if (command === 'search' && !(args.query && String(args.query).trim())) return 'search requires --query "words" or --query-file <path> [--jid <jid>] [--days 90] [--limit 50]';
  if (command === 'delivery') {
    const sub = args._[1] || 'status';
    if (!['status', 'report', 'flush'].includes(sub)) return 'delivery requires status, report [--since <ISO time>] [--limit N], or flush';
    if (args.since && !Number.isFinite(Date.parse(args.since)) && !Number.isFinite(Number(args.since))) return 'delivery report: --since must be an ISO time';
  }
  if (command === 'watchlist') {
    const sub = args._[1];
    if (!['list', 'add', 'remove'].includes(sub)) return 'watchlist requires list, add --jid <jid> [--name "..."], or remove --jid <jid>';
    if (sub !== 'list' && !(args.jid && JID_PATTERN.test(args.jid))) return `watchlist ${sub} requires a valid --jid`;
  }
  return null;
}

async function runCommand(rt, command, args, {
  cwd = process.cwd(), book = null, config = null, root = rt.paths.root, audit = NO_AUDIT, onWatchlistChange = null,
} = {}) {
  const res = { exit: 0, out: [], err: [] };
  const done = (obj, exit = 0) => { if (obj) res.out.push(obj); res.exit = exit; return res; };
  const fail = (line, exit = 1) => { res.err.push(line); res.exit = exit; return res; };
  const { store, diag } = rt;

  if (command === 'status') {
    return done({ connected: rt.connectionState === 'open', me: rt.me(), diag });
  }

  if (command === 'sync') {
    return done({ synced: rt.offlineDrained, newMessages: diag.newMessages, diag });
  }

  if (command === 'chats') {
    let groups = null;
    for (let attempt = 1; attempt <= 2 && !groups; attempt++) {
      try {
        groups = await rt.sock.groupFetchAllParticipating();
        delete diag.groupFetchError;
      } catch (e) {
        diag.groupFetchError = e && e.message ? e.message : String(e);
        if (attempt < 2) await sleep(2000);
      }
    }
    if (groups) {
      store.upsertGroups(groups);
      diag.groupsFromServer = Object.keys(groups).length;
    }
    store.flush();
    const chats = store.chatList();
    return done({ chats, count: chats.length, diag });
  }

  if (command === 'read') {
    if (!args.jid) return fail('read requires --jid <jid>');
    const { days, limit } = readOptions(args);
    // This read's own outcome goes into this response only: the listener's
    // diag is shared with everything else running at the same time.
    let outcome = {};
    if (!args.noBackfill) {
      const waitOk = Number.isFinite(args.backfillWait) && args.backfillWait >= 0;
      outcome = await backfill(rt, args.jid, {
        cutoffUnix: Math.floor(Date.now() / 1000) - days * 86400,
        ...(waitOk ? { pageWaitMs: args.backfillWait * 1000 } : {}),
      });
    }
    store.flush();
    const readDiag = {
      ...diag,
      storeMessages: store.chatMessages(args.jid).length,
      pendingItems: store.pendingCount(),
      ...(store.alias(args.jid) ? { aliasJid: store.alias(args.jid) } : {}),
      ...(outcome.impossible ? { backfillImpossible: outcome.impossible } : {}),
      ...(outcome.bootstrap ? { backfillBootstrap: outcome.bootstrap } : {}),
      ...(outcome.error ? { backfillError: outcome.error } : {}),
      ...(outcome.aliasLookupError ? { aliasLookupError: outcome.aliasLookupError } : {}),
    };
    return done({ ...buildReadResult(store, args.jid, { days, limit, notDrained: !rt.offlineDrained }), diag: readDiag });
  }

  if (command === 'download') {
    const { jid, id } = args;
    if (!jid || !id) return fail('download requires --jid <jid> --id <message-id>');
    const find = () => { const f = store.findInChat(jid, id); return f ? f.entry : null; };
    let entry = find();
    if (!entry || !entry.raw) {
      await backfill(rt, jid, { targetId: id, maxPages: 40 });
      entry = find();
    }
    if (!entry || !entry.raw || !hasMedia(entry.raw.message)) {
      return fail(`download: message ${id} not found in ${jid} or has no media`);
    }
    const buffer = await downloadMedia(rt, entry.raw);
    const { mimetype, ext, fileName: mediaFileName } = mediaInfo(entry.raw.message);
    const name = resolveDownloadFileName({
      jid, id, mediaFileName, ext,
      out: args.out,
      exists: (n) => fs.existsSync(path.resolve(cwd, n)),
    });
    const file = path.resolve(cwd, name);
    fs.writeFileSync(file, buffer);
    return done({ downloaded: true, jid, id, file: name, bytes: buffer.length, mimetype });
  }

  // Hourly caps on anything sent outside the prompt flow (per connector, all chats).
  const capped = (kind, limit) => {
    if (!book || !Number.isFinite(limit)) return null;
    if (book.count(kind, '*') >= limit) return `${command}: hourly limit reached (${limit}); try again later`;
    return null;
  };
  const counted = (kind) => { if (book) { book.hit(kind, '*'); book.save(); } };

  if (command === 'send') {
    const over = capped('send', config && config.limits.sendsPerHour);
    if (over) return fail(over);
    if (!args.jid) return fail('send requires --jid <jid>');
    if (!args.text && !args.file) return fail('send requires --text "..." or --file <path>');
    // Bare digits mean an individual chat (with country code); group JIDs and LIDs pass through as-is.
    const recipient = await resolveRecipient(rt, args.jid);
    if (recipient.error) return fail(recipient.error);
    const { jid } = recipient;
    // Waits for WhatsApp's ack: a refused 1:1 message must never be reported as sent.
    const deliver = async (kind, content, file) => {
      let result;
      try {
        result = await sendAndStore(rt, jid, content, { confirm: true });
      } catch (e) {
        if (e.code === 'SEND_REJECTED' || e.code === 'SEND_UNCONFIRMED') return fail(`send: ${e.message}`);
        throw e;
      }
      counted('send');
      return done({ sent: true, kind, jid, ...(file ? { file } : {}), id: result && result.key ? result.key.id : null });
    };
    if (args.file) {
      const file = path.resolve(cwd, args.file);
      if (!fs.existsSync(file)) return fail(`send: file not found: ${args.file}`);
      const buffer = fs.readFileSync(file);
      if (buffer.length > 100 * 1024 * 1024) {
        return fail(`send: file too large (${buffer.length} bytes); refusing files over 100 MB`);
      }
      const ext = path.extname(file).toLowerCase();
      const mimetype = ext === '.pdf' ? 'application/pdf'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.png' ? 'image/png'
            : 'application/octet-stream';
      const base = path.basename(file);
      if (mimetype === 'image/jpeg' || mimetype === 'image/png') {
        return deliver('image', { image: buffer, caption: args.caption || undefined, fileName: base }, base);
      }
      return deliver('document', { document: buffer, mimetype, fileName: base, caption: args.caption || undefined }, base);
    }
    return deliver('text', { text: args.text });
  }

  if (command === 'edit' || command === 'delete') {
    const problem = validateArgs(command, args);
    if (problem) return fail(problem);
    const over = capped('edit', config && config.limits.editsPerHour);
    if (over) return fail(over);
    const found = store.findInChat(args.jid, args.id);
    if (!found) return fail(`${command}: message ${args.id} is not in the store for ${args.jid}`);
    const entry = found.entry;
    // Only what the connector itself sent: never the owner's own messages
    // typed on the phone, and never anyone else's.
    if (!entry.sentByConnector) return fail(`${command}: message ${args.id} was not sent by the connector; only its own messages can be ${command === 'edit' ? 'edited' : 'deleted'}`);
    if (entry.deleted) return fail(`${command}: message ${args.id} is already deleted`);
    const ageS = Math.floor(Date.now() / 1000) - (entry.timestampUnix || 0);
    const raw = entry.raw && entry.raw.key ? entry.raw.key : {};
    const key = { remoteJid: raw.remoteJid || found.jid, id: args.id, fromMe: true };
    if (command === 'edit') {
      if (!EDITABLE_TYPES.has(entry.type)) return fail(`edit: only text messages can be edited (this one is ${entry.type || 'unknown'})`);
      if (ageS > EDIT_WINDOW_S) return fail(`edit: WhatsApp only allows edits within ${EDIT_WINDOW_S / 60} minutes of sending; this message is ${Math.round(ageS / 60)} minutes old`);
      // Keep the reply prefix on an edited reply.
      const prefix = config && config.replyPrefix;
      const text = String(args.text).trim();
      const finalText = prefix && hasPrefix(entry.text, prefix) ? withPrefix(text, prefix) : text;
      await sendAndStore(rt, found.jid, { text: finalText, edit: key });
      counted('edit');
      store.applyEdit(found.jid, args.id, { conversation: finalText });
      store.flush();
      audit.record('edit', { chat: found.jid, id: args.id });
      return done({ edited: true, jid: found.jid, id: args.id, text: finalText });
    }
    if (ageS > DELETE_WINDOW_S) return fail(`delete: WhatsApp only allows deleting for everyone within ${DELETE_WINDOW_S / 3600} hours of sending; this message is ${Math.round(ageS / 3600)} hours old`);
    await sendAndStore(rt, found.jid, { delete: key });
    counted('edit');
    store.markDeleted(found.jid, args.id);
    store.flush();
    audit.record('delete', { chat: found.jid, id: args.id });
    return done({ deleted: true, jid: found.jid, id: args.id });
  }

  if (command === 'react' || command === 'reply' || command === 'escalate' || command === 'watchlist') {
    const problem = validateArgs(command, args);
    if (problem) return fail(problem);
  }

  if (command === 'react') {
    const over = capped('react', config && config.limits.reactionsPerHour);
    if (over) return fail(over);
    const key = reactionKey(store, args.jid, args.id, args.participant);
    if (!key) {
      return fail(`react: message ${args.id} is not in the store; pass --participant <sender jid> to react to it`);
    }
    await sendReaction(rt, args.jid, key, args.emoji);
    counted('react');
    if (book) noteReaction({ book, root, jid: args.jid, id: args.id, emoji: args.emoji, audit });
    return done({ reacted: true, jid: args.jid, id: args.id, emoji: args.emoji });
  }

  if (command === 'reply') {
    if (!book || !config) return fail('reply: prompt state is not available');
    const r = await replyToPrompt({ rt, book, config, root, jid: args.jid, id: args.id, text: args.text, keepOpen: !!args.keepOpen, afterEscalation: !!args.afterEscalation, audit });
    res.out.push(...r.out);
    res.err.push(...r.err);
    res.exit = r.exit;
    return res;
  }

  if (command === 'escalate') {
    if (!book || !config) return fail('escalate: prompt state is not available');
    const r = await escalatePrompt({ rt, book, config, root, jid: args.jid, id: args.id, need: args.text, audit });
    res.out.push(...r.out);
    res.err.push(...r.err);
    res.exit = r.exit;
    return res;
  }

  if (command === 'watchlist') {
    if (!book || !config) return fail('watchlist: config is not available');
    if (args._[1] === 'list') return done({ allChats: !!config.allChats, watchlist: config.watchlist, triggerWord: config.triggerWord });
    const r = await changeWatchlist({
      rt, book, config, root, action: args._[1], jid: args.jid, name: args.name, audit, saveWatchlist,
    });
    if (r.exit === 0 && onWatchlistChange) onWatchlistChange(config.watchlist);
    res.out.push(...r.out);
    res.err.push(...r.err);
    res.exit = r.exit;
    return res;
  }

  return fail(`unknown command: ${command}`);
}

module.exports = {
  runCommand, validateArgs, searchStore, buildReadResult, presentMessage, readOptions, backfill, resolveDownloadFileName, mediaInfo,
};
