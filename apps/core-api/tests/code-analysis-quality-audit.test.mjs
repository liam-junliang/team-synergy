import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from './code-analysis-quality.mjs';
import { auditQuality } from './code-analysis-quality-audit.mjs';

const hashJson = value => digest(JSON.stringify(value));
const check = (result, id) => result.checks.find(row => row.id === id);
function fixture(t) {
  const source = mkdtempSync(path.join(tmpdir(), 'tsp-quality-audit-'));
  t.after(() => { assert.equal(path.dirname(source), path.resolve(tmpdir())); assert(path.basename(source).startsWith('tsp-quality-audit-')); rmSync(source, { recursive: true, force: true }); });
  const files = [{ path: 'route.ts', content: 'return guard();\n' }, { path: 'guard.test.ts', content: 'assert.rejects(action);\n' }];
  const snapshot = { snapshot_id: 'b'.repeat(64), manifest_sha256: 'c'.repeat(64), commit: 'a'.repeat(40), files: files.map(file => ({ path: file.path, byte_count: Buffer.byteLength(file.content), line_count: 2, sha256: digest(file.content) })) };
  for (const file of files) writeFileSync(path.join(source, file.path), file.content);
  const segments = files.map((file, index) => {
    const identity = { path: file.path, file_sha256: snapshot.files[index].sha256, byte_start: 0, byte_end: Buffer.byteLength(file.content), line_start: 1, line_end: 2, content_sha256: digest(file.content) };
    const input_sha256 = hashJson(identity);
    return { id: `segment:${input_sha256.slice(0, 32)}`, ...identity, input_sha256 };
  });
  const plan = { snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, segments, batches: segments.map(segment => [segment.id]) };
  const graph = { project: { gitCommitHash: snapshot.commit }, nodes: [{ id: 'm1', type: 'module', summary: 'Routes' }, { id: 'm2', type: 'module', summary: 'Guard test definitions' }, ...files.map(file => ({ id: `file:${file.path}`, type: 'file', filePath: file.path, summary: file.path.endsWith('test.ts') ? 'Defines a rejected action assertion; tests not executed.' : 'Calls guard.' }))], edges: [{ source: 'm1', target: 'file:route.ts', type: 'contains' }, { source: 'm2', target: 'file:guard.test.ts', type: 'contains' }, { source: 'file:route.ts', target: 'file:guard.test.ts', type: 'imports' }, { source: 'm1', target: 'm2', type: 'depends_on' }], layers: [{ id: 'm1', nodeIds: ['m1', 'file:route.ts'] }, { id: 'm2', nodeIds: ['m2', 'file:guard.test.ts'] }], tour: [] };
  const evidence = [{ path: 'route.ts', line_start: 1, line_end: 1 }];
  const briefs = files.map(file => ({ path: file.path, summary: 'summary', responsibility: 'responsibility', behaviors: [], dependencies: [], state_owners: [], user_purposes: [] }));
  const report = { snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, full_source_coverage: true, total_files: files.length, total_segments: segments.length, completed_segments: segments.length, total_bytes: files.reduce((n, file) => n + Buffer.byteLength(file.content), 0), covered_bytes: files.reduce((n, file) => n + Buffer.byteLength(file.content), 0), file_coverage: snapshot.files.map(file => ({ path: file.path, sha256: file.sha256, total_bytes: file.byte_count, covered_bytes: file.byte_count, segments: segments.filter(s => s.path === file.path).map(s => ({ ...s, completed: true })) })), file_ownership: files.map((file, index) => ({ path: file.path, module_id: `m${index + 1}`, rationale: 'Assigned by responsibility.' })), node_evidence: graph.nodes.map(node => ({ node_id: node.id, evidence })), relation_evidence: graph.edges.map(edge => ({ ...edge, evidence, basis: 'semantic_inference' })), unresolved: [] };
  const consistency = { verification_version: 'cross-file-claims-1.0.0', snapshot_id: snapshot.snapshot_id, files_checked: 2, contexts_checked: 2, claims_checked: 4, corrected_claims: 0, uncertain_claims: 0, checks: files.map(file => ({ path: file.path, input_sha256: digest(file.path), checked_claims: ['summary', 'responsibility'], findings: [], unresolved_dependencies: [] })), brief_changes: briefs.map(brief => ({ path: brief.path, before_sha256: hashJson(brief), after_sha256: hashJson(brief) })) };
  return { source, snapshot, artifact: { snapshot_id: snapshot.snapshot_id, ua_graph: graph }, report, consistency, plan, facts: segments.map(segment => ({ segment_id: segment.id, input_sha256: segment.input_sha256, summary: 'Stored source interpretation.' })), rawBriefs: briefs, briefs };
}

