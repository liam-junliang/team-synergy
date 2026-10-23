import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntakeBundleSchema, evaluateIntakeProduction, evaluateIntakeQuality, renderIntakeSpecification } from '../dist/index.js';

const hash = 'a'.repeat(64);
function sample() {
  const evidence = [{ path: 'materials/policy/reservations.md', sha256: hash, line_start: 1, line_end: 8 }];
  const common = { title: '预约', summary: '会议室预约', content_markdown: '当成员预约空闲时段时，系统应创建预约。', evidence, assessment: 'documented', tests: [], gaps: ['尚无实现或实测结果。'] };
  return {
    schema_version: 1, project_code: 'A'.repeat(20), repository_code: null, namespace: 'reservation', profile: 'pilot',
    source: { mode: 'materials', inputs: [{ key: 'policy', kind: 'document', label: '会议室制度', prefix: 'materials/policy' }],
      commit: null, dirty: false, complete: false, scope: ['materials/policy'], files: [{ path: evidence[0].path, sha256: hash }], manifest_sha256: hash,
      exclusions: [], analyzed_at: '2026-10-21T00:00:00.000Z', skill_version: '2.0.0',
      production: { version: '1.0', scope_statement: '只覆盖会议室预约创建；取消与费用另行确认。', discovery_status: 'reviewed',
        capabilities: [{ key: 'CAP-BOOK', title: '创建预约', module_key: 'module.booking', feature_key: 'feature.create', disposition: 'included', reason: '输入制度已明确', requirement_keys: ['REQ-BOOK-01'], evidence }], conflicts: [] } },
    items: [{ ...common, key: 'module.booking', kind: 'module' }, { ...common, key: 'feature.create', kind: 'feature', module_key: 'module.booking' },
      { ...common, key: 'REQ-BOOK-01', kind: 'requirement', module_key: 'module.booking', feature_key: 'feature.create',
        acceptance_criteria: [{ id: 'AC-BOOK-01', text: '给定成员和空闲时段，当提交预约，则创建归属该成员的预约。' }],
        specification: { actor: '实验室成员', trigger: '提交预约', preconditions: ['时段可用'], main_flow: ['校验成员身份', '检查冲突并保存预约'],
          exceptions: [{ condition: '时段冲突', handling: '拒绝且保留原预约' }], business_rules: ['同一会议室预约不得重叠'], state_changes: ['空闲时段变为已预约'], data_contracts: ['开始时间小于结束时间；具体接口尚未设计'] },
        verification_plan: [{ ac_id: 'AC-BOOK-01', method: 'manual', preconditions: '创建可用时段和成员', steps: ['以该成员提交预约', '读取预约详情'], expected: '成员归属和时段一致；仅产生一条预约' }] }],
  };
}

test('materials-only specifications retain provenance, AC and future verification without fictitious code/tests', () => {
  const bundle = IntakeBundleSchema.parse(sample());
  const { coverage, issues } = evaluateIntakeProduction(bundle);
  assert.equal(bundle.repository_code, null);
  assert.equal(coverage.specified, 1);
  assert.equal(coverage.with_verification, 1);
  assert.deepEqual(issues, []);
  assert.deepEqual(bundle.items[2].tests, []);
  assert.equal(bundle.items[2].assessment, 'documented');
  const markdown = renderIntakeSpecification(bundle.items[2]);
  assert.ok(markdown.includes('AC-BOOK-01'));
  assert.ok(markdown.includes('时段冲突：拒绝且保留原预约'));
  assert.ok(markdown.includes('未执行的计划不代表通过'));
});

test('uncovered and unknown capabilities do not disappear into the specified count', () => {
  const bundle = sample();
  bundle.source.production.capabilities.push({ ...bundle.source.production.capabilities[0], key: 'CAP-CANCEL', title: '取消', requirement_keys: [] },
    { key: 'CAP-FEE', title: '费用', disposition: 'unknown', reason: '团队还未确定', requirement_keys: [], evidence: [] },
    { key: 'CAP-PAY', title: '支付', disposition: 'excluded', reason: '本次无支付范围', requirement_keys: [], evidence: [] });
  const { coverage, issues } = evaluateIntakeProduction(IntakeBundleSchema.parse(bundle));
  assert.deepEqual([coverage.declared, coverage.in_scope, coverage.specified, coverage.pending, coverage.unknown, coverage.excluded], [4, 2, 1, 1, 1, 1]);
  assert.equal(coverage.status, 'gaps');
  assert.ok(issues.some(issue => issue.rule_id === 'production.capability_specification' && issue.severity === 'blocker'));
});

