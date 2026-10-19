import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { renderContextPackFromTask } from '../dist/pack.js';
import { schema } from '@team-synergy/persistence';
import {
  createHttpTestContext,
  insertMember,
  insertProject,
  insertTeam,
  insertUser,
  testCode,
} from './http-test-helpers.mjs';

async function seedTaskFixture(db) {
  const team = await insertTeam(db, { code: testCode(100) });
  const owner = await insertUser(db, {
    code: testCode(101),
    legacyCode: 'user-chen',
    account: 'user.chen',
    displayName: 'chen',
  });
  const member = await insertUser(db, {
    code: testCode(102),
    legacyCode: 'user-wang',
    account: 'user.wang',
    displayName: 'wang',
  });
  const project = await insertProject(db, {
    code: testCode(103),
    legacyCode: 'PROJECT-A',
    teamId: team.id,
  });
  await insertMember(db, { principalId: owner.id, projectId: project.id, role: 'owner', displayName: 'chen' });
  await insertMember(db, { principalId: member.id, projectId: project.id, role: 'member', displayName: 'wang' });
  const [feature] = await db.insert(schema.features).values({
    code: testCode(104),
    legacy_code: 'FEATURE-12',
    project_id: project.id,
    title: '用户登录',
    status: 'active',
  }).returning();
  const [task] = await db.insert(schema.tasks).values({
    code: testCode(105),
    legacy_code: 'TASK-301',
    feature_id: feature.id,
    title: '实现认证失败统一响应与锁定策略',
    profile: 'builder',
    source: 'requirement',
    status: 'draft',
    acceptance: JSON.stringify([{ id: 'AC-1', text: '验收标准' }]),
    base_snapshot: 0,
    created_at: 't0',
  }).returning();
  return { owner, member, project, feature, task };
}

test('Context Pack: renders the complete frozen baseline so another Agent can execute its original contract', () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'acp-baseline-pack-'));
  try {
    const baseline = { baseline_code: testCode(800), project_code: testCode(103), version: 1, name: '交接首版',
      scope: 'release/1.0', reason: '确认首版', parent_baseline_code: null, created_by: testCode(101), created_at: 't0', content_hash: 'frozen-content-hash',
      requirements: [{ requirement_code: testCode(801), revision: 1, revision_code: testCode(802), title: '最初需求', status: 'confirmed',
        feature_code: testCode(104), module_code: null, document_code: null, body: '跨人交接必须保留原始目标',
        acceptance_criteria: [{ id: 'AC-1', text: '接收人读取同一份冻结规则' }], open_questions: [] }] };
    const rendered = renderContextPackFromTask({ task_code: testCode(105), title: '继续交接任务', requirement_baseline: baseline },
      { workspaceRoot, runCode: testCode(803), principalCode: testCode(102) }, { project_code: baseline.project_code, title: '项目', content: '', revision: 1 });
    const brief = readFileSync(rendered.briefPath, 'utf8');
    assert.match(brief, /固定需求基线/);
    assert.match(brief, /frozen-content-hash/);
    const embedded = JSON.parse(brief.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.deepEqual(embedded, baseline);
    assert.equal(embedded.requirements[0].body, '跨人交接必须保留原始目标');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('CLI: task create --baseline selects a frozen revision through the API', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const [requirement] = await ctx.db.insert(schema.requirements).values({ code: testCode(810), feature_id: fixture.feature.id,
      title: '新标题', current_revision: 2, state: 'confirmed', owner_principal_id: fixture.owner.id }).returning();
    const [revision] = await ctx.db.insert(schema.requirementRevisions).values({ code: testCode(811), requirement_id: requirement.id,
      revision: 1, summary: '基线原规则', acceptance_criteria: '[{"id":"AC-1","text":"旧版本"}]', open_questions: '[]', created_at: 't0' }).returning();
    await ctx.db.insert(schema.requirementRevisions).values({ code: testCode(812), requirement_id: requirement.id,
      revision: 2, summary: '最新规则', acceptance_criteria: '[{"id":"AC-2","text":"新版本"}]', open_questions: '[]', created_at: 't1' });
    const token = 'task-baseline-owner-device';
    await ctx.db.insert(schema.devices).values({ code: testCode(813), principal_id: fixture.owner.id,
      device_name: 'baseline-cli-test', credential_hash: createHash('sha256').update(token).digest('hex'), created_at: 't0' });
    const response = await fetch(`${ctx.apiUrl}/projects/${fixture.project.code}/requirement-baselines`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '首版', scope: 'release/1.0', reason: '首版冻结',
        requirements: [{ requirement_code: requirement.code, revision: 1 }] }),
    });
    const frozen = await response.json();
    assert.equal(frozen.ok, true, JSON.stringify(frozen));
    const [baseline] = await ctx.db.select().from(schema.requirementBaselines).where(eq(schema.requirementBaselines.code, frozen.data.baseline_code));
    const result = await ctx.runCli(['task', 'create', '--feature', fixture.feature.code, '--title', '按首版实现', '--profile', 'builder',
      '--source', 'requirement', '--requirement', requirement.code, '--baseline', baseline.code, '--acceptance', '[{"id":"AC-1","text":"完成"}]'],
    { ACP_TOKEN: token, ACP_PRINCIPAL_CODE: '' });
    assert.equal(result.status, 0, result.out || result.err);
    const created = JSON.parse(result.out);
    assert.equal(created.ok, true, result.out);
    const [stored] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.code, created.data.task_code));
    assert.equal(stored.requirement_baseline_id, baseline.id);
    assert.equal(stored.source_requirement_revision_id, revision.id);
  } finally { await ctx.cleanup(); }
});

