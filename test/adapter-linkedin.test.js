import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/linkedin.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/linkedin-saved.html', import.meta.url), 'utf8'));
const byId = (items, id) => items.find((i) => i.native_id === id);

test('extracts 4 items from fixture', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['7000000000000000001', '7000000000000000002', '7000000000000000003', '7000000000000000004']);
  assert.equal(items[0].author, 'Test User');
  assert.equal(items[0].saved_at, null);
  assert.equal(items[3].text, 'Another sample post body for the fourth card');
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('image-only or text-less item still has author and url', () => {
  const i = byId(adapter.extract(fixture()), '7000000000000000003');
  assert.equal(i.text, '');
  assert.equal(i.author, 'Image User');
  assert.equal(i.url, 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000003/');
  assert.deepEqual(i.media, ['https://media.licdn.com/dms/image/post-photo-3/feedshare-shrink_800/0/1.jpg']);
});

test('see-more button text is stripped from the body', () => {
  const i = byId(adapter.extract(fixture()), '7000000000000000001');
  assert.equal(i.text, 'Sample post text\nSecond line of sample text');
  assert.ok(!/see more/i.test(i.text));
});

test('avatar is not listed as post media', () => {
  const items = adapter.extract(fixture());
  for (const i of items) assert.ok(i.media.every((m) => !m.includes('avatar-')), i.native_id);
  assert.deepEqual(byId(items, '7000000000000000001').media, []);
  assert.deepEqual(byId(items, '7000000000000000002').media, ['https://media.licdn.com/dms/image/post-photo-1/feedshare-shrink_800/0/1.jpg']);
});

test('url drops the updateEntityUrn query', () => {
  for (const i of adapter.extract(fixture())) {
    assert.equal(i.url, `https://www.linkedin.com/feed/update/urn:li:activity:${i.native_id}/`);
    assert.ok(!i.url.includes('?'));
  }
});

test('author falls back to the profile slug when the name text is empty', () => {
  const d = doc(`<div data-view-name="search-entity-result-content-a-template" data-chameleon-result-urn="urn:li:activity:7000000000000000009">
    <a href="https://www.linkedin.com/in/some-slug?x=1"><img src="https://media.licdn.com/a.jpg"></a></div>`);
  assert.equal(adapter.extract(d)[0].author, 'some-slug');
});

test('matches() accepts the saved page and rejects the home page', () => {
  assert.equal(adapter.matches('https://www.linkedin.com/my-items/saved-posts/'), true);
  assert.equal(adapter.matches('https://www.linkedin.com/feed/'), false);
  assert.equal(adapter.matches('https://example.com/my-items/saved-posts/'), false);
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});

test('a card without an activity urn is skipped, not fatal', () => {
  const d = doc('<div data-view-name="search-entity-result-content-a-template"><p>x</p></div>');
  assert.deepEqual(adapter.extract(d), []);
});
