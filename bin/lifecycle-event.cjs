#!/usr/bin/env node
/**
 * Write one lifecycle event to requests/ (Kind: lifecycle), for scripts such
 * as deploy/install-listener.sh. Text comes in as arguments, never through a
 * shell string:
 *
 *   node bin/lifecycle-event.cjs --event listener-installed --title "..." [--notify] --line "..." [--line "..."]
 *
 * With push delivery on, the event is pushed to Muse right away: by the
 * listener when one is running (asked over listener.sock, so it stays the
 * only process that retries), otherwise by this script itself.
 */

'use strict';

const path = require('path');
const { writeEvent } = require('../lib/lifecycle.cjs');
const { loadConfig, loadDeliverySettings, DEFAULTS } = require('../lib/config.cjs');
const { createDelivery } = require('../lib/delivery.cjs');
const ipc = require('../lib/ipc.cjs');

const ROOT = path.join(__dirname, '..');

async function main() {
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
  try {
    config = loadConfig(ROOT);
  } catch {
    // The event still goes out, with the defaults (and the delivery settings if those are readable).
    config = { ...DEFAULTS, delivery: loadDeliverySettings(ROOT) || DEFAULTS.delivery };
  }
  const log = (m) => console.error(m);
  const name = writeEvent({ root: ROOT, config, event: opts.event, title: opts.title, notify: opts.notify, lines: opts.lines, log });
  if (!name) process.exit(1);
  if (config.delivery && config.delivery.enabled) {
    const reply = await ipc.request(path.join(ROOT, 'listener.sock'), { argv: ['delivery', 'flush'] }, { timeoutMs: 15000 });
    if (!reply || reply.exit !== 0) {
      createDelivery({ root: ROOT, config, log, standalone: true }).notify(path.join(ROOT, 'requests'), name);
    }
  }
  console.log(name);
}

main().catch((e) => {
  console.error(`error: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
