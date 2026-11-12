import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/threads.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/threads-saved.html', import.meta.url), 'utf8'));
const byId = (items, id) => items.find((i) => i.native_id === id);

test('extracts 4 items from fixture', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['AbCdEfGh123', 'XyZ9876543', 'Q1w2E3r4T5y', 'Zx8Cv7Bn6M']);
  assert.equal(items[0].url, 'https://www.threads.com/@testuser/post/AbCdEfGh123');
  assert.equal(items[0].author, 'testuser');
  assert.equal(items[0].text, 'Sample post text');
  assert.deepEqual(items[0].media, [], 'avatar is not post media');
  assert.deepEqual(items[1].media, ['https://scontent.cdninstagram.com/v/photo-1.jpg']);
  assert.equal(items[3].text, 'Another sample post body');
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('image-only or text-less item still has author and url', () => {
  const i = byId(adapter.extract(fixture()), 'Q1w2E3r4T5y');
  assert.equal(i.text, '');
  assert.equal(i.author, 'photouser');
  assert.equal(i.url, 'https://www.threads.com/@photouser/post/Q1w2E3r4T5y');
  assert.deepEqual(i.media, ['https://scontent.fbcdn.net/v/photo-3.jpg']);
});

test('time datetime is not used as saved_at', () => {
  for (const i of adapter.extract(fixture())) assert.equal(i.saved_at, null);
});

test('matches() accepts the saved page and rejects the home page', () => {
  assert.equal(adapter.matches('https://www.threads.com/saved'), true);
  assert.equal(adapter.matches('https://www.threads.com/'), false);
  assert.equal(adapter.matches('https://example.com/saved'), false);
});

test('matches accepts threads.com and threads.net', () => {
  assert.equal(adapter.matches('https://www.threads.com/saved'), true);
  assert.equal(adapter.matches('https://threads.com/saved'), true);
  assert.equal(adapter.matches('https://www.threads.net/saved'), true);
  assert.equal(adapter.matches('https://www.threads.net/'), false);
});

test('a single post on the page is its own card (climb stops at data-pagelet)', () => {
  const d = doc(`<body><div data-pagelet="x"><div><a href="/@solo"><img src="https://scontent.cdninstagram.com/a.jpg"></a>
    <a href="/@solo/post/Abcdefgh1"><time datetime="2026-11-01T00:00:00Z">1d</time></a><div dir="auto">Sample solo text</div></div></div><div dir="auto">Outside the card text that is much longer</div></body>`);
  const [i, ...rest] = adapter.extract(d);
  assert.equal(rest.length, 0);
  assert.equal(i.text, 'Sample solo text');
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});
