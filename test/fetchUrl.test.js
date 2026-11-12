import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchSaveable } from '../server/fetchUrl.js';
import { validateItem } from '../shared/item.js';

const PUBLIC = async () => ['93.184.216.34'];
const html = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const yt = readFileSync(new URL('./fixtures/yt-player.html', import.meta.url), 'utf8');

/** fetch stub that records every requested url */
function stub(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'manual', 'redirects must be handled manually');
    return handler(String(url));
  };
  fn.calls = calls;
  return fn;
}

test('blocks 127.0.0.1, localhost, 169.254.169.254, 10.0.0.5', async () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://foo.localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/']) {
    const f = stub(() => html('x'));
    await assert.rejects(fetchSaveable(u, { fetch: f, lookup: PUBLIC }), /blocked/, u);
    assert.equal(f.calls.length, 0, `${u} must not be fetched`);
  }
});

test('blocks the rest of the private, link-local, CGNAT and ipv6 ranges (literal and via dns)', async () => {
  const hosts = [
    '0.0.0.0', '127.5.5.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255',
    '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[febf::1]',
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:169.254.169.254]', '[64:ff9b::7f00:1]',
    '2130706433', '0x7f.0.0.1', '0177.0.0.1',
  ];
  for (const h of hosts) {
    const f = stub(() => html('x'));
    await assert.rejects(fetchSaveable(`http://${h}/`, { fetch: f, lookup: PUBLIC }), /blocked/, h);
    assert.equal(f.calls.length, 0, h);
  }
  // hostname that resolves to a blocked address, including when only one of several is blocked
  for (const addrs of [['10.1.2.3'], ['93.184.216.34', '127.0.0.1'], ['::ffff:192.168.0.1'], ['fe80::1']]) {
    const f = stub(() => html('x'));
    await assert.rejects(fetchSaveable('http://evil.example/', { fetch: f, lookup: async () => addrs }), /blocked/, addrs.join());
    assert.equal(f.calls.length, 0);
  }
  // unresolvable or empty answer is refused too
  await assert.rejects(fetchSaveable('http://nx.example/', { fetch: stub(() => html('x')), lookup: async () => [] }));
});

test('allows public addresses just outside the blocked ranges', async () => {
  for (const h of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '169.253.0.1', '8.8.8.8', '[2606:4700::1111]']) {
    const item = await fetchSaveable(`http://${h}/`, { fetch: stub(() => html('<title>ok</title>')), lookup: PUBLIC });
    assert.equal(item.platform, 'web', h);
  }
});

test('blocks redirect to private address, relative redirects resolve, max 3 redirects', async () => {
  const f = stub((u) => (u === 'https://a.example/' ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) : html('secret')));
  await assert.rejects(fetchSaveable('https://a.example/', { fetch: f, lookup: PUBLIC }), /blocked/);
  assert.deepEqual(f.calls, ['https://a.example/']);

  // redirect whose host only resolves to a private address at the second hop
  const lookup = async (h) => (h === 'inner.example' ? ['10.0.0.9'] : ['93.184.216.34']);
  const f2 = stub(() => new Response(null, { status: 301, headers: { location: 'https://inner.example/x' } }));
  await assert.rejects(fetchSaveable('https://a.example/', { fetch: f2, lookup }), /blocked/);

  const f3 = stub((u) => (u.endsWith('/start') ? new Response(null, { status: 302, headers: { location: '/next' } }) : html('<title>landed</title>')));
  const item = await fetchSaveable('https://a.example/start', { fetch: f3, lookup: PUBLIC });
  assert.equal(item.url, 'https://a.example/next');

  const loop = stub(() => new Response(null, { status: 302, headers: { location: '/again' } }));
  await assert.rejects(fetchSaveable('https://a.example/', { fetch: loop, lookup: PUBLIC }), /redirect/);
  assert.equal(loop.calls.length, 4); // original + 3 redirects

  const ftp = stub(() => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));
  await assert.rejects(fetchSaveable('https://a.example/', { fetch: ftp, lookup: PUBLIC }), /http/);
});

test('non-http scheme rejected', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://a.example/', 'javascript:alert(1)', 'gopher://a.example/', 'not a url']) {
    const f = stub(() => html('x'));
    await assert.rejects(fetchSaveable(u, { fetch: f, lookup: PUBLIC }), u);
    assert.equal(f.calls.length, 0);
  }
});