test('valid stored coverage and projected dependencies remain separate from semantic approval', t => {
  const f = fixture(t), result = auditQuality(f);
  assert.equal(result.structural_status, 'pass');
  assert.equal(check(result, 'cross_batch_module_projection').evidence.across_disjoint_source_batches, 1);
  assert.equal(result.semantic_status, 'requires_independent_source_review');
  assert(result.manual_gates.every(gate => gate.status === 'unverified'));
  assert.equal(result.semantic_score, undefined);
});

test('coverage declarations and file nodes cannot replace source byte identities and stored facts', t => {
  const f = fixture(t);
  const incomplete = auditQuality({ ...f, facts: f.facts.slice(0, 1) });
  assert.equal(check(incomplete, 'complete_segment_evidence').status, 'fail');
  const changed = structuredClone(f.plan); changed.segments[0].input_sha256 = 'forged';
  assert.equal(check(auditQuality({ ...f, plan: changed }), 'complete_segment_evidence').status, 'fail');
  const unproven = auditQuality({ ...f, source: undefined, plan: undefined, facts: undefined });
  assert.equal(check(unproven, 'fixed_source_bytes').status, 'unverified');
  assert.equal(check(unproven, 'complete_segment_evidence').status, 'unverified');
});

test('duplicate owners, absent module relations and invented evidence fail mechanical checks', t => {
  const f = fixture(t);
  f.report.file_ownership.push({ ...f.report.file_ownership[0] });
  f.artifact.ua_graph.edges = f.artifact.ua_graph.edges.filter(edge => !(edge.source === 'm1' && edge.target === 'm2'));
  f.report.node_evidence[0].evidence = [{ path: 'not-in-snapshot.ts', line_start: 1, line_end: 1 }];
  const result = auditQuality(f);
  assert.equal(check(result, 'global_primary_ownership').status, 'fail');
  assert.equal(check(result, 'cross_batch_module_projection').status, 'fail');
  assert.equal(check(result, 'traceable_public_sources').status, 'fail');
});

test('private consistency findings must be source-located and visible in public corrections or uncertainty', t => {
  const f = fixture(t);
  f.consistency.checks[0].findings.push({ claim_id: 'summary', status: 'corrected', replacement: 'The callee ignores the body.', reason: 'Definition shows no body use.', evidence: [{ path: 'route.ts', line_start: 1, line_end: 1 }] });
  f.consistency.corrected_claims = 1;
  let result = auditQuality(f);
  assert.equal(check(result, 'consistency_accounting').status, 'fail');
  f.artifact.ua_graph.nodes.find(node => node.id === 'file:route.ts').summary = 'The callee ignores the body.';
  result = auditQuality(f);
  assert.equal(check(result, 'consistency_accounting').status, 'pass');
  f.consistency.checks[1].checked_claims = ['summary']; f.consistency.claims_checked = 3;
  assert.equal(check(auditQuality(f), 'consistency_accounting').status, 'fail');
});

test('private unknowns and potentially misleading test outcomes require visible boundaries and human review', t => {
  const f = fixture(t);
  f.report.unresolved.push({ scope: 'system', description: 'Database runtime behavior is unverified.' });
  f.artifact.ua_graph.nodes.find(node => node.id === 'file:guard.test.ts').summary = 'Tests passed successfully.';
  let result = auditQuality(f);
  assert.equal(check(result, 'public_unknown_visibility').status, 'fail');
  assert.equal(result.manual_gates.find(gate => gate.id === 'tests_are_not_execution').candidates.length, 1);
  f.artifact.ua_graph.nodes[0].languageNotes = 'Database runtime behavior is unverified.';
  result = auditQuality(f);
  assert.equal(check(result, 'public_unknown_visibility').status, 'pass');
  assert.equal(result.manual_gates.find(gate => gate.id === 'tests_are_not_execution').status, 'unverified');
});

