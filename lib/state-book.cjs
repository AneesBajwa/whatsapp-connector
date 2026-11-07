'use strict';
/**
 * muse-state.json: what Muse has done, so nothing is acted on twice across
 * restarts: prompts seen and their status, and the timestamps behind the
 * rate limits. Written atomically, mode 600, outside auth/. No message text.
 */

const { writeAtomic, readJson } = require('./message-store.cjs');

const HOUR_MS = 3600 * 1000;
const KEEP_EVENTS_MS = 24 * HOUR_MS;
// Finished prompt records are kept this long (for stats and duplicate checks).
const KEEP_PROMPTS_MS = 30 * 24 * HOUR_MS;
const OPEN_STATUSES = new Set(['received', 'pending', 'in_progress', 'escalated', 'pending_approval']);

function createStateBook(file) {
  const data = readJson(file, null) || {};
  data.prompts = data.prompts || {};
  data.rate = data.rate || {};
  data.marks = data.marks || {};

  function save() {
    const oldest = Date.now() - KEEP_PROMPTS_MS;
    for (const [key, r] of Object.entries(data.prompts)) {
      if (!OPEN_STATUSES.has(r.status) && Date.parse(r.receivedAt) < oldest) delete data.prompts[key];
    }
    for (const [key, at] of Object.entries(data.marks)) {
      if (typeof at === 'number' && at < oldest) delete data.marks[key];
    }
    const cutoff = Date.now() - KEEP_EVENTS_MS;
    for (const kind of Object.keys(data.rate)) {
      for (const jid of Object.keys(data.rate[kind])) {
        data.rate[kind][jid] = data.rate[kind][jid].filter((t) => t >= cutoff);
        if (!data.rate[kind][jid].length) delete data.rate[kind][jid];
      }
    }
    writeAtomic(file, JSON.stringify(data, null, 2));
  }

  return {
    data,
    save,
    prompt: (key) => data.prompts[key] || null,
    setPrompt: (key, value) => (data.prompts[key] = value),
    prompts: () => Object.entries(data.prompts),
    hit(kind, jid, now = Date.now()) {
      ((data.rate[kind] = data.rate[kind] || {})[jid] = data.rate[kind][jid] || []).push(now);
    },
    count(kind, jid, windowMs = HOUR_MS, now = Date.now()) {
      const list = (data.rate[kind] && data.rate[kind][jid]) || [];
      return list.filter((t) => t > now - windowMs).length;
    },
    /** Generic once-only markers (e.g. a nudge or digest already sent). */
    marked: (key) => !!data.marks[key],
    mark: (key, value = Date.now()) => { data.marks[key] = value; },
  };
}

module.exports = { createStateBook, HOUR_MS };
