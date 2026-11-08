'use strict';
/** Command-line parsing shared by the CLI and the listener. */

const VALUE_FLAGS = {
  '--jid': 'jid', '--days': 'days', '--phone': 'phone', '--text': 'text', '--file': 'file',
  '--caption': 'caption', '--id': 'id', '--out': 'out', '--limit': 'limit',
  '--lock-wait': 'lockWait', '--sync-wait': 'syncWait', '--backfill-wait': 'backfillWait',
  '--emoji': 'emoji', '--participant': 'participant', '--query': 'query', '--name': 'name',
  '--text-file': 'textFile', '--since': 'since',
};
const NUMBER_FLAGS = new Set(['days', 'limit', 'lockWait', 'syncWait', 'backfillWait']);
const BOOLEAN_FLAGS = { '--cached': 'cached', '--no-backfill': 'noBackfill', '--keep-open': 'keepOpen', '--after-escalation': 'afterEscalation' };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS[flag]) {
      const key = VALUE_FLAGS[flag];
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      out[key] = NUMBER_FLAGS.has(key) ? Number(value) : value;
    } else if (BOOLEAN_FLAGS[a]) {
      out[BOOLEAN_FLAGS[a]] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function seconds(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

module.exports = { parseArgs, seconds };
