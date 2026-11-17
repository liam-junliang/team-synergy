import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSemanticSource, semanticDigest, validateSegmentFacts, createSemanticEvidenceCatalog, resolveSemanticEvidenceIds, validateReducedFileBrief, inspectReducedFileBriefShape, strictObject, textField, listField, semanticInvalid } from '../dist/code-analysis-semantic-source.js';

function fixture(t, contents) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-full-semantics-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-full-semantics-')); rmSync(root, { recursive: true, force: true }); });
  const files = Object.entries(contents).map(([name, text]) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), text);
    return { path: name, sha256: semanticDigest(Buffer.from(text)), byte_count: Buffer.byteLength(text), line_count: text ? text.split('\n').length : 0 };
  });
  return { root, snapshot: { snapshot_id: 'a'.repeat(64), manifest_sha256: semanticDigest(files), files } };
}

test('all safe files and all UTF8 bytes are covered without sampling, including oversized single lines and blank tails', t => {
  const contents = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`src/file${n}.ts`, `export const n = ${n};\n\n`]));
  contents['src/huge.txt'] = '超大🙂'.repeat(15000) + '\nfinal\n'; contents['empty.txt'] = '';
  const { root, snapshot } = fixture(t, contents), plan = planSemanticSource(snapshot, root);
  assert.equal(plan.total_files, 102); assert.equal(plan.total_bytes, snapshot.files.reduce((sum, file) => sum + file.byte_count, 0));
  for (const file of snapshot.files) {
    const segments = plan.segments.filter(segment => segment.path === file.path);
    assert.ok(segments.length); assert.equal(segments[0].byte_start, 0); assert.equal(segments.at(-1).byte_end, file.byte_count);
    for (let index = 1; index < segments.length; index++) assert.equal(segments[index].byte_start, segments[index - 1].byte_end);
    assert.equal(Buffer.concat(segments.map(segment => Buffer.from(segment.text))).equals(readFileSync(path.join(root, file.path))), true);
    for (const segment of segments) { assert.equal(segment.text.includes('\ufffd'), false); assert.ok(segment.byte_end - segment.byte_start <= 24 * 1024); }
  }
  assert.ok(plan.batches.every(batch => batch.length <= 12 && batch.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0) <= 40 * 1024));
  assert.deepEqual(planSemanticSource(snapshot, root), plan);
});

