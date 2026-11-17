import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactPublishedNodeEvidence, mergeSourceEvidenceRanges, semanticEvidenceUnion } from '../dist/code-analysis-semantic-architecture.js';

function coveredRows(evidence) {
  const rows = new Set();
  for (const item of evidence) for (let line = item.line_start; line <= item.line_end; line++) rows.add(`${item.path}:${line}`);
  return [...rows].sort();
}
test('publication compaction preserves the exact line set across duplicates, containment, overlap and adjacency', () => {
  const evidence = [{ path: 'a.ts', line_start: 4, line_end: 8 }, { path: 'a.ts', line_start: 1, line_end: 3 }, { path: 'a.ts', line_start: 2, line_end: 4 }, { path: 'a.ts', line_start: 4, line_end: 8 }, { path: 'a.ts', line_start: 10, line_end: 11 }, { path: 'b.ts', line_start: 1, line_end: 2 }, { path: 'b.ts', line_start: 3, line_end: 4 }];
  const original = JSON.stringify(evidence), compacted = compactPublishedNodeEvidence(evidence);
  assert.deepEqual(compacted, [{ path: 'a.ts', line_start: 1, line_end: 8 }, { path: 'a.ts', line_start: 10, line_end: 11 }, { path: 'b.ts', line_start: 1, line_end: 4 }]);
  assert.deepEqual(coveredRows(compacted), coveredRows(evidence)); assert.equal(JSON.stringify(evidence), original);
  assert.deepEqual(mergeSourceEvidenceRanges(evidence), compacted);
  assert.deepEqual(compactPublishedNodeEvidence(compacted), compacted);
  // The input-identity helper deliberately retains the original distinct spans.
  assert.equal(semanticEvidenceUnion(evidence).length, 6);
});
test('compaction does not expand across an uncovered blank row or a file boundary', () => {
  const source = ['first', 'second', '', 'fourth', 'fifth'];
  const evidence = [{ path: 'blank.ts', line_start: 1, line_end: 2 }, { path: 'blank.ts', line_start: 4, line_end: 5 }, { path: 'another.ts', line_start: 3, line_end: 3 }];
  assert.equal(source[2], '');
  const compacted = compactPublishedNodeEvidence(evidence);
  assert.deepEqual(coveredRows(compacted), coveredRows(evidence)); assert.equal(coveredRows(compacted).includes('blank.ts:3'), false);
  assert.equal(compacted.filter(item => item.path === 'blank.ts').length, 2);
});

test('shared line union rejects invalid ranges while preserving the publication error contract', () => {
  for (const line_start of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const ranges = [{ path: 'a.ts', line_start, line_end: 4 }];
    assert.throws(() => mergeSourceEvidenceRanges(ranges), error => error.details?.reason === 'source_evidence_range');
    assert.throws(() => compactPublishedNodeEvidence(ranges), error => error.details?.reason === 'publication_evidence_range');
  }
});
test('native endpoint containment is preserved while public range count becomes bounded without dropping support', () => {
  const evidence = Array.from({ length: 180 }, (_, index) => ({ path: 'callee.ts', line_start: index + 1, line_end: index + 3 }));
  const endpoints = [{ path: 'callee.ts', line_start: 12, line_end: 15 }, { path: 'callee.ts', line_start: 96, line_end: 98 }, { path: 'callee.ts', line_start: 179, line_end: 182 }];
  const compacted = compactPublishedNodeEvidence(evidence);
  assert.equal(compacted.length, 1); assert.deepEqual(coveredRows(compacted), coveredRows(evidence));
  for (const endpoint of endpoints) assert.ok(compacted.some(range => range.path === endpoint.path && range.line_start <= endpoint.line_start && range.line_end >= endpoint.line_end));
});
