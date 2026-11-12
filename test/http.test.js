import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb, getSaved, listRecent } from '../server/db.js';
import { createReceiver } from '../server/http.js';

const mk = (over = {}) => ({
  platform: 'x', native_id: '1', url: 'https://x.com/jane/status/1', author: 'jane',
  text: 'hello', media: [], saved_at: '2026-11-01T10:00:00.000Z', transcript: null, ...over,
});

/** start a receiver on an ephemeral port; returns {db, base, close} */
async function start(opts = {}) {
  const db = openDb(':memory:');
  const server = http.createServer(createReceiver({ db, ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => server.close() };
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('ingest stores valid items and reports bad index', async () => {
  const { db, base, close } = await start();
  const res = await post(base, { items: [mk(), { platform: 'nope' }, mk({ native_id: '3', url: 'https://x.com/jane/status/3' })] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stored, 2);
  assert.equal(body.created, 2);
  assert.equal(body.errors.length, 1);
  assert.equal(body.errors[0].index, 1);
  assert.match(body.errors[0].message, /platform/);
  assert.ok(getSaved(db, 'x:1'));
  assert.ok(getSaved(db, 'x:3'));
  close();
});

test('saved_at is normalised to UTC ISO', async () => {
  const { db, base, close } = await start();
  await post(base, { items: [mk({ saved_at: '2026-11-01T12:00:00+02:00' })] });
  assert.equal(getSaved(db, 'x:1').saved_at, '2026-11-01T10:00:00.000Z');
  close();
});

test('re-ingest does not duplicate', async () => {
  const { db, base, close } = await start();
  await post(base, { items: [mk()] });
  const body = await (await post(base, { items: [mk({ text: 'edited' })] })).json();
  assert.deepEqual(body, { stored: 1, created: 0, errors: [] });
  assert.equal(listRecent(db).length, 1);
  close();
});

test('health', async () => {
  const { base, close } = await start();
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
  close();
});

test('health is open without a token even when a token is set; ingest is not', async () => {
  const { base, close } = await start({ token: 's3cret' });
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await post(base, { items: [] })).status, 401);
  close();
});

test('403 for Origin https://evil.example, even with a valid token', async () => {
  const { db, base, close } = await start({ token: 's3cret' });
  const res = await post(base, { items: [mk()] }, { origin: 'https://evil.example', authorization: 'Bearer s3cret' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(getSaved(db, 'x:1'), null);
  close();
});

test('chrome-extension origin allowed and echoed; preflight lists headers and methods', async () => {
  const { base, close } = await start({ token: 's3cret' });
  const origin = 'chrome-extension://abcdef';
  const res = await post(base, { items: [mk()] }, { origin, authorization: 'Bearer s3cret' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);

  const pre = await fetch(`${base}/ingest`, { method: 'OPTIONS', headers: { origin } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), origin);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, GET, OPTIONS');

  const evil = await fetch(`${base}/ingest`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  close();
});

test('401 without token when token set, 200 with', async () => {
  const { base, close } = await start({ token: 's3cret' });
  assert.equal((await post(base, { items: [] })).status, 401);
  assert.equal((await post(base, { items: [] }, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(base, { items: [] }, { authorization: 'Bearer s3cret-but-longer' })).status, 401);
  assert.equal((await post(base, { items: [] }, { authorization: 's3cret' })).status, 401);
  assert.equal((await post(base, { items: [] }, { authorization: 'Bearer s3cret' })).status, 200);
  close();
});

test('413 over 1 MB', async () => {
  const { base, close } = await start();
  const res = await post(base, { items: [mk({ text: 'x'.repeat(1024 * 1024 + 10) })] });
  assert.equal(res.status, 413);
  close();
});

test('413 when streamed body exceeds cap without content-length', async () => {
  const { base, close } = await start();
  const res = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' } }, resolve);
    req.on('error', reject);
    const chunk = Buffer.alloc(256 * 1024, 'a');
    for (let i = 0; i < 6; i++) req.write(chunk); // chunked, no content-length
    req.end();
  });
  assert.equal(res.statusCode, 413);
  res.resume();
  close();
});

test('400 on invalid JSON, missing items, non-array items', async () => {
  const { base, close } = await start();
  assert.equal((await post(base, '{not json')).status, 400);
  assert.equal((await post(base, {})).status, 400);
  assert.equal((await post(base, { items: 'x' })).status, 400);
  assert.equal((await post(base, '[]')).status, 400);
  close();
});

test('404 for unknown route', async () => {
  const { base, close } = await start();
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  close();
});
