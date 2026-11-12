// Service worker: does the network POST so content scripts never hit page CORS.
importScripts('core.js');
const { postBatches } = globalThis.__saveback;

const DEFAULT_ENDPOINT = 'http://127.0.0.1:7777';

async function post(items) {
  const { endpoint, token } = await chrome.storage.local.get(['endpoint', 'token']);
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '')}/ingest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(30_000), // an abort throws, which postWithSplit reports as a network error
  });
  let rejected = 0;
  if (res.ok) {
    try {
      rejected = (await res.json()).errors?.length ?? 0;
    } catch {
      // a 2xx without a JSON body still counts as stored
    }
  }
  return { ok: res.ok, status: res.status, rejected };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'send') return false;
  postBatches(msg.items, post).then(reply, (e) => reply({ ok: false, error: String(e?.message ?? e) }));
  return true; // reply asynchronously
});
