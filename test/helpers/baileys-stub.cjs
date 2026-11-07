'use strict';
/**
 * Offline stand-in for @whiskeysockets/baileys 7.0.0-rc14. Each test copies it
 * into its temp folder as node_modules/@whiskeysockets/baileys/index.js, so the
 * CLI copy there loads this instead of the real library. It never opens a
 * network connection.
 *
 * It replays the event order of the real library (lib/Socket/socket.js and
 * chats.js): pair-success writes account + me, then the server closes the
 * stream with 515; `end()` emits one close and drops its listeners; a socket
 * whose creds have `me` logs in, one without shows a QR; after login, offline
 * messages are delivered and `receivedPendingNotifications` is emitted.
 *
 * Driven by environment variables:
 *   WA_SIM        JSON scenario for this process (see fields used below)
 *   WA_SIM_LOG    file this stub appends one line per event to
 *   WA_SIM_QUEUE  JSON array file standing in for the server's offline queue;
 *                 each successful login delivers and empties it
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const sim = JSON.parse(process.env.WA_SIM || '{}');
const record = (event) => fs.appendFileSync(process.env.WA_SIM_LOG, event + '\n');
const PAIR_SUCCESS = { account: { details: 'x' }, me: { id: '1:1@s.whatsapp.net', name: 'x' }, platform: 'iphone' };
let creds;
let sockets = 0;
let sent = 0;
let historyRequests = 0;
let dropped = false;

// The queue is a folder of batch files; each is claimed with an atomic
// rename, so a batch is delivered exactly once and never read half-written.
function takeQueue() {
  const dir = process.env.WA_SIM_QUEUE;
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const claimed = path.join(dir, `${name}.taken-${process.pid}`);
    try { fs.renameSync(path.join(dir, name), claimed); } catch { continue; }
    out.push(...JSON.parse(fs.readFileSync(claimed, 'utf8')));
    fs.unlinkSync(claimed);
  }
  return out;
}

const useMultiFileAuthState = async (dir) => {
  const file = path.join(dir, 'creds.json');
  creds = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { registered: false };
  return { state: { creds, keys: {} }, saveCreds: async () => fs.writeFileSync(file, JSON.stringify(creds)) };
};

const makeWASocket = () => {
  record('socket');
  if (sim.throwOnSocket === sockets++) throw new Error('socket creation failed');

  // Like the library's event buffer: while buffering, message upserts are held
  // until flush().
  const ev = new EventEmitter();
  const held = [];
  let buffering = false;
  const emitNow = ev.emit.bind(ev);
  ev.emit = (event, data) => {
    if (buffering && event === 'messages.upsert') {
      held.push(data);
      return true;
    }
    return emitNow(event, data);
  };
  ev.flush = () => {
    buffering = false;
    while (held.length) emitNow('messages.upsert', held.shift());
  };
  ev.on('creds.update', (update) => Object.assign(creds, update));

  let closed = false;
  const end = async (error) => {
    if (closed) return;
    closed = true;
    if (liveTimer) clearInterval(liveTimer);
    if (sim.writeKeyOnEnd) fs.writeFileSync(path.join(process.cwd(), 'auth', 'late-key.json'), '{}', { mode: 0o644 });
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } });
    ev.removeAllListeners('connection.update');
    // Like ev.destroy() in the library: anything still held back is gone.
    held.length = 0;
    buffering = false;
  };
  const failWith = (statusCode) => end({ output: { statusCode } });
  const pairSuccessThenRestart = () => {
    ev.emit('creds.update', PAIR_SUCCESS);
    ev.emit('connection.update', { isNewLogin: true, qr: undefined });
    failWith(515);
  };

  // { __update: [...] } stands for a messages.update event (poll votes,
  // edits, deletes); { __reaction: [...] } for a messages.reaction event.
  const emitSpecial = (item) => {
    if (item.__update) ev.emit('messages.update', item.__update);
    else if (item.__reaction) ev.emit('messages.reaction', item.__reaction);
    else return false;
    return true;
  };

  // After login: history (if any), queued offline messages, then the
  // end-of-offline signal. drain: 'never' withholds the signal; 'buffered'
  // also holds the messages until flush(), as the library does mid-batch.
  // While connected, anything added to the queue later arrives live.
  let liveTimer = null;
  const deliverOffline = () => {
    if (closed) return;
    const mode = sim.drain || 'normal';
    if (mode === 'buffered') buffering = true;
    for (const set of sim.history || []) ev.emit('messaging-history.set', set);
    const queued = takeQueue();
    const offline = queued.filter((m) => !m.__update && !m.__reaction);
    if (offline.length) ev.emit('messages.upsert', { messages: offline, type: 'append' });
    for (const item of queued) emitSpecial(item);
    if (mode === 'normal') ev.emit('connection.update', { receivedPendingNotifications: true });
    liveTimer = setInterval(() => {
      if (closed) return clearInterval(liveTimer);
      for (const item of takeQueue()) {
        if (!emitSpecial(item)) ev.emit('messages.upsert', { messages: [item], type: 'notify' });
      }
    }, 100);
    // One scripted drop for the first socket of this process.
    if (sim.dropOnce && !dropped) {
      dropped = true;
      setTimeout(() => failWith(sim.dropOnce.code), sim.dropOnce.afterMs);
    }
  };

  setTimeout(() => {
    ev.emit('connection.update', { connection: 'connecting' });
    if (creds.me) {
      const outcome = sim.logins && sim.logins.length ? sim.logins.shift() : 'open';
      if (outcome === 'open') {
        ev.emit('connection.update', { connection: 'open' });
        setTimeout(deliverOffline, 30);
      } else if (typeof outcome === 'number') {
        failWith(outcome);
      }
    } else if (sim.registration === 'scan') {
      record('qr');
      ev.emit('connection.update', { qr: 'FAKE-QR' });
      setTimeout(pairSuccessThenRestart, 50);
    } else if (sim.registration === 'qr-expires') {
      record('qr');
      ev.emit('connection.update', { qr: 'FAKE-QR' });
      setTimeout(() => failWith(408), 50);
    }
  }, 20);

  return {
    ev,
    end,
    get user() { return creds.me; },
    waitForSocketOpen: async () => {},
    requestPairingCode: async () => {
      record('requestPairingCode');
      creds.me = { id: '1@s.whatsapp.net', name: '~' };
      setTimeout(() => {
        ev.emit('creds.update', { registered: true });
        pairSuccessThenRestart();
      }, 50);
      return 'ABCD1234';
    },
    groupFetchAllParticipating: async () => {
      record('groupFetch');
      return sim.groups || {};
    },
    // The phone's on-demand history reply. sim.backfillReply: 'none' (never
    // answers), 'empty' (answers with no messages); sim.backfillNeedsAnchor:
    // ignores requests without a message id; sim.backfillOnlyFor: answers
    // only requests for that chat JID.
    // Returns the request id; the reply carries it as peerDataRequestSessionId.
    fetchMessageHistory: async (count, key, timestampMs) => {
      const requestId = `REQ${++historyRequests}`;
      record('historyRequest');
      record('historyRequestArgs ' + JSON.stringify({ count, key, timestampMs, requestId }));
      if (sim.backfillReply === 'none') return requestId;
      if (sim.backfillNeedsAnchor && !key.id) return requestId;
      if (sim.backfillOnlyFor && key.remoteJid !== sim.backfillOnlyFor) return requestId;
      const messages = sim.backfillReply === 'empty' ? [] : sim.backfill;
      if (messages) {
        setTimeout(() => ev.emit('messaging-history.set', {
          chats: [], contacts: [], messages, syncType: 6, peerDataRequestSessionId: requestId,
        }), 50);
      }
      return requestId;
    },
    // sim.groupMeta: { '<group jid>': { participants: [{ id, admin }] } }
    groupMetadata: async (jid) => {
      record('groupMetadata ' + jid);
      return (sim.groupMeta || {})[jid] || { id: jid, participants: [] };
    },
    // sim.lidMap: { '<lid>@lid': '<number>@s.whatsapp.net' }; the library
    // answers with device-specific JIDs.
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          const pn = (sim.lidMap || {})[lid];
          return pn ? pn.replace('@', ':0@') : null;
        },
        getLIDForPN: async (pn) => Object.keys(sim.lidMap || {}).find((lid) => sim.lidMap[lid] === pn) || null,
      },
    },
    sendMessage: async (jid, content, options = {}) => {
      const qm = options.quoted && options.quoted.message;
      const quotedText = qm ? (qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || undefined) : undefined;
      const quoted = options.quoted ? { id: options.quoted.key.id, fromMe: !!options.quoted.key.fromMe, text: quotedText } : undefined;
      record('send ' + JSON.stringify({ jid, content, quoted, messageId: options.messageId, ephemeralExpiration: options.ephemeralExpiration }));
      if (sim.sendFails) throw new Error('send failed');
      if (sim.textSendsFail && content.text !== undefined && !content.edit) throw new Error('Connection Closed');
      sent++;
      const key = { remoteJid: jid, id: options.messageId || `SENT${sent}`, fromMe: true };
      const textMessage = (text) => (quoted
        ? { extendedTextMessage: { text, contextInfo: { stanzaId: quoted.id } } }
        : { conversation: text });
      // Edits and deletes are protocol messages (types 14 and 0), as in the library.
      const message = content.edit ? { protocolMessage: { type: 14, key: content.edit, editedMessage: { conversation: content.text } } }
        : content.delete ? { protocolMessage: { type: 0, key: content.delete } }
          : content.react ? { reactionMessage: content.react }
            : content.text ? textMessage(content.text)
              : { documentMessage: {} };
      const full = { key, message, messageTimestamp: Math.floor(Date.now() / 1000) };
      // Like emitOwnEvents in the library: our own message comes back as an
      // upsert before the caller has the result, then processMessage turns
      // edits, deletes and reactions into their own events.
      ev.emit('messages.upsert', { messages: [full], type: 'append' });
      if (content.edit) {
        ev.emit('messages.update', [{ key: { ...key, id: content.edit.id }, update: { message: { editedMessage: { message: message.protocolMessage.editedMessage } } } }]);
      } else if (content.delete) {
        ev.emit('messages.update', [{ key: { ...key, id: content.delete.id }, update: { message: null, messageStubType: 1, key } }]);
      } else if (content.react) {
        ev.emit('messages.reaction', [{ key: content.react.key, reaction: { ...content.react, key } }]);
      }
      return full;
    },
  };
};

module.exports = {
  default: makeWASocket,
  useMultiFileAuthState,
  Browsers: { ubuntu: () => ['Ubuntu', 'Chrome', '22.04.4'] },
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  BufferJSON: { replacer: (k, v) => v, reviver: (k, v) => v },
  generateMessageIDV2: () => `3EB0${Math.random().toString(16).slice(2, 14).toUpperCase()}`,
  fetchLatestWaWebVersion: async () => {
    record('versionFetch');
    return sim.version || { version: [2, 3000, 999], isLatest: true };
  },
  downloadMediaMessage: async () => {
    record('download');
    return Buffer.from(sim.mediaBytes || 'MEDIA');
  },
  // Simplified tally: the stub's votes name their options directly instead of
  // carrying the hashed, encrypted selections the real library decrypts.
  getAggregateVotesInPollMessage: ({ message, pollUpdates }) => {
    const poll = message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3;
    const tally = poll.options.map((o) => ({ name: o.optionName, voters: [] }));
    for (const u of pollUpdates || []) {
      for (const name of u.vote.selectedOptions) {
        const opt = tally.find((t) => t.name === String(name));
        if (opt) opt.voters.push(u.pollUpdateMessageKey.participant);
      }
    }
    return tally;
  },
};
