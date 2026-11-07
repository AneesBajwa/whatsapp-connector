'use strict';
/** Offline tests for `search`: answered from the store alone, never connecting. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKit, waMessage, QR_LINKED } = require('./helpers/harness.cjs');

const G1 = '120363000000000001@g.us';
const G2 = '120363000000000002@g.us';
const ALICE = '111@lid';

function seeded(fn) {
  const kit = createKit({ creds: QR_LINKED });
  try {
    kit.queue([
      waMessage({ chat: G1, id: 'M1', text: 'Venue options: the community hall or the park', from: ALICE, name: 'Alice', ts: 1000 }),
      waMessage({ chat: G1, id: 'M2', text: 'We decided on the hall as the VENUE', from: ALICE, name: 'Alice', ts: 2000 }),
      waMessage({ chat: G2, id: 'M3', text: 'Café venue booked', from: ALICE, name: 'Alice', ts: 3000 }),
      waMessage({ chat: G2, id: 'M4', text: 'unrelated message', from: ALICE, name: 'Alice', ts: 4000 }),
    ]);
    kit.cli(['chats'], { sim: { groups: { [G1]: { subject: 'Planning' }, [G2]: { subject: 'Food' } } } });
    return fn(kit);
  } finally {
    kit.cleanup();
  }
}

test('search: finds messages containing every word, newest first, across chats, without connecting', () => seeded((kit) => {
  const before = kit.count('socket');
  const r = kit.cli(['search', '--query', 'venue', '--days', '100000']);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.result.results.map((m) => m.id), ['M3', 'M2', 'M1']);
  assert.equal(r.result.results[0].chatName, 'Food');
  assert.equal(kit.count('socket'), before);
}));

test('search: every word must match, ignoring case and accents', () => seeded((kit) => {
  const r = kit.cli(['search', '--query', 'HALL decided', '--days', '100000']);
  assert.deepEqual(r.result.results.map((m) => m.id), ['M2']);
  const accents = kit.cli(['search', '--query', 'cafe', '--days', '100000']);
  assert.deepEqual(accents.result.results.map((m) => m.id), ['M3']);
}));

test('search: --jid keeps it to one chat', () => seeded((kit) => {
  const r = kit.cli(['search', '--query', 'venue', '--jid', G1, '--days', '100000']);
  assert.deepEqual(r.result.results.map((m) => m.id), ['M2', 'M1']);
}));

test('search: needs --query', () => seeded((kit) => {
  const r = kit.cli(['search']);
  assert.equal(r.exit, 1);
}));