test('CLI：task list 缺少 API 配置时返回结构化 api_required', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const res = await ctx.runCli(['task', 'list', '--assigned-to', 'me'], { ACP_API_URL: '', ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'api_required');
  } finally {
    await ctx.cleanup();
  }
});

test('CLI：非法参数输出 JSON envelope（机器模式全覆盖）', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const res = await ctx.runCli(['task', 'list', '--status', 'NOT_A_STATUS'], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'invalid_status');
  } finally {
    await ctx.cleanup();
  }
});

test('CLI：task assign 成功（draft → assigned，快照推进）', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const res = await ctx.runCli(['task', 'assign', fixture.task.code, '--assignee', fixture.owner.code], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.status, 'assigned');
    assert.equal(parsed.data.base_snapshot, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('CLI：非 Owner assign 被拒绝 exit 1 + 结构化 error', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const res = await ctx.runCli(['task', 'assign', fixture.task.code, '--assignee', fixture.member.code], { ACP_PRINCIPAL_CODE: fixture.member.code });
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'assign_forbidden');
  } finally {
    await ctx.cleanup();
  }
});

test('CLI：assign → claim（真实 worktree）→ submit 全链路', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const repo = ctx.makeRepo('task-cli-repo');

    const assign = await ctx.runCli(['task', 'assign', fixture.task.code, '--assignee', fixture.owner.code], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(assign.status, 0, assign.out);

    const claim = await ctx.runCli(['task', 'claim', fixture.task.code, '--profile', 'builder', '--repo', repo], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(claim.status, 0, claim.out);
    const claimed = JSON.parse(claim.out);
    assert.equal(claimed.ok, true, claim.out);
    assert.equal(claimed.data.status, 'running');
    assert.match(claimed.data.run_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.ok(existsSync(path.join(ctx.workspacesDir, claimed.data.run_code, '.agent', 'workspace.yaml')));

    const submit = await ctx.runCli(
      [
        'task', 'submit', fixture.task.code,
        '--run-code', claimed.data.run_code,
        '--artifact-kind', 'commit',
        '--artifact-uri', 'git:a92f81c',
        '--artifact-hash', 'h1',
        '--evidence-type', 'self_test',
        '--evidence-result', 'pass',
        '--acceptance-refs', 'AC-1',
        '--evidence-command', 'pnpm test',
      ],
      { ACP_PRINCIPAL_CODE: fixture.owner.code },
    );
    assert.equal(submit.status, 0, submit.out);
    const submitted = JSON.parse(submit.out);
    assert.equal(submitted.ok, true, submit.out);
    assert.equal(submitted.data.status, 'submitted');

    const status = await ctx.runCli(['task', 'status', fixture.task.code], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    const statusData = JSON.parse(status.out).data;
    assert.equal(statusData.status, 'submitted');
    assert.equal(statusData.artifact_count, 1);
    assert.equal(statusData.evidence_count, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('CLI：submit 冒用他人 Run 被拒绝', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedTaskFixture(ctx.db);
    const repo = ctx.makeRepo('task-cli-hijack-repo');

    const assign = await ctx.runCli(['task', 'assign', fixture.task.code, '--assignee', fixture.owner.code], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    assert.equal(assign.status, 0);
    const claim = await ctx.runCli(['task', 'claim', fixture.task.code, '--profile', 'builder', '--repo', repo], { ACP_PRINCIPAL_CODE: fixture.owner.code });
    const claimed = JSON.parse(claim.out);
    assert.equal(claimed.ok, true);

    const submit = await ctx.runCli(
      [
        'task', 'submit', fixture.task.code,
        '--run-code', claimed.data.run_code,
        '--artifact-kind', 'commit',
        '--artifact-uri', 'x',
        '--artifact-hash', 'h',
        '--evidence-type', 'self_test',
        '--evidence-result', 'pass',
        '--acceptance-refs', 'AC-1',
      ],
      { ACP_PRINCIPAL_CODE: fixture.member.code },
    );
    assert.equal(submit.status, 1);
    const parsed = JSON.parse(submit.out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'submit_identity_mismatch');
  } finally {
    await ctx.cleanup();
  }
});
