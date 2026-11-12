import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const { ADAPTER_FILES } = createRequire(import.meta.url)('../extension/popup.js');

const dir = new URL('../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));

test('manifest is MV3 with the required keys', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const k of ['name', 'version', 'description', 'permissions', 'host_permissions', 'background', 'action']) {
    assert.ok(manifest[k], k);
  }
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
});

test('manifest host permissions cover the platforms and local server, no wildcard', () => {
  const hp = manifest.host_permissions;
  for (const d of ['x.com', 'youtube.com', 'linkedin.com', 'instagram.com', 'facebook.com', 'threads.net', 'threads.com']) {
    assert.ok(hp.some((h) => h.includes(d)), d);
  }
  assert.ok(hp.includes('http://127.0.0.1:7777/*'));
  assert.ok(!hp.some((h) => h === '<all_urls>' || h === 'https://*/*' || h === 'http://*/*'));
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});

test('manifest points at files that exist', () => {
  for (const f of [manifest.background.service_worker, manifest.action.default_popup, 'core.js', 'popup.js']) {
    assert.ok(existsSync(new URL(f, dir)), f);
  }
});

test('every popup ADAPTER_FILES entry exists under extension/', () => {
  assert.ok(ADAPTER_FILES.length > 0);
  for (const f of ADAPTER_FILES) assert.ok(existsSync(new URL(f, dir)), f);
});
