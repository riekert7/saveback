import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeResult } = require('../extension/popup.js'); // must load without chrome.*

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
  assert.match(describeResult({ platform: 'x' }, false), /x\.com\/i\/bookmarks/);
  assert.match(describeResult({ platform: 'linkedin' }, false), /linkedin\.com\/my-items\/saved-posts/);
});

test('unsupported site lists the supported platforms', () => {
  assert.match(describeResult({}, false), /X.*YouTube.*LinkedIn.*Instagram.*Facebook.*Threads/);
});
