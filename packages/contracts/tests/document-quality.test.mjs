import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DOCUMENT_QUALITY_PURPOSES,
  DOCUMENT_QUALITY_RULE_VERSION,
  evaluateDocumentQuality,
  inferDocumentQualityPurpose,
} from '../dist/index.js';

function input(overrides = {}) {
  return {
    title: '领取任务需求规格',
    content: '# 任务领取\n\n角色为任务负责人。前置条件为已分派任务。\n## 规则\n仅允许负责人领取；无权限时拒绝。\n## 验收\n验收预期结果：负责人领取成功，其他用户收到拒绝。',
    purpose: 'requirements',
    source_kind: 'requirement_document',
    revision: 3,
    document_code: '00000000000000000001',
    content_sha256: 'a'.repeat(64),
    checked_at: '2026-10-21T03:00:00.000Z',
    ...overrides,
  };
}

function check(report, id) {
  const value = report.checks.find(item => item.id === id);
  assert.ok(value, `missing check ${id}`);
  return value;
}

test('enterprise artifact titles retain their intended purposes when stored as requirement documents', () => {
  for (const [title, purpose] of [
    ['系统上下文与角色', 'overview'], ['项目章程与业务背景', 'overview'],
    ['领域模型与术语', 'reference'], ['风险与缺口登记', 'reference'],
    ['开发与接入指南', 'operations'], ['功能需求规格', 'requirements'],
  ]) assert.equal(inferDocumentQualityPurpose({title, source_kind:'requirement'}), purpose);
});

test('usable requirements pass text checks while semantic and actual implementation stay unverified', () => {
  const report = evaluateDocumentQuality(input());
  assert.equal(report.summary.failed, 0);
  assert.equal(report.status, 'needs_review');
  assert.equal(check(report, 'review.intent').status, 'needs_review');
  assert.equal(check(report, 'review.evidence').status, 'needs_review');
  assert.match(check(report, 'review.intent').suggestion, /不强制要求代码证据/);
  assert.equal(report.document_code, input().document_code);
  assert.equal(report.revision, 3);
  assert.equal(report.content_sha256, 'a'.repeat(64));
  assert.equal(report.checked_at, input().checked_at);
  assert.equal(report.rule_version, DOCUMENT_QUALITY_RULE_VERSION);
  assert.equal(report.purpose_source, 'inferred');
  assert.match(report.scope_note, /不是综合评分/);
  assert.equal('score' in report, false);
});

test('template placeholders cannot obtain a clean text report just by supplying headings', () => {
  const report = evaluateDocumentQuality(input({ content: '# 功能需求\n\n## 用户与范围\n{{roles}}\n## 前置规则\n待补充\n## 权限异常\n[填写失败行为]\n## 验收\nTODO' }));
  assert.equal(report.status, 'needs_changes');
  assert.equal(check(report, 'text.placeholders').status, 'failed');
  assert.equal(check(report, 'text.placeholders').line_start, 4);
  assert.ok(report.summary.blockers >= 1);
});

test('empty body and title produce explicit blockers independent of document purpose', () => {
  const report = evaluateDocumentQuality(input({ title: '  ', content: ' \n ', purpose: 'reference' }));
  assert.equal(check(report, 'text.title').status, 'failed');
  assert.equal(check(report, 'text.body').status, 'failed');
  assert.ok(report.summary.blockers >= 2);
});

test('parent headings containing children are not empty leaves and fenced example headings are ignored', () => {
  const report = evaluateDocumentQuality(input({
    purpose: 'reference',
    content: '# 背景\n## 来源\n日期：2026-10-21\n\n```markdown\n## Example\nTODO\n```\n## 用途\n范围为内部调研。',
  }));
  assert.equal(check(report, 'text.empty_sections').status, 'passed');
  assert.equal(check(report, 'text.placeholders').status, 'passed');
  assert.equal(check(report, 'text.fences').status, 'passed');
});

test('an empty last-level section is located without counting a nonempty sibling', () => {
  const report = evaluateDocumentQuality(input({ content: '# 文档\n## 用户\n负责人。\n## 验收\n<!-- internal comment -->\n---\n## 规则\n任务负责人有权限领取。' }));
  assert.equal(check(report, 'text.empty_sections').status, 'failed');
  assert.equal(check(report, 'text.empty_sections').line_start, 4);
});

