import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const vendor = path.join(repository, 'apps/web/public/vendor/ua-reader/2.9.8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('vendored native reader matches its engine, adapter source and content manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(vendor, 'manifest.json'), 'utf8'));
  assert.equal(manifest.engine_version, '2.9.8');
  assert.equal(manifest.protocol_version, 1);
  assert.equal(manifest.entry, 'reader.js');
  assert.ok(manifest.adapter_sources['apps/web/ua-reader/selection.ts'], 'selection visibility helpers must be part of the built source manifest');
  for (const [file, expected] of Object.entries(manifest.assets)) {
    assert.ok(['reader.js', 'reader.css'].includes(file));
    const bytes = readFileSync(path.join(vendor, file));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(hash(bytes), expected.sha256);
  }
  for (const [file, expected] of Object.entries(manifest.adapter_sources)) {
    assert.ok(file.startsWith('apps/web/ua-reader/') || file === 'scripts/build-ua-reader.mjs');
    assert.equal(hash(readFileSync(path.join(repository, file))), expected);
  }
});

test('isolated reader bundle has no original source/auth loaders and retains bundled license notices', () => {
  const script = readFileSync(path.join(vendor, 'reader.js'), 'utf8');
  for (const forbidden of ['/file-content.json', '/knowledge-graph.json', 'understand-anything-token', 'localStorage', 'sessionStorage', 'fetch(']) assert.equal(script.includes(forbidden), false, forbidden);
  assert.ok(script.includes('full_system'), 'the bundled bridge must recognize the complete-system reader profile');
  assert.ok(script.includes('data-tsp-domain-meta'), 'the bundled sidebar must render metadata beyond domain nodes');
  for (const marker of ['data-tsp-user-purposes', 'data-tsp-open-questions']) assert.ok(script.includes(marker), marker);
  assert.ok(script.includes('tspReaderProfile'), 'the bundled graph must scope selection visibility to the explicit reader profile');
  const notices = readFileSync(path.join(vendor, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /Understand Anything/);
  assert.match(notices, /MIT/);
  assert.match(notices, /elkjs@0\.9\.3/);
  assert.match(notices, /EPL-2\.0/);
});
