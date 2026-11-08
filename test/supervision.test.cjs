'use strict';
/**
 * Supervision without a watchdog: systemd restarts the listener whatever
 * the exit (Restart=always, never rate-limited), and in user scope the unit
 * and its enable link live in the home folder, which survives a VM
 * replacement. A fake systemctl (system and --user) and a fake loginctl
 * stand in for the real ones; "start" runs the real listener against the
 * stub library. Nothing here touches the machine's systemd.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createKit, waitUntil, cliAsync, QR_LINKED, KIT_ROOT } = require('./helpers/harness.cjs');

const GROUP = '120363000000000001@g.us';
const CONFIG = { watchlist: [{ jid: GROUP, name: 'Test Group' }] };
const UNIT = 'muse-whatsapp-listener';
const ME = os.userInfo().username;

// ---------------------------------------------------------------- the unit files

function unitSettings(file) {
  const text = fs.readFileSync(path.join(KIT_ROOT, 'deploy', file), 'utf8');
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const s = line.match(/^\[(\w+)\]$/);
    if (s) { current = s[1]; sections[current] = {}; continue; }
    const kv = line.match(/^([A-Za-z]+)=(.*)$/);
    if (kv && current) sections[current][kv[1]] = kv[2];
  }
  return sections;
}

for (const file of [`${UNIT}.service`, `${UNIT}.user.service`]) {
  test(`unit ${file}: restarts the listener after any exit, with no start limit, except "not linked" (2) and "another listener" (3)`, () => {
    const u = unitSettings(file);
    assert.equal(u.Service.Restart, 'always');
    assert.equal(u.Service.RestartPreventExitStatus, '2 3');
    assert.equal(u.Unit.StartLimitIntervalSec, '0', 'systemd never gives up restarting');
    assert.ok(Number(u.Service.RestartSec) > 0);
    assert.match(u.Service.ExecStart, / bin\/listen\.cjs$/);
  });
}

test('unit (user scope): no User= line, and started by the user\'s own systemd at boot', () => {
  const u = unitSettings(`${UNIT}.user.service`);
  assert.equal(u.Service.User, undefined);
  assert.equal(u.Install.WantedBy, 'default.target');
});

// ---------------------------------------------------------------- the fake machine

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
SCOPE=system
if [ "$1" = --user ]; then SCOPE=user; shift; fi
S="$FAKE_SYSTEMD/$SCOPE"; mkdir -p "$S"
echo "$SCOPE $*" >> "$FAKE_SYSTEMD/calls"
CMD="$1"; shift
[ "$1" = --quiet ] && shift
WANTS="$HOME/.config/systemd/user/default.target.wants"
case "$CMD" in
  show-environment)
    if [ "$SCOPE" = user ] && [ -n "$FAKE_NO_USER_MANAGER" ]; then echo "Failed to connect to bus" >&2; exit 1; fi
    # A user with no session: their systemd runs only once lingering is on.
    if [ "$SCOPE" = user ] && [ -n "$FAKE_MANAGER_NEEDS_LINGER" ] && [ ! -f "$FAKE_LINGER_DIR/$(id -un)" ]; then echo "Failed to connect to bus" >&2; exit 1; fi
    echo "HOME=$HOME" ;;
  daemon-reload) ;;
  is-enabled)
    if [ "$SCOPE" = user ]; then [ -L "$WANTS/$1.service" ]; else [ -f "$S/enabled" ]; fi ;;
  enable)
    if [ "$SCOPE" = user ]; then mkdir -p "$WANTS" && ln -sf "$HOME/.config/systemd/user/$1.service" "$WANTS/$1.service"
    else touch "$S/enabled"; fi ;;
  is-active) [ -f "$S/pid" ] && kill -0 "$(cat "$S/pid")" 2>/dev/null ;;
  start|try-restart)
    if [ "$CMD" = try-restart ] && [ -f "$S/pid" ]; then kill "$(cat "$S/pid")" 2>/dev/null; sleep 1; fi
    cd "$KIT_DIR" || exit 1
    nohup "$NODE_BIN" bin/listen.cjs </dev/null >> listener.log 2>&1 9>&- &
    echo $! > "$S/pid" ;;
  *) exit 1 ;;
esac
`;

// /var/lib/systemd/linger/<user> on a real machine.
const FAKE_LOGINCTL = `#!/usr/bin/env bash
mkdir -p "$FAKE_LINGER_DIR"
case "$1" in
  show-user) [ -f "$FAKE_LINGER_DIR/$2" ] && echo yes || echo no ;;
  enable-linger) [ -n "$FAKE_LINGER_DENIED" ] && exit 1; touch "$FAKE_LINGER_DIR/$2" ;;
  *) exit 1 ;;
esac
`;

function machine({ env: extraEnv = {} } = {}) {
  const kit = createKit({ creds: QR_LINKED, config: CONFIG });
  fs.mkdirSync(kit.path('deploy'));
  for (const f of ['install-listener.sh', `${UNIT}.service`, `${UNIT}.user.service`]) {
    fs.copyFileSync(path.join(KIT_ROOT, 'deploy', f), kit.path(`deploy/${f}`));
  }
  fs.chmodSync(kit.path('deploy/install-listener.sh'), 0o755);
  const fake = kit.path('fakebin');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'fake-systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'fake-loginctl'), FAKE_LOGINCTL, { mode: 0o755 });
  // sudo -n <cmd> runs <cmd> (the tests are not root).
  fs.writeFileSync(path.join(fake, 'sudo'), '#!/usr/bin/env bash\n[ "$1" = "-n" ] && shift\nexec "$@"\n', { mode: 0o755 });
  const home = kit.path('home');
  fs.mkdirSync(home);
  const env = {
    PATH: `${fake}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, XDG_RUNTIME_DIR: kit.path('run-user'),
    SYSTEMCTL: path.join(fake, 'fake-systemctl'), LOGINCTL: path.join(fake, 'fake-loginctl'),
    FAKE_SYSTEMD: kit.path('fake-systemd'), FAKE_LINGER_DIR: kit.path('var-lib-systemd/linger'),
    KIT_DIR: kit.dir, NODE_BIN: process.execPath, SOCKET_WAIT_S: '20', USER_MANAGER_WAIT_S: '2',
    USER_UNIT_DIR: path.join(home, '.config/systemd/user'),
    WA_SIM: '{}', WA_SIM_LOG: kit.path('sim.log'), WA_SIM_QUEUE: kit.path('sim-queue'),
    ...extraEnv,
  };
  const install = (...args) => spawnSync('bash', [kit.path('deploy/install-listener.sh'), ...args], { cwd: kit.dir, env, encoding: 'utf8', timeout: 90000 });
  const pidOf = (scope) => { try { return Number(fs.readFileSync(kit.path(`fake-systemd/${scope}/pid`), 'utf8')); } catch { return null; } };
  const kill = (scope, signal = 'SIGTERM') => { const pid = pidOf(scope); if (pid) { try { process.kill(pid, signal); } catch { /* gone */ } } };
  const userUnitDir = path.join(home, '.config/systemd/user');
  /** What the user's systemd does at boot: with lingering on, start every unit wanted by default.target. */
  const boot = () => {
    if (!fs.existsSync(path.join(env.FAKE_LINGER_DIR, ME))) return [];
    const wants = path.join(userUnitDir, 'default.target.wants');
    const started = [];
    for (const link of fs.existsSync(wants) ? fs.readdirSync(wants) : []) {
      if (!fs.existsSync(path.join(wants, link))) continue; // a dangling link starts nothing
      spawnSync(env.SYSTEMCTL, ['--user', 'start', link.replace(/\.service$/, '')], { env, cwd: kit.dir });
      started.push(link);
    }
    return started;
  };
  const finish = async () => {
    kill('user'); kill('system');
    await waitUntil(() => !kit.exists('listener.sock'), { what: 'listener stopped' }).catch(() => { kill('user', 'SIGKILL'); kill('system', 'SIGKILL'); });
    kit.cleanup();
  };
  return { kit, env, install, pidOf, kill, boot, userUnitDir, finish };
}

