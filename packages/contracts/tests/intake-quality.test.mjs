import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_QUALITY_RULE_VERSION, ENTERPRISE_ARTIFACTS, INTAKE_QUALITY_RULE_VERSION,
  IntakeBundleSchema, evaluateIntakeQuality,
} from '../dist/index.js';

const hash = 'a'.repeat(64);
function bundle() {
  const evidence = [
    { path: 'src/service.ts', sha256: hash, line_start: 1, line_end: 10 },
    { path: 'tests/service.test.ts', sha256: hash, line_start: 1, line_end: 10 },
  ];
  const item = { key: 'module-platform', kind: 'module', title: 'Platform', summary: '', content_markdown: '', assessment: 'observed_in_code', evidence, tests: [], gaps: [] };
  return IntakeBundleSchema.parse({
    schema_version: 1, project_code: 'A'.repeat(20), repository_code: 'B'.repeat(20), namespace: 'test-quality', profile: 'enterprise',
    source: { commit: 'a'.repeat(40), dirty: false, complete: true, scope: ['.'], files: evidence.map(({ path, sha256 }) => ({ path, sha256 })), manifest_sha256: hash, exclusions: [], analyzed_at: '2026-10-21T00:00:00.000Z', skill_version: '1.0.0' },
    items: [item, ...ENTERPRISE_ARTIFACTS.filter(artifact => artifact.required).map(artifact => ({
      ...item, key: `doc-${artifact.type}`, title: artifact.title, kind: artifact.kind, artifact_type: artifact.type,
      ...(artifact.kind === 'architecture' ? { diagram_source: 'flowchart LR\n UI-->API' } : { module_key: item.key }),
      content_markdown: `# ${artifact.title}\n` + artifact.sections.map(section => `## ${section}\n${artifact.type === 'requirements' && section === '功能需求' ? '### REQ-ACCESS-01\n当管理员提交请求时，系统必须校验权限。\n' : ''}${section === '验收场景' ? 'Given 管理员已登录，When 提交合法请求，Then 返回成功并保留审计记录。' : '【实现观察】角色、用户、范围与组件职责可由来源追溯；权限异常拒绝及业务规则需要确认。目标、环境、验证计划、部署和恢复操作均有适用边界。'}\n`).join(''),
      tests: [{ path: 'tests/service.test.ts', name: 'access scenario', status: 'defined' }], gaps: ['未执行运行验证；负责人仍需确认业务目标。'],
    }))],
  });
}
const artifact = (value, type) => value.items.find(item => item.artifact_type === type);
const rules = report => report.issues.filter(issue => issue.severity === 'blocker').map(issue => issue.rule_id);

test('heading-heavy valid input remains bounded and preserves required-section findings', { timeout: 5000 }, () => {
  const value = bundle();
  const charter = artifact(value, 'charter');
  charter.content_markdown = '# x\n'.repeat(24_000);
  assert.ok(charter.content_markdown.length <= 100_000);
  const parsed = IntakeBundleSchema.parse(value);
  const report = evaluateIntakeQuality(parsed);
  assert.equal(report.issues.filter(issue => issue.item_key === charter.key && issue.rule_id === 'section.required').length, 6);
  assert.ok(report.summary.blockers > 0);
});

test('catalog has one definition for each enterprise artifact and stable required inventory', () => {
  assert.equal(ENTERPRISE_ARTIFACTS.length, 13);
  assert.equal(new Set(ENTERPRISE_ARTIFACTS.map(item => item.type)).size, 13);
  assert.equal(ENTERPRISE_ARTIFACTS.filter(item => item.required).length, 11);
});

test('complete rule-valid dossier remains pending semantic/source/runtime review', () => {
  const report = evaluateIntakeQuality(bundle(), { batch_revision: 4, payload_hash: hash });
  assert.equal(report.summary.blockers, 0, JSON.stringify(report.issues));
  assert.equal(report.status, 'needs_review');
  assert.equal(report.summary.needs_review, 3);
  assert.deepEqual(report.artifacts, { required: 11, present: 11, missing: [], complete: true });
  assert.equal(report.batch_revision, 4);
  assert.equal(report.payload_hash, hash);
  assert.equal(report.rule_version, INTAKE_QUALITY_RULE_VERSION);
  assert.ok(report.rule_version.includes(DOCUMENT_QUALITY_RULE_VERSION));
  assert.match(report.scope_note, /不执行 Agent/);
});

test('missing and duplicate required artifacts block without inventing inventory completeness', () => {
  const value = bundle();
  value.items = value.items.filter(item => item.artifact_type !== 'charter');
  value.items.push({ ...artifact(value, 'architecture'), key: 'duplicate-architecture' });
  const report = evaluateIntakeQuality(value);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.artifacts.missing, ['charter']);
  assert.equal(report.artifacts.present, 9);
  assert.equal(report.artifacts.complete, false);
  assert.ok(rules(report).includes('artifact.required'));
  assert.ok(rules(report).includes('artifact.unique'));
});

test('same evidence location is counted once even when symbol labels differ', () => {
  const value = bundle(); const item = artifact(value, 'charter');
  item.evidence = [{ ...item.evidence[0], symbol: 'A' }, { ...item.evidence[0], symbol: 'B' }];
  const issue = evaluateIntakeQuality(value).issues.find(issue => issue.rule_id === 'evidence.distinct');
  assert.equal(issue?.item_key, item.key);
  assert.equal(issue?.severity, 'blocker');
});

