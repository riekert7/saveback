import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateItem, itemId } from '../shared/item.js';

const full = {
  platform: 'x',
  native_id: '123',
  url: 'https://x.com/a/status/123',
  author: 'a',
  text: 'hello',
  media: ['https://pbs.twimg.com/1.jpg'],
  saved_at: '2026-11-12T10:00:00.000Z',
  transcript: 'spoken',
};

test('valid item round-trips', () => {
  assert.deepEqual(validateItem(full), full);
  assert.equal(itemId(full), 'x:123');
});

test('rejects unknown platform', () => {
  assert.throws(() => validateItem({ ...full, platform: 'myspace' }), /platform/);
});

test('rejects non-http url (javascript:)', () => {
  assert.throws(() => validateItem({ ...full, url: 'javascript:alert(1)' }), /url/);
});

test('defaults optional fields', () => {
  const { author, text, media, transcript, saved_at, ...min } = full;
  const item = validateItem(min);
  assert.equal(item.author, '');
  assert.equal(item.text, '');
  assert.deepEqual(item.media, []);
  assert.equal(item.transcript, null);
  assert.equal(item.saved_at, null);
});

test('accepts empty text', () => {
  assert.equal(validateItem({ ...full, text: '' }).text, '');
});

test('drops unknown fields', () => {
  const item = validateItem({ ...full, evil: 1 });
  assert.equal('evil' in item, false);
});
