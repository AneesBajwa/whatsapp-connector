'use strict';
/**
 * Listener lifecycle and recovery after a VM replacement:
 * - lifecycle events (Kind: lifecycle files in requests/) and the heartbeat
 * - a restarted listener reports how the last run ended, and missed prompts
 * - deploy/install-listener.sh reinstalls a wiped unit and starts the listener
 *   (against a fake systemctl that runs the real listener with the stub)
 * - the CLI fallback (listener.autostart) brings the listener back on use
 * Nothing here touches WhatsApp, systemd or the real kit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createKit, waMessage, waitUntil, cliAsync, nowSec, QR_LINKED, KIT_ROOT } = require('./helpers/harness.cjs');
const { createLifecycle } = require('../lib/lifecycle.cjs');

const GROUP = '120363000000000001@g.us';
const CONFIG = { watchlist: [{ jid: GROUP, name: 'Test Group' }] };
const LC_CONFIG = { ownerName: 'Alex', promptMaxAgeMinutes: 60, health: { alertAfterMinutes: 10 } };

const events = (dir) => (fs.existsSync(path.join(dir, 'requests'))
  ? fs.readdirSync(path.join(dir, 'requests')).filter((f) => f.includes('-lifecycle-')).sort()
    .map((f) => fs.readFileSync(path.join(dir, 'requests', f), 'utf8'))
  : []);
const eventOf = (body) => (body.match(/^Event: (.+)$/m) || [])[1];
// LC_CONFIG names the owner; listener runs without an ownerName fall back to the default.
const notifies = (body) => /Tell (Alex|the owner) in the Muse app/.test(body);
const requestFiles = (kit) => (kit.exists('requests') ? fs.readdirSync(kit.path('requests')).filter((f) => f.endsWith('.md') && !f.includes('-lifecycle-')) : []);

function tmpRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lifecycle-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- lifecycle module

test('lifecycle: a first run reports started; a clean stop reports stopped and is remembered', () => tmpRoot((root) => {
  const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000 });
  lc.started();
  lc.stopped('SIGTERM');
  const [started, stopped] = events(root);
  assert.equal(eventOf(started), 'started');
  assert.match(started, /^Kind: lifecycle$/m);
  assert.match(started, /no record of an earlier run/);
  assert.equal(notifies(started), false);
  assert.equal(eventOf(stopped), 'stopped');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'listener-state.json'), 'utf8'));
  assert.equal(state.stopReason, 'SIGTERM');
  assert.ok(state.stoppedAt);
}));

test('lifecycle: after a VM replacement the start says when the old run was last alive and that the machine restarted', () => tmpRoot((root) => {
  const t = Date.now();
  // The old run: heartbeat 40 minutes ago, no clean stop; the machine booted 5 minutes ago.
  fs.writeFileSync(path.join(root, 'listener-state.json'), JSON.stringify({ pid: 1, startedAt: new Date(t - 3 * 3600000).toISOString(), lastAliveAt: new Date(t - 40 * 60000).toISOString() }));
  const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, bootAt: () => t - 5 * 60000 });
  assert.equal(lc.previous.clean, false);
  assert.equal(lc.previous.machineRestarted, true);
  lc.started();
  lc.stopped('SIGTERM');
  const [started] = events(root);
  assert.match(started, /ended without a clean stop/);
  assert.match(started, /about 40 minutes/);
  assert.match(started, /the VM was replaced or rebooted/);
  assert.equal(notifies(started), true, 'down longer than the alert threshold');
}));

test('lifecycle: a quick clean restart is nothing to tell anyone about', () => tmpRoot((root) => {
  const t = Date.now();
  fs.writeFileSync(path.join(root, 'listener-state.json'), JSON.stringify({ pid: 1, startedAt: new Date(t - 3600000).toISOString(), lastAliveAt: new Date(t - 5000).toISOString(), stoppedAt: new Date(t - 5000).toISOString(), stopReason: 'SIGTERM' }));
  const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, bootAt: () => t - 86400000 });
  lc.started();
  const [started] = events(root);
  assert.match(started, /stopped cleanly \(SIGTERM\)/);
  assert.doesNotMatch(started, /machine restarted/);
  assert.equal(notifies(started), false);
}));

test('lifecycle: crashes add up to one crash-loop event; only the first crash and the loop notify', () => tmpRoot((root) => {
  let t = Date.now();
  const run = () => createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000 });
  for (let i = 0; i < 5; i++) {
    const lc = run();
    lc.started();
    lc.stopped('crashed', 'boom');
    t += 20000;
  }
  const all = events(root);
  const kinds = all.map(eventOf);
  assert.equal(kinds.filter((k) => k === 'crash-loop').length, 1);
  assert.equal(kinds.indexOf('crash-loop'), kinds.length - 1, 'nothing more once the loop is reported');
  assert.deepEqual(all.filter(notifies).map(eventOf), ['crashed', 'crash-loop']);
}));

test('lifecycle: VM replacements are not a crash loop', () => tmpRoot((root) => {
  let t = Date.now();
  // Three runs in 30 minutes, each ended by the VM going away (machine rebooted since).
  for (let i = 0; i < 4; i++) {
    const boot = t - 1000;
    const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => boot });
    lc.started();
    // die without a clean stop: just leave the state file as the heartbeat wrote it
    t += 10 * 60000;
  }
  assert.ok(!events(root).some((b) => eventOf(b) === 'crash-loop'));
  assert.equal(events(root).filter((b) => eventOf(b) === 'started').length, 4);
}));

test('lifecycle: a listener killed every 5 minutes on the same boot is a loop', () => tmpRoot((root) => {
  let t = Date.now();
  for (let i = 0; i < 4; i++) {
    const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000 });
    lc.started();
    t += 5 * 60000; // then killed: no clean stop, same boot
  }
  assert.equal(events(root).filter((b) => eventOf(b) === 'crash-loop').length, 1);
}));

test('lifecycle: a crash loop ended by a clean restart still reports recovered once a run lasts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lifecycle-test-'));
  try {
    let t = Date.now();
    const run = (extra = {}) => createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000, ...extra });
    for (let i = 0; i < 3; i++) {
      const lc = run();
      lc.started();
      lc.stopped('crashed', 'boom');
      t += 10000;
    }
    const looping = run();
    looping.started(); // announces the loop
    looping.stopped('SIGTERM'); // someone fixed it and restarted the service
    t += 5000;
    const fixed = run({ recoveryMs: 50 });
    fixed.started();
    await waitUntil(() => events(root).some((b) => eventOf(b) === 'recovered'), { what: 'recovered', timeout: 2000 });
    fixed.stopped('SIGTERM');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle: a start-up crash after an outage does not hide the real gap', () => tmpRoot((root) => {
  const T0 = Date.parse('2026-11-06T08:00:00Z');
  let t = T0 - 3600000;
  const boot1 = t - 1000;
  const a = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => boot1 });
  a.started();
  a.setListening(true);
  t = T0;
  a.setListening(false); // the VM goes away at 08:00
  t = T0 + 3 * 3600000; // three hours later a new VM boots
  const boot2 = t - 30000;
  const b = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => boot2 });
  t += 3000;
  b.stopped('crashed', 'proxy agent unavailable'); // dies during start-up, never connected
  t += 10000;
  const c = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => boot2 });
  assert.equal(c.unheardSince(), Math.floor(T0 / 1000), 'prompts are checked from when it last listened');
  c.started();
  const started = events(root).filter((b2) => eventOf(b2) === 'started').pop();
  assert.match(started, /Nothing has been listening since 2026-11-06T08:00:00\.000Z \(about 3 hours\)/);
  assert.equal(notifies(started), true);
}));

test('lifecycle: a crash every 5 minutes is a loop too', () => tmpRoot((root) => {
  let t = Date.now();
  for (let i = 0; i < 4; i++) {
    const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000 });
    lc.started();
    t += 5 * 60000;
    lc.stopped('crashed', 'timer threw');
    t += 10000;
  }
  assert.equal(events(root).filter((b) => eventOf(b) === 'crash-loop').length, 1);
}));

test('lifecycle: when every run dies during start-up, the loop is still reported', () => tmpRoot((root) => {
  let t = Date.now();
  for (let i = 0; i < 4; i++) {
    const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000 });
    lc.stopped('crashed', 'bad config'); // started() never reached
    t += 10000;
  }
  const kinds = events(root).map(eventOf);
  assert.equal(kinds[0], 'crashed');
  assert.equal(kinds.filter((k) => k === 'crash-loop').length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'listener-state.json'), 'utf8'));
  assert.equal(state.stopReason, 'crashed', 'the crash itself is still recorded');
}));

test('lifecycle: after a crash loop, a run that stays up reports that it recovered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lifecycle-test-'));
  try {
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000 });
      lc.started();
      lc.stopped('crashed', 'boom');
      t += 10000;
    }
    const lc = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t, bootAt: () => t - 86400000, recoveryMs: 50 });
    lc.started();
    await waitUntil(() => events(root).some((b) => eventOf(b) === 'recovered'), { what: 'recovered event', timeout: 2000 });
    assert.equal(notifies(events(root).find((b) => eventOf(b) === 'recovered')), true);
    lc.stopped('SIGTERM');
    const next = createLifecycle({ root, config: LC_CONFIG, heartbeatMs: 3600000, now: () => t + 1000, bootAt: () => t - 86400000 });
    assert.equal(next.looping, false, 'the loop is over');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listener: a failure during start-up (malformed config) is reported as a crash, not only logged', async () => {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  fs.writeFileSync(kit.path('muse-config.json'), '{ "watchlist": [ oops');
  const listener = kit.startListener();
  try {
    const exit = await listener.exited;
    assert.equal(exit.code, 1);
    const crashed = events(kit.dir).find((b) => eventOf(b) === 'crashed');
    assert.ok(crashed, 'a crashed event was written');
    assert.match(crashed, /muse-config\.json/);
    assert.equal(notifies(crashed), true);
  } finally {
    kit.cleanup();
  }
});

// ---------------------------------------------------------------- listener recovery

test('listener: back after an outage, it reports the gap, picks up a fresh prompt and lists the one it missed', async () => {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  // As left by a run that died with the VM 3 hours ago.
  fs.writeFileSync(kit.path('listener-state.json'), JSON.stringify({ pid: 1, startedAt: new Date(Date.now() - 5 * 3600000).toISOString(), lastAliveAt: new Date(Date.now() - 3 * 3600000).toISOString() }));
  kit.queue([
    waMessage({ chat: GROUP, id: 'OLD1', text: '@agent what are the open roles', fromMe: true, ts: nowSec() - 2 * 3600 }),
    waMessage({ chat: GROUP, id: 'NEW1', text: '@agent who confirmed today', fromMe: true, ts: nowSec() - 4 * 60 }),
  ]);
  const listener = kit.startListener();
  try {
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'missed-prompts'), { what: 'missed-prompts event', timeout: 20000 });
    await waitUntil(() => requestFiles(kit).some((f) => f.includes('NEW1')), { what: 'fresh prompt picked up' });
    const started = events(kit.dir).find((b) => eventOf(b) === 'started');
    assert.match(started, /ended without a clean stop/);
    assert.equal(notifies(started), true);
    const missed = events(kit.dir).find((b) => eventOf(b) === 'missed-prompts');
    assert.match(missed, /id OLD1/);
    assert.doesNotMatch(missed, /NEW1/);
    assert.ok(!requestFiles(kit).some((f) => f.includes('OLD1')), 'too old to answer on its own');
  } finally {
    await listener.stop();
  }
  assert.ok(events(kit.dir).some((b) => eventOf(b) === 'stopped'), 'a clean stop is reported');
  kit.cleanup();
});

test('listener: a prompt missed in a 1:1 chat (not on the watchlist) is listed too', async () => {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  fs.writeFileSync(kit.path('listener-state.json'), JSON.stringify({ pid: 1, startedAt: new Date(Date.now() - 5 * 3600000).toISOString(), lastAliveAt: new Date(Date.now() - 3 * 3600000).toISOString() }));
  kit.queue([waMessage({ chat: '14375550000@s.whatsapp.net', id: 'DM1', text: '@agent book the table', fromMe: true, ts: nowSec() - 2 * 3600 })]);
  const listener = kit.startListener();
  try {
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'missed-prompts'), { what: 'missed-prompts event', timeout: 20000 });
    assert.match(events(kit.dir).find((b) => eventOf(b) === 'missed-prompts'), /id DM1/);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
});

test('listener: a typo fixed by an edit during an outage is listed as missed', async () => {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  // Sent with a typo 100 minutes ago, stored by a one-shot run...
  kit.queue([waMessage({ chat: GROUP, id: 'TY1', text: '@agnet who is coming?', fromMe: true, ts: nowSec() - 100 * 60 })]);
  assert.equal(kit.cli(['status']).exit, 0);
  // ...then the listener went down 90 minutes ago, and the fix arrives when it is back.
  fs.writeFileSync(kit.path('listener-state.json'), JSON.stringify({ pid: 1, startedAt: new Date(Date.now() - 5 * 3600000).toISOString(), lastAliveAt: new Date(Date.now() - 90 * 60000).toISOString() }));
  kit.queue([{ __update: [{ key: { remoteJid: GROUP, id: 'TY1', fromMe: true }, update: { message: { editedMessage: { message: { conversation: '@agent who is coming?' } } } } }] }]);
  const listener = kit.startListener();
  try {
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'missed-prompts'), { what: 'missed-prompts event', timeout: 20000 });
    assert.match(events(kit.dir).find((b) => eventOf(b) === 'missed-prompts'), /id TY1/);
  } finally {
    await listener.stop();
    kit.cleanup();
  }
});

// ---------------------------------------------------------------- deploy/install-listener.sh

// The kit's own unit, with the placeholders the shipped template has. Never
// the project's deploy/ copy: on the VM that one is filled in for real.
const UNIT_TEMPLATE = `[Unit]
Description=Muse WhatsApp listener (test)

[Service]
Type=simple
User=<user that owns the connector folder>
WorkingDirectory=<absolute path to the connector folder>
Environment=NODE_USE_ENV_PROXY=1
EnvironmentFile=-<absolute path to the connector folder>/listener.env
ExecStart=<absolute path to node> bin/listen.cjs
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=2

[Install]
WantedBy=multi-user.target
`;

/**
 * A kit with the installer, its own unit template, and a fake systemctl
 * (passed as SYSTEMCTL, so the real one is never reachable) whose "start"
 * runs the real listener against the stub library, detached like systemd does.
 */
