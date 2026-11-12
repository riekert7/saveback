// Platform-independent capture loop. Classic script: no imports. Loads in the page (injected by the
// popup), in the service worker (importScripts) and under Node tests (module.exports).
// Wrapped in an IIFE so injecting it twice into the same page does not redeclare anything.
(function () {
  const STEP_MS = 800;
  const JITTER_MS = 600;
  const STAGNANT_LIMIT = 5; // slow loaders on Instagram and Facebook
  const MAX_ITEMS = 2000;
  const BATCH_SIZE = 25;

  const dedupe = (items, seen) =>
    items.filter((i) => {
      const key = `${i.platform}:${i.native_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const chunk = (arr, n) => {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  const shouldStop = ({ stagnantSteps, total }) => stagnantSteps >= STAGNANT_LIMIT || total >= MAX_ITEMS;

  /**
   * One POST attempt; on a network error (post throws) split in half and try each half once.
   * post(items) -> { ok, status, rejected? } or throws. Items that still fail come back in `unsent`.
   * An HTTP error status is not a network error: no split.
   */
  async function postWithSplit(items, post) {
    const attempt = async (batch) => {
      try {
        const r = await post(batch);
        if (r.ok) return { sent: batch.length - (r.rejected ?? 0), rejected: r.rejected ?? 0, unsent: [], status: r.status };
        return { sent: 0, rejected: 0, unsent: batch, status: r.status };
      } catch {
        return { sent: 0, rejected: 0, unsent: batch, network: true };
      }
    };
    const first = await attempt(items);
    let parts = [first];
    if (first.network && items.length > 1) {
      const mid = items.length >> 1;
      parts = [await attempt(items.slice(0, mid)), await attempt(items.slice(mid))];
    }
    const unsent = parts.flatMap((p) => p.unsent);
    const bad = parts.find((p) => p.unsent.length);
    return {
      ok: unsent.length === 0,
      status: (bad ?? parts[parts.length - 1]).status,
      network: !!bad?.network,
      sent: parts.reduce((n, p) => n + p.sent, 0),
      rejected: parts.reduce((n, p) => n + p.rejected, 0),
      unsent,
    };
  }

  /** postWithSplit over batches of 25; stops at the first failed batch and reports the rest as unsent. */
  async function postBatches(items, post) {
    const batches = chunk(items, BATCH_SIZE);
    let sent = 0;
    let rejected = 0;
    for (let i = 0; i < batches.length; i++) {
      const r = await postWithSplit(batches[i], post);
      sent += r.sent;
      rejected += r.rejected;
      if (!r.ok) return { ...r, sent, rejected, unsent: [...r.unsent, ...batches.slice(i + 1).flat()] };
    }
    return { ok: true, status: 200, network: false, sent, rejected, unsent: [] };
  }

  const failure = (r) => r.error ?? (r.network ? 'network' : r.status === 401 ? 'unauthorized' : `http ${r.status}`);

  /**
   * Scroll loop. Extracts on EVERY step (feeds virtualise, so earlier posts leave the DOM), sends only
   * new items, stops on the first failed send (the caller gets the unsent items and can re-run).
   * send(items) -> { ok, status?, network?, sent?, rejected?, unsent?, error? }
   */
  async function runCapture(adapter, { doc, scroll, sleep, send, onProgress }) {
    const seen = new Set();
    const unsent = [];
    let found = 0;
    let sent = 0;
    let rejected = 0;
    let stagnantSteps = 0;
    let error;
    for (;;) {
      let fresh;
      try {
        fresh = dedupe(adapter.extract(doc), seen).slice(0, MAX_ITEMS - found);
      } catch (e) {
        error = `extract failed: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      found += fresh.length;
      stagnantSteps = fresh.length ? 0 : stagnantSteps + 1;
      if (fresh.length) {
        let r;
        try {
          r = await send(fresh);
        } catch (e) {
          r = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!r || typeof r !== 'object') r = { ok: false, error: 'no reply from Saveback' };
        const rej = r.rejected ?? 0;
        sent += r.sent ?? (r.ok ? fresh.length - rej : 0);
        rejected += rej;
        if (!r.ok) {
          unsent.push(...(r.unsent ?? fresh));
          error = failure(r);
        }
        try {
          onProgress?.({ found, sent });
        } catch {
          // progress is cosmetic
        }
        if (error) break;
      }
      if (shouldStop({ stagnantSteps, total: found })) break;
      await scroll();
      await sleep(STEP_MS + Math.floor(Math.random() * JITTER_MS));
    }
    const result = { found, sent, unsent };
    if (rejected) result.rejected = rejected;
    if (error) result.error = error;
    return result;
  }

  // Adapters (extension/adapters/<platform>.js) call register({ platform, matches(url), extract(document) }).
  const adapters = globalThis.__saveback?.adapters ?? [];
  const register = (a) => {
    const i = adapters.findIndex((x) => x.platform === a.platform);
    if (i >= 0) adapters[i] = a;
    else adapters.push(a);
  };

  /** Page side, injected by the popup: pick the adapter for this URL and run. Browser only. */
  async function capturePage() {
    const adapter = adapters.find((a) => a.matches(location.href));
    if (!adapter) return { matched: false };
    const r = await runCapture(adapter, {
      doc: document,
      scroll: () => window.scrollBy(0, window.innerHeight * 0.9),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      send: (items) => chrome.runtime.sendMessage({ type: 'send', items }),
      onProgress: (p) => chrome.runtime.sendMessage({ type: 'progress', ...p }).catch(() => {}),
    });
    return { matched: true, platform: adapter.platform, ...r, unsent: r.unsent.length };
  }

  const api = { dedupe, chunk, shouldStop, postWithSplit, postBatches, runCapture, register, adapters, capturePage };
  globalThis.__saveback = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
