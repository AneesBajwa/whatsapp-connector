'use strict';
/**
 * muse-config.json: where Muse listens and how it behaves. Missing settings
 * fall back to the defaults below.
 *
 * allChats (default true): the owner's @<triggerWord> works in every chat
 * (groups and 1:1 chats, including "Message yourself"). Set it to false to
 * listen only in the chats on the watchlist; the watchlist is kept either way
 * and never defaults to anything.
 */

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./message-store.cjs');

const DEFAULTS = {
  allChats: true,
  watchlist: [],
  triggerWord: 'agent',
  replyPrefix: 'Muse: ',
  ownerName: 'the owner',
  promptMaxAgeMinutes: 60,
  contextMessages: 30,
  limits: { promptsPerChatPerHour: 20, repliesPerPrompt: 3, repliesPerChatPerHour: 30, sendsPerHour: 30, reactionsPerHour: 120, editsPerHour: 30 },
  expireAfterMinutes: 30,
  health: { alertAfterMinutes: 10 },
  retentionDays: 90,
  // Escalating live checks to the main agent: off until the VM routes
  // requests/escalations/ to it (see HANDOFF-VM.md).
  escalation: { enabled: false },
};

const JID_PATTERN = /^[0-9A-Za-z.:_-]+@(g\.us|s\.whatsapp\.net|lid)$/;

function loadConfig(root, { log = () => {} } = {}) {
  const file = path.join(root, 'muse-config.json');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`muse-config.json is unreadable: ${e.message}`);
    log('warning: no muse-config.json; using the defaults');
  }
  const config = {
    ...DEFAULTS,
    ...raw,
    limits: { ...DEFAULTS.limits, ...(raw.limits || {}) },
    health: { ...DEFAULTS.health, ...(raw.health || {}) },
    escalation: { ...DEFAULTS.escalation, ...(raw.escalation || {}) },
  };
  if (raw.allChats !== undefined && typeof raw.allChats !== 'boolean') {
    throw new Error(`muse-config.json: allChats must be true or false (got ${JSON.stringify(raw.allChats)})`);
  }
  if (!/^[\p{L}\p{N}_]+$/u.test(config.triggerWord)) {
    throw new Error(`muse-config.json: triggerWord must be letters, digits or _ (got ${JSON.stringify(config.triggerWord)})`);
  }
  const seen = new Set();
  config.watchlist = (Array.isArray(raw.watchlist) ? raw.watchlist : []).filter((w) => {
    if (!w || typeof w.jid !== 'string' || !JID_PATTERN.test(w.jid)) {
      log(`warning: ignoring watchlist entry with an invalid jid: ${JSON.stringify(w && w.jid)}`);
      return false;
    }
    if (seen.has(w.jid)) return false;
    seen.add(w.jid);
    return true;
  }).map((w) => ({ jid: w.jid, name: typeof w.name === 'string' && w.name ? w.name : null }));
  return config;
}

/** Replace the watchlist in muse-config.json, keeping every other setting. */
function saveWatchlist(root, watchlist) {
  const file = path.join(root, 'muse-config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  raw.watchlist = watchlist.map((w) => ({ jid: w.jid, name: w.name || null }));
  writeAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
}

module.exports = { loadConfig, saveWatchlist, DEFAULTS, JID_PATTERN };
