import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dedupe, chunk, shouldStop, postWithSplit, postBatches, runCapture } = require('../extension/core.js');

const item = (id, platform = 'x') => ({ platform, native_id: String(id), url: `https://x.com/a/status/${id}` });
const ids = (items) => items.map((i) => i.native_id);

test('dedupe drops repeats across steps', () => {
  const seen = new Set();
  assert.deepEqual(ids(dedupe([item(1), item(2), item(1)], seen)), ['1', '2']);
  assert.deepEqual(ids(dedupe([item(2), item(3)], seen)), ['3']);
  assert.equal(dedupe([item(1, 'youtube')], seen).length, 1, 'key includes platform');
});

test('chunk splits into n-sized groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 25), []);
});

test('shouldStop at 5 stagnant steps', () => {
  assert.equal(shouldStop({ stagnantSteps: 4, total: 10 }), false);
  assert.equal(shouldStop({ stagnantSteps: 5, total: 10 }), true);
});

test('shouldStop at 2000 total', () => {
  assert.equal(shouldStop({ stagnantSteps: 0, total: 1999 }), false);
  assert.equal(shouldStop({ stagnantSteps: 0, total: 2000 }), true);
});

// Fake feed that virtualises: only the current window of 2 items is in the DOM.
function virtualFeed(all) {
  let pos = 0;
  return {
    adapter: { platform: 'x', matches: () => true, extract: () => all.slice(pos, pos + 2) },
    scroll: () => { pos += 2; },
  };
}
const okSend = (sentLog) => async (items) => { sentLog.push(...items); return { ok: true, status: 200 }; };

test('runCapture extracts every step, not once', async () => {
  const all = [1, 2, 3, 4, 5, 6].map(item);
  const { adapter, scroll } = virtualFeed(all);
  const log = [];
  const r = await runCapture(adapter, { doc: {}, scroll, sleep: async () => {}, send: okSend(log) });
  assert.deepEqual(ids(log), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual({ found: r.found, sent: r.sent, error: r.error }, { found: 6, sent: 6, error: undefined });
});

test('runCapture sends a post seen twice only once', async () => {
  const log = [];
  const adapter = { extract: () => [item(1), item(1), item(2)] };
  const r = await runCapture(adapter, { doc: {}, scroll() {}, sleep: async () => {}, send: okSend(log) });
  assert.deepEqual(ids(log), ['1', '2']);
  assert.equal(r.found, 2);
});

test('runCapture reports error when send fails and keeps unsent items for retry', async () => {
  const all = [1, 2, 3, 4].map(item);
  const { adapter, scroll } = virtualFeed(all);
  let calls = 0;
  const send = async (items) => {
    calls++;
    return calls === 1 ? { ok: true, status: 200 } : { ok: false, network: true, unsent: items };
  };
  const r = await runCapture(adapter, { doc: {}, scroll, sleep: async () => {}, send });
  assert.equal(r.error, 'network');
  assert.equal(r.sent, 2);
  assert.deepEqual(ids(r.unsent), ['3', '4']);
  assert.equal(calls, 2, 'stops scrolling after a failed send');
});

test('runCapture maps 401 to unauthorized', async () => {
  const r = await runCapture({ extract: () => [item(1)] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(r.error, 'unauthorized');
  assert.deepEqual(ids(r.unsent), ['1']);
});

test('runCapture with zero items returns found 0', async () => {
  let sends = 0;
  const r = await runCapture({ extract: () => [] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => { sends++; return { ok: true }; },
  });
  assert.equal(r.found, 0);
  assert.equal(r.sent, 0);
  assert.equal(r.error, undefined);
  assert.equal(sends, 0);
});

test('runCapture stops after 5 stagnant steps, sleeping 800-1400 ms between steps', async () => {
  const sleeps = [];
  let scrolls = 0;
  const r = await runCapture({ extract: () => [item(1)] }, {
    doc: {}, scroll: () => { scrolls++; }, sleep: async (ms) => { sleeps.push(ms); }, send: async () => ({ ok: true }),
  });
  assert.equal(r.found, 1);
  assert.equal(scrolls, 5); // step 1 finds the item; steps 2-6 find nothing; stop
  assert.equal(sleeps.length, 5);
  assert.ok(sleeps.every((ms) => ms >= 800 && ms < 1400), sleeps.join());
});

test('runCapture honours the 2000 item cap', async () => {
  let n = 0;
  const adapter = { extract: () => Array.from({ length: 300 }, () => item(n++)) };
  const log = [];
  const r = await runCapture(adapter, { doc: {}, scroll() {}, sleep: async () => {}, send: okSend(log) });
  assert.equal(r.found, 2000);
  assert.equal(log.length, 2000);
});

test('runCapture reports progress', async () => {
  const seen = [];
  await runCapture({ extract: () => [item(1)] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => ({ ok: true }), onProgress: (p) => seen.push(p),
  });
  assert.deepEqual(seen[0], { found: 1, sent: 1 });
});

test('runCapture counts server-rejected items out of sent', async () => {
  const r = await runCapture({ extract: () => [item(1), item(2)] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => ({ ok: true, rejected: 1 }),
  });
  assert.deepEqual({ found: r.found, sent: r.sent, rejected: r.rejected }, { found: 2, sent: 1, rejected: 1 });
});

test('postWithSplit posts once on success', async () => {
  const calls = [];
  const r = await postWithSplit([item(1), item(2)], async (b) => { calls.push(b.length); return { ok: true, status: 200 }; });
  assert.deepEqual(calls, [2]);
  assert.deepEqual({ ok: r.ok, sent: r.sent, unsent: r.unsent }, { ok: true, sent: 2, unsent: [] });
});

test('postWithSplit halves a batch on network error and retries each half once', async () => {
  const calls = [];
  const post = async (b) => {
    calls.push(ids(b));
    if (b.length === 4) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200 };
  };
  const r = await postWithSplit([1, 2, 3, 4].map(item), post);
  assert.deepEqual(calls, [['1', '2', '3', '4'], ['1', '2'], ['3', '4']]);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 4);
});

test('postWithSplit reports a half that still fails as unsent, without splitting further', async () => {
  const calls = [];
  const post = async (b) => {
    calls.push(ids(b));
    if (b.length > 2 || b[0].native_id === '3') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200 };
  };
  const r = await postWithSplit([1, 2, 3, 4].map(item), post);
  assert.equal(calls.length, 3);
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
  assert.equal(r.sent, 2);
  assert.deepEqual(ids(r.unsent), ['3', '4']);
});

