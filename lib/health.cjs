'use strict';
/**
 * Listener health: alerts for the owner (via requests/, Kind: alert) when the
 * WhatsApp connection is down longer than health.alertAfterMinutes, when it
 * comes back after such an alert, and at once when the session is closed for
 * good (logged out, replaced by another copy). Also: retention and stats.
 *
 * Nothing checks on an interval: a disconnect arms one deadline
 * (alertAfterMinutes later) and reconnecting disarms it. check() can also be
 * called on demand (the status command does).
 */

const fs = require('fs');
const path = require('path');
const { writeAlert } = require('./alerts.cjs');
const { NO_AUDIT } = require('./audit.cjs');
const { readLedger, DIR: DELIVERY_DIR } = require('./delivery.cjs');

const FATAL_TEXT = {
  401: (owner) => [
    'WhatsApp logged out this device, so the connector can no longer read or send.',
    `It needs linking again: ${owner} links it from home with pair-qr (Muse cannot do this). Until then, commands answer needsPairing.`,
  ],
  440: () => [
    'Another copy of this WhatsApp session connected and replaced the listener (status 440).',
    'Stop the other copy (any other machine or process using this auth/ folder), then restart the listener service. The listener will not reconnect by itself, so the two copies do not keep fighting.',
  ],
  403: () => ['WhatsApp refused this session (status 403, forbidden). The listener stopped reconnecting; check the account in WhatsApp before restarting it.'],
  411: () => ['WhatsApp reported a multi-device mismatch (status 411). The listener stopped reconnecting; the device may need linking again.'],
};

function minutes(ms) {
  return Math.max(1, Math.round(ms / 60000));
}

function createHealthMonitor({ rt, config, root, audit = NO_AUDIT, log = () => {} }) {
  let downSince = Date.now(); // until the first open
  let alerted = false;
  let deadline = null;
  let stopped = false;
  const thresholdMs = config.health.alertAfterMinutes * 60000;

  /** While down: one timer for the moment the outage reaches the threshold. */
  function arm() {
    if (stopped || deadline || alerted || rt.fatalCode || !downSince) return;
    deadline = setTimeout(() => {
      deadline = null;
      monitor.check();
      arm(); // still under the threshold (a clock change): wait for the rest
    }, Math.max(0, downSince + thresholdMs - Date.now()) + 10);
    if (deadline.unref) deadline.unref();
  }
  function disarm() {
    if (deadline) clearTimeout(deadline);
    deadline = null;
  }

  rt.events.on('disconnected', () => {
    if (!downSince) downSince = Date.now();
    arm();
  });
  rt.events.on('open', () => {
    disarm();
    if (alerted) {
      const downMs = Date.now() - downSince;
      writeAlert({
        root, config, key: 'health-recovered', title: 'WhatsApp connection back',
        lines: [`The listener is back online after about ${minutes(downMs)} minute(s) without a WhatsApp connection. Messages sent meanwhile are delivered now. Prompts from the last ${config.promptMaxAgeMinutes} minutes are picked up; older ones are listed in a missed-prompts event.`],
      });
      audit.record('health_recovered', { downMs });
      log('health: back online');
    }
    downSince = null;
    alerted = false;
  });
  rt.events.on('fatal', (code) => {
    disarm();
    const text = (FATAL_TEXT[code] || (() => [`The WhatsApp session closed with status ${code} and the listener stopped reconnecting.`]))(config.ownerName);
    writeAlert({ root, config, key: `health-fatal-${code}`, title: 'WhatsApp session closed', lines: text });
    audit.record('health_fatal', { code });
    alerted = true;
  });

  const monitor = {
    check(now = Date.now()) {
      if (!downSince || alerted || rt.fatalCode) return;
      if (now - downSince < thresholdMs) return;
      alerted = true;
      writeAlert({
        root, config, key: 'health-down', title: 'WhatsApp connection down',
        lines: [
          `The listener is not connected to WhatsApp, and has not been since ${new Date(downSince).toISOString()} (about ${minutes(now - downSince)} minute(s)). It keeps retrying.`,
          `While it is down, @${config.triggerWord} prompts get no 👀 and no answer. WhatsApp holds messages for the device, so nothing is lost once it reconnects.`,
          'If this lasts, check the VM\'s network and proxy, and the listener service log.',
        ],
      });
      audit.record('health_alert', { downMs: now - downSince });
      log('health: outage alert written');
    },
    stop() {
      stopped = true;
      disarm();
    },
  };
  arm(); // down until the first open
  return monitor;
}

/**
 * Delete stored messages, and request files with their attachments, past the
 * retention period. Delivery markers (requests/.delivery/) go only once their
 * file has gone, so a file is never left without its marker.
 */
function applyRetention({ rt, config, root, audit = NO_AUDIT }) {
  const cutoffUnix = Math.floor(Date.now() / 1000) - config.retentionDays * 86400;
  const removed = rt.store.purgeOlderThan(cutoffUnix);
  rt.store.flush();
  let requestsRemoved = 0;
  const dir = path.join(root, 'requests');
  const cutoffMs = cutoffUnix * 1000;
  const sweep = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (d === dir && e.name === DELIVERY_DIR) continue;
      if (e.isDirectory()) {
        sweep(p);
        try { if (!fs.readdirSync(p).length && d !== dir) fs.rmdirSync(p); } catch { /* ignore */ }
      } else if (fs.statSync(p).mtimeMs < cutoffMs) {
        fs.unlinkSync(p);
        requestsRemoved++;
      }
    }
  };
  sweep(dir);
  let markersRemoved = 0;
  for (const row of readLedger(root)) {
    if (!row.file || fs.existsSync(path.join(dir, row.file))) continue;
    try { fs.unlinkSync(path.join(dir, DELIVERY_DIR, `${encodeURIComponent(row.file)}.json`)); markersRemoved++; } catch { /* already gone */ }
  }
  if (removed || requestsRemoved) audit.record('retention', { messagesRemoved: removed, filesRemoved: requestsRemoved });
  return { removed, requestsRemoved, markersRemoved };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Prompt counts and 👀 / reply latency over the last `days` days. */
function promptStats(book, days = 7) {
  const since = Date.now() - days * 86400000;
  const records = book.prompts().map(([, r]) => r)
    .filter((r) => r.kind !== 'watch-change' && r.status !== 'rate_limited' && Date.parse(r.receivedAt) >= since);
  const span = (from, to) => (from && to ? Date.parse(to) - Date.parse(from) : null);
  const summary = (list) => {
    const sorted = list.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return { median: percentile(sorted, 50), p95: percentile(sorted, 95), count: sorted.length };
  };
  return {
    days,
    prompts: records.length,
    answered: records.filter((r) => r.status === 'answered').length,
    expired: records.filter((r) => r.status === 'expired').length,
    declined: records.filter((r) => r.status === 'declined').length,
    escalated: records.filter((r) => r.escalation).length,
    escalatedAnswered: records.filter((r) => r.escalation && r.status === 'answered').length,
    // A prompt made by an edit (a fixed typo) is timed from the edit.
    ackMs: summary(records.map((r) => span(r.editedAt || r.promptAt, r.ackAt))),
    replyMs: summary(records.map((r) => span(r.editedAt || r.promptAt, r.repliedAt))),
  };
}

module.exports = { createHealthMonitor, applyRetention, promptStats };
