import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/instagram.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/instagram-saved.html', import.meta.url), 'utf8'));
const byId = (items, id) => items.find((i) => i.native_id === id);

test('extracts 4 items from fixture, ignoring non-post links', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['AAAA1111aa', 'BBBB2222bb', 'CCCC3333cc', 'DDDD4444dd']);
  assert.equal(items[0].url, 'https://www.instagram.com/p/AAAA1111aa/');
  assert.equal(items[0].text, 'Photo of a sample desk with a laptop and a cup of tea');
  assert.deepEqual(items[0].media, ['https://scontent-test.cdninstagram.com/v/t51/img1.jpg']);
  assert.equal(items[0].author, '', 'the grid does not show the author');
  assert.equal(items[0].saved_at, null);
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('image-only item has empty text and still has url and media', () => {
  const i = byId(adapter.extract(fixture()), 'CCCC3333cc');
  assert.equal(i.text, '');
  assert.equal(i.url, 'https://www.instagram.com/p/CCCC3333cc/');
  assert.deepEqual(i.media, ['https://scontent-test.cdninstagram.com/v/t51/img3.jpg']);
});

test('a reel (Clip marker) is extracted like any other post', () => {
  const i = byId(adapter.extract(fixture()), 'BBBB2222bb');
  assert.equal(i.text, 'Sample reel caption about a test recipe');
});

test('the same post linked twice appears once', () => {
  const d = doc(`<body><a href="/p/Zz9Zz9Zz9Z/" role="link"><img alt="One" src="https://scontent-test.cdninstagram.com/a.jpg"></a>
    <a href="/p/Zz9Zz9Zz9Z/" role="link"><img alt="One" src="https://scontent-test.cdninstagram.com/a.jpg"></a></body>`);
  assert.equal(adapter.extract(d).length, 1);
});

test('a non-http image src is dropped from media', () => {
  const d = doc('<body><a href="/p/Zz9Zz9Zz9Z/" role="link"><img alt="One" src="data:image/gif;base64,AAAA"></a></body>');
  const [i] = adapter.extract(d);
  assert.deepEqual(i.media, []);
  validateItem(i);
});

test('matches() accepts All posts and collection pages, rejects home', () => {
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/all-posts/'), true);
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/all-posts'), true);
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/my-list/17900000000000000/'), true);
  assert.equal(adapter.matches('https://www.instagram.com/'), false);
  assert.equal(adapter.matches('https://example.com/test_user/saved/all-posts/'), false);
});

test('collection branch is anchored: trailing junk and non-numeric ids are rejected', () => {
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/all-posts/foo/'), false);
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/my-list/notanid/'), false);
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/my-list/17900000000000000/extra'), false);
});

test('collections overview page is rejected by matches()', () => {
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved/'), false);
  assert.equal(adapter.matches('https://www.instagram.com/test_user/saved'), false);
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});