function installerKit() {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  fs.mkdirSync(kit.path('deploy'));
  fs.copyFileSync(path.join(KIT_ROOT, 'deploy', 'install-listener.sh'), kit.path('deploy/install-listener.sh'));
  fs.chmodSync(kit.path('deploy/install-listener.sh'), 0o755);
  fs.writeFileSync(kit.path('deploy/muse-whatsapp-listener.service'), UNIT_TEMPLATE);
  const fake = kit.path('fakebin');
  fs.mkdirSync(fake);
  const systemctl = path.join(fake, 'fake-systemctl');
  fs.writeFileSync(systemctl, `#!/usr/bin/env bash
S="$FAKE_SYSTEMD"; mkdir -p "$S"
echo "$*" >> "$S/calls"
case "$1" in
  daemon-reload) ;;
  is-enabled) [ -f "$S/enabled" ] ;;
  enable) touch "$S/enabled" ;;
  is-active) [ -f "$S/pid" ] && kill -0 "$(cat "$S/pid")" 2>/dev/null ;;
  start|try-restart)
    if [ "$1" = try-restart ] && [ -f "$S/pid" ]; then kill "$(cat "$S/pid")" 2>/dev/null; sleep 1; fi
    cd "$KIT_DIR" || exit 1
    # Like systemd: the service is detached and holds none of our descriptors.
    nohup "$NODE_BIN" bin/listen.cjs </dev/null >> listener.log 2>&1 9>&- &
    echo $! > "$S/pid" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  // For the CLI fallback: sudo -n <cmd> runs <cmd> (the tests are not root).
  fs.writeFileSync(path.join(fake, 'sudo'), '#!/usr/bin/env bash\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  const env = {
    PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    SYSTEMCTL: systemctl,
    FAKE_SYSTEMD: kit.path('fake-systemd'), KIT_DIR: kit.dir, NODE_BIN: process.execPath,
    UNIT_DIR: kit.path('etc-systemd'), SOCKET_WAIT_S: '20',
    WA_SIM: '{}', WA_SIM_LOG: kit.path('sim.log'), WA_SIM_QUEUE: kit.path('sim-queue'),
  };
  const install = (...args) => {
    const started = Date.now();
    const r = spawnSync('bash', [kit.path('deploy/install-listener.sh'), ...args], { cwd: kit.dir, env, encoding: 'utf8', timeout: 90000 });
    return { ...r, ms: Date.now() - started };
  };
  const listenerPid = () => { try { return Number(fs.readFileSync(kit.path('fake-systemd/pid'), 'utf8')); } catch { return null; } };
  const kill = (signal = 'SIGTERM') => { const pid = listenerPid(); if (pid) { try { process.kill(pid, signal); } catch { /* gone */ } } };
  const finish = async () => {
    kill();
    await waitUntil(() => !kit.exists('listener.sock'), { what: 'listener stopped' }).catch(() => kill('SIGKILL'));
    kit.cleanup();
  };
  return { kit, env, install, listenerPid, kill, finish };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('install-listener: with the unit wiped (VM replaced), it reinstalls it, starts the listener and reports it; a second run does nothing', async () => {
  const { kit, install, listenerPid, finish } = installerKit();
  try {
    const r = install('--reason', 'boot');
    assert.equal(r.status, 0, r.stderr);
    const unit = fs.readFileSync(kit.path('etc-systemd/muse-whatsapp-listener.service'), 'utf8');
    assert.match(unit, new RegExp(`^WorkingDirectory=${esc(kit.dir)}$`, 'm'));
    assert.doesNotMatch(unit, /^(User|WorkingDirectory|EnvironmentFile|ExecStart)=.*<[^>]*>/m, 'every placeholder filled');
    assert.ok(kit.exists('listener.sock'), 'listener is up');
    const calls = fs.readFileSync(kit.path('fake-systemd/calls'), 'utf8');
    assert.match(calls, /daemon-reload/);
    assert.match(calls, /^enable muse-whatsapp-listener$/m);
    assert.match(calls, /^start muse-whatsapp-listener$/m);
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'started'), { what: 'started event' });
    const installed = events(kit.dir).find((b) => eventOf(b) === 'listener-installed');
    assert.match(installed, /unit file was missing/);
    assert.match(installed, /brought the WhatsApp listener back/);
    const status = await cliAsync(kit, ['status']);
    assert.equal(status.result.connected, true);
    assert.ok(status.result.listener, 'answered by the listener');
    console.log(`# install-listener: unit wiped -> listener up and event written in ${r.ms} ms`);

    const before = events(kit.dir).length;
    const again = install('--reason', 'boot');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /nothing to do/);
    assert.ok(again.ms < 10000, `a no-op run is quick (took ${again.ms} ms)`);
    assert.equal(events(kit.dir).length, before, 'no event when nothing changed');
    assert.ok(listenerPid());
  } finally {
    await finish();
  }
});