test('reduce structural diagnostics identify exact bounded fields without retaining text or unexpected keys', () => {
  const marker = 'untrusted-property-and-text-42';
  const wire = { path: 'a.ts', input_sha256: 'a'.repeat(64), summary: 'Summary.', responsibility: 'Owns a state.', behaviors: [{ description: 'Guards a transition.', evidence_ids: ['E001'] }], state_owners: [], user_purposes: [], dependencies: [{ target: 'callee', type: 'calls', description: 'Delegates a guard.', status: 'inferred', evidence_ids: ['E001'] }], evidence_ids: ['E001'], unknowns: [] };
  const evidence = [{ id: 'E001', path: 'a.ts', line_start: 1, line_end: 2 }], context = { file: { path: 'a.ts', sha256: 'b'.repeat(64), byte_count: 100 }, input_sha256: wire.input_sha256, segment_ids: ['one'] };
  const invalid = { ...wire, summary: marker.repeat(70), responsibility: ' '.repeat(2), behaviors: Array.from({ length: 21 }, () => ({ description: 'x'.repeat(801), evidence_ids: [] })), state_owners: Array(21).fill('owner'), user_purposes: [null], dependencies: [{ ...wire.dependencies[0], target: 'x'.repeat(501), type: 'x'.repeat(81), description: 'x'.repeat(501), status: marker, evidence_ids: Array(21).fill('E001') }], unknowns: ['x'.repeat(801)], [marker]: marker };
  const report = inspectReducedFileBriefShape(invalid);
  assert.ok(report.total > 40); assert.equal(report.issues.length, 40);
  assert.ok(report.issues.some(issue => issue.path === '$.summary' && issue.rule === 'max_length' && issue.maximum === 1200 && issue.observed_length === marker.length * 70));
  assert.ok(report.issues.some(issue => issue.path === '$.behaviors' && issue.rule === 'max_items' && issue.maximum === 20 && issue.observed_count === 21));
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.throws(() => validateReducedFileBrief(invalid, context, { entries: evidence, facts: [] }), error => error.details.reason === 'schema' && error.details.schema_issue_count === report.total && error.details.issue_paths.length > 0 && !JSON.stringify(error.details).includes(marker));
  const cases = [
    [{ ...wire, dependencies: Array(25).fill(wire.dependencies[0]) }, '$.dependencies', 'max_items', 24],
    [{ ...wire, evidence_ids: Array.from({ length: 27 }, (_, index) => `E${String(index + 1).padStart(3, '0')}`) }, '$.evidence_ids', 'max_items', 20],
    [{ ...wire, dependencies: [{ ...wire.dependencies[0], status: marker }] }, '$.dependencies[0].status', 'enum'],
    [{ ...wire, dependencies: [{ ...wire.dependencies[0], evidence_ids: ['E001', 7] }] }, '$.dependencies[0].evidence_ids[1]', 'type'],
    [{ ...wire, state_owners: Array(21).fill('state') }, '$.state_owners', 'max_items', 20],
    [{ ...wire, user_purposes: Array(21).fill('purpose') }, '$.user_purposes', 'max_items', 20],
    [{ ...wire, unknowns: Array(21).fill('unknown') }, '$.unknowns', 'max_items', 20],
    [{ ...wire, unknowns: ['x'.repeat(801)] }, '$.unknowns[0]', 'max_length', 800],
    [{ ...wire, responsibility: 'x'.repeat(801) }, '$.responsibility', 'max_length', 800],
    [{ ...wire, summary: undefined }, '$.summary', 'type'],
    [{ ...wire, behaviors: [{ description: 'Guard.', evidence_ids: [] }] }, '$.behaviors[0].evidence_ids', 'min_items'],
  ];
  for (const [value, fieldPath, rule, maximum] of cases) {
    assert.throws(() => validateReducedFileBrief(value, context, { entries: evidence, facts: [] }), error => error.details.schema_issues.some(issue => issue.path === fieldPath && issue.rule === rule && (maximum === undefined || issue.maximum === maximum)));
  }
  assert.deepEqual(inspectReducedFileBriefShape(wire), { issues: [], total: 0 });
});

test('shared schema failures always expose safe field feedback for bounded repair', () => {
  for (const run of [() => textField('x'.repeat(1201)), () => listField([1, 2], 1), () => strictObject({ 'untrusted-property-42': 'private-value' }, ['summary']), () => semanticInvalid('schema')]) {
    assert.throws(run, error => error.details.reason === 'schema' && error.details.issue_paths.length > 0 && !JSON.stringify(error.details).includes('untrusted-property-42') && !JSON.stringify(error.details).includes('private-value'));
  }
});

test('changed source bytes fail before a semantic prompt can be generated', t => {
  const { root, snapshot } = fixture(t, { 'a.ts': 'export const yes = 1;\n' });
  writeFileSync(path.join(root, 'a.ts'), 'export const no = 2;\n');
  assert.throws(() => planSemanticSource(snapshot, root), { code: 'code_snapshot_changed' });
});

test('every returned segment must match its content identity and evidence must stay within its actual source range', t => {
  const { root, snapshot } = fixture(t, { 'a.ts': 'export const yes = 1;\n' }), plan = planSemanticSource(snapshot, root);
  const segment = plan.segments[0], evidence = [{ path: segment.path, line_start: 1, line_end: 1 }];
  const fact = { segment_id: segment.id, input_sha256: segment.input_sha256, summary: 'Exports a constant.', responsibility: 'Provides a numeric constant.', behaviors: [{ description: 'Initializes the constant to one.', evidence }], state_owners: [], user_purposes: ['Read the constant'], dependencies: [], evidence, unknowns: ['No runtime execution was performed.'] };
  assert.equal(validateSegmentFacts({ segments: [fact] }, [segment])[0].segment_id, segment.id);
  assert.throws(() => validateSegmentFacts({ segments: [] }, [segment]), { code: 'code_analysis_model_invalid' });
  assert.throws(() => validateSegmentFacts({ segments: [{ ...fact, input_sha256: 'b'.repeat(64) }] }, [segment]), { code: 'code_analysis_model_invalid' });
  assert.throws(() => validateSegmentFacts({ segments: [{ ...fact, evidence: [{ path: 'other.ts', line_start: 1, line_end: 1 }] }] }, [segment]), { code: 'code_analysis_model_invalid' });
});

