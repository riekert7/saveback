// Popup. Classic script. describeResult is pure and exported for Node tests; everything that
// touches chrome.* or the DOM only runs in the browser (module is undefined there).
const DEFAULT_ENDPOINT = 'http://127.0.0.1:7777';
// Files injected on Capture. Each adapter task adds its file here, e.g. 'adapters/x.js'.
const ADAPTER_FILES = ['adapters/x.js', 'adapters/linkedin.js', 'adapters/threads.js', 'adapters/instagram.js', 'adapters/facebook.js'];
// Hostname suffix -> platform and the page the user must open. Used for the wrong-page message.
const SAVED_PAGES = {
  x: { host: 'x.com', page: 'X saved posts, the Bookmarks tab (x.com/i/history)' },
  youtube: { host: 'youtube.com', page: 'a YouTube playlist such as Watch later (youtube.com/playlist?list=WL)' },
  linkedin: { host: 'linkedin.com', page: 'LinkedIn saved posts (linkedin.com/my-items/saved-posts)' },
  instagram: { host: 'instagram.com', page: 'your Instagram Saved > All posts (instagram.com/<you>/saved/all-posts/)' },
  facebook: { host: 'facebook.com', page: 'Facebook saved (facebook.com/saved)' },
  threads: { host: 'threads.net', page: 'Threads saved (threads.com/saved)' },
};

function platformForUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host.endsWith('threads.com')) return 'threads';
  return Object.keys(SAVED_PAGES).find((p) => host === SAVED_PAGES[p].host || host.endsWith(`.${SAVED_PAGES[p].host}`));
}

/** @param result {found, sent, rejected?, unsent?, error?, endpoint?, platform?} @param matched did an adapter accept the page */
function describeResult(result, matched) {
  if (!matched) {
    const where = SAVED_PAGES[result.platform]?.page;
    return where
      ? `This is not a saved page. Open ${where}, then click Capture.`
      : 'Open a saved-posts page on X, YouTube, LinkedIn, Instagram, Facebook or Threads, then click Capture.';
  }
  if (result.failed) return `Capture failed: ${result.failed}`;
  const { found, sent, error } = result;
  if (error) {
    const left = Array.isArray(result.unsent) ? result.unsent.length : result.unsent ?? 0;
    const tail = found ? ` ${found} found, ${sent} saved, ${left} not sent. Click Capture again to retry.` : '';
    if (error === 'network') {
      return `Cannot reach Saveback at ${result.endpoint}. Start it with \`node server/cli.js\` (or \`npx saveback\` once published).${tail}`;
    }
    if (error === 'unauthorized') return `Check your token.${tail}`;
    if (error.startsWith('extract failed: ')) {
      return `Capture failed: selectors may be outdated (${error.slice('extract failed: '.length)}).${tail}`;
    }
    if (/^http \d+$/.test(error)) return `Capture failed: Saveback answered ${error}.${tail}`;
    return `Capture failed: ${error}.${tail}`;
  }
  if (found === 0) return '0 found, selectors may be outdated';
  const rejected = result.rejected ? ` (${result.rejected} rejected by the server)` : '';
  return `${found} found, ${sent} saved${rejected}`;
}

async function onCapture(els) {
  const show = (s) => { els.result.textContent = s; };
  els.capture.disabled = true;
  try {
    let endpoint;
    let origin;
    try {
      const u = new URL(els.endpoint.value.trim() || DEFAULT_ENDPOINT);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      origin = u.origin;
      endpoint = u.href.replace(/\/+$/, ''); // keep a path prefix, drop the trailing slash
    } catch {
      return show('Endpoint must be an http(s) URL, for example http://127.0.0.1:7777.');
    }
    // Must run first: permissions.request needs the click's user gesture. Already-granted origins resolve true.
    if (origin !== DEFAULT_ENDPOINT) {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      } catch {
        // http:// endpoints other than the default are not declarable as optional permissions
      }
      if (!granted) return show(`Permission to reach ${origin} was not granted. Use https:// or ${DEFAULT_ENDPOINT}.`);
    }
    await chrome.storage.local.set({ endpoint, token: els.token.value.trim() });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    show('Capturing, keep this page open...');
    let res;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['core.js', ...ADAPTER_FILES] });
      [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__saveback.capturePage() });
    } catch (e) {
      // Restricted or non-host page (no permission to script it): wrong page. Anything else is a real failure.
      const platform = platformForUrl(tab?.url);
      return show(platform ? describeResult({ failed: e instanceof Error ? e.message : String(e) }, true) : describeResult({}, false));
    }
    const result = res?.result;
    if (!result) return show(describeResult({ failed: 'the page returned no result' }, true));
    show(describeResult({ ...result, endpoint, platform: result.platform ?? platformForUrl(tab.url) }, result.matched));
  } catch (e) {
    show(`Capture failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    els.capture.disabled = false;
  }
}

async function init() {
  const els = Object.fromEntries(['endpoint', 'token', 'capture', 'result'].map((id) => [id, document.getElementById(id)]));
  const saved = await chrome.storage.local.get(['endpoint', 'token']);
  els.endpoint.value = saved.endpoint ?? DEFAULT_ENDPOINT;
  els.token.value = saved.token ?? '';
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'progress') els.result.textContent = `Capturing: ${msg.found} found, ${msg.sent} saved...`;
  });
  els.capture.addEventListener('click', () => onCapture(els));
}

if (typeof module !== 'undefined') module.exports = { describeResult, platformForUrl };
else init();
