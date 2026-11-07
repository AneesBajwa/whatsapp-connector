'use strict';
/**
 * Listener lifecycle: events pushed to Muse, and a heartbeat so each run can
 * tell how the previous one ended.
 *
 * Events are markdown files in requests/ (Kind: lifecycle), the same channel
 * as prompts and alerts, so the hook that wakes Muse for requests wakes it
 * for these too. Muse never has to ask whether the listener is alive:
 *   started        the listener is up; says how the previous run ended and how
 *                  long nothing was listening
 *   stopped        a clean stop (systemctl stop/restart, VM shutdown)
 *   crashed        an error ended the run, at start-up or later (systemd
 *                  restarts it)
 *   crash-loop     it keeps failing; further started/crashed events are held
 *                  back until a run lasts
 *   recovered      after a crash loop, a run has stayed up
 *   missed-prompts @agent prompts that arrived while nothing was listening
 *                  and were already too old to answer when it came back
 *   cannot-start   no linked session: it will not start until re-linked
 * (Connection down for longer than health.alertAfterMinutes, and back, are
 * the existing Kind: alert files from health.cjs.)
 *
 * Which ones ask Muse to tell the owner ("notify"): a first crash, a crash
 * loop and its end, missed prompts, and a start after an outage longer than
 * health.alertAfterMinutes. Routine starts and stops are only noted, and
 * repeat crashes within an hour are noted until they add up to a loop.
 *
 * A process cannot report its own sudden death (VM replaced, SIGKILL). The
 * next start does: listener-state.json is rewritten every minute while the
 * listener runs, so a start that finds no clean stop knows when the old run
 * was last alive, and whether the machine itself restarted since. The state
 * also keeps "listening until": the last time a run was actually connected to
 * WhatsApp. Downtime and missed prompts are measured from that, so a run that
 * crashed during start-up (or never connected) cannot hide the real gap.
 */

const os = require('os');
const path = require('path');
const { writeAtomic, readJson } = require('./message-store.cjs');
const { writeOnce, stamp, slug } = require('./request-files.cjs');

const HEARTBEAT_MS = 60000;
// Failures counted toward a crash loop: crashes, and runs that ended without a
// clean stop on the same machine boot (killed; a VM replacement is not a
// failure of the listener). Three within the window is a loop; a run that
// stays up LOOP_RECOVERY_MS after a loop ends it (also after a clean restart).
const LOOP_WINDOW_MS = 60 * 60000;
const LOOP_FAILURES = 3;
const LOOP_RECOVERY_MS = 10 * 60000;

const iso = (ms) => new Date(ms).toISOString();

function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}

/** Write one lifecycle event file. Never throws: an event must not break the listener. */
function writeEvent({ root, config, event, title, notify, lines, log = () => {}, now = Date.now() }) {
  try {
    const name = `${stamp(Math.floor(now / 1000))}-lifecycle-${slug(event)}-${process.pid}.md`;
    const owner = (config && config.ownerName) || 'the owner';
    const body = [
      `# Muse event: ${title}`,
      '',
      'Status: pending',
      'Kind: lifecycle',
      `Event: ${event}`,
      `At: ${iso(now)}`,
      notify ? `Needs approval: no. Tell ${owner} in the Muse app.` : 'Needs approval: no. Nothing to tell anyone: note it.',
      '',
      ...lines,
      '',
    ].join('\n');
    writeOnce(path.join(root, 'requests'), name, body);
    return name;
  } catch (e) {
    log(`warning: could not write the ${event} event: ${e && e.message ? e.message : e}`);
    return null;
  }
}