const events = (dir) => (fs.existsSync(path.join(dir, 'requests')) ? fs.readdirSync(path.join(dir, 'requests')) : [])
  .filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(dir, 'requests', f), 'utf8'))
  .filter((b) => /^Kind: lifecycle$/m.test(b));
const eventOf = (b) => (b.match(/^Event: (\S+)$/m) || [])[1];
const started = (kit) => events(kit.dir).filter((b) => eventOf(b) === 'started');

// ---------------------------------------------------------------- user scope

test('install --scope user: unit and enable link in the home folder, lingering on, listener up; a second run changes nothing', async () => {
  const m = machine();
  try {
    const r = m.install('--scope', 'user', '--reason', 'manual');
    assert.equal(r.status, 0, r.stderr);
    const unitFile = path.join(m.userUnitDir, `${UNIT}.service`);
    const unit = fs.readFileSync(unitFile, 'utf8');
    assert.match(unit, /^Restart=always$/m);
    assert.doesNotMatch(unit, /^User=/m);
    assert.doesNotMatch(unit, /^(WorkingDirectory|EnvironmentFile|ExecStart)=.*<[^>]*>/m, 'every placeholder filled');
    assert.match(unit, new RegExp(`^WorkingDirectory=${m.kit.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal(fs.realpathSync(path.join(m.userUnitDir, 'default.target.wants', `${UNIT}.service`)), fs.realpathSync(unitFile), 'enabled, in the home folder');
    assert.ok(fs.existsSync(path.join(m.env.FAKE_LINGER_DIR, ME)), 'lingering turned on');
    assert.ok(!fs.existsSync(m.kit.path('fake-systemd/system/enabled')), 'nothing installed system-wide');
    assert.equal(fs.readFileSync(m.kit.path('deploy/.listener-scope'), 'utf8').trim(), 'user');
    assert.ok(m.kit.exists('listener.sock'));
    await waitUntil(() => started(m.kit).length === 1, { what: 'started event' });
    const installed = events(m.kit.dir).find((b) => eventOf(b) === 'listener-installed');
    assert.match(installed, /user scope/);
    assert.match(installed, /lingering was off/);
    assert.ok((await cliAsync(m.kit, ['status'])).result.connected);

    // Later runs without --scope (a boot hook, the CLI fallback) use the remembered scope.
    const again = m.install('--reason', 'boot');
    assert.equal(again.status, 0, again.stderr);
    assert.match(fs.readFileSync(m.kit.path('deploy/install-listener.log'), 'utf8'), /nothing to do: installed, enabled and running \(user scope\)/);
    assert.equal(events(m.kit.dir).filter((b) => eventOf(b) === 'listener-installed').length, 1);
  } finally {
    await m.finish();
  }
});

test('VM replacement (user scope): /etc is wiped, the home folder is kept, and the user\'s systemd brings the listener back at boot with no script run', async () => {
  const m = machine();
  try {
    assert.equal(m.install('--scope', 'user').status, 0);
    await waitUntil(() => started(m.kit).length === 1, { what: 'first start' });
    // The VM goes away: the process dies without a clean stop, /etc and the
    // system manager's state are gone. The home folder (connector, unit,
    // enable link) and here the linger state survive.
    m.kill('user', 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(m.kit.path('fake-systemd'), { recursive: true, force: true });
    const t0 = Date.now();
    assert.deepEqual(m.boot(), [`${UNIT}.service`], 'the user manager starts the listener at boot');
    await waitUntil(() => started(m.kit).length === 2, { what: 'second start', timeout: 15000 });
    assert.match(started(m.kit)[1], /ended without a clean stop/);
    assert.equal(events(m.kit.dir).filter((b) => eventOf(b) === 'listener-installed').length, 1, 'no install run was needed');
    assert.equal(fs.readFileSync(m.kit.path('fake-systemd/calls'), 'utf8').trim(), `user start ${UNIT}`, 'only the boot start ran');
    await waitUntil(async () => (await cliAsync(m.kit, ['status'])).result?.connected === true, { what: 'connected' });
    console.log(`# supervision: VM replaced (user scope) -> listener back ${Date.now() - t0} ms after boot`);
  } finally {
    await m.finish();
  }
});

test('VM replacement that also loses the linger state: the boot hook run turns lingering back on and starts the listener, and says so', async () => {
  const m = machine();
  try {
    assert.equal(m.install('--scope', 'user').status, 0);
    await waitUntil(() => started(m.kit).length === 1, { what: 'first start' });
    m.kill('user', 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(m.kit.path('fake-systemd'), { recursive: true, force: true });
    fs.rmSync(m.kit.path('var-lib-systemd'), { recursive: true, force: true }); // /var/lib/systemd/linger went with the VM
    assert.deepEqual(m.boot(), [], 'without lingering the user manager does not start at boot');
    const r = m.install('--reason', 'boot'); // the remembered scope: user
    assert.equal(r.status, 0, r.stderr);
    await waitUntil(() => started(m.kit).length === 2, { what: 'second start' });
    const installed = events(m.kit.dir).filter((b) => eventOf(b) === 'listener-installed').at(-1);
    assert.match(installed, /lingering was off/);
    assert.match(installed, /the service was not running/);
    assert.ok(fs.existsSync(path.join(m.env.FAKE_LINGER_DIR, ME)));
  } finally {
    await m.finish();
  }
});

test('install --scope user refuses while the system-scope listener runs: two supervisors would fight over the session', async () => {
  const m = machine();
  try {
    // The system-scope listener, installed into a folder in the kit (never the real /etc).
    const sys = spawnSync('bash', [m.kit.path('deploy/install-listener.sh'), '--scope', 'system', '--reason', 'manual'],
      { cwd: m.kit.dir, env: { ...m.env, UNIT_DIR: m.kit.path('etc-systemd') }, encoding: 'utf8', timeout: 90000 });
    assert.equal(sys.status, 0, sys.stderr);
    await waitUntil(() => started(m.kit).length === 1, { what: 'system listener up' });
    const r = m.install('--scope', 'user');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /system-scope listener .* is running or enabled; stop and disable it first/);
    assert.ok(!fs.existsSync(path.join(m.userUnitDir, `${UNIT}.service`)), 'nothing installed');
    assert.match(events(m.kit.dir).find((b) => eventOf(b) === 'install-failed'), /system-scope listener/);
  } finally {
    await m.finish();
  }
});

test('install --scope user fails, with an event, when lingering cannot be turned on', async () => {
  const m = machine({ env: { FAKE_LINGER_DENIED: '1' } });
  try {
    const r = m.install('--scope', 'user');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lingering is off/);
    const failed = events(m.kit.dir).find((b) => eventOf(b) === 'install-failed');
    assert.match(failed, /not at boot/);
    assert.ok(!m.kit.exists('listener.sock'));
  } finally {
    await m.finish();
  }
});

test('install --scope user fails, with an event, when this user has no systemd of its own', async () => {
  const m = machine({ env: { FAKE_NO_USER_MANAGER: '1' } });
  try {
    const r = m.install('--scope', 'user');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot reach this user's systemd/);
    assert.match(events(m.kit.dir).find((b) => eventOf(b) === 'install-failed'), /user services are not available/);
  } finally {
    await m.finish();
  }
});

test('install --scope user refuses while the system-scope unit is enabled, even when it is not running', async () => {
  const m = machine();
  try {
    fs.mkdirSync(m.kit.path('fake-systemd/system'), { recursive: true });
    fs.writeFileSync(m.kit.path('fake-systemd/system/enabled'), ''); // enabled, stopped: it starts at the next boot
    const r = m.install('--scope', 'user');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /running or enabled/);
    assert.ok(!fs.existsSync(path.join(m.userUnitDir, `${UNIT}.service`)), 'nothing installed');
  } finally {
    await m.finish();
  }
});

