#!/usr/bin/env node
/**
 * Write one lifecycle event to requests/ (Kind: lifecycle), for scripts such
 * as deploy/install-listener.sh. Text comes in as arguments, never through a
 * shell string:
 *
 *   node bin/lifecycle-event.cjs --event listener-installed --title "..." [--notify] --line "..." [--line "..."]
 */

'use strict';

const path = require('path');
const { writeEvent } = require('../lib/lifecycle.cjs');
const { loadConfig, DEFAULTS } = require('../lib/config.cjs');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opts = { lines: [], notify: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--event') opts.event = argv[++i];
  else if (a === '--title') opts.title = argv[++i];
  else if (a === '--line') opts.lines.push(argv[++i]);
  else if (a === '--notify') opts.notify = true;
}
if (!opts.event || !opts.title) {
  console.error('usage: lifecycle-event.cjs --event <name> --title "..." [--notify] --line "..."');
  process.exit(1);
}
process.umask(0o077);
let config = DEFAULTS;
try { config = loadConfig(ROOT); } catch { /* the event still goes out, with the defaults */ }
const name = writeEvent({ root: ROOT, config, event: opts.event, title: opts.title, notify: opts.notify, lines: opts.lines, log: (m) => console.error(m) });
if (!name) process.exit(1);
console.log(name);
