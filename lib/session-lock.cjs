'use strict';
/**
 * One process per WhatsApp session. Two connections with the same login
 * replace each other (status 440), so every process that connects takes this
 * lock first: the listener for its lifetime, one-shot commands for their run.
 *
 * The lock file holds { pid, label, startedAt }. A lock whose process is gone
 * is stale and taken over; the takeover renames it aside first, so two
 * processes can never both believe they removed the same stale lock.
 */

const fs = require('fs');
const os = require('os');

// When this machine booted (to the second). A lock written before the last
// boot is stale even if its pid now belongs to some other live process.
const bootTime = () => Math.round(Date.now() / 1000 - os.uptime());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Whether the process that wrote this lock is still the one holding it. */
function holderAlive(holder) {
  if (!holder) return false;
  if (holder.pid === process.pid) return false; // our own pid, reused after a crash or reboot
  if (Number.isFinite(holder.bootTime) && Math.abs(holder.bootTime - bootTime()) > 120) return false;
  return isAlive(holder.pid);
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Remove a lock file only if it still holds the same stale content. */
function removeStale(file, holder) {
  const aside = `${file}.stale-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return;
  }
  const moved = readHolder(aside);
  const same = moved && holder && moved.pid === holder.pid && moved.startedAt === holder.startedAt;
  if (!same) {
    // Raced with a fresh lock: put it back (link fails if a newer one exists).
    try { fs.linkSync(aside, file); } catch { /* a newer lock won */ }
  }
  try { fs.unlinkSync(aside); } catch { /* ignore */ }
}

async function acquireLock(file, { waitMs = 0, pollMs = 500, label = '' } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const mine = { pid: process.pid, label, startedAt: new Date().toISOString(), bootTime: bootTime() };
      fs.writeSync(fd, JSON.stringify(mine));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const cur = readHolder(file);
        if (cur && cur.pid === process.pid && cur.startedAt === mine.startedAt) {
          try { fs.unlinkSync(file); } catch { /* ignore */ }
        }
      };
      process.once('exit', release);
      return { release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = readHolder(file);
    if (holder ? !holderAlive(holder) : isOld(file)) {
      removeStale(file, holder);
      continue;
    }
    if (Date.now() >= deadline) {
      const who = holder ? `pid ${holder.pid}${holder.label ? ` running ${holder.label}` : ''}` : 'another process';
      const err = new Error(`session busy (held by ${who})`);
      err.code = 'SESSION_BUSY';
      err.holder = holder;
      throw err;
    }
    await sleep(pollMs);
  }
}

/** An unreadable lock file is only stale once it is clearly not mid-write. */
function isOld(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > 10000;
  } catch {
    return true;
  }
}

module.exports = { acquireLock, isAlive, holderAlive, readHolder };
