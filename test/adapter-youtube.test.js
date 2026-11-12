import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/youtube.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/youtube-saved.html', import.meta.url), 'utf8'));
const byId = (items, id) => items.find((i) => i.native_id === id);
const row = (href, title, dur = '1:00', id = 'zzzzzzzzzzz') =>
  `<yt-lockup-view-model><a href="${href}"><img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg"><span>${dur}</span></a><a href="${href}"><span>${title}</span></a></yt-lockup-view-model>`;

test('extracts 4 items from fixture', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']);
  assert.equal(items[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal(items[0].text, 'Sample video title one');
  assert.deepEqual(items[0].media, ['https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg']);
  assert.equal(items[0].author, '');
  assert.equal(items[0].transcript, null);
  assert.equal(items[0].saved_at, null);
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('title-less item has empty text and still has url and thumbnail', () => {
  const i = byId(adapter.extract(fixture()), 'ccccccccccc');
  assert.equal(i.text, '');
  assert.equal(i.url, 'https://www.youtube.com/watch?v=ccccccccccc');
  assert.deepEqual(i.media, ['https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg']);
});

test('the duration-only anchor is never used as the title', () => {
  const items = adapter.extract(fixture());
  for (const i of items) assert.doesNotMatch(i.text, /^\d{1,2}(:\d{2}){1,2}$/);
  // duration anchor first in document order, longer-looking duration, still not the title
  const [i] = adapter.extract(doc(row('/watch?v=eeeeeeeeeee&list=WL', 'Hi', '1:02:03', 'eeeeeeeeeee')));
  assert.equal(i.text, 'Hi');
});

test('a duration-only anchor without a thumbnail is not the title either', () => {
  const d = doc('<yt-lockup-view-model><a href="/watch?v=aaaaaaaaaaa&list=WL"><span>12:34</span></a></yt-lockup-view-model>');
  assert.equal(adapter.extract(d)[0].text, '');
});

test('a row with no v= is skipped, the rest are kept', () => {
  const d = doc(row('/playlist?list=PLx', 'No video here') + row('/watch?v=aaaaaaaaaaa&list=WL', 'Kept', '2:00', 'aaaaaaaaaaa'));
  assert.deepEqual(adapter.extract(d).map((i) => i.native_id), ['aaaaaaaaaaa']);
});

test('a v that is not 11 characters is skipped', () => {
  assert.deepEqual(adapter.extract(doc(row('/watch?v=short&list=WL', 'Bad id'))), []);
});

test('rows for the same video id appear once', () => {
  const d = doc(row('/watch?v=aaaaaaaaaaa&list=WL&index=1', 'First', '2:00', 'aaaaaaaaaaa') + row('/watch?v=aaaaaaaaaaa&list=WL&index=9', 'Again', '2:00', 'aaaaaaaaaaa'));
  const items = adapter.extract(d);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'First');
});

test('matches() accepts playlist pages incl. Watch Later, rejects watch page and home', () => {
  assert.equal(adapter.matches('https://www.youtube.com/playlist?list=WL'), true);
  assert.equal(adapter.matches('https://www.youtube.com/playlist?list=PLtestlist'), true);
  assert.equal(adapter.matches('https://www.youtube.com/'), false);
  assert.equal(adapter.matches('https://www.youtube.com/watch?v=aaaaaaaaaaa&list=WL'), false);
  assert.equal(adapter.matches('https://www.youtube.com/playlist'), false);
  assert.equal(adapter.matches('https://example.com/playlist?list=WL'), false);
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});
