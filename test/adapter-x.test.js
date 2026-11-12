import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/x.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/x-saved.html', import.meta.url), 'utf8'));

test('extracts 4 items from fixture', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['1234567890123456789', '1234567890123456790', '1234567890123456791', '1234567890123456792']);
  assert.equal(items[0].url, 'https://x.com/testuser/status/1234567890123456789');
  assert.equal(items[0].author, 'testuser');
  assert.equal(items[0].text, 'Sample post text');
  assert.equal(items[0].saved_at, null);
  assert.equal(items[3].text, 'Sample long post text', 'show-more button text is stripped');
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('image-only or text-less item still has author and url', () => {
  const i = adapter.extract(fixture()).find((x) => x.native_id === '1234567890123456791');
  assert.equal(i.text, '');
  assert.equal(i.author, 'mediauser');
  assert.equal(i.url, 'https://x.com/mediauser/status/1234567890123456791');
  assert.deepEqual(i.media, ['https://pbs.twimg.com/media/PHOTO1.jpg?format=jpg&name=medium', 'https://pbs.twimg.com/amplify_video_thumb/1/img/POSTER.jpg']);
});

test('quoted tweet text is not used (first tweetText only)', () => {
  const items = adapter.extract(fixture());
  const q = items.find((x) => x.native_id === '1234567890123456790');
  assert.equal(q.text, 'Own text of the quoting post');
  assert.equal(q.author, 'otheruser');
  assert.deepEqual(q.media, [], 'quoted photo is not the post media');
  // a quote with no text of its own must not inherit the quoted text
  const d = doc(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/a/status/1234567890123456800"><time datetime="2026-11-01T00:00:00Z"></time></a></div>
    <div role="link"><div data-testid="tweetText">Quoted</div></div></article>`);
  assert.equal(adapter.extract(d)[0].text, '');
});

test('matches() accepts the saved page and rejects the home page', () => {
  assert.equal(adapter.matches('https://x.com/i/history'), true);
  assert.equal(adapter.matches('https://x.com/home'), false);
  assert.equal(adapter.matches('https://example.com/i/history'), false);
});

test('matches accepts both /i/history and /i/bookmarks', () => {
  assert.equal(adapter.matches('https://x.com/i/bookmarks'), true);
  assert.equal(adapter.matches('https://x.com/i/history'), true);
  assert.equal(adapter.matches('https://twitter.com/i/bookmarks'), true);
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});

test('a card without a permalink is skipped, not fatal', () => {
  const d = doc('<article data-testid="tweet"><div data-testid="tweetText">x</div></article>');
  assert.deepEqual(adapter.extract(d), []);
});

test('registers itself with core', () => {
  assert.ok(globalThis.__saveback.adapters.some((a) => a.platform === 'x'));
});