test('install-listener: after the listener is killed with the VM and /etc is wiped, the next boot run brings it back past the stale socket', async () => {
  const { kit, install, kill, finish } = installerKit();
  try {
    assert.equal(install().status, 0);
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'started'), { what: 'first start' });
    // VM replacement: the process dies without a clean stop; /etc and the enable link are gone.
    kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(kit.path('etc-systemd'), { recursive: true, force: true });
    fs.rmSync(kit.path('fake-systemd'), { recursive: true, force: true });
    assert.ok(kit.exists('listener.sock'), 'the dead listener left its socket behind, as in the persistent home folder');
    const r = install('--reason', 'boot');
    assert.equal(r.status, 0, r.stderr);
    await waitUntil(() => events(kit.dir).filter((b) => eventOf(b) === 'started').length === 2, { what: 'second start' });
    const second = events(kit.dir).filter((b) => eventOf(b) === 'started')[1];
    assert.match(second, /ended without a clean stop/);
    console.log(`# install-listener: killed + /etc wiped -> back in ${r.ms} ms`);
  } finally {
    await finish();
  }
});

test('install-listener: a unit in /etc that differs is reported and left alone, and replaced with --force', async () => {
  const { kit, install, finish } = installerKit();
  try {
    assert.equal(install().status, 0);
    const dest = kit.path('etc-systemd/muse-whatsapp-listener.service');
    fs.writeFileSync(dest, `${fs.readFileSync(dest, 'utf8')}# local change\n`);
    const r = install('--reason', 'manual');
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(dest, 'utf8'), /# local change/, 'left alone');
    const differs = events(kit.dir).find((b) => eventOf(b) === 'unit-differs');
    assert.ok(differs);
    assert.equal(notifies(differs), true);
    assert.equal(install('--reason', 'manual').status, 0);
    assert.equal(events(kit.dir).filter((b) => eventOf(b) === 'unit-differs').length, 1, 'the same difference is announced once');
    const forced = install('--reason', 'manual', '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.doesNotMatch(fs.readFileSync(dest, 'utf8'), /# local change/);
    assert.match(fs.readFileSync(kit.path('fake-systemd/calls'), 'utf8'), /^try-restart muse-whatsapp-listener$/m);
  } finally {
    await finish();
  }
});

test('install-listener: with no systemd it fails with an event, and the same failure is announced once', () => {
  const { kit, env, finish } = installerKit();
  const run = () => spawnSync('bash', [kit.path('deploy/install-listener.sh')], {
    cwd: kit.dir, env: { ...env, SYSTEMCTL: kit.path('fakebin/no-such-systemctl') }, encoding: 'utf8',
  });
  try {
    const r = run();
    assert.equal(r.status, 1);
    assert.equal(run().status, 1);
    const failed = events(kit.dir).filter((b) => eventOf(b) === 'install-failed');
    assert.equal(failed.length, 1, 'repeated failures are not re-announced');
    assert.match(failed[0], /systemctl not found/);
    assert.equal(notifies(failed[0]), true);
  } finally {
    return finish();
  }
});

test('install-listener: --reason without a value is an error, not a hang', () => {
  const { kit, env, finish } = installerKit();
  try {
    const r = spawnSync('bash', [kit.path('deploy/install-listener.sh'), '--reason'], { cwd: kit.dir, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs a value/);
  } finally {
    return finish();
  }
});

// ---------------------------------------------------------------- CLI fallback

test('cli fallback: with listener.autostart, a command that finds no listener runs the installer and goes through the listener', async () => {
  const { kit, env, install, finish } = installerKit();
  try {
    // Enable the fallback the way the handoff does, then take the listener down.
    assert.equal(install('--reason', 'manual', '--cli-fallback').status, 0);
    assert.equal(fs.readFileSync(kit.path('listener.autostart'), 'utf8'), '', 'an empty marker');
    await waitUntil(() => events(kit.dir).some((b) => eventOf(b) === 'started'), { what: 'first start' });
    const pid = Number(fs.readFileSync(kit.path('fake-systemd/pid'), 'utf8'));
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(kit.exists('listener.sock'), 'stale socket left behind');
    const r = await cliAsync(kit, ['status'], { timeout: 90000, env });
    assert.equal(r.exit, 0, r.stderr);
    assert.equal(r.result.connected, true);
    assert.ok(r.result.listener, 'answered by the listener it started');
    assert.match(r.stderr, /listener started in \d+s/);
    assert.match(fs.readFileSync(kit.path('deploy/install-listener.log'), 'utf8'), /\[cli\]/);
  } finally {
    await finish();
  }
});

test('cli fallback: not without listener.autostart, not for an unlinked session, and at most once every 5 minutes', async () => {
  const { kit, env, finish } = installerKit();
  try {
    let r = kit.cli(['status']);
    assert.equal(r.exit, 0);
    assert.equal(r.result.listener, undefined);
    assert.doesNotMatch(r.stderr, /starting it/);

    fs.writeFileSync(kit.path('listener.autostart'), '');
    fs.writeFileSync(kit.path('.listener-revive-at'), 'recent');
    r = await cliAsync(kit, ['status'], { env });
    assert.doesNotMatch(r.stderr, /starting it/, 'tried recently: no second attempt');

    // A stamp dated in the future (a replacement VM whose clock is behind) does not block the fallback.
    const future = new Date(Date.now() + 3600000);
    fs.utimesSync(kit.path('.listener-revive-at'), future, future);
    fs.writeFileSync(kit.path('auth/creds.json'), JSON.stringify({ registered: false })); // unlinked: no attempt either way
    r = await cliAsync(kit, ['status'], { env });
    assert.doesNotMatch(r.stderr, /starting it/);
    fs.writeFileSync(kit.path('auth/creds.json'), JSON.stringify(QR_LINKED));
    r = await cliAsync(kit, ['status'], { env, timeout: 90000 });
    assert.match(r.stderr, /starting it/, 'the future stamp counts as old');
    fs.rmSync(kit.path('.listener-revive-at'));
    fs.writeFileSync(kit.path('auth/creds.json'), JSON.stringify({ registered: false }));
    r = await cliAsync(kit, ['status'], { env });
    assert.doesNotMatch(r.stderr, /starting it/, 'unlinked: the listener could not start anyway');
  } finally {
    await finish();
  }
});