function createLifecycle({
  root, config, log = () => {}, statePath = path.join(root, 'listener-state.json'),
  now = () => Date.now(), bootAt = () => Date.now() - os.uptime() * 1000,
  heartbeatMs = HEARTBEAT_MS, recoveryMs = LOOP_RECOVERY_MS, audit = { record() {} },
}) {
  const previous = readJson(statePath, null);
  const startedAt = now();
  const thresholdMs = ((config && config.health && config.health.alertAfterMinutes) || 10) * 60000;
  const promptWindow = (config && config.promptMaxAgeMinutes) || 60;
  let timer = null;
  let recoveryTimer = null;
  let stopped = false;

  /** How the previous run ended, from its last saved state. */
  function previousRun() {
    if (!previous) return null;
    const lastAlive = Date.parse(previous.stoppedAt || previous.lastAliveAt || previous.startedAt);
    if (!Number.isFinite(lastAlive)) return null;
    const ranFrom = Date.parse(previous.startedAt);
    const listened = Date.parse(previous.listeningUntil);
    const listenedUntil = Number.isFinite(listened) ? Math.min(listened, lastAlive) : lastAlive;
    return {
      clean: !!previous.stoppedAt && previous.stopReason !== 'crashed',
      crashed: previous.stopReason === 'crashed',
      stopReason: previous.stopReason || null,
      lastAliveAt: lastAlive,
      listenedUntil,
      ranMs: Number.isFinite(ranFrom) ? lastAlive - ranFrom : null,
      // Nothing was listening from the last time a run was connected.
      downMs: startedAt - listenedUntil,
      // The machine booted after the old run was last seen: the VM was
      // replaced or rebooted (os.uptime() is the new machine's).
      machineRestarted: bootAt() > lastAlive,
    };
  }
  const prev = previousRun();
  const earlier = ((previous && previous.recentFailures) || []).filter((t) => startedAt - t < LOOP_WINDOW_MS);
  const prevFailed = !!prev && (prev.crashed || (!prev.clean && !prev.machineRestarted));
  const recentFailures = prevFailed ? [...earlier, prev.lastAliveAt] : prev && prev.clean ? [] : earlier;
  const looping = recentFailures.length >= LOOP_FAILURES;
  // A notified loop stays notified (also across a clean restart) until a run
  // has stayed up long enough to say "recovered".
  let loopNotified = !!(previous && previous.loopNotified);
  // Until this run connects, "listening until" stays where the last
  // connected run left it.
  let listening = false;
  let listeningUntil = prev ? prev.listenedUntil : null;

  const state = (extra = {}) => {
    if (listening) listeningUntil = now();
    return {
      pid: process.pid,
      startedAt: iso(startedAt),
      lastAliveAt: iso(now()),
      ...(listeningUntil ? { listeningUntil: iso(listeningUntil) } : {}),
      recentFailures,
      loopNotified,
      ...extra,
    };
  };
  const save = (extra) => {
    try { writeAtomic(statePath, JSON.stringify(state(extra))); } catch (e) { log(`warning: could not save listener-state.json: ${e.message}`); }
  };
  const event = (args) => {
    audit.record(`lifecycle_${args.event.replace(/-/g, '_')}`, { notify: !!args.notify });
    return writeEvent({ root, config, log, now: now(), ...args });
  };

  /** Announce the loop once; later failures are held back until a run lasts. */
  function announceLoop({ persist = true } = {}) {
    if (loopNotified) return;
    loopNotified = true;
    if (persist) save();
    event({
      event: 'crash-loop', title: 'WhatsApp listener keeps failing', notify: true,
      lines: [
        `The listener has failed ${recentFailures.length} times in the last ${duration(LOOP_WINDOW_MS)} and systemd keeps restarting it.`,
        `Further started/crashed events are held back until a run lasts; a "recovered" event follows once one stays up for ${duration(recoveryMs)}.`,
        'While this goes on, @agent prompts may get no 👀 and no answer.',
        'Check the service log: journalctl -u muse-whatsapp-listener -n 50',
      ],
    });
  }

  /** After a loop: once this run has stayed up long enough, say so. */
  function watchForRecovery() {
    recoveryTimer = setTimeout(() => {
      if (stopped || !loopNotified) return;
      loopNotified = false;
      recentFailures.length = 0;
      save();
      event({
        event: 'recovered', title: 'WhatsApp listener running again', notify: true,
        lines: [`After the crash loop, the listener has now stayed up for ${duration(recoveryMs)} (pid ${process.pid}, started ${iso(startedAt)}).`],
      });
    }, recoveryMs);
    if (recoveryTimer.unref) recoveryTimer.unref();
  }

  return {
    previous: prev,
    looping,
    /** The unix time from which prompts may have gone unheard (null on a first run). */
    unheardSince: () => (prev ? Math.floor(prev.listenedUntil / 1000) : null),

    /** Connected to WhatsApp (true) or not (false): what "listening until" follows. */
    setListening(on) {
      if (on === listening) return;
      if (listening) listeningUntil = now(); // up to the moment it stopped
      listening = !!on;
      if (!stopped) save();
    },

    started() {
      save();
      timer = setInterval(() => { if (!stopped) save(); }, heartbeatMs);
      if (timer.unref) timer.unref();
      if (looping) {
        announceLoop();
        watchForRecovery();
        return;
      }
      if (loopNotified) watchForRecovery();
      const lines = [`The WhatsApp listener started (pid ${process.pid}) and is connecting to WhatsApp.`];
      let notify = false;
      if (!prev) {
        lines.push('There is no record of an earlier run.');
      } else {
        const how = prev.crashed ? 'crashed'
          : prev.clean ? `stopped cleanly (${prev.stopReason || 'stop'})`
            : 'ended without a clean stop (killed, or the machine went away)';
        lines.push(`The previous run ${how}; it was last alive at ${iso(prev.lastAliveAt)}.`);
        lines.push(`Nothing has been listening since ${iso(prev.listenedUntil)} (about ${duration(prev.downMs)}).`);
        if (prev.machineRestarted) lines.push(`The machine restarted since then (booted at ${iso(bootAt())}): the VM was replaced or rebooted.`);
        lines.push(`Messages that arrived meanwhile are delivered now; prompts from the last ${promptWindow} minutes are picked up as usual.`);
        // A crash was already announced by its own event.
        notify = prev.downMs > thresholdMs;
      }
      event({ event: 'started', title: 'WhatsApp listener started', notify, lines });
    },

    /** A clean stop or a crash (also one during start-up). Written before the process exits. */
    stopped(reason, error = null) {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      const crashed = reason === 'crashed';
      // Also when every run dies during start-up (started() never ran). The
      // state save below records loopNotified together with the crash.
      if (crashed && looping) announceLoop({ persist: false });
      save({ stoppedAt: iso(now()), stopReason: reason, ...(error ? { error: String(error).slice(0, 300) } : {}) });
      if (crashed && (looping || loopNotified)) return; // the crash-loop event covers it
      event({
        event: crashed ? 'crashed' : 'stopped',
        title: crashed ? 'WhatsApp listener crashed' : 'WhatsApp listener stopped',
        // The first crash in an hour is announced; repeats are noted until they make a loop.
        notify: crashed && recentFailures.length === 0,
        lines: crashed
          ? [`The listener hit an error and is exiting: ${String(error || 'unknown error').slice(0, 300)}`,
            'systemd restarts it in about 10 seconds; a started event follows when it is back.',
            ...(recentFailures.length ? [`It has failed ${recentFailures.length} other time(s) in the last hour.`] : [])]
          : [`The listener stopped cleanly (${reason}). Until it starts again, nothing watches for @agent prompts.`,
            'A started event follows when it is back. If this was a VM shutdown, it comes back when the VM does.'],
      });
    },

    /** Owner prompts that arrived while nothing listened and were too old to answer on return. */
    missedPrompts(list, chatName = () => null) {
      if (!list || !list.length) return;
      event({
        event: 'missed-prompts', title: `${list.length} @agent prompt(s) missed while the listener was down`, notify: true,
        lines: [
          `These arrived while nothing was listening and were older than ${promptWindow} minutes when the listener came back, so they got no 👀 and no answer:`,
          '',
          ...list.map((m) => `- ${m.timestamp} in ${JSON.stringify(chatName(m.chatJid) || m.chatJid)} (${m.chatJid}), id ${m.id}: ${JSON.stringify(String(m.text || '').replace(/\s+/g, ' ').slice(0, 200))}`),
          '',
          `Ask ${(config && config.ownerName) || 'the owner'} whether they still want answers; do not answer them on your own.`,
        ],
      });
    },
  };
}

module.exports = { createLifecycle, writeEvent, HEARTBEAT_MS, LOOP_WINDOW_MS };
