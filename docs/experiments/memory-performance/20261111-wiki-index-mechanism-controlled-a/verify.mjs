// Independent raw-result recomputation; does not import benchmark statistics.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = new URL('./comparison.json', import.meta.url);
const bytes = readFileSync(file), report = JSON.parse(bytes);
const round = value => Math.round(value * 1000) / 1000;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { n: values.length, mean: round(total / values.length), p50: round(percentile(.5)),
    p95: round(percentile(.95)), p99: round(percentile(.99)), max: round(sorted.at(-1)),
    summedDurationMs: round(total), serialOperationsPerSecond: round(values.length * 1000 / total) };
};
assert.equal(report.accepted, true);
assert.equal(report.samples.length, 96);
assert.deepEqual(report.sourceHashesBefore, report.sourceHashesAfter);
for (const cleanup of report.cleanup) {
  assert.equal(cleanup.removed, true);
  assert.equal(existsSync(cleanup.root), false);
}
let pairedSamples = 0, verifiedSummaries = 0;
for (const scale of report.scales) {
  assert.equal(scale.final.equivalent, true);
  assert.equal(scale.final.rows.fts, scale.scale);
  assert.equal(scale.final.rows.meta, scale.scale);
  for (let round = 1; round <= 2; round++) for (let sample = 0; sample < 12; sample++) {
    const pair = report.samples.filter(row => row.scale === scale.scale && row.round === round && row.sample === sample);
    assert.equal(pair.length, 2);
    assert.equal(pair[0].payloadHash, pair[1].payloadHash);
    assert.deepEqual(pair.map(row => row.position), [0, 1]);
    assert.deepEqual(pair.map(row => row.mode).sort(), ['full', 'incremental']);
    assert.equal(pair[0].changedBytes, pair[1].changedBytes);
    pairedSamples++;
  }
  for (const summary of scale.summaries) {
    const rows = report.samples.filter(row => row.scale === scale.scale && row.mode === summary.mode
      && (summary.kind === 'all' || row.kind === summary.kind));
    assert.deepEqual(stats(rows.map(row => row.indexDurationMs)), summary.indexMs);
    assert.deepEqual(stats(rows.map(row => row.endToEndDurationMs)), summary.endToEndMs);
    verifiedSummaries++;
  }
}
const verification = { accepted: true, rawSamples: report.samples.length, pairedSamples,
  verifiedSummaries, sourceUnchanged: true, allTemporaryRootsRemoved: true,
  inputSha256: createHash('sha256').update(bytes).digest('hex') };
writeFileSync(new URL('./verification.json', import.meta.url), JSON.stringify(verification, null, 2));
console.log(JSON.stringify(verification));
