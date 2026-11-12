import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { validateItem } from '../shared/item.js';

const require = createRequire(import.meta.url);
require('../extension/core.js'); // sets globalThis.__saveback so the adapter can register
const adapter = require('../extension/adapters/facebook.js');

const doc = (html) => parseHTML(html).document;
const fixture = () => doc(readFileSync(new URL('./fixtures/facebook-saved.html', import.meta.url), 'utf8'));
const byId = (items, id) => items.find((i) => i.native_id === id);

test('extracts 4 items from fixture; two links to the same video collapse into one', () => {
  const items = adapter.extract(fixture());
  assert.deepEqual(items.map((i) => i.native_id), ['100000000000001', '200000000000002', '100000000000003', '400000000000004']);
  assert.equal(items.filter((i) => i.native_id === '100000000000001').length, 1);
});

test('video item: canonical watch url, longest link text, fbcdn thumbnail, page author', () => {
  const i = byId(adapter.extract(fixture()), '100000000000001');
  assert.equal(i.url, 'https://www.facebook.com/watch/?v=100000000000001');
  assert.equal(i.text, 'Sample video title that is quite a bit longer than the others');
  assert.deepEqual(i.media, ['https://scontent-test.xx.fbcdn.net/v/t15/img1.jpg']);
  assert.equal(i.author, 'Test Page');
  assert.equal(i.saved_at, null);
});

test('reel item uses the /reel/{id}/ form', () => {
  const i = byId(adapter.extract(fixture()), '200000000000002');
  assert.equal(i.url, 'https://www.facebook.com/reel/200000000000002/');
  assert.equal(i.text, 'Sample reel caption');
  assert.equal(i.author, 'Test Reel Source');
});

test('permalink keeps its path, drops tracking params, keeps the others', () => {
  const i = byId(adapter.extract(fixture()), '100000000000003');
  assert.equal(i.url, 'https://www.facebook.com/testpage/100000000000003/abcdef/?view_single=1');
  assert.equal(i.text, 'Sample post caption with a photo');
  assert.equal(i.author, 'Test Source Page');
});

test('tracking params __tn__, ref, mibextid, _rdr never survive in any url', () => {
  for (const i of adapter.extract(fixture())) assert.doesNotMatch(i.url, /__tn__|[?&]ref=|mibextid|_rdr/);
});

test('item with no text keeps its url (duration text is not the text)', () => {
  const i = byId(adapter.extract(fixture()), '400000000000004');
  assert.equal(i.text, '');
  assert.equal(i.author, '');
  assert.equal(i.url, 'https://www.facebook.com/watch/?v=400000000000004');
  assert.deepEqual(i.media, ['https://scontent-test.xx.fbcdn.net/v/t15/img4.jpg']);
});

test('links outside [role="main"] are ignored', () => {
  assert.equal(byId(adapter.extract(fixture()), '999999999999999'), undefined);
});

test('every item passes validateItem', () => {
  for (const i of adapter.extract(fixture())) validateItem(i);
});

test('a single saved item is its own card: nothing outside it leaks in (author, text, media)', () => {
  const d = doc(`<body><div role="main"><div><div><a href="/watch/?v=500000000000005"><img src="https://scontent-test.xx.fbcdn.net/a.jpg"></a>
    <a href="/watch/?v=500000000000005">Sample solo title</a></div></div>
    <div><a href="/profile.php?id=100000000000055"><span>Someone Else</span></a><img src="https://scontent-test.xx.fbcdn.net/other.jpg"><span>Outside text that is much longer than the title</span></div></div></body>`);
  const items = adapter.extract(d);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Sample solo title');
  assert.equal(items[0].author, '');
  assert.deepEqual(items[0].media, ['https://scontent-test.xx.fbcdn.net/a.jpg']);
});

test('a related-video link inside a card neither ends the climb nor becomes an item', () => {
  const items = adapter.extract(fixture());
  assert.equal(byId(items, '777000000000007'), undefined);
  assert.equal(byId(items, '100000000000001').text, 'Sample video title that is quite a bit longer than the others');
  assert.equal(byId(items, '100000000000001').author, 'Test Page');
});

test('a group source link with a numeric segment is not an item and does not cost the card its text', () => {
  const items = adapter.extract(fixture());
  assert.equal(items.length, 4);
  assert.equal(byId(items, '123456789012'), undefined);
  assert.equal(byId(items, '100000000000003').text, 'Sample post caption with a photo');
});

test('only post-like paths yield ids; groups, photo, pages and profile paths never do', () => {
  const link = (h) => `<a href="${h}"><img src="https://scontent-test.xx.fbcdn.net/a.jpg"></a><a href="${h}">T</a>`;
  const hrefs = ['/groups/123456789012/', '/photo/?fbid=123456789012', '/photo.php?fbid=123456789012', '/pages/Test/123456789012/info', '/profile.php?id=123456789012', '/events/123456789012/about/'];
  for (const h of hrefs) assert.deepEqual(adapter.extract(doc(`<body><div role="main">${link(h)}</div></body>`)), [], h);
  const ok = { '/testpage/posts/123456789012': '123456789012', '/permalink/123456789012/': '123456789012', '/testpage/123456789012/abc/': '123456789012', '/groups/987654321098/posts/123456789012/': '123456789012' };
  for (const [h, id] of Object.entries(ok)) assert.deepEqual(adapter.extract(doc(`<body><div role="main">${link(h)}</div></body>`)).map((i) => i.native_id), [id], h);
});

test('v must be digits before it is used in the canonical url', () => {
  const link = (v) => `<a href="/watch/?v=${v}"><img src="https://scontent-test.xx.fbcdn.net/a.jpg"></a><a href="/watch/?v=${v}">T</a>`;
  assert.deepEqual(adapter.extract(doc(`<body><div role="main">${link('abc%22def')}</div></body>`)), []);
});

test('an id seen through a single link only is secondary, not an item', () => {
  const d = doc('<body><div role="main"><a href="/watch/?v=600000000000006">Lone related link</a></div></body>');
  assert.deepEqual(adapter.extract(d), []);
});

test('non-fbcdn and non-http images are not media', () => {
  const d = doc(`<body><div role="main"><div><a href="/watch/?v=500000000000005"><img src="data:image/gif;base64,AAAA"><img src="https://example.com/x.jpg"></a><a href="/watch/?v=500000000000005">T</a></div></div></body>`);
  const [i] = adapter.extract(d);
  assert.deepEqual(i.media, []);
  validateItem(i);
});

test('no class names are used in selectors', () => {
  const sels = Object.values(adapter.SELECTORS).filter((v) => typeof v === 'string');
  assert.ok(sels.length > 0);
  for (const s of sels) assert.doesNotMatch(s, /(^|[\s>+~,])\.[A-Za-z_-]/, s);
});

test('matches() accepts /saved and /saved/, rejects home and other sites', () => {
  assert.equal(adapter.matches('https://www.facebook.com/saved'), true);
  assert.equal(adapter.matches('https://www.facebook.com/saved/'), true);
  assert.equal(adapter.matches('https://www.facebook.com/'), false);
  assert.equal(adapter.matches('https://www.facebook.com/saved/more'), false);
  assert.equal(adapter.matches('https://example.com/saved'), false);
});

test('extract on an empty page returns []', () => {
  assert.deepEqual(adapter.extract(doc('<html><body></body></html>')), []);
});