test('install --scope system refuses while the user-scope listener is enabled for the folder\'s owner', async () => {
  const m = machine();
  try {
    assert.equal(m.install('--scope', 'user').status, 0);
    await waitUntil(() => started(m.kit).length === 1, { what: 'user listener up' });
    const sys = spawnSync('bash', [m.kit.path('deploy/install-listener.sh'), '--scope', 'system', '--reason', 'manual'],
      { cwd: m.kit.dir, env: { ...m.env, UNIT_DIR: m.kit.path('etc-systemd') }, encoding: 'utf8', timeout: 90000 });
    assert.equal(sys.status, 1);
    assert.match(sys.stderr, /user-scope listener is enabled .* systemctl --user disable --now/);
    assert.ok(!fs.existsSync(m.kit.path(`etc-systemd/${UNIT}.service`)), 'nothing installed system-wide');
    assert.ok(!fs.existsSync(m.kit.path('fake-systemd/system/pid')), 'no second listener started');
  } finally {
    await m.finish();
  }
});

test('install --scope user turns lingering on before it needs the user\'s systemd, which only runs once lingering is on', async () => {
  const m = machine({ env: { FAKE_MANAGER_NEEDS_LINGER: '1' } });
  try {
    const r = m.install('--scope', 'user');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(m.env.FAKE_LINGER_DIR, ME)));
    await waitUntil(() => started(m.kit).length === 1, { what: 'started event' });
  } finally {
    await m.finish();
  }
});

