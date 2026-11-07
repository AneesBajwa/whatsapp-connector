'use strict';
/**
 * audit.log: one JSON line per thing Muse did or decided (prompt seen, 👀
 * sent, request written, reply sent, reaction, rate limit, watchlist change,
 * health alert), with timings. Never message text. Mode 600.
 */

const fs = require('fs');

const MAX_BYTES = 5 * 1024 * 1024;

function createAudit(file) {
  return {
    record(event, fields = {}) {
      try {
        // Keep one previous file: audit.log.1.
        if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
        fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
      } catch { /* the audit log must never break message handling */ }
    },
  };
}

const NO_AUDIT = { record() {} };

module.exports = { createAudit, NO_AUDIT };