test('fences require the same marker, adequate length, and no closing info string', () => {
  for (const ending of ['~~~', '```', '```` javascript']) {
    const report = evaluateDocumentQuality(input({ content: '# Examples\n\n````ts\nconst a = 1;\n' + ending }));
    assert.equal(check(report, 'text.fences').status, 'failed', ending);
    assert.equal(check(report, 'text.fences').line_start, 3);
  }
  const closed = evaluateDocumentQuality(input({ content: '# Examples\n\n~~~~ts\n~~~\n```\n~~~~~\n' }));
  assert.equal(check(closed, 'text.fences').status, 'passed');
});

test('repeated ID references and traceability cells do not become duplicate definitions', () => {
  const report = evaluateDocumentQuality(input({ content: `${input().content}\n\n## FR-001 领取规则\n负责人领取已分派任务。\n参见 FR-001。验收 FR-001。\n\n| 需求 | 测试 |\n| --- | --- |\n| FR-001 | TC-001 |\n| FR-001 | TC-002 |` }));
  assert.equal(check(report, 'text.requirement_ids').status, 'passed');
});

test('duplicate requirement definitions identify the second definition rather than an inline mention', () => {
  const report = evaluateDocumentQuality(input({ content: '# FR-001 领取\n角色负责人按规则领取。\n参见 FR-001。\n## FR-001 拒绝\n其他用户无权限，验收应拒绝。' }));
  const duplicate = check(report, 'text.requirement_ids');
  assert.equal(duplicate.status, 'failed');
  assert.equal(duplicate.severity, 'blocker');
  assert.equal(duplicate.line_start, 4);
  assert.match(duplicate.message, /第 1 行/);
});

test('business intent requires no code or implementation evidence to pass structural checks', () => {
  const report = evaluateDocumentQuality(input({ content: '# 试用需求\n\n角色：业务负责人。规则：试用用户可以申请延长试用，拒绝条件为权限不足。\n验收预期结果：符合条件的用户得到成功确认。' }));
  assert.equal(report.summary.failed, 0);
  assert.equal(check(report, 'review.evidence').status, 'needs_review');
  assert.equal(report.checks.some(item => item.status === 'failed' && /代码|code/.test(item.title)), false);
});

test('a reference note is checked against its purpose, without requirement IDs or dossier chapters', () => {
  const report = evaluateDocumentQuality(input({ purpose: 'reference', content: '会议记录来源：产品访谈，日期 2026-10-21。背景：了解当前交接流程。' }));
  assert.equal(report.summary.failed, 0);
  assert.equal(check(report, 'text.requirement_ids').status, 'not_applicable');
  assert.equal(check(report, 'review.evidence').status, 'not_applicable');
  assert.equal(report.checks.some(item => item.id === 'requirements.acceptance'), false);
});

test('manual checks remain outside the checked denominator and not-applicable checks outside applicable', () => {
  const report = evaluateDocumentQuality(input({ purpose: 'reference', content: '来源：用户访谈。范围为需求发现。' }));
  const { applicable, checked, passed, failed, needs_review, not_applicable } = report.summary;
  assert.equal(checked, passed + failed);
  assert.equal(applicable, checked + needs_review);
  assert.equal(applicable + not_applicable, report.checks.length);
  assert.ok(needs_review >= 2);
  assert.ok(checked < applicable);
});

test('purpose selection changes only the check profile and is reflected in report binding', () => {
  const selected = evaluateDocumentQuality(input({ purpose: 'operations', purpose_source: 'selected' }));
  assert.equal(selected.purpose, 'operations');
  assert.equal(selected.purpose_source, 'selected');
  assert.equal(selected.document_code, input().document_code);
  assert.equal(check(selected, 'operations.recovery').status, 'failed');
  assert.equal(selected.checks.some(item => item.id === 'requirements.acceptance'), false);
});

