'use strict';
/** Unit tests for lib/message-store.cjs: memory bound and ordering. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/message-store.cjs');

const msg = (chat, id, ts, text = 'x') => ({ key: { remoteJid: chat, id, fromMe: false, participant: '1@lid' }, messageTimestamp: ts, message: { conversation: text } });

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('store: only a bounded number of chats stay in memory, and evicted chats reload from disk', () => withDir((dir) => {
  const store = createStore(dir, { maxLoadedChats: 3 });
  for (let i = 0; i < 10; i++) {
    store.addMessages([msg(`${i}@g.us`, `M${i}`, 1000 + i)]);
    store.flush();
  }
  assert.ok(store.loadedChats() <= 3, `loaded ${store.loadedChats()}`);
  assert.deepEqual(store.messages('0@g.us').map((m) => m.id), ['M0']);
}));

test('store: a dirty chat is never evicted before it is saved', () => withDir((dir) => {
  const store = createStore(dir, { maxLoadedChats: 2 });
  for (let i = 0; i < 6; i++) store.addMessages([msg(`${i}@g.us`, `M${i}`, 1000 + i)]);
  store.flush();
  const fresh = createStore(dir);
  for (let i = 0; i < 6; i++) assert.equal(fresh.messages(`${i}@g.us`).length, 1, `chat ${i}`);
}));

test('store: messages stay in time order after out-of-order arrivals', () => withDir((dir) => {
  const store = createStore(dir);
  store.addMessages([msg('g@g.us', 'B', 2000)]);
  assert.deepEqual(store.messages('g@g.us').map((m) => m.id), ['B']);
  store.addMessages([msg('g@g.us', 'A', 1000), msg('g@g.us', 'C', 3000)]);
  assert.deepEqual(store.messages('g@g.us').map((m) => m.id), ['A', 'B', 'C']);
  store.purgeOlderThan(1500);
  assert.deepEqual(store.messages('g@g.us').map((m) => m.id), ['B', 'C']);
}));