test('postWithSplit does not split on an HTTP error status', async () => {
  let calls = 0;
  const r = await postWithSplit([item(1), item(2)], async () => { calls++; return { ok: false, status: 401 }; });
  assert.equal(calls, 1);
  assert.deepEqual({ ok: r.ok, status: r.status, network: !!r.network }, { ok: false, status: 401, network: false });
  assert.equal(r.unsent.length, 2);
});

test('postBatches sends at most 25 per request and stops at the first failed batch', async () => {
  const items = Array.from({ length: 60 }, (_, i) => item(i));
  const sizes = [];
  const post = async (b) => { sizes.push(b.length); return sizes.length === 2 ? { ok: false, status: 500 } : { ok: true, status: 200 }; };
  const r = await postBatches(items, post);
  assert.deepEqual(sizes, [25, 25]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(r.sent, 25);
  assert.equal(r.unsent.length, 35);
});

test('postBatches sums sent and rejected across batches', async () => {
  const items = Array.from({ length: 30 }, (_, i) => item(i));
  const r = await postBatches(items, async () => ({ ok: true, status: 200, rejected: 1 }));
  assert.deepEqual({ ok: r.ok, sent: r.sent, rejected: r.rejected }, { ok: true, sent: 28, rejected: 2 });
});

test('runCapture reports extract failure and keeps what it already sent', async () => {
  let step = 0;
  const adapter = {
    extract: () => {
      if (step++ === 1) throw new TypeError("Cannot read properties of null (reading 'querySelector')");
      return [item(1), item(2)];
    },
  };
  const log = [];
  const r = await runCapture(adapter, { doc: {}, scroll() {}, sleep: async () => {}, send: okSend(log) });
  assert.match(r.error, /^extract failed: Cannot read properties of null/);
  assert.deepEqual({ found: r.found, sent: r.sent }, { found: 2, sent: 2 });
  assert.deepEqual(ids(log), ['1', '2']);
  assert.equal(step, 2, 'stops the loop');
});

test('runCapture treats send throwing as unsent plus error', async () => {
  const r = await runCapture({ extract: () => [item(1), item(2)] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => { throw new Error('Extension context invalidated'); },
  });
  assert.equal(r.error, 'Extension context invalidated');
  assert.deepEqual({ found: r.found, sent: r.sent }, { found: 2, sent: 0 });
  assert.deepEqual(ids(r.unsent), ['1', '2']);
});

test('runCapture treats an undefined send reply as an error without throwing', async () => {
  for (const reply of [undefined, null, 'oops']) {
    const r = await runCapture({ extract: () => [item(1)] }, {
      doc: {}, scroll() {}, sleep: async () => {}, send: async () => reply,
    });
    assert.equal(r.error, 'no reply from Saveback');
    assert.deepEqual(ids(r.unsent), ['1']);
    assert.equal(r.sent, 0);
  }
});

test('runCapture survives a throwing onProgress', async () => {
  const r = await runCapture({ extract: () => [item(1)] }, {
    doc: {}, scroll() {}, sleep: async () => {}, send: async () => ({ ok: true }), onProgress: () => { throw new Error('gone'); },
  });
  assert.equal(r.sent, 1);
  assert.equal(r.error, undefined);
});
