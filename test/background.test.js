import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ext = (f) => readFileSync(new URL(`../extension/${f}`, import.meta.url), 'utf8');

/** Load the service worker in a sandbox with stubbed chrome/fetch; returns a send(items) helper. */
function load(fetchImpl) {
  let listener;
  const ctx = vm.createContext({
    chrome: { storage: { local: { get: async () => ({}) } }, runtime: { onMessage: { addListener: (f) => { listener = f; } } } },
    fetch: fetchImpl, AbortSignal, JSON, URL, console,
  });
  ctx.importScripts = (f) => vm.runInContext(ext(f), ctx);
  vm.runInContext(ext('background.js'), ctx);
  return (items) => new Promise((resolve) => listener({ type: 'send', items }, {}, resolve));
}

const item = { platform: 'x', native_id: '1', url: 'https://x.com/a/status/1', author: 'a', text: 't', media: [], saved_at: null, transcript: null };

test('ingest fetch carries a timeout signal', async () => {
  let signal;
  const send = load(async (_url, init) => { signal = init.signal; return { ok: true, status: 200, json: async () => ({}) }; });
  await send([item]);
  assert.ok(signal instanceof AbortSignal);
});

test('a timed-out fetch fails like a network error, so the popup says Cannot reach Saveback', async () => {
  const send = load(async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const r = await send([item]);
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
  assert.equal(r.unsent.length, 1);
});
