import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CLI = new URL('../server/cli.js', import.meta.url).pathname;
const children = new Set();
const dirs = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), 'saveback-cli-'));
  dirs.push(d);
  return join(d, 'saveback.db');
};

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/** Spawn the CLI; collects stdout and stderr, and an exit promise. */
function run(env) {
  const child = spawn(process.execPath, [CLI], {
    env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  const p = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { p.out += d; });
  child.stderr.on('data', (d) => { p.err += d; });
  p.exit = new Promise((r) => child.on('exit', (code) => r(code)));
  return p;
}

async function waitHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${base} never became healthy`);
}

const waitFor = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const rpcLines = (p) => p.out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const send = (p, msg) => p.child.stdin.write(JSON.stringify(msg) + '\n');
const initialize = (p) => send(p, {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

const item = {
  platform: 'x', native_id: '42', url: 'https://x.com/jane/status/42', author: 'jane',
  text: 'zebracrossing is a great word', media: [], saved_at: '2026-11-01T10:00:00.000Z', transcript: null,
};
const ingest = (base, headers = {}) => fetch(`${base}/ingest`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ items: [item] }),
});

test('remote mode without token exits 1', async () => {
  const p = run({ SAVEBACK_MODE: 'remote', SAVEBACK_DB: tmpDb(), PORT: String(await freePort()) });
  assert.equal(await p.exit, 1);
  assert.match(p.err, /SAVEBACK_TOKEN/);
});

test('remote mode with empty token exits 1', async () => {
  const p = run({ SAVEBACK_MODE: 'remote', SAVEBACK_TOKEN: '', SAVEBACK_DB: tmpDb(), PORT: String(await freePort()) });
  assert.equal(await p.exit, 1);
  assert.match(p.err, /SAVEBACK_TOKEN/);
});

test('remote mode: health open, ingest and /mcp need the token, ingest then search over /mcp finds the item', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  run({ SAVEBACK_MODE: 'remote', SAVEBACK_TOKEN: 's3cret', SAVEBACK_DB: tmpDb(), PORT: String(port) });
  await waitHealthy(base);

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await ingest(base)).status, 401);
  assert.equal((await ingest(base, { authorization: 'Bearer wrong' })).status, 401);
  const mcpPost = (headers) => fetch(`${base}/mcp`, {
    method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  });
  assert.equal((await mcpPost({})).status, 401);
  assert.equal((await mcpPost({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await mcpPost({ authorization: 'Bearer s3cret', origin: 'https://evil.example' })).status, 403);

  const auth = { authorization: 'Bearer s3cret' };
  assert.equal((await ingest(base, auth)).status, 200);

  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  const res = await client.callTool({ name: 'search_saved', arguments: { query: 'zebracrossing' } });
  assert.ok(!res.isError);
  assert.match(res.content[0].text, /x:42/);
  await client.close();
});

test('local mode: POST /ingest works on 127.0.0.1 and stdout carries only MCP frames', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const p = run({ SAVEBACK_DB: tmpDb(), SAVEBACK_PORT: String(port) });
  await waitHealthy(base);

  assert.equal((await ingest(base)).status, 200); // no token in local mode

  initialize(p);
  await waitFor(() => rpcLines(p).find((m) => m.id === 1), 'initialize response');
  send(p, { jsonrpc: '2.0', method: 'notifications/initialized' });
  send(p, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_saved', arguments: { query: 'zebracrossing' } } });
  const r2 = await waitFor(() => rpcLines(p).find((m) => m.id === 2), 'search response');
  assert.match(r2.result.content[0].text, /x:42/);

  p.child.stdin.end(); // closing stdin ends the session
  await p.exit;
  const lines = p.out.split('\n').filter(Boolean);
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', `non-frame on stdout: ${l}`);
});

test('second local process on a taken port stays up and still answers MCP over stdio', async () => {
  const port = await freePort();
  const db = tmpDb();
  const a = run({ SAVEBACK_DB: db, SAVEBACK_PORT: String(port) });
  await waitHealthy(`http://127.0.0.1:${port}`);

  const b = run({ SAVEBACK_DB: db, SAVEBACK_PORT: String(port) });
  initialize(b);
  await waitFor(() => rpcLines(b).find((m) => m.id === 1), 'initialize response from second process');
  assert.match(b.err, new RegExp(`${port}`));
  assert.equal(b.child.exitCode, null);
  assert.equal(a.child.exitCode, null);
});
