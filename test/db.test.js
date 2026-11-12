import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertItem, getSaved, searchSaved, listRecent, listUnseen, markSeen, addNote, setTags } from '../server/db.js';

const mk = (over = {}) => ({
  platform: 'x',
  native_id: '1',
  url: 'https://x.com/jane/status/1',
  author: 'jane',
  text: 'sourdough starter tips',
  media: [],
  saved_at: '2026-11-01T10:00:00.000Z',
  transcript: null,
  ...over,
});

test('upsert twice keeps one row and preserves seen/notes/tags', () => {
  const db = openDb(':memory:');
  assert.deepEqual(upsertItem(db, mk()), { id: 'x:1', created: true });
  markSeen(db, 'x:1');
  addNote(db, 'x:1', 'try this');
  setTags(db, 'x:1', ['food']);
  const before = getSaved(db, 'x:1');

  assert.deepEqual(upsertItem(db, mk({ text: 'edited sourdough text', media: ['https://a.com/1.jpg'] })), { id: 'x:1', created: false });

  const row = getSaved(db, 'x:1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 1);
  assert.equal(row.text, 'edited sourdough text');
  assert.deepEqual(row.media, ['https://a.com/1.jpg']);
  assert.equal(row.seen, true);
  assert.equal(row.notes, 'try this');
  assert.deepEqual(row.tags, ['food']);
  assert.equal(row.captured_at, before.captured_at);
  // FTS follows the update, with no stale duplicate
  assert.equal(searchSaved(db, { query: 'edited' }).length, 1);
  assert.equal(searchSaved(db, { query: 'starter' }).length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items_fts').get().n, 1);
});

test('getSaved returns null for unknown id; mutators return false', () => {
  const db = openDb(':memory:');
  assert.equal(getSaved(db, 'x:nope'), null);
  assert.equal(markSeen(db, 'x:nope'), false);
  assert.equal(addNote(db, 'x:nope', 'n'), false);
  assert.equal(setTags(db, 'x:nope', ['a']), false);
});

test('search finds by text, author and transcript', () => {
  const db = openDb(':memory:');
  upsertItem(db, mk({ native_id: '1', text: 'gardening hacks', author: 'bob' }));
  upsertItem(db, mk({ native_id: '2', text: 'other', author: 'zelda' }));
  upsertItem(db, mk({ platform: 'youtube', native_id: 'v', url: 'https://youtube.com/watch?v=v', text: 'video', author: 'chan', transcript: 'mulch the beds in autumn' }));
  assert.deepEqual(searchSaved(db, { query: 'gardening' }).map((r) => r.id), ['x:1']);
  assert.deepEqual(searchSaved(db, { query: 'zelda' }).map((r) => r.id), ['x:2']);
  assert.deepEqual(searchSaved(db, { query: 'mulch autumn' }).map((r) => r.id), ['youtube:v']);
});

test("search with syntax chars '\"', 'a-b', 'x:' does not throw", () => {
  const db = openDb(':memory:');
  upsertItem(db, mk({ text: 'a-b testing x: things "quoted"' }));
  for (const q of ['"', 'a-b', 'x:', 'foo*', '"unbalanced', 'NOT', 'a OR', '(', '^x', '-', '""', 'a"b', "it's", 'col:val AND (b']) {
    assert.doesNotThrow(() => searchSaved(db, { query: q }), q);
  }
  assert.equal(searchSaved(db, { query: 'a-b' }).length, 1);
  assert.equal(searchSaved(db, { query: 'x:' }).length, 1);
});

test('platform and since filters', () => {
  const db = openDb(':memory:');
  upsertItem(db, mk({ native_id: '1', text: 'cats', saved_at: '2026-10-01T00:00:00.000Z' }));
  upsertItem(db, mk({ native_id: '2', text: 'cats', saved_at: '2026-11-10T00:00:00.000Z' }));
  upsertItem(db, mk({ platform: 'reddit', native_id: '3', url: 'https://reddit.com/r/a/3', text: 'cats', saved_at: '2026-11-10T00:00:00.000Z' }));
  assert.deepEqual(searchSaved(db, { query: 'cats', platform: 'reddit' }).map((r) => r.id), ['reddit:3']);
  assert.deepEqual(searchSaved(db, { query: 'cats', since: '2026-11-01' }).map((r) => r.id).sort(), ['reddit:3', 'x:2']);
  assert.equal(searchSaved(db, { query: '', since: '2026-11-01', platform: 'x' }).length, 1);
});

test('empty query returns most recent; limit defaults and caps', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 130; i++) upsertItem(db, mk({ native_id: String(i), saved_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  const def = searchSaved(db, { query: '  ' });
  assert.equal(def.length, 20);
  assert.equal(def[0].id, 'x:129');
  assert.equal(searchSaved(db, { query: '', limit: 1000 }).length, 100);
  assert.equal(listRecent(db, { limit: 3 }).length, 3);
});

test('listUnseen excludes seen items and honours olderThanDays', () => {
  const db = openDb(':memory:');
  upsertItem(db, mk({ native_id: '1', saved_at: '2020-01-01T00:00:00.000Z' }));
  upsertItem(db, mk({ native_id: '2', saved_at: '2020-01-01T00:00:00.000Z' }));
  upsertItem(db, mk({ native_id: '3', saved_at: null }));
  markSeen(db, 'x:2');
  assert.deepEqual(listUnseen(db, {}).map((r) => r.id).sort(), ['x:1', 'x:3']);
  assert.deepEqual(listUnseen(db, { olderThanDays: 30 }).map((r) => r.id), ['x:1']);
});

test('empty-text item found by author and by url', () => {
  const db = openDb(':memory:');
  upsertItem(db, mk({ native_id: '9', text: '', author: 'pixelpat', url: 'https://instagram.com/p/AbC123/', platform: 'instagram', media: ['https://cdn.com/i.jpg'] }));
  assert.deepEqual(searchSaved(db, { query: 'pixelpat' }).map((r) => r.id), ['instagram:9']);
  assert.deepEqual(searchSaved(db, { query: 'https://instagram.com/p/AbC123/' }).map((r) => r.id), ['instagram:9']);
  assert.deepEqual(searchSaved(db, { query: 'AbC123' }).map((r) => r.id), ['instagram:9']);
});

test('notes are searchable after addNote, and append', () => {
  const db = openDb(':memory:');
  upsertItem(db, mk());
  assert.equal(searchSaved(db, { query: 'quokka' }).length, 0);
  assert.equal(addNote(db, 'x:1', 'quokka idea'), true);
  assert.equal(addNote(db, 'x:1', 'second thought'), true);
  assert.equal(searchSaved(db, { query: 'quokka' }).length, 1);
  assert.equal(searchSaved(db, { query: 'second' }).length, 1);
  assert.equal(getSaved(db, 'x:1').notes, 'quokka idea\nsecond thought');
  assert.equal(db.prepare('SELECT count(*) AS n FROM items_fts').get().n, 1);
});