function groupedFixture(t, mixed = false, version = 'cross-file-claims-1.1.0') {
  const f = fixture(t), filePath = 'route.ts', originalUnknown = 'Runtime timezone is unknown.';
  f.consistency.verification_version = version;
  f.rawBriefs = structuredClone(f.rawBriefs); f.rawBriefs[0].unknowns = [originalUnknown]; f.briefs = structuredClone(f.rawBriefs);
  const reasons = ['Definition only uses middleware identity.', 'Caller argument is ignored by the definition.', 'No fallback to the body exists.'];
  const rows = reasons.map((reason, index) => ({ path: filePath, input_sha256: digest(`context-${index}`), checked_claims: ['summary', 'responsibility'], findings: [{ claim_id: 'summary', status: mixed && index === 1 ? 'uncertain' : 'corrected', replacement: mixed && index === 1 ? '' : 'The callee ignores the body.', reason, evidence: [{ path: filePath, line_start: 1, line_end: 1 }] }], unresolved_dependencies: [] }));
  f.consistency.checks = [...rows, f.consistency.checks[1]];
  f.consistency.contexts_checked = 4; f.consistency.claims_checked = 8;
  f.consistency.corrected_claims = mixed ? 0 : 1; f.consistency.uncertain_claims = mixed ? 1 : 0;
  if (version === 'cross-file-claims-1.3.0') {
    f.consistency.applied_corrected_claims = f.consistency.corrected_claims; f.consistency.host_downgraded_findings = 0;
    f.report.statistics = { consistency_files: 2, consistency_claims: 8, consistency_corrected_claims: f.consistency.corrected_claims, consistency_uncertain_claims: f.consistency.uncertain_claims, consistency_applied_corrected_claims: f.consistency.corrected_claims, consistency_host_downgraded_findings: 0 };
  }
  const reference = hashJson({ verification_version: f.consistency.verification_version, path: filePath, checks: rows });
  const note = mixed
    ? `跨文件待确认：summary，3条审查意见/4项不同理由。未采纳纠正建议：${reasons[0]}；待确认：${reasons[1]}；另2项理由完整保留于审计。一致性审计引用：${reference}。`
    : `已修正的跨文件源码解释（仍是推断）：summary，3条审查意见/3项不同理由。已采纳纠正：${reasons[0]}；已采纳纠正：${reasons[1]}；另1项理由完整保留于审计。一致性审计引用：${reference}。`;
  const summary = mixed ? '待确认：summary（跨文件依据尚未一致）' : 'The callee ignores the body.';
  Object.assign(f.artifact.ua_graph.nodes.find(node => node.filePath === filePath), { summary, domainMeta: { businessRules: [originalUnknown, note] } });
  f.briefs[0].summary = summary; f.briefs[0].unknowns.push(note);
  f.consistency.brief_changes = f.rawBriefs.map((brief, index) => ({ path: brief.path, before_sha256: hashJson(brief), after_sha256: hashJson(f.briefs[index]) }));
  f.report.unresolved = [originalUnknown, note].map(description => ({ scope: `file:${filePath}`, description }));
  return f;
}

test('v1.1 grouped reasons remain auditable without publishing each raw reason', t => {
  const f = groupedFixture(t), result = auditQuality(f);
  assert.equal(check(result, 'consistency_accounting').status, 'pass');
  assert.equal(check(result, 'public_unknown_visibility').status, 'pass');
  assert(!JSON.stringify(f.artifact.ua_graph).includes('No fallback to the body exists.'));
  const file = f.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts');
  // Matching report and graph text cannot make a forged reference/count legitimate.
  file.domainMeta.businessRules[1] = file.domainMeta.businessRules[1].replace(/一致性审计引用：[a-f0-9]+/, '一致性审计引用：forged');
  f.report.unresolved[1].description = file.domainMeta.businessRules[1];
  assert.equal(check(auditQuality(f), 'public_unknown_visibility').status, 'pass');
  assert.equal(check(auditQuality(f), 'consistency_accounting').status, 'fail');
  const badCount = groupedFixture(t), badFile = badCount.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts');
  badFile.domainMeta.businessRules[1] = badFile.domainMeta.businessRules[1].replace('3条审查意见', '4条审查意见');
  badCount.report.unresolved[1].description = badFile.domainMeta.businessRules[1];
  assert.equal(check(auditQuality(badCount), 'consistency_accounting').status, 'fail');
});

