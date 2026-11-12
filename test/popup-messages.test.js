import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeResult, platformForUrl } = require('../extension/popup.js'); // must load without chrome.*

const endpoint = 'http://127.0.0.1:7777';

test('success', () => {
  assert.equal(describeResult({ found: 12, sent: 12 }, true), '12 found, 12 saved');
});

test('success with server-rejected items says so', () => {
  assert.match(describeResult({ found: 12, sent: 10, rejected: 2 }, true), /^12 found, 10 saved.*2 rejected/);
});

test('zero found', () => {
  assert.equal(describeResult({ found: 0, sent: 0 }, true), '0 found, selectors may be outdated');
});

test('network error names the endpoint and how to start the server', () => {
  const s = describeResult({ found: 5, sent: 0, error: 'network', endpoint, unsent: [{}, {}] }, true);
  assert.ok(s.startsWith(`Cannot reach Saveback at ${endpoint}. Start it with \`node server/cli.js\` (or \`npx saveback\` once published).`), s);
});

test('401', () => {
  assert.match(describeResult({ found: 5, sent: 0, error: 'unauthorized', endpoint }, true), /^Check your token\./);
});

test('other server error is shown, not swallowed', () => {
  assert.match(describeResult({ found: 5, sent: 0, error: 'http 500', endpoint }, true), /http 500/);
});

test('wrong page says which page to open', () => {
  assert.match(describeResult({ platform: 'x' }, false), /x\.com\/i\/history/);
  assert.match(describeResult({ platform: 'linkedin' }, false), /linkedin\.com\/my-items\/saved-posts/);
});

test('wrong-page message names the right page for each platform, from a real page URL', () => {
  const cases = {
    'https://x.com/home': ['x', 'Open X saved posts, the Bookmarks tab (x.com/i/history), then click Capture.'],
    'https://www.youtube.com/': ['youtube', 'Open a playlist page such as Watch Later (youtube.com/playlist?list=WL), then click Capture.'],
    'https://www.linkedin.com/feed/': ['linkedin', 'Open LinkedIn saved posts (linkedin.com/my-items/saved-posts), then click Capture.'],
    'https://www.instagram.com/': ['instagram', 'Open your Instagram Saved > All posts (instagram.com/<you>/saved/all-posts/), then click Capture.'],
    'https://www.facebook.com/': ['facebook', 'Open Facebook saved (facebook.com/saved), then click Capture.'],
    'https://www.threads.com/': ['threads', 'Open Threads saved (threads.com/saved), then click Capture.'],
  };
  for (const [url, [platform, page]] of Object.entries(cases)) {
    assert.equal(platformForUrl(url), platform, url);
    assert.equal(describeResult({ platform: platformForUrl(url) }, false), `This is not a saved page. ${page}`, url);
  }
});

test('threads.com and threads.net users are never sent to threads.net', () => {
  for (const url of ['https://www.threads.com/', 'https://threads.com/@someone', 'https://www.threads.net/']) {
    assert.equal(platformForUrl(url), 'threads', url);
    const msg = describeResult({ platform: platformForUrl(url) }, false);
    assert.doesNotMatch(msg, /threads\.net/, url);
    assert.match(msg, /threads\.com\/saved/, url);
  }
});

test('unsupported site lists the supported platforms', () => {
  assert.match(describeResult({}, false), /X.*YouTube.*LinkedIn.*Instagram.*Facebook.*Threads/);
});

test('extract failure is a capture failure, not the wrong-page message', () => {
  const s = describeResult({ found: 0, sent: 0, error: 'extract failed: boom' }, true);
  assert.match(s, /^Capture failed: selectors may be outdated \(boom\)/);
  assert.doesNotMatch(s, /not a saved page/);
});

test('generic failure message is shown as Capture failed, not wrong page', () => {
  const s = describeResult({ failed: 'Extension context invalidated' }, true);
  assert.equal(s, 'Capture failed: Extension context invalidated');
  assert.equal(describeResult({ found: 3, sent: 0, error: 'no reply from Saveback' }, true).startsWith('Capture failed: no reply from Saveback.'), true);
});

test('onCapture saves endpoint and token first, un-awaited, so the click still gates permissions.request', async () => {
  const { onCapture } = require('../extension/popup.js');
  const calls = [];
  globalThis.chrome = {
    storage: { local: { set: (v) => { calls.push(['set', v]); return new Promise(() => {}); } } }, // never settles
    permissions: { request: async (p) => { calls.push(['request', p]); return false; } },
  };
  const els = { endpoint: { value: 'https://saveback.example.com/' }, token: { value: ' tok ' }, capture: {}, result: {} };
  try {
    await onCapture(els);
  } finally {
    delete globalThis.chrome;
  }
  assert.deepEqual(calls.map((c) => c[0]), ['set', 'request']);
  assert.deepEqual(calls[0][1], { endpoint: 'https://saveback.example.com', token: 'tok' });
  assert.match(els.result.textContent, /not granted/);
});
