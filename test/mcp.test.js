import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, upsertItem, getSaved } from '../server/db.js';
import { buildMcpServer } from '../server/mcp.js';

const mk = (over = {}) => ({
  platform: 'x', native_id: '1', url: 'https://x.com/jane/status/1', author: 'jane',
  text: 'sourdough starter tips', media: [], saved_at: '2026-11-01T10:00:00.000Z', transcript: null, ...over,
});

async function start(opts = {}) {
  const db = openDb(':memory:');
  const server = buildMcpServer({ db, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, 'text');
    return { isError: r.isError === true, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
  };
  return { db, client, call };
}

test('lists all eight tools', async () => {
  const { client } = await start();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add_note', 'get_saved', 'list_recent', 'list_unseen', 'mark_seen', 'save_url', 'search_saved', 'tag']);
  const unseen = (await client.listTools()).tools.find((t) => t.name === 'list_unseen');
  assert.match(unseen.description, /summarise themes, then mark_seen/);
});

test('search_saved returns an ingested item', async () => {
  const { db, call } = await start();
  upsertItem(db, mk());
  const r = await call('search_saved', { query: 'sourdough' });
  assert.equal(r.isError, false);
  assert.equal(r.json()[0].id, 'x:1');
});

test('search_saved survives FTS syntax characters', async () => {
  const { db, call } = await start();
  upsertItem(db, mk());
  for (const q of ['"', 'NEAR(', 'a AND', '*', "it's (broken", 'x:1 -']) {
    const r = await call('search_saved', { query: q });
    assert.equal(r.isError, false, q);
    assert.ok(Array.isArray(r.json()));
  }
});

test('list tools truncate text and transcript, get_saved returns full', async () => {
  const { db, call } = await start();
  const big = 'alpha '.repeat(400);
  upsertItem(db, mk({ text: big, transcript: big }));
  upsertItem(db, mk({ native_id: '2', url: 'https://x.com/jane/status/2', text: 'short' }));
  for (const [tool, args] of [['search_saved', { query: 'alpha' }], ['list_recent', {}], ['list_unseen', {}]]) {
    const rows = (await call(tool, args)).json();
    const row = rows.find((r) => r.id === 'x:1');
    assert.equal(row.text.length, 500, tool);
    assert.equal(row.transcript.length, 500, tool);
    assert.equal(row.truncated, true, tool);
  }
  const short = (await call('list_recent')).json().find((r) => r.id === 'x:2');
  assert.equal(short.text, 'short');
  assert.ok(!short.truncated);
  const full = (await call('get_saved', { id: 'x:1' })).json();
  assert.equal(full.text.length, big.length);
  assert.equal(full.transcript.length, big.length);
});

test('list_unseen then mark_seen removes it', async () => {
  const { db, call } = await start();
  upsertItem(db, mk());
  assert.equal((await call('list_unseen')).json().length, 1);
  assert.equal((await call('mark_seen', { id: 'x:1' })).isError, false);
  assert.equal((await call('list_unseen')).json().length, 0);
});

test('add_note and tag update the item', async () => {
  const { db, call } = await start();
  upsertItem(db, mk());
  assert.equal((await call('add_note', { id: 'x:1', note: 'for the bread post' })).isError, false);
  assert.equal((await call('tag', { id: 'x:1', tags: ['baking', 'later'] })).isError, false);
  const it = getSaved(db, 'x:1');
  assert.equal(it.notes, 'for the bread post');
  assert.deepEqual(it.tags, ['baking', 'later']);
});

test('unknown id is isError for get_saved, mark_seen, add_note, tag', async () => {
  const { call } = await start();
  for (const [tool, args] of [['get_saved', {}], ['mark_seen', {}], ['add_note', { note: 'n' }], ['tag', { tags: ['a'] }]]) {
    const r = await call(tool, { id: 'x:nope', ...args });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /x:nope/);
  }
});

test('save_url stores the fetched item (fake fetchSaveable)', async () => {
  const item = mk({ platform: 'youtube', native_id: 'abc123', url: 'https://www.youtube.com/watch?v=abc123', text: 'a title', transcript: 'words here' });
  const { db, call } = await start({ fetchSaveable: async (url) => { assert.equal(url, 'https://youtu.be/abc123'); return item; } });
  const r = await call('save_url', { url: 'https://youtu.be/abc123' });
  assert.equal(r.isError, false);
  const out = r.json();
  assert.equal(out.id, 'youtube:abc123');
  assert.equal(out.created, true);
  assert.equal(out.platform, 'youtube');
  assert.equal(out.text_length, 7);
  assert.equal(out.has_transcript, true);
  assert.equal(getSaved(db, 'youtube:abc123').transcript, 'words here');
  assert.equal((await call('save_url', { url: 'https://youtu.be/abc123' })).json().created, false);
});

test('save_url error surfaces as isError', async () => {
  const { call } = await start({ fetchSaveable: async () => { throw new Error('blocked address: localhost'); } });
  const r = await call('save_url', { url: 'http://localhost/' });
  assert.equal(r.isError, true);
  assert.match(r.text, /blocked address/);
});

test('save_url refuses private addresses with the real fetcher', async () => {
  const { call } = await start();
  const r = await call('save_url', { url: 'http://127.0.0.1/' });
  assert.equal(r.isError, true);
  assert.match(r.text, /blocked address/);
});