test('architecture diagram source can provide structural cues without claiming rendered graph validation', () => {
  const report = evaluateDocumentQuality(input({ purpose: 'architecture', content: '', diagram_source: 'flowchart LR\n  component[组件职责与边界]\n  component --> deployment[部署失败恢复]\n  decision[约束与取舍]' }));
  assert.equal(check(report, 'text.body').status, 'passed');
  assert.equal(check(report, 'architecture.structure').status, 'passed');
  assert.equal(check(report, 'architecture.behavior').status, 'passed');
  assert.equal(check(report, 'review.evidence').status, 'needs_review');
  assert.match(report.scope_note, /未渲染/);
});

test('purpose inference uses specific title topics before a generic source kind', () => {
  assert.equal(inferDocumentQualityPurpose({ title: 'API 与数据契约', source_kind: 'requirement_document' }), 'api');
  assert.equal(inferDocumentQualityPurpose({ title: '非功能需求', source_kind: 'requirement_document' }), 'nonfunctional');
  assert.equal(inferDocumentQualityPurpose({ title: '测试追溯矩阵', source_kind: 'project_document' }), 'testing');
  assert.equal(inferDocumentQualityPurpose({ title: '安全设计', source_kind: 'architecture_document' }), 'security');
  assert.equal(inferDocumentQualityPurpose({ title: '组件关系', source_kind: 'architecture' }), 'architecture');
  assert.equal(inferDocumentQualityPurpose({ title: '会议纪要', source_kind: 'project_document' }), 'reference');
});

test('overview recognizes natural Chinese descriptions of people and implemented scope', () => {
  for (const people of ['面向多人协作开发项目。', '项目成员可以共同完成开发任务。', '团队通过平台交接资料。', '维护者负责处理项目运行问题。']) {
    const report = evaluateDocumentQuality(input({ purpose: 'overview', content: `项目目标是支持协作交付。\n${people}\n已实现任务领取与执行证据提交，尚未完成外部系统集成。` }));
    assert.equal(check(report, 'overview.people').status, 'passed', people);
    assert.equal(check(report, 'overview.capabilities').status, 'passed');
    assert.equal(report.summary.failed, 0);
    assert.equal(report.status, 'needs_review');
  }
  for (const capabilities of ['已实现任务领取与执行。', '尚未完成组织管理。', '平台形成从任务到验证的闭环。', '边界限定为本地协作开发。', '不追求替代现有代码托管工具。']) {
    const report = evaluateDocumentQuality(input({ purpose: 'overview', content: `目标是支持协作交付。团队通过平台完成交接。\n${capabilities}` }));
    assert.equal(check(report, 'overview.capabilities').status, 'passed', capabilities);
    assert.equal(check(report, 'review.intent').status, 'needs_review');
  }
});

test('overview topic headings and bare keyword lists are not substantive descriptions', () => {
  for (const content of ['# 目标\n## 团队\n## 已实现\n', '目标 范围\n成员 团队 维护者\n已实现 尚未完成 闭环 边界 不追求']) {
    const report = evaluateDocumentQuality(input({ purpose: 'overview', content }));
    assert.equal(check(report, 'overview.purpose').status, 'failed');
    assert.equal(check(report, 'overview.people').status, 'failed');
    assert.equal(check(report, 'overview.capabilities').status, 'failed');
    assert.equal(report.status, 'needs_changes');
  }
});

test('every purpose has a bounded explicit profile and standards references without certification claims', () => {
  for (const purpose of DOCUMENT_QUALITY_PURPOSES) {
    const report = evaluateDocumentQuality(input({ purpose }));
    assert.ok(report.checks.length >= 10 && report.checks.length <= 13, purpose);
    assert.equal(new Set(report.checks.map(item => item.id)).size, report.checks.length, purpose);
    assert.ok(report.checks.filter(item => item.category.startsWith('用途检查')).length >= 2);
    for (const standard of report.standards) {
      assert.match(standard.url, /^https:\/\/(www\.iso\.org|owasp\.org)\//);
      assert.match(standard.note, /不证明标准符合性/);
    }
  }
});

test('same inputs produce exactly the same report without clocks, randomness, or mutation', () => {
  const value = input();
  const before = structuredClone(value);
  assert.deepEqual(evaluateDocumentQuality(value), evaluateDocumentQuality(value));
  assert.deepEqual(value, before);
});
