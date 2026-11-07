'use strict';
/**
 * Local control socket between the CLI and the listener: a Unix socket in the
 * connector folder (listener.sock, mode 600), one JSON request line and one
 * JSON reply line per connection.
 *
 * request() returns null when no listener is answering (no socket file, or a
 * stale one), so the CLI can fall back to its own one-shot connection; the
 * session lock still keeps that from overlapping a live listener.
 */

const fs = require('fs');
const net = require('net');

const MAX_REQUEST_BYTES = 1024 * 1024;

function failure(line) {
  return { exit: 1, out: [], err: [line] };
}

async function serve(sockPath, handler) {
  try { fs.unlinkSync(sockPath); } catch { /* none left over */ }
  const server = net.createServer((conn) => {
    let buf = '';
    let handled = false;
    conn.setEncoding('utf8');
    conn.on('error', () => { /* client went away */ });
    conn.on('data', async (chunk) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        handled = true;
        conn.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      let reply;
      try {
        reply = await handler(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reply = failure(`error: ${e && e.message ? e.message : e}`);
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  fs.chmodSync(sockPath, 0o600);
  return server;
}

function request(sockPath, payload, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) {
      resolve(null);
      return;
    }
    const conn = net.connect(sockPath);
    let buf = '';
    let connected = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(failure('error: the listener did not answer in time')), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      connected = true;
      conn.write(`${JSON.stringify(payload)}\n`);
    });
    conn.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)));
      } catch {
        finish(failure('error: unreadable reply from the listener'));
      }
    });
    // Before connecting: no listener (fall back). After: a real failure.
    conn.on('error', (e) => finish(connected ? failure(`error: listener connection failed: ${e.message}`) : null));
    conn.on('close', () => finish(connected ? failure('error: the listener closed the connection without answering') : null));
  });
}

module.exports = { serve, request };