test('required sections need prose rather than headings, nested headings or multiline comments', () => {
  const value = bundle(); const item = artifact(value, 'charter');
  item.content_markdown = ENTERPRISE_ARTIFACTS.find(item => item.type === 'charter').sections.map(section => `## ${section}\n<!--\n伪正文\n-->\n### 子标题\n`).join('');
  const report = evaluateIntakeQuality(value);
  const issues = report.issues.filter(issue => issue.rule_id === 'section.nonempty');
  assert.equal(issues.length, 6);
  assert.ok(issues.every(issue => issue.item_key === item.key && issue.line_start > 0));
});

test('shared text evaluator catches unfinished placeholders, duplicate definitions and fences', () => {
  for (const [extra, rule] of [
    ['\n## 未决内容\nTODO\n', 'document.text.placeholders'],
    ['\n### REQ-SAME-01\n规则 A\n### REQ-SAME-01\n规则 B\n', 'document.text.requirement_ids'],
    ['\n```ts\nconst open = true;\n', 'document.text.fences'],
  ]) {
    const value = bundle(); artifact(value, 'requirements').content_markdown += extra;
    const issue = evaluateIntakeQuality(value).issues.find(issue => issue.rule_id === rule);
    assert.equal(issue?.severity, 'blocker', rule);
    assert.ok(issue.line_start > 0);
  }
});

test('a section heading quoted inside a code fence cannot satisfy required section', () => {
  const value = bundle(); const item = artifact(value, 'charter');
  item.content_markdown = item.content_markdown.replace('## 干系人', '```md\n## 干系人\n```');
  assert.ok(evaluateIntakeQuality(value).issues.some(issue => issue.rule_id === 'section.required' && issue.message.includes('干系人')));
});

test('requirements require real test references and conditional observable acceptance', () => {
  const value = bundle(); const item = artifact(value, 'requirements');
  item.tests = [];
  item.content_markdown = item.content_markdown.replace('Given 管理员已登录，When 提交合法请求，Then 返回成功并保留审计记录。', '验收内容需要由负责人确认，暂无可执行场景。');
  const result = rules(evaluateIntakeQuality(value));
  assert.ok(result.includes('requirements.test_reference'));
  assert.ok(result.includes('requirements.acceptance'));
});

test('acceptance keyword labels alone cannot satisfy a usable scenario', () => {
  const value = bundle(); const item = artifact(value, 'requirements');
  item.content_markdown = item.content_markdown.replace('Given 管理员已登录，When 提交合法请求，Then 返回成功并保留审计记录。', 'Given When Then 场景 必须');
  assert.ok(rules(evaluateIntakeQuality(value)).includes('requirements.acceptance'));
});

test('NFR can acknowledge unmeasured targets without fabricated metrics or a numeric blocker', () => {
  const value = bundle(); const item = artifact(value, 'nfr');
  item.content_markdown = ENTERPRISE_ARTIFACTS.find(item => item.type === 'nfr').sections.map(section => `## ${section}\n【待确认】目标阈值尚未确定，负责人需要确认负载与环境；验证计划为独立测试，未测量实际结果。\n`).join('');
  const report = evaluateIntakeQuality(value);
  assert.equal(report.summary.blockers, 0, JSON.stringify(report.issues));
  assert.ok(report.issues.some(issue => issue.rule_id === 'nfr.measurement_plan' && issue.severity === 'warning'));
  assert.ok(!report.issues.some(issue => issue.rule_id === 'nfr.claim_state'));
  assert.ok(report.issues.some(issue => issue.rule_id === 'review.runtime'));
});

test('heuristic content gaps produce warnings and no automatic semantic pass', () => {
  const value = bundle(); artifact(value, 'charter').content_markdown = ENTERPRISE_ARTIFACTS.find(item => item.type === 'charter').sections.map(section => `## ${section}\n本章为当前资料记录，具体业务含义需要责任方确认。\n`).join('');
  const report = evaluateIntakeQuality(value);
  assert.equal(report.summary.blockers, 0);
  assert.ok(report.issues.some(issue => issue.rule_id.startsWith('document.') && issue.severity === 'warning'));
  assert.ok(report.issues.some(issue => issue.rule_id.startsWith('review.')));
  assert.equal(report.status, 'needs_review');
});

test('source exclusions and dirty limitations survive alongside blocking findings', () => {
  const value = bundle(); value.source.complete = false; value.source.dirty = true; value.items = [value.items[0]];
  const report = evaluateIntakeQuality(value);
  assert.ok(report.summary.blockers > 0);
  assert.equal(report.summary.warnings, 2);
  assert.ok(report.issues.some(issue => issue.message.includes('source.complete=false')));
  assert.ok(report.issues.some(issue => issue.message.includes('source.dirty=true')));
});

test('pilot compatibility does not enforce enterprise dossiers and remains explicit about source scope', () => {
  const value = bundle(); value.profile = 'pilot'; value.items = [value.items[0]]; value.source.complete = false;
  const report = evaluateIntakeQuality(value);
  assert.equal(report.summary.blockers, 0);
  assert.equal(report.summary.warnings, 1);
  assert.equal(report.profile, 'pilot');
  assert.equal(report.artifacts.complete, false);
});