test('file-reduce evidence catalog includes nested behavior/dependency support and never invents a merged or full-file range', () => {
  const first = { path: 'a.ts', line_start: 2, line_end: 4 }, second = { path: 'a.ts', line_start: 5, line_end: 7 }, separated = { path: 'a.ts', line_start: 10, line_end: 11 };
  const facts = [{ segment_id: 'one', input_sha256: 'a'.repeat(64), summary: 'First part.', responsibility: 'Defines state.', state_owners: [], user_purposes: [], unknowns: [], evidence: [first], behaviors: [{ description: 'A guarded transition.', evidence: [second] }], dependencies: [{ target: 'helper', type: 'calls', description: 'Delegates validation.', status: 'inferred', evidence: [separated] }] }];
  const before = JSON.stringify(facts), catalog = createSemanticEvidenceCatalog(facts);
  assert.deepEqual(catalog.entries, [{ id: 'E001', ...first }, { id: 'E002', ...second }, { id: 'E003', ...separated }]);
  assert.deepEqual(catalog.facts[0].behaviors[0].evidence_ids, ['E002']); assert.deepEqual(catalog.facts[0].dependencies[0].evidence_ids, ['E003']);
  assert.equal('evidence' in catalog.facts[0], false); assert.equal('evidence' in catalog.facts[0].behaviors[0], false);
  assert.deepEqual(resolveSemanticEvidenceIds(['E001', 'E002', 'E003'], catalog.entries), [first, second, separated]);
  assert.equal(resolveSemanticEvidenceIds(['E001', 'E002'], catalog.entries).some(item => item.line_start === 2 && item.line_end === 7), false);
  for (const ids of [['E999'], ['E001', 'E001'], [0], [{ path: 'a.ts', line_start: 1, line_end: 100 }]]) assert.throws(() => resolveSemanticEvidenceIds(ids, catalog.entries), { code: 'code_analysis_model_invalid' });
  assert.throws(() => resolveSemanticEvidenceIds([], catalog.entries), { code: 'code_analysis_model_invalid' });
  assert.equal(JSON.stringify(facts), before); assert.deepEqual(createSemanticEvidenceCatalog(facts), catalog);
  const context = { file: { path: 'a.ts', sha256: 'b'.repeat(64), byte_count: 3000, line_count: 100 }, input_sha256: 'c'.repeat(64), segment_ids: ['one'] };
  const wire = { path: 'a.ts', input_sha256: context.input_sha256, summary: 'Combines the guarded behaviors.', responsibility: 'Controls the documented state.', behaviors: [{ description: 'Performs a guarded transition.', evidence_ids: ['E002'] }], state_owners: [], user_purposes: [], dependencies: [{ target: 'helper', type: 'calls', description: 'Delegates validation.', status: 'inferred', evidence_ids: ['E003'] }], evidence_ids: ['E001', 'E002'], unknowns: [] };
  const reduced = validateReducedFileBrief(wire, context, catalog);
  assert.deepEqual(reduced.behaviors[0].evidence, [second]); assert.deepEqual(reduced.dependencies[0].evidence, [separated]);
  assert.deepEqual(reduced.evidence, [first, second]);
  assert.throws(() => validateReducedFileBrief({ ...wire, evidence_ids: ['E999'] }, context, catalog), { code: 'code_analysis_model_invalid' });
  const { evidence_ids: _ids, ...withoutIds } = wire;
  assert.throws(() => validateReducedFileBrief({ ...withoutIds, evidence: [{ path: 'a.ts', line_start: 1, line_end: 100 }] }, context, catalog), { code: 'code_analysis_model_invalid' });
  assert.throws(() => validateReducedFileBrief({ ...wire, input_sha256: 'd'.repeat(64) }, context, catalog), { code: 'code_analysis_model_invalid' });
});