test('v1.1 mixed opinions stay uncertain and original unknowns cannot be silently removed', t => {
  const f = groupedFixture(t, true), result = auditQuality(f);
  assert.equal(check(result, 'consistency_accounting').status, 'pass');
  const file = f.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts');
  file.summary = 'The callee ignores the body.';
  assert.equal(check(auditQuality(f), 'consistency_accounting').status, 'fail');
  file.summary = '待确认：summary（跨文件依据尚未一致）';
  file.domainMeta.businessRules.shift(); f.report.unresolved.shift();
  assert.equal(check(auditQuality(f), 'public_unknown_visibility').status, 'pass');
  assert(check(auditQuality(f), 'consistency_accounting').issues.some(issue => issue.startsWith('original_unknown_removed:')));
});

test('known v1.2/v1.3 keep grouped publication without accepting unreviewed future versions', t => {
  for (const version of ['cross-file-claims-1.2.0', 'cross-file-claims-1.3.0']) for (const mixed of [false, true]) {
    const result = auditQuality(groupedFixture(t, mixed, version));
    assert.equal(check(result, 'consistency_accounting').status, 'pass');
    assert.equal(check(result, 'public_unknown_visibility').status, 'pass');
  }
  const f = fixture(t);
  for (const version of ['cross-file-claims-1.4.0', 'cross-file-claims-2.0.0', undefined]) {
    f.consistency.verification_version = version;
    const checked = check(auditQuality(f), 'consistency_accounting');
    assert.equal(checked.status, 'fail');
    assert(checked.issues.includes('unsupported_consistency_version'));
  }
});

const hostReason = '宿主未采用纠正建议：当前页所引证据未包含实际提供的完整被调用定义；原断言保留待确认，原建议与合法引用已保留于私有审计。';
function hostFixture(t, downgraded = 1) {
  const f = groupedFixture(t, true, 'cross-file-claims-1.3.0');
  const rows = f.consistency.checks.filter(row => row.path === 'route.ts');
  for (let index = 0; index < downgraded; index++) {
    const finding = rows[index + 1].findings[0];
    Object.assign(finding, { status: 'uncertain', replacement: '', reason: hostReason, host_reason: 'missing_complete_callee_definition', original_proposal: { status: 'corrected', replacement: `UNTRUSTED_PRIVATE_REPLACEMENT_${index}`, reason: `PRIVATE_REASON_${index}`, evidence_ids: ['E001'], evidence: structuredClone(finding.evidence) } });
  }
  f.consistency.host_downgraded_findings = downgraded;
  f.report.statistics.consistency_host_downgraded_findings = downgraded;
  const reasons = [...new Set([...rows.map(row => `${row.findings[0].status === 'corrected' ? '未采纳纠正建议' : '待确认'}：${row.findings[0].reason}`), '同一断言同时存在纠正建议和未确认意见，保留待确认。'])];
  const reference = hashJson({ verification_version: f.consistency.verification_version, path: 'route.ts', checks: rows });
  const note = `跨文件待确认：summary，3条审查意见/${reasons.length}项不同理由。${reasons.slice(0, 2).join('；')}；另${reasons.length - 2}项理由完整保留于审计。一致性审计引用：${reference}。`;
  f.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts').domainMeta.businessRules[1] = note;
  f.report.unresolved[1].description = note; f.briefs[0].unknowns[1] = note;
  f.consistency.brief_changes[0].after_sha256 = hashJson(f.briefs[0]);
  return f;
}

test('v1.3 counts host downgrades per finding while mixed claims remain unapplied and auditable', t => {
  for (const count of [1, 2]) {
    const f = hostFixture(t, count), result = auditQuality(f), accounting = check(result, 'consistency_accounting');
    assert.equal(accounting.status, 'pass');
    assert.equal(accounting.evidence.independently_counted_host_downgrades, count);
    assert.equal(accounting.evidence.applied_corrected_claims, 0);
    assert.equal(accounting.evidence.uncertain_claims, 1);
    assert(!JSON.stringify(f.artifact).includes('UNTRUSTED_PRIVATE_REPLACEMENT'));
    assert(result.manual_gates.some(gate => gate.id === 'host_proposal_catalog_scope' && gate.status === 'unverified'));
    f.consistency.host_downgraded_findings = 0;
    assert(check(auditQuality(f), 'consistency_accounting').issues.includes('host_downgrade_totals_mismatch'));
    f.consistency.host_downgraded_findings = count; f.consistency.applied_corrected_claims = 1;
    assert(check(auditQuality(f), 'consistency_accounting').issues.includes('host_downgrade_totals_mismatch'));
  }
  const mismatch = hostFixture(t); delete mismatch.report.statistics.consistency_host_downgraded_findings;
  assert(check(auditQuality(mismatch), 'consistency_accounting').issues.includes('report_host_downgrade_totals_mismatch'));
});

