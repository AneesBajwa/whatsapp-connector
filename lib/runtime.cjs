'use strict';
/**
 * One WhatsApp session: auth state, socket lifecycle and reconnect policy, the
 * message store, and run diagnostics. Shared by the one-shot CLI and the
 * long-running listener so both behave the same way.
 *
 * auth/ is the login. It is chmod 700/600 at startup, after every save and
 * on shutdown, never logged, never copied. Never call sock.logout().
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createStore, ensurePrivateDir, writeAtomic, readJson, bareJid, DELETED_STUBS } = require('./message-store.cjs');
const { applyVoteMessages } = require('./polls.cjs');

const RESTART_REQUIRED = 515;
const PDO_RESPONSE = 17; // ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
const MAX_PEER_REPLIES = 100;
const ADMIN_CACHE_MS = 10 * 60 * 1000;
const ADMIN_LOOKUP_MS = 10000;
// Closes a reconnect cannot fix: logged out, forbidden, multi-device mismatch,
// and connection replaced (another copy of this session is live, so
// reconnecting would only fight it).
const FATAL_REASONS = { 401: 'logged_out', 403: 'forbidden', 411: 'multidevice_mismatch', 440: 'connection_replaced' };
const FATAL_CLOSE_CODES = new Set(Object.keys(FATAL_REASONS).map(Number));
const ONESHOT_RECONNECT_DELAYS_MS = [2000, 5000, 10000];
const LISTENER_RECONNECT_DELAYS_MS = [2000, 5000, 10000, 30000, 60000];
const VERSION_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;
// A reconnect waits at most this long for a version fetch.
const VERSION_REFRESH_WAIT_MS = 5000;
// After the end-of-offline signal Baileys flushes its event buffer on the next
// tick; give it a moment before reading the store.
const SYNC_SETTLE_MS = 750;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kitPaths(root) {
  return {
    root,
    auth: path.join(root, 'auth'),
    store: path.join(root, 'store'),
    lock: path.join(root, 'session.lock'),
    socket: path.join(root, 'listener.sock'),
    versionCache: path.join(root, 'store', 'wa-version.json'),
    qr: path.join(root, 'qr.png'),
    state: path.join(root, 'muse-state.json'),
    requests: path.join(root, 'requests'),
    audit: path.join(root, 'audit.log'),
  };
}

/**
 * True once WhatsApp has accepted this device. `account` is only written at
 * pair-success, in both the QR and phone-code flows. `registered` is never set
 * by the QR flow, and `me` is written as soon as a phone code is requested.
 */
function isLinked(creds) {
  return !!(creds && creds.account);
}

/** The status code behind a Baileys disconnect, or null if it has none. */
function disconnectStatus(disconnect) {
  const output = disconnect && disconnect.error && disconnect.error.output;
  return output ? output.statusCode : null;
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

function getLogger() {
  try {
    return require('pino')({ level: 'silent' });
  } catch {
    const noop = () => {};
    const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
    logger.child = () => logger;
    return logger;
  }
}

/**
 * The VM reaches the internet through an HTTP proxy (HTTPS_PROXY env).
 * Baileys' raw WebSocket ignores it, so a direct connection fails the TLS
 * handshake; route the socket through the proxy agent. The proxy URL is
 * never logged. (Node's own fetch, used for the version lookup, needs
 * NODE_USE_ENV_PROXY=1 to honour the proxy.)
 */
function getProxyAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return undefined;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxy);
  } catch (e) {
    // Fail closed: a configured proxy that cannot be used must not silently
    // fall back to a direct connection.
    throw new Error(`proxy agent unavailable: ${errorMessage(e)}`);
  }
}

