'use strict';
/**
 * Files in requests/: prompts, alerts and lifecycle events all land there
 * (escalations in requests/escalations/). Each file is written once and
 * appears whole (hard-linked from requests/.tmp/), so a watcher sees a single
 * create event and never a half-written file.
 *
 * Every file created here is announced to the hook set with onCreated()
 * (lib/delivery.cjs pushes it to Muse), from the process that wrote it.
 */

const fs = require('fs');
const path = require('path');
const { ensurePrivateDir } = require('./message-store.cjs');

let createdHook = null;

/** Called as hook(dir, name) after each new file; null to stop. */
function onCreated(hook) {
  createdHook = typeof hook === 'function' ? hook : null;
}

function slug(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'chat').slice(0, 40);
}

function stamp(unix) {
  return new Date(unix * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Write a file once: never overwrites. Returns false if it already existed. */
function writeOnce(dir, name, body) {
  ensurePrivateDir(dir);
  const tmpDir = path.join(dir, '.tmp');
  ensurePrivateDir(tmpDir);
  const tmp = path.join(tmpDir, `${name}.${process.pid}`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  let created = true;
  try {
    fs.linkSync(tmp, path.join(dir, name));
  } catch (e) {
    if (e.code !== 'EEXIST') {
      try { fs.unlinkSync(tmp); } catch { /* keep the original error */ }
      throw e;
    }
    created = false;
  }
  fs.unlinkSync(tmp);
  if (created && createdHook) {
    // Delivery must never break the write: the file is there either way.
    try { createdHook(dir, name); } catch { /* the hook logs its own failures */ }
  }
  return created;
}

module.exports = { slug, stamp, writeOnce, onCreated };
