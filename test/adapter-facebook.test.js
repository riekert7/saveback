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

test('a single saved item on the page is its own card', () => {
  const d = doc(`<body><div role="main"><div><a href="/watch/?v=500000000000005"><img src="https://scontent-test.xx.fbcdn.net/a.jpg"></a>
    <a href="/watch/?v=500000000000005">Sample solo title</a></div></div></body>`);
  const items = adapter.extract(d);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Sample solo title');
});

test('non-fbcdn and non-http images are not media', () => {
  const d = doc(`<body><div role="main"><div><a href="/watch/?v=500000000000005"><img src="data:image/gif;base64,AAAA"><img src="https://example.com/x.jpg"></a></div></div></body>`);
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
