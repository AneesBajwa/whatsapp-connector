'use strict';
/**
 * Test harness: builds a throwaway copy of the kit in a temp folder (bin/,
 * lib/, muse-config.json) with the offline Baileys stub in node_modules, and
 * runs the CLI or listener there. Nothing here touches WhatsApp or the real
 * kit's auth/, store/ or requests/.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn, execFile } = require('node:child_process');

const KIT_ROOT = path.join(__dirname, '..', '..');
const STUB = path.join(__dirname, 'baileys-stub.cjs');

const QR_LINKED = { registered: false, account: { details: 'x' }, me: { id: '1:1@s.whatsapp.net', name: 'x' } };

function createKit({ creds, rawCreds, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-kit-test-'));
  for (const sub of ['bin', 'lib']) {
    const from = path.join(KIT_ROOT, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  // The example config, not the local muse-config.json: tests must not depend on a deployment's real chats.
  const shippedConfig = path.join(KIT_ROOT, 'muse-config.example.json');
  if (config) fs.writeFileSync(path.join(dir, 'muse-config.json'), JSON.stringify(config));
  else if (fs.existsSync(shippedConfig)) fs.copyFileSync(shippedConfig, path.join(dir, 'muse-config.json'));

  const stubDir = path.join(dir, 'node_modules', '@whiskeysockets', 'baileys');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.copyFileSync(STUB, path.join(stubDir, 'index.js'));

  if (creds || rawCreds) {
    fs.mkdirSync(path.join(dir, 'auth'));
    fs.writeFileSync(path.join(dir, 'auth', 'creds.json'), rawCreds || JSON.stringify(creds));
  }
  const logFile = path.join(dir, 'sim.log');
  const queueFile = path.join(dir, 'sim-queue');
  fs.writeFileSync(logFile, '');
  fs.mkdirSync(queueFile);
  let batch = 0;

  const p = (rel) => path.join(dir, rel);
  const events = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);

  const kit = {
    dir,
    path: p,
    exists: (rel) => fs.existsSync(p(rel)),
    mode: (rel) => (fs.existsSync(p(rel)) ? fs.statSync(p(rel)).mode & 0o777 : null),
    readJson: (rel) => JSON.parse(fs.readFileSync(p(rel), 'utf8')),
    events,
    count: (name) => events().filter((e) => e === name).length,
    sends: () => events().filter((e) => e.startsWith('send ')).map((e) => JSON.parse(e.slice(5))),
    /** Put messages in the stub server's offline queue for the next login. */
    queue(messages) {
      const name = `${String(++batch).padStart(6, '0')}.json`;
      fs.writeFileSync(path.join(queueFile, `${name}.tmp`), JSON.stringify(messages));
      fs.renameSync(path.join(queueFile, `${name}.tmp`), path.join(queueFile, name));
    },
    /** True once every queued batch has been delivered. */
    queueEmpty: () => fs.readdirSync(queueFile).filter((n) => n.endsWith('.json')).length === 0,
    run(script, args, { sim = {}, timeout = 15000, env = {} } = {}) {
      const started = Date.now();
      // A minimal env: no proxy variables and no NODE_PATH, so nothing can
      // route around the stub.
      const res = spawnSync(process.execPath, [script, ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH, WA_SIM: JSON.stringify(sim), WA_SIM_LOG: logFile, WA_SIM_QUEUE: queueFile, ...env },
        encoding: 'utf8',
        timeout,
      });
      const results = (res.stdout || '').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return { unparsed: line }; } })
        .filter((o) => !('qr' in o));
      return {
        exit: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        results,
        result: results[results.length - 1],
        ms: Date.now() - started,
      };
    },
    cli(args, opts) { return kit.run('bin/whatsapp-cli.cjs', args, opts); },
    /** Start bin/listen.cjs in the background; its output goes to listener.log. */
    startListener({ sim = {}, env = {} } = {}) {
      const out = fs.openSync(p('listener.log'), 'a');
      const child = spawn(process.execPath, ['bin/listen.cjs'], {
        cwd: dir,
        env: { PATH: process.env.PATH, WA_SIM: JSON.stringify(sim), WA_SIM_LOG: logFile, WA_SIM_QUEUE: queueFile, ...env },
        stdio: ['ignore', out, out],
      });
      fs.closeSync(out);
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      kit.listeners.push(child);
      return {
        child,
        exited,
        log: () => (fs.existsSync(p('listener.log')) ? fs.readFileSync(p('listener.log'), 'utf8') : ''),
        async stop() {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          return exited;
        },
      };
    },
    listeners: [],
    cleanup() {
      for (const child of kit.listeners) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return kit;
}

/** Poll an async or sync predicate until it returns a truthy value. */
async function waitUntil(pred, { timeout = 8000, every = 150, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await pred();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** Run the CLI without blocking this process (so a listener child keeps running). */
function cliAsync(kit, args, { sim = {}, timeout = 15000, env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, ['bin/whatsapp-cli.cjs', ...args], {
      cwd: kit.dir,
      env: { PATH: process.env.PATH, WA_SIM: JSON.stringify(sim), WA_SIM_LOG: kit.path('sim.log'), WA_SIM_QUEUE: kit.path('sim-queue'), ...env },
      encoding: 'utf8',
      timeout,
    }, (error, stdout, stderr) => {
      const results = (stdout || '').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return { unparsed: line }; } });
      resolve({
        exit: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout, stderr, results, result: results[results.length - 1], ms: Date.now() - started,
      });
    });
  });
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A received WhatsApp message in the shape Baileys emits. */
function waMessage({ chat, id, text, from, name, ts = nowSec(), fromMe = false, message }) {
  const isGroup = chat.endsWith('@g.us');
  return {
    key: { remoteJid: chat, id, fromMe, ...(isGroup && !fromMe ? { participant: from } : {}) },
    pushName: fromMe ? undefined : name,
    messageTimestamp: ts,
    message: message !== undefined ? message : { conversation: text },
  };
}

/** A process id that is guaranteed not to be running. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

module.exports = { createKit, waMessage, nowSec, deadPid, waitUntil, cliAsync, QR_LINKED, KIT_ROOT };