test('a missing AC plan and a new uncovered AC invalidate specification coverage', () => {
  for (const change of [bundle => bundle.items[2].verification_plan = [], bundle => bundle.items[2].acceptance_criteria.push({ id: 'AC-BOOK-02', text: '时段冲突时保留原预约' })]) {
    const bundle = sample(); change(bundle);
    const report = evaluateIntakeProduction(IntakeBundleSchema.parse(bundle));
    assert.equal(report.coverage.specified, 0);
    assert.ok(report.issues.some(issue => issue.rule_id === 'production.verification'));
  }
});

test('dangling and cross-module capability references cannot enter the candidate graph', () => {
  for (const change of [bundle => bundle.source.production.capabilities[0].requirement_keys = ['absent'],
    bundle => bundle.source.production.capabilities[0].feature_key = 'module.booking',
    bundle => bundle.items[2].verification_plan[0].ac_id = 'AC-MISSING',
    bundle => bundle.source.production.capabilities[0].evidence[0].sha256 = 'c'.repeat(64)]) {
    const bundle = structuredClone(sample()); change(bundle);
    assert.equal(IntakeBundleSchema.safeParse(bundle).success, false);
  }
});

test('materials do not acquire implementation or Git claims through assessment labels', () => {
  for (const change of [bundle => bundle.items[0].assessment = 'observed_in_code', bundle => bundle.source.commit = 'a'.repeat(40),
    bundle => bundle.repository_code = 'B'.repeat(20), bundle => delete bundle.source.mode,
    bundle => bundle.source.inputs[0].prefix = '../other']) {
    const bundle = sample(); change(bundle);
    assert.equal(IntakeBundleSchema.safeParse(bundle).success, false);
  }
});

test('source contradictions remain blockers until an evidenced resolution is recorded', () => {
  const bundle = sample();
  bundle.source.production.conflicts.push({ key: 'LIMIT', summary: '额度规则不一致', status: 'open', resolution: '', evidence: bundle.items[0].evidence });
  assert.ok(evaluateIntakeQuality(IntakeBundleSchema.parse(bundle)).issues.some(issue => issue.rule_id === 'production.conflict'));
  bundle.source.production.conflicts[0].status = 'resolved';
  assert.ok(evaluateIntakeQuality(IntakeBundleSchema.parse(bundle)).issues.some(issue => issue.rule_id === 'production.conflict_resolution'));
});

test('legacy packages retain unknown product coverage and are not silently enriched before hashing', () => {
  const bundle = sample();
  bundle.repository_code = 'B'.repeat(20); delete bundle.source.mode; delete bundle.source.inputs; delete bundle.source.production;
  for (const item of bundle.items) { delete item.acceptance_criteria; delete item.verification_plan; delete item.specification; }
  const parsed = IntakeBundleSchema.parse(bundle);
  assert.deepEqual(parsed, bundle);
  assert.equal(evaluateIntakeQuality(parsed).coverage.status, 'unknown');
});

test('complete structured AC plans do not require magic wording in prose, but incomplete plans cannot bypass checks', () => {
  const bundle = sample(); bundle.profile = 'enterprise';
  bundle.items[2].content_markdown = '# REQ-BOOK-01\n\n预约时段与成员保持一致。';
  bundle.items[2].acceptance_criteria[0].text = '预约归属提交成员且时段一致。';
  const acceptanceIssues = value => evaluateIntakeQuality(IntakeBundleSchema.parse(value)).issues.filter(issue => issue.rule_id === 'requirements.acceptance');
  assert.deepEqual(acceptanceIssues(bundle), []);
  for (const change of [item => item.verification_plan[0].expected = '', item => item.verification_plan[0].preconditions = '',
    item => item.verification_plan[0].steps = [''], item => item.acceptance_criteria.push({ id: 'AC-BOOK-02', text: '冲突时不新增' })]) {
    const missing = structuredClone(bundle); change(missing.items[2]);
    assert.equal(acceptanceIssues(missing).length, 1);
  }
  delete bundle.items[2].acceptance_criteria; delete bundle.items[2].verification_plan;
  assert.equal(acceptanceIssues(bundle).length, 1);
});