test('v1.3 cannot adopt downgraded proposals or leak their reason, replacement or object publicly', t => {
  const f = hostFixture(t), host = f.consistency.checks[1].findings[0];
  const node = f.artifact.ua_graph.nodes.find(candidate => candidate.filePath === 'route.ts');
  node.summary = host.original_proposal.replacement;
  f.briefs[0].summary = host.original_proposal.replacement;
  f.consistency.brief_changes[0].after_sha256 = hashJson(f.briefs[0]);
  let accounting = check(auditQuality(f), 'consistency_accounting');
  assert(accounting.issues.some(issue => issue.startsWith('incorrect_reconciled_claim_application:')));
  const leaked = hostFixture(t), leakedHost = leaked.consistency.checks[1].findings[0];
  leaked.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts').domainMeta.businessRules[1] += leakedHost.original_proposal.reason;
  assert(check(auditQuality(leaked), 'consistency_accounting').issues.some(issue => issue.startsWith('private_proposal_text_in_public_note:')));
  leaked.report.debug = { original_proposal: leakedHost.original_proposal };
  assert(check(auditQuality(leaked), 'consistency_accounting').issues.includes('private_original_proposal_object_published'));
});

test('v1.3 independent callee facts matching a refused proposal require source review without a false leak verdict', t => {
  const f = hostFixture(t), independentFact = 'assert.rejects defines an expected rejection without execution proof.';
  const host = f.consistency.checks[1].findings[0]; host.original_proposal.replacement = independentFact;
  f.rawBriefs[1].summary = independentFact; f.briefs[1].summary = independentFact;
  const calleeNode = f.artifact.ua_graph.nodes.find(node => node.filePath === 'guard.test.ts');
  calleeNode.summary = independentFact;
  f.report.node_evidence.find(row => row.node_id === calleeNode.id).evidence = [{ path: 'guard.test.ts', line_start: 1, line_end: 1 }];
  const checks = f.consistency.checks.filter(row => row.path === 'route.ts');
  const reference = hashJson({ verification_version: f.consistency.verification_version, path: 'route.ts', checks });
  const caller = f.artifact.ua_graph.nodes.find(node => node.filePath === 'route.ts');
  const note = caller.domainMeta.businessRules[1].replace(/一致性审计引用：[a-f0-9]+/, `一致性审计引用：${reference}`);
  caller.domainMeta.businessRules[1] = note; f.briefs[0].unknowns[1] = note; f.report.unresolved[1].description = note;
  f.consistency.brief_changes = f.rawBriefs.map((brief, index) => ({ path: brief.path, before_sha256: hashJson(brief), after_sha256: hashJson(f.briefs[index]) }));
  const result = auditQuality(f);
  assert.equal(check(result, 'consistency_accounting').status, 'pass');
  const reuse = check(result, 'private_proposal_reuse_evidence');
  assert.equal(reuse.status, 'unverified');
  assert.deepEqual(reuse.issues, []);
  assert(reuse.evidence.potential_matches.some(match => match.node_id === calleeNode.id && match.existing_in_raw_file));
  assert.equal(f.briefs[0].summary, '待确认：summary（跨文件依据尚未一致）');
  assert.equal(result.structural_status, 'unverified');
  assert(result.manual_gates.some(gate => gate.id === 'private_proposal_independent_reuse'));
});

test('v1.3 semantic downgrading never excuses malformed normalized identity, status or proposal citations', t => {
  for (const mutate of [
    f => { f.consistency.checks[1].input_sha256 = 'wrong-context'; },
    f => { f.consistency.checks[1].findings[0].replacement = 'Must stay empty.'; },
    f => { f.consistency.checks[1].findings[0].reason = 'PRIVATE_REASON_0'; },
    f => { f.consistency.checks[1].findings[0].original_proposal.evidence_ids = ['E001', 'E001']; },
    f => { f.consistency.checks[1].findings[0].original_proposal.evidence_ids = ['not-an-id']; },
    f => { f.consistency.checks[1].findings[0].original_proposal.evidence[0].path = 'not-in-source.ts'; },
  ]) {
    const f = hostFixture(t); mutate(f);
    const accounting = check(auditQuality(f), 'consistency_accounting');
    assert.equal(accounting.status, 'fail');
    assert(accounting.issues.some(issue => /invalid_(normalized|host|private)/.test(issue)));
  }
});
