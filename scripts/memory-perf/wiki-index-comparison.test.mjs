import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comparisonStats, assertOwnedTempRoot, removeOwnedTempRoot } from './wiki-index-comparison.mjs';

test('uses nearest-rank percentiles and serial service-time throughput', () => {
  assert.deepEqual(comparisonStats([1, 2, 3, 4]), {
    n: 4, mean: 2.5, p50: 2, p95: 4, p99: 4, max: 4,
    summedDurationMs: 10, serialOperationsPerSecond: 400,
  });
  assert.equal(comparisonStats([]).serialOperationsPerSecond, null);
  assert.throws(() => comparisonStats([NaN]));
  assert.throws(() => comparisonStats([-1]));
});

test('only removes an existing directly owned absolute temporary directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'tsp-wiki-index-micro-'));
  writeFileSync(join(root, 'marker'), 'owned');
  assert.equal(assertOwnedTempRoot(root), root);
  for (const invalid of [tmpdir(), process.cwd(), '.', join(root, 'marker'), join(root, '..')]) {
    assert.throws(() => assertOwnedTempRoot(invalid));
  }
  removeOwnedTempRoot(root);
  assert.equal(existsSync(root), false);
  assert.throws(() => removeOwnedTempRoot(root));
});
