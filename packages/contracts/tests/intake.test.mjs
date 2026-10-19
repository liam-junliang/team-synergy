import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IntakeBundleSchema, IntakeReviewSchema, IntakeApplySchema, intakeManifestText, isIntakeSourcePath } from '../dist/intake.js';

const hash = 'a'.repeat(64);
function bundle() {
  const files = [{ path: 'src/access.ts', sha256: hash }];
  return { schema_version: 1, project_code: '00000000000000000001', repository_code: '00000000000000000002', namespace: 'sample', source: {
    commit: 'b'.repeat(40), dirty: true, scope: ['src'], files, manifest_sha256: createHash('sha256').update(intakeManifestText(files)).digest('hex'), complete: false, exclusions: ['tests not inspected'], analyzed_at: '2026-10-18T00:00:00Z', skill_version: '1.0.0',
  }, items: [{ key: 'module.access', kind: 'module', title: 'Access', summary: 'Permission checks', content_markdown: '', evidence: [{ path: files[0].path, sha256: hash, line_start: 1, line_end: 10 }], assessment: 'observed_in_code', tests: [], gaps: [] }] };
}
test('intake captures dirty partial snapshots without claiming tests or review passed', () => {
  const result = IntakeBundleSchema.parse(bundle());
  assert.equal(result.source.complete, false);
  assert.equal(result.source.dirty, true);
  assert.deepEqual(result.items[0].tests, []);
  assert.equal('review' in result.items[0], false);
});
test('source manifest serialization is stable across input ordering and locale', () => {
  const files = [{ path: 'src/z.ts', sha256: hash }, { path: 'src/A.ts', sha256: hash }];
  assert.equal(intakeManifestText(files), intakeManifestText([...files].reverse()));
  assert.equal(intakeManifestText(files), `src/A.ts\0${hash}\nsrc/z.ts\0${hash}\n`);
});
test('source references reject escaping, absolute, secret and generated paths', () => {
  for (const bad of ['../x.ts', 'src/../../x.ts', '/src/x.ts', 'C:/x.ts', 'src\\x.ts', 'src//x.ts', './x.ts', '.env', '.env.local', 'a/.git/config', 'node_modules/x.ts', 'id_rsa', 'cert.pem', 'x\n.ts']) assert.equal(isIntakeSourcePath(bad), false, bad);
  assert.equal(isIntakeSourcePath('src/auth-config.ts'), true);
});
test('evidence must refer to a file and hash from this scan and a valid line range', () => {
  for (const change of [value => value.items[0].evidence[0].sha256 = 'c'.repeat(64), value => value.items[0].evidence[0].path = 'missing.ts', value => value.items[0].evidence[0].line_end = 0, value => value.items[0].tests.push({ path: 'missing.test.ts', name: 'test', status: 'passed' })]) {
    const value = bundle(); change(value); assert.equal(IntakeBundleSchema.safeParse(value).success, false);
  }
});

test('a manifest cannot claim files outside the reviewed scope or a similarly named sibling', () => {
  for (const scope of [['tests'], ['sr'], ['src/access']]) {
    const value = bundle(); value.source.scope = scope;
    assert.equal(IntakeBundleSchema.safeParse(value).success, false);
  }
  const value = bundle(); value.source.scope = ['src/access.ts'];
  assert.equal(IntakeBundleSchema.safeParse(value).success, true);
});
test('unknown fields and historical completion claims are rejected rather than stripped', () => {
  for (const change of [value => value.schema_version = 2, value => value.items[0].status = 'closed', value => value.source.token = 'secret', value => value.items[0].assessment = 'accepted', value => value.items[0].kind = 'task']) {
    const value = bundle(); change(value); assert.equal(IntakeBundleSchema.safeParse(value).success, false);
  }
});
test('candidate graph requires explicit typed parents and consistent module references', () => {
  const value = bundle();
  const original = value.items[0];
  value.items.push({ ...original, key: 'feature.login', kind: 'feature', module_key: original.key });
  value.items.push({ ...original, key: 'doc.login', kind: 'requirement_document', module_key: original.key, content_markdown: '# Login' });
  value.items.push({ ...original, key: 'req.login', kind: 'requirement', module_key: original.key, feature_key: 'feature.login', document_key: 'doc.login', content_markdown: 'Verify credentials' });
  assert.equal(IntakeBundleSchema.safeParse(value).success, true);
  value.items[3].module_key = 'feature.login';
  assert.equal(IntakeBundleSchema.safeParse(value).success, false);
  delete value.items[1].module_key;
  assert.equal(IntakeBundleSchema.safeParse(value).success, false);
});
test('duplicates, missing graph sources and empty content cannot enter staging', () => {
  const duplicate = bundle(); duplicate.items.push(duplicate.items[0]); assert.equal(IntakeBundleSchema.safeParse(duplicate).success, false);
  const duplicateFile = bundle(); duplicateFile.source.files.push(duplicateFile.source.files[0]); assert.equal(IntakeBundleSchema.safeParse(duplicateFile).success, false);
  const architecture = bundle(); architecture.items[0].kind = 'architecture'; assert.equal(IntakeBundleSchema.safeParse(architecture).success, false);
  architecture.items[0].diagram_source = 'flowchart LR\nA-->B'; assert.equal(IntakeBundleSchema.safeParse(architecture).success, true);
});
test('recognizable credentials are rejected in candidate content', () => {
  for (const content of ['-----BEGIN PRIVATE KEY-----', `ghp_${'x'.repeat(30)}`, 'https://user:password@example.org/repo.git']) {
    const value = bundle(); value.items[0].content_markdown = content; assert.equal(IntakeBundleSchema.safeParse(value).success, false);
  }
});
test('review decisions cannot smuggle an overwrite or an unpinned binding', () => {
  const base = { base_revision: 1, decisions: [{ key: 'module.access', action: 'create' }] };
  assert.equal(IntakeReviewSchema.safeParse(base).success, true);
  for (const decision of [{ key: 'm', action: 'update' }, { key: 'm', action: 'bind', target_code: '00000000000000000001' }, { key: 'm', action: 'create', target_code: '00000000000000000001', target_fingerprint: hash }]) assert.equal(IntakeReviewSchema.safeParse({ ...base, decisions: [decision] }).success, false);
  assert.equal(IntakeReviewSchema.safeParse({ ...base, decisions: [{ key: 'm', action: 'bind', target_code: '00000000000000000001', target_fingerprint: hash }] }).success, true);
  assert.equal(IntakeReviewSchema.safeParse({ ...base, decisions: [...base.decisions, ...base.decisions] }).success, false);
});
test('publish requires a reviewed plan hash and a bounded replay key', () => {
  assert.equal(IntakeApplySchema.safeParse({ plan_hash: hash, idempotency_key: 'publish:01' }).success, true);
  for (const value of [{ idempotency_key: 'x' }, { plan_hash: hash, idempotency_key: '' }, { plan_hash: hash, idempotency_key: 'x', approve: true }]) assert.equal(IntakeApplySchema.safeParse(value).success, false);
});