// Root on a VM runs boot hooks. It must leave nothing in the folder that the
// owner then cannot open, and its events must be the owner's, like the
// listener's. Needs root, runuser and a second user: the Linux check (a
// node:22 container, as root, with its "node" user) runs it.
const asRoot = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const id = spawnSync('id', ['-u', 'node'], { encoding: 'utf8' });
  const runuser = spawnSync('sh', ['-c', 'command -v runuser'], { encoding: 'utf8' });
  if (id.status !== 0 || runuser.status !== 0) return null;
  return { user: 'node', uid: Number(id.stdout.trim()) };
})();

test('as root for a folder another user owns: state files and events stay the owner\'s, and a user-scope run continues as the owner', { skip: asRoot ? false : 'needs root, runuser and a "node" user (the Linux check)' }, async () => {
  const m = machine();
  try {
    spawnSync('chown', ['-R', `${asRoot.user}:${asRoot.user}`, m.kit.dir]);
    const run = (env, ...args) => spawnSync('bash', [m.kit.path('deploy/install-listener.sh'), ...args],
      { cwd: m.kit.dir, env: { ...m.env, ...env }, encoding: 'utf8', timeout: 60000 });
    // A system-scope boot run as root that fails (here: no systemctl).
    const sys = run({ SYSTEMCTL: '/nonexistent/systemctl', UNIT_DIR: m.kit.path('etc-systemd') }, '--scope', 'system', '--reason', 'boot');
    assert.equal(sys.status, 1);
    assert.match(sys.stderr, /systemctl not found/);
    const owned = (rel) => fs.statSync(m.kit.path(rel)).uid;
    for (const rel of ['deploy/.install-listener.lock', 'deploy/.install-listener.last-failure', 'deploy/install-listener.log']) {
      assert.equal(owned(rel), asRoot.uid, `${rel} is the owner's`);
    }
    const files = fs.readdirSync(m.kit.path('requests')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.equal(owned(`requests/${files[0]}`), asRoot.uid, 'the install-failed event is the owner\'s');

    // Root again, user scope: it turns lingering on for the owner and goes on as the owner.
    const user = run({ SYSTEMCTL: '/nonexistent/systemctl' }, '--scope', 'user', '--reason', 'boot');
    assert.equal(user.status, 1);
    assert.match(user.stderr, /systemctl not found/, 'got past the lock and the state files root left');
    assert.ok(fs.existsSync(path.join(m.env.FAKE_LINGER_DIR, asRoot.user)), 'lingering turned on for the owner, not root');
    assert.match(fs.readFileSync(m.kit.path('deploy/install-listener.log'), 'utf8'), /\[boot\] FAILED: systemctl not found[\s\S]*\[boot\] FAILED: systemctl not found/);
  } finally {
    await m.finish();
  }
});