test('html page becomes web item with title and stripped text', async () => {
  const page = `<!doctype html><html><head><title>Hello &amp; welcome</title><style>body{color:red}</style></head>
    <body><script>var secret = 1;</script><!-- hidden --><h1>Big</h1><p>Some <b>bold</b> text&nbsp;here &lt;ok&gt;.</p><noscript>no js</noscript></body></html>`;
  const item = await fetchSaveable('https://a.example/post?x=1', { fetch: stub(() => html(page)), lookup: PUBLIC });
  validateItem(item);
  assert.equal(item.platform, 'web');
  assert.equal(item.url, 'https://a.example/post?x=1');
  assert.equal(item.native_id, createHash('sha1').update('https://a.example/post?x=1').digest('hex').slice(0, 16));
  assert.match(item.text, /^Hello & welcome/);
  assert.match(item.text, /Big/);
  assert.match(item.text, /Some bold text here <ok>\./);
  assert.doesNotMatch(item.text, /secret|color:red|hidden|no js|<b>/);
  assert.equal(item.transcript, null);
});

test('text is capped at 20000 chars and the body read is capped at 2 MB', async () => {
  const big = '<title>t</title><p>' + 'a'.repeat(3 * 1024 * 1024) + '</p>';
  const item = await fetchSaveable('https://a.example/', { fetch: stub(() => html(big)), lookup: PUBLIC });
  assert.equal(item.text.length, 20000);
});

test('non-text content type gives an empty web item instead of throwing', async () => {
  const f = stub(() => new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }));
  const item = await fetchSaveable('https://a.example/doc.pdf', { fetch: f, lookup: PUBLIC });
  validateItem(item);
  assert.equal(item.platform, 'web');
  assert.equal(item.text, '');
  assert.equal(item.url, 'https://a.example/doc.pdf');
  const plain = await fetchSaveable('https://a.example/a.txt', { fetch: stub(() => new Response('just text', { headers: { 'content-type': 'text/plain' } })), lookup: PUBLIC });
  assert.equal(plain.text, 'just text');
});

test('http error status throws', async () => {
  await assert.rejects(fetchSaveable('https://a.example/', { fetch: stub(() => new Response('no', { status: 500, headers: { 'content-type': 'text/html' } })), lookup: PUBLIC }), /500/);
});

test('youtube watch url becomes youtube item with transcript from fixture', async () => {
  const xml = '<?xml version="1.0"?><transcript><text start="0" dur="1">Hello &amp; welcome</text><text start="1" dur="1">it&#39;s a &quot;test&quot; &lt;3</text><text start="2" dur="1">third</text></transcript>';
  const f = stub((u) => (u.includes('/api/timedtext') ? new Response(xml, { headers: { 'content-type': 'text/xml' } }) : html(yt)));
  for (const u of ['https://www.youtube.com/watch?v=abc123XYZ_-&t=5s', 'https://youtu.be/abc123XYZ_-?si=zz', 'https://m.youtube.com/watch?v=abc123XYZ_-']) {
    const item = await fetchSaveable(u, { fetch: f, lookup: PUBLIC });
    validateItem(item);
    assert.equal(item.platform, 'youtube');
    assert.equal(item.native_id, 'abc123XYZ_-');
    assert.equal(item.url, 'https://www.youtube.com/watch?v=abc123XYZ_-');
    assert.equal(item.author, 'Jane Dev');
    assert.match(item.text, /How to ship/);
    assert.equal(item.transcript, 'Hello & welcome it\'s a "test" <3 third');
  }
});

test('youtube without captions has null transcript', async () => {
  const bare = yt.replace(/"captions":\{.*?\]\}\}/s, '"x":1');
  assert.ok(!bare.includes('captionTracks'));
  const f = stub(() => html(bare));
  const item = await fetchSaveable('https://www.youtube.com/watch?v=abc123XYZ_-', { fetch: f, lookup: PUBLIC });
  assert.equal(item.platform, 'youtube');
  assert.equal(item.transcript, null);
  assert.equal(f.calls.length, 1);
});

test('youtube caption url is also guarded', async () => {
  const evil = yt.replace('https://www.youtube.com/api/timedtext', 'http://169.254.169.254/latest');
  const f = stub(() => html(evil));
  const item = await fetchSaveable('https://www.youtube.com/watch?v=abc123XYZ_-', { fetch: f, lookup: PUBLIC });
  assert.equal(item.transcript, null);
  assert.equal(f.calls.length, 1);
});