async function createRuntime({ root, command, mode = 'oneshot', log = () => {} }) {
  const baileys = require('@whiskeysockets/baileys');
  const { default: makeWASocket, useMultiFileAuthState, Browsers, fetchLatestWaWebVersion, BufferJSON } = baileys;
  const p = kitPaths(root);
  const pairing = command === 'pair' || command === 'pair-qr';
  const events = new EventEmitter();
  events.setMaxListeners(100); // every command waiting for the connection listens for a while
  const startedAt = Date.now();

  fs.mkdirSync(p.auth, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(p.auth);

  // Directory 700, every credential file 600: at startup, after every save
  // and on shutdown. A plain mkdir leaves them group-readable.
  function lockAuthPerms() {
    try {
      fs.chmodSync(p.auth, 0o700);
      for (const f of fs.readdirSync(p.auth)) {
        try { fs.chmodSync(path.join(p.auth, f), 0o600); } catch (e) { log(`warning: could not lock ${f}: ${errorMessage(e)}`); }
      }
    } catch (e) {
      log(`warning: could not lock auth permissions: ${errorMessage(e)}`);
    }
  }
  lockAuthPerms();
  async function saveCredsLocked() {
    await saveCreds();
    lockAuthPerms();
  }

  const meJid = () => {
    const id = (sock && sock.user && sock.user.id) || (state.creds.me && state.creds.me.id);
    return id && baileys.jidNormalizedUser ? baileys.jidNormalizedUser(id) : id || null;
  };
  const meLid = () => {
    const id = (sock && sock.user && sock.user.lid) || (state.creds.me && state.creds.me.lid);
    return id && baileys.jidNormalizedUser ? baileys.jidNormalizedUser(id) : id || null;
  };
  const store = createStore(p.store, {
    BufferJSON,
    meJid,
    meLid,
    aggregatePoll: (message, pollUpdates) => baileys.getAggregateVotesInPollMessage({ message, pollUpdates }, meJid()),
  });
  const diag = {
    command,
    mode,
    version: null,
    versionIsLatest: null,
    versionSource: null,
    opens: 0,
    reconnects: 0,
    closeCodes: [],
    offlineDrained: false,
    offlineDrainMs: null,
    historyEvents: 0,
    historySyncTypes: {},
    upsertEvents: 0,
    newMessages: 0,
    elapsedMs: 0,
  };

  let version = null;
  let sock = null;
  let connectionState = 'idle';
  let lastDisconnect = null;
  let latestQrAt = null;
  let restartUsed = false;
  let reconnects = 0;
  let reconnectTimer = null;
  let shuttingDown = false;
  let offlineDrained = false;
  let openedAt = 0;
  let fatalCode = null;
  let stableTimer = null;
  // The listener's backoff resets only after a connection has stayed up this long.
  const STABLE_AFTER_MS = 60000;

  /** Every connection state change is an event ('state'), so waits never poll. */
  function setState(next) {
    if (connectionState === next) return;
    connectionState = next;
    events.emit('state', next);
  }

  /**
   * Resolve when test() says so (re-checked on each state change and on the
   * end-of-offline signal), reject on its error or after timeoutMs.
   */
  function waitForState(test, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (fn, value) => {
        events.removeListener('state', check);
        events.removeListener('drained', check);
        clearTimeout(timer);
        fn(value);
      };
      function check() {
        let r;
        try { r = test(); } catch (e) { finish(reject, e); return true; }
        if (!r) return false;
        if (r.error) finish(reject, r.error);
        else finish(resolve, r.value);
        return true;
      }
      if (check()) return;
      events.on('state', check);
      events.on('drained', check);
      timer = setTimeout(() => finish(reject, new Error(timeoutMessage)), timeoutMs);
    });
  }

  /**
   * The WhatsApp Web version only matters when connecting, so the listener
   * refreshes it on each reconnect (from the cache while that is recent),
   * not on a timer. Never holds a reconnect up for more than a few seconds.
   */
  function refreshVersion() {
    let timer = null;
    const cap = new Promise((r) => { timer = setTimeout(r, VERSION_REFRESH_WAIT_MS); if (timer.unref) timer.unref(); });
    const refresh = resolveVersion().catch((e) => log(`warning: version refresh failed: ${errorMessage(e)}`));
    return Promise.race([refresh, cap]).finally(() => clearTimeout(timer));
  }

  async function resolveVersion() {
    const cache = readJson(p.versionCache, null);
    const cached = cache && Array.isArray(cache.version) ? cache : null;
    let result;
    if (!pairing && cached && Date.now() - cached.fetchedAt < VERSION_CACHE_MAX_AGE_MS) {
      result = { version: cached.version, isLatest: true, source: 'cached' };
    } else {
      // Never throws: on failure it returns the bundled version, isLatest:false.
      const r = await fetchLatestWaWebVersion();
      if (r.isLatest) {
        result = { version: r.version, isLatest: true, source: 'fetched' };
        if (!pairing) {
          try {
            ensurePrivateDir(p.store);
            writeAtomic(p.versionCache, JSON.stringify({ version: r.version, fetchedAt: Date.now() }));
          } catch (e) {
            log(`warning: could not cache the WhatsApp version: ${errorMessage(e)}`);
          }
        }
      } else {
        const why = r.error && r.error.message ? r.error.message : String(r.error);
        const useCached = !pairing && cached;
        log(`version fetch failed, using ${useCached ? 'the last fetched' : 'the bundled'} version: ${why}`);
        result = useCached
          ? { version: cached.version, isLatest: false, source: 'cached-stale' }
          : { version: r.version, isLatest: false, source: 'bundled' };
      }
    }
    version = result.version;
    diag.version = result.version.join('.');
    diag.versionIsLatest = result.isLatest;
    diag.versionSource = result.source;
    return result;
  }

  /**
   * Decrypt any poll votes among received messages and record them on their
   * poll. Votes for a poll not stored yet wait in the store; they come back
   * from addMessages as `pendingVotes` once the poll arrives.
   */
  function applyVotes(messages) {
    if (!messages || !messages.length) return;
    const meIds = [state.creds.me && state.creds.me.id, state.creds.me && state.creds.me.lid, sock && sock.user && sock.user.lid];
    applyVoteMessages({ baileys, store, messages, meIds, diag });
  }

  /** Save received messages, then decrypt votes in them and any that were waiting for them. */
  function saveMessages(messages) {
    const r = store.addMessages(messages);
    diag.newMessages += r.added;
    applyVotes(messages);
    applyVotes(r.pendingVotes);
    // Deletes the library merged into a stored message, by someone other
    // than its sender: the same check as a live delete (admin, or owner).
    for (const d of r.unverifiedDeletes || []) applyRevoke({ ...d.by, remoteJid: d.jid, id: d.id });
    return r;
  }

  // What the phone sent back for our own requests to it (history requests),
  // by request id, so a backfill can tell "answered with nothing" from "no answer".
  const peerReplies = new Map();
  function notePeerReply(requestId, info) {
    if (!requestId) return;
    peerReplies.set(requestId, { ...(peerReplies.get(requestId) || {}), ...info, at: Date.now() });
    while (peerReplies.size > MAX_PEER_REPLIES) peerReplies.delete(peerReplies.keys().next().value);
  }
  function notePeerResponses(messages) {
    for (const m of messages || []) {
      const pm = m && m.message && m.message.protocolMessage;
      const res = pm && pm.peerDataOperationRequestResponseMessage;
      const isResponse = pm && (pm.type === PDO_RESPONSE || pm.type === 'PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE');
      if (isResponse && res && res.stanzaId) {
        notePeerReply(res.stanzaId, { response: true, results: (res.peerDataOperationResult || []).length });
      }
    }
  }

  /**
   * Group admins, cached for a while. WhatsApp lets an admin delete anyone's
   * message in the group; clients accept such a delete only from an admin.
   */
  const adminCache = new Map();
  async function groupAdmins(groupJid) {
    const cached = adminCache.get(groupJid);
    if (cached && Date.now() - cached.at < ADMIN_CACHE_MS) return cached.admins;
    if (!sock || typeof sock.groupMetadata !== 'function') return null;
    let timer;
    const meta = await Promise.race([
      sock.groupMetadata(groupJid),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ADMIN_LOOKUP_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!meta) return null;
    const admins = new Set();
    for (const part of meta.participants || []) {
      if (!part || !part.admin) continue;
      for (const j of [part.id, part.lid, part.phoneNumber, part.jid]) {
        if (typeof j === 'string') admins.add(bareJid(j));
      }
    }
    adminCache.set(groupJid, { at: Date.now(), admins });
    return admins;
  }

  /**
   * A delete for everyone: applied when it comes from the sender, from the
   * account owner in a group (WhatsApp only lets the owner's own devices do
   * that as an admin), or from a group admin (checked against the group's
   * admin list; a failed lookup is retried once).
   */
  const adminChecks = new Set();
  function applyRevoke(key, attempt = 1) {
    const found = store.findInChat(key.remoteJid, key.id);
    if (!found) return; // a later history copy of the message carries the delete
    if (store.isFromSender(found.entry, key)) {
      if (store.markDeleted(found.jid, key.id, key)) diag.deletes = (diag.deletes || 0) + 1;
      return;
    }
    if (!found.jid.endsWith('@g.us')) {
      diag.deletesIgnored = (diag.deletesIgnored || 0) + 1;
      return;
    }
    if (key.fromMe) {
      if (store.markDeleted(found.jid, key.id, null, { deletedBy: 'me' })) diag.deletes = (diag.deletes || 0) + 1;
      return;
    }
    const by = [key.participant, key.participantAlt].filter(Boolean).map(bareJid);
    const forms = new Set([...by, ...by.map((j) => store.alias(j)).filter(Boolean)]);
    const check = groupAdmins(found.jid).then((admins) => {
      if (admins && [...forms].some((j) => admins.has(j))) {
        if (store.markDeleted(found.jid, key.id, null, { deletedBy: by[0] || null })) diag.deletes = (diag.deletes || 0) + 1;
      } else if (admins) {
        diag.deletesIgnored = (diag.deletesIgnored || 0) + 1;
      } else {
        throw new Error('no group metadata');
      }
    }).catch((e) => {
      diag.adminCheckFailed = (diag.adminCheckFailed || 0) + 1;
      log(`warning: could not check group admins (${errorMessage(e)})${attempt === 1 && !shuttingDown ? '; retrying in 30s' : ''}`);
      if (attempt === 1 && !shuttingDown) {
        const t = setTimeout(() => applyRevoke(key, 2), 30000);
        if (t.unref) t.unref();
      }
    }).finally(() => adminChecks.delete(check));
    adminChecks.add(check);
  }

  function flushEvents() {
    try {
      if (sock && sock.ev && typeof sock.ev.flush === 'function') sock.ev.flush();
    } catch (e) {
      log(`warning: could not flush buffered events: ${errorMessage(e)}`);
    }
  }

  function onClose(ld) {
    // Baileys receipts messages before releasing them from its event buffer,
    // and destroys that buffer right after this close event: release them now
    // or they are lost for good.
    flushEvents();
    clearTimeout(stableTimer);
    const code = disconnectStatus(ld);
    diag.closeCodes.push(code);
    offlineDrained = false;
    if (shuttingDown) {
      setState('close');
      return;
    }
    if (pairing) {
      // WhatsApp closes the socket right after accepting a new link (515) and
      // expects a reconnect with the saved login. That is the last step of
      // linking and needs no new scan. Once only, so a repeat is a failure.
      if (!restartUsed && code === RESTART_REQUIRED) {
        restartUsed = true;
        log('WhatsApp asked for a restart; reconnecting with the saved login (no new scan needed).');
        reconnect(0);
        return;
      }
      setState('close');
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      fatalCode = code;
      setState('close');
      events.emit('fatal', code);
      return;
    }
    const delays = mode === 'listener' ? LISTENER_RECONNECT_DELAYS_MS : ONESHOT_RECONNECT_DELAYS_MS;
    if (mode !== 'listener' && reconnects >= delays.length) {
      setState('close');
      return;
    }
    const delay = code === RESTART_REQUIRED ? 0 : delays[Math.min(reconnects, delays.length - 1)];
    reconnects++;
    diag.reconnects++;
    log(`connection closed (status ${code}); reconnecting in ${delay / 1000}s`);
    reconnect(delay);
  }

  function reconnect(delay) {
    setState('connecting');
    events.emit('disconnected');
    const versionReady = mode === 'listener' ? refreshVersion() : Promise.resolve();
    const go = async () => {
      reconnectTimer = null;
      if (shuttingDown) return;
      await versionReady;
      if (shuttingDown) return;
      try {
        sock = startSocket();
      } catch (e) {
        log(`could not reconnect: ${errorMessage(e)}`);
        if (mode === 'listener' && !shuttingDown) {
          // The listener never gives up on a transient failure.
          const next = LISTENER_RECONNECT_DELAYS_MS[Math.min(reconnects, LISTENER_RECONNECT_DELAYS_MS.length - 1)];
          reconnects++;
          diag.reconnects++;
          reconnect(next);
          return;
        }
        setState('close');
      }
    };
    if (delay) reconnectTimer = setTimeout(go, delay);
    else go();
  }

  function startSocket() {
    const s = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      // Staying "available" would stop the phone from showing notifications.
      markOnlineOnConnect: false,
      agent: getProxyAgent(),
      version,
      logger: getLogger(),
      // Lets Baileys decrypt poll votes (needs the poll's message secret).
      getMessage: async (key) => {
        const m = store.get(key.remoteJid, key.id);
        return m && m.raw ? m.raw.message : undefined;
      },
    });
    s.ev.on('creds.update', saveCredsLocked);
    s.ev.on('messaging-history.set', ({ chats, contacts, messages, syncType, lidPnMappings, peerDataRequestSessionId }) => {
      diag.historyEvents++;
      const k = String(syncType);
      diag.historySyncTypes[k] = (diag.historySyncTypes[k] || 0) + 1;
      // An on-demand reply names the request it answers.
      notePeerReply(peerDataRequestSessionId, { history: true, messages: (messages || []).length });
      store.addAliases(lidPnMappings);
      store.upsertChats(chats);
      store.upsertContacts(contacts);
      saveMessages(messages);
      events.emit('history', messages);
    });
    s.ev.on('lid-mapping.update', (pair) => store.addAliases([pair]));
    // Live reactions (the library folds ones whose message arrives in the same
    // batch into that message's `reactions`, which the store keeps too).
    s.ev.on('messages.reaction', (list) => {
      for (const { key, reaction } of list || []) {
        if (!key || !reaction) continue;
        if (store.applyReaction(key.remoteJid, key.id, reaction)) {
          diag.reactions = (diag.reactions || 0) + 1;
        } else {
          // The target is not stored yet: the reaction waits in the store
          // and is applied when the message arrives (e.g. by a backfill).
          diag.reactionsPending = (diag.reactionsPending || 0) + 1;
        }
      }
    });
    s.ev.on('chats.upsert', (list) => store.upsertChats(list));
    s.ev.on('contacts.upsert', (list) => store.upsertContacts(list));
    s.ev.on('contacts.update', (list) => store.upsertContacts(list));
    s.ev.on('messages.upsert', ({ messages, type }) => {
      diag.upsertEvents++;
      notePeerResponses(messages);
      saveMessages(messages);
      events.emit('messages', messages, type);
    });
    s.ev.on('messages.update', (updates) => {
      const editedTargets = [];
      for (const u of updates || []) {
        if (!u || !u.key || !u.update) continue;
        const upd = u.update;
        if (Array.isArray(upd.pollUpdates)) {
          store.applyPollUpdates(u.key.remoteJid, u.key.id, upd.pollUpdates);
        }
        // Edits and deletes, ours (the library echoes what we send) and
        // other people's. u.key carries the target id and the editor's identity.
        const edited = upd.message && upd.message.editedMessage && upd.message.editedMessage.message;
        if (edited) {
          if (store.applyEdit(u.key.remoteJid, u.key.id, edited, u.key)) {
            diag.edits = (diag.edits || 0) + 1;
            const found = store.findInChat(u.key.remoteJid, u.key.id);
            if (found) editedTargets.push({ jid: found.jid, id: u.key.id });
          }
        } else if ('message' in upd && upd.message === null && DELETED_STUBS.has(Number(upd.messageStubType))) {
          applyRevoke(u.key);
        }
      }
      events.emit('messages.update', updates);
      // Stored messages whose text an edit just changed (an edit can turn a
      // message into an @agent prompt).
      if (editedTargets.length) events.emit('edited', editedTargets);
    });
    s.ev.on('connection.update', (update) => {
      if (s !== sock) return; // a replaced socket's late events
      const { connection, lastDisconnect: ld, qr, receivedPendingNotifications } = update;
      if (ld) lastDisconnect = ld;
      if (connection === 'open') {
        diag.opens++;
        openedAt = Date.now();
        setState('open');
        if (mode === 'listener') {
          clearTimeout(stableTimer);
          stableTimer = setTimeout(() => { reconnects = 0; }, STABLE_AFTER_MS);
          stableTimer.unref();
        }
        events.emit('open');
      } else if (connection === 'connecting') {
        setState('connecting');
      } else if (connection === 'close') {
        onClose(ld);
        return;
      }
      if (receivedPendingNotifications === true) {
        offlineDrained = true;
        diag.offlineDrained = true;
        diag.offlineDrainMs = Date.now() - startedAt;
        events.emit('drained');
      }
      // QR pairing: print each QR as a JSON line for a parent process, and
      // write qr.png for a person running the CLI directly.
      if (qr) {
        latestQrAt = new Date().toISOString();
        console.log(JSON.stringify({ qr, at: latestQrAt }));
        try {
          require('qrcode').toFile(p.qr, qr, { width: 512, margin: 2 }, (err) => {
            if (!err) { try { fs.chmodSync(p.qr, 0o600); } catch { /* ignore */ } }
            if (err) log(`warning: could not write qr.png: ${err.message}`);
            else log('qr.png updated — scan it with WhatsApp > Linked devices > Link a device.');
          });
        } catch (e) {
          log(`warning: qrcode renderer unavailable: ${errorMessage(e)}`);
        }
      }
    });
    return s;
  }

  async function start() {
    if (!version) await resolveVersion();
    setState('connecting');
    sock = startSocket();
  }

  /** Resolve once open; throw if the connection is finally closed or times out. */
  function waitForOpen(timeoutMs) {
    return waitForState(() => {
      if (connectionState === 'open') return { value: true };
      if (connectionState === 'close') {
        const code = disconnectStatus(lastDisconnect);
        const err = new Error(`connection closed${code ? ` (status ${code})` : ''}`);
        err.statusCode = code;
        return { error: err };
      }
      return null;
    }, timeoutMs, 'timed out waiting for connection to open');
  }

  /**
   * Wait for WhatsApp's end-of-offline signal (everything queued for this
   * device has been delivered), then flush the library's held-back events
   * into the store. Returns whether the signal arrived in time.
   */
  async function waitForSync(timeoutMs) {
    await waitForState(() => (connectionState === 'close' || (connectionState === 'open' && offlineDrained) ? { value: true } : null),
      timeoutMs, 'sync wait').catch(() => { /* timed out: go on with what arrived */ });
    if (connectionState === 'open') {
      await sleep(SYNC_SETTLE_MS);
      flushEvents();
    }
    store.flush();
    return offlineDrained;
  }

  async function shutdown() {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearTimeout(stableTimer);
    flushEvents();
    // Admin checks still running (a one-shot run may end right after a
    // delete arrives): let them finish (a lookup times out after
    // ADMIN_LOOKUP_MS), so their result is saved.
    if (adminChecks.size) await Promise.race([Promise.allSettled([...adminChecks]), sleep(ADMIN_LOOKUP_MS + 2000)]);
    try { store.flush(); } catch (e) { log(`warning: could not save the message store: ${errorMessage(e)}`); }
    // Baileys saves creds asynchronously; flush before the process exits.
    try { await saveCredsLocked(); } catch { /* ignore */ }
    try { if (sock) await sock.end(); } catch { /* ignore */ }
    await sleep(250);
    try { store.flush(); } catch { /* ignore */ }
    lockAuthPerms();
    diag.elapsedMs = Date.now() - startedAt;
  }

  return {
    baileys,
    logger: getLogger(),
    paths: p,
    state,
    store,
    diag,
    events,
    mode,
    startedAt,
    isLinked: () => isLinked(state.creds),
    me: () => (sock && sock.user ? sock.user.id : (state.creds.me && state.creds.me.id) || null),
    meLid: () => (sock && sock.user && sock.user.lid) || (state.creds.me && state.creds.me.lid) || null,
    resolveVersion,
    start,
    waitForOpen,
    waitForSync,
    flushEvents,
    shutdown,
    saveCredsLocked,
    lockAuthPerms,
    get sock() { return sock; },
    get connectionState() { return connectionState; },
    get lastDisconnect() { return lastDisconnect; },
    get latestQrAt() { return latestQrAt; },
    get offlineDrained() { return offlineDrained; },
    get openedAt() { return openedAt; },
    get fatalCode() { return fatalCode; },
    /** What the phone sent back for one of our requests to it, or null. */
    peerReply: (requestId) => peerReplies.get(requestId) || null,
  };
}

/**
 * Store options for processes that read the store without a session: poll
 * tallies, and the account's own JIDs (read from the saved login, never
 * written) so its own reactions and votes are attributed.
 */
function storePollOptions(root = null) {
  const baileys = require('@whiskeysockets/baileys');
  let me = null;
  if (root) me = (readJson(path.join(root, 'auth', 'creds.json'), {}) || {}).me || null;
  const norm = (id) => (id && baileys.jidNormalizedUser ? baileys.jidNormalizedUser(id) : id || null);
  return {
    BufferJSON: baileys.BufferJSON,
    meJid: () => norm(me && me.id),
    meLid: () => norm(me && me.lid),
    aggregatePoll: (message, pollUpdates) => baileys.getAggregateVotesInPollMessage({ message, pollUpdates }, norm(me && me.id)),
  };
}

module.exports = { createRuntime, kitPaths, isLinked, disconnectStatus, errorMessage, storePollOptions, FATAL_CLOSE_CODES, FATAL_REASONS };
