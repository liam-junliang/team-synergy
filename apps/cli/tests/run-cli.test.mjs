import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import {
  createHttpTestContext,
  insertMember,
  insertProject,
  insertTeam,
  insertUser,
  testCode,
} from './http-test-helpers.mjs';

async function seedAssignedRunTask(db, taskCode = testCode(210), status = 'assigned') {
  const team = await insertTeam(db, { code: testCode(200) });
  const owner = await insertUser(db, { code: testCode(201), legacyCode: 'owner', account: 'owner', displayName: 'o' });
  const builder = await insertUser(db, { code: testCode(202), legacyCode: 'builder', account: 'builder', displayName: 'b' });
  const project = await insertProject(db, { code: testCode(203), legacyCode: 'PROJECT-RUN', teamId: team.id });
  await insertMember(db, { principalId: owner.id, projectId: project.id, role: 'owner', displayName: 'o' });
  await insertMember(db, { principalId: builder.id, projectId: project.id, role: 'member', displayName: 'b' });

  const [overview] = await db.insert(schema.projectDocuments).values({
    code: testCode(204),
    project_id: project.id,
    title: 'Run 项目文档',
    content: '# 运行上下文\n\n执行器可以通过环境变量读取本文件。',
    revision: 1,
    created_by: owner.id,
    created_at: 't0',
    updated_by: owner.id,
    updated_at: 't0',
  }).returning();
  await db.update(schema.projects).set({ overview_document_id: overview.id }).where(eq(schema.projects.id, project.id));

  const [feature] = await db.insert(schema.features).values({
    code: testCode(205),
    legacy_code: 'FEATURE-1',
    project_id: project.id,
    title: 'f',
    status: 'active',
  }).returning();

  const [document] = await db.insert(schema.requirementDocuments).values({
    code: testCode(206),
    legacy_code: 'RDOC-RUN',
    project_id: project.id,
    module_key: 'RUN',
    title: '执行器需求',
    current_revision: 1,
    state: 'active',
    owner_principal_id: owner.id,
    created_at: 't0',
    updated_at: 't0',
  }).returning();

  await db.insert(schema.requirementDocumentRevisions).values({
    code: testCode(207),
    document_id: document.id,
    revision: 1,
    summary: '执行器所需需求上下文',
    content: '# 执行器需求\n\n读取任务关联的完整需求正文。',
    keywords: JSON.stringify(['执行器', '上下文']),
    change_summary: 'initial',
    created_by: owner.id,
    created_at: 't0',
  });

  const [requirement] = await db.insert(schema.requirements).values({
    code: testCode(208),
    legacy_code: 'REQ-RUN',
    feature_id: feature.id,
    document_id: document.id,
    title: '注入需求上下文',
    current_revision: 1,
    state: 'confirmed',
    owner_principal_id: owner.id,
  }).returning();

  await db.insert(schema.requirementRevisions).values({
    code: testCode(209),
    requirement_id: requirement.id,
    revision: 1,
    summary: '注入需求上下文',
    acceptance_criteria: JSON.stringify([{ id: 'AC-REQ-1', text: '执行器可读取需求文档' }]),
    open_questions: JSON.stringify([]),
    created_at: 't0',
  });

  const [task] = await db.insert(schema.tasks).values({
    code: taskCode,
    legacy_code: status === 'draft' ? 'TASK-DRAFT' : 'TASK-RUN',
    feature_id: feature.id,
    title: 'run loop',
    profile: 'builder',
    source: 'requirement',
    requirement_id: requirement.id,
    status,
    assignee_principal_id: status === 'assigned' ? builder.id : null,
    acceptance: JSON.stringify([{ id: 'AC-1', text: '执行循环' }]),
    base_snapshot: status === 'assigned' ? 1 : 0,
    created_at: 't0',
  }).returning();

  return { owner, builder, project, task };
}

test('run：claim → 执行命令 → 收尾检查全部经 HTTP', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const fixture = await seedAssignedRunTask(ctx.db, testCode(210));
  const repoDir = ctx.makeRepo();
  try {
    const command = `node -e "const fs=require('node:fs');fs.copyFileSync(process.env.ACP_PROJECT_DOCUMENT_PATH,'seen-project-document.md');fs.copyFileSync(process.env.ACP_REQUIREMENTS_INDEX_PATH,'seen-requirements-index.md');fs.copyFileSync(process.env.ACP_REQUIREMENT_DOCUMENT_PATH,'seen-requirement-document.md');fs.writeFileSync('executed.txt','executed')"`;
    const result = await ctx.runCli(
      ['task', 'run', fixture.task.code, '--profile', 'builder', '--repo', repoDir, '--command', command],
      { ACP_PRINCIPAL_CODE: fixture.builder.code },
    );
    assert.equal(result.status, 0, `${result.out}\n${result.err}`);
    const envelope = JSON.parse(result.out);
    assert.equal(envelope.ok, true, result.out);
    assert.match(envelope.data.run_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.ok(existsSync(path.join(envelope.data.workspace_root, 'repo', 'executed.txt')));
    assert.equal(envelope.data.project_code, fixture.project.code);
    assert.ok(existsSync(envelope.data.project_document));
    assert.ok(existsSync(envelope.data.handoff_index));
    assert.equal(envelope.data.handoff_documents.length, 1);
    assert.match(readFileSync(envelope.data.handoff_documents[0], 'utf8'), /运行上下文/);
    assert.match(readFileSync(path.join(envelope.data.workspace_root, 'repo', 'seen-project-document.md'), 'utf8'), /执行器可以通过环境变量读取/);
    assert.match(readFileSync(path.join(envelope.data.workspace_root, 'repo', 'seen-requirements-index.md'), 'utf8'), /执行器需求/);
    assert.match(readFileSync(path.join(envelope.data.workspace_root, 'repo', 'seen-requirement-document.md'), 'utf8'), /读取任务关联的完整需求正文/);
    assert.ok(envelope.data.wrap_up.dirty_files.some((item) => item.includes('executed.txt')));
    assert.ok(envelope.data.wrap_up.next[0].includes(`tsp task submit ${fixture.task.code}`));
    assert.ok(envelope.data.wrap_up.next[0].includes(`--run-code ${envelope.data.run_code}`));
    assert.ok(existsSync(envelope.data.brief));
    assert.match(readFileSync(envelope.data.brief, 'utf8'), /Status: `running`/);
    assert.equal(envelope.data.task_status, 'running');
  } finally {
    await ctx.cleanup();
  }
});

test('run：执行器失败返回 executor_failed，Run 工作区保留', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const fixture = await seedAssignedRunTask(ctx.db, testCode(211));
  const repoDir = ctx.makeRepo('repo-fail');
  try {
    const result = await ctx.runCli(
      ['task', 'run', fixture.task.code, '--profile', 'builder', '--repo', repoDir, '--command', 'node -e "process.exit(3)"'],
      { ACP_PRINCIPAL_CODE: fixture.builder.code },
    );
    const envelope = JSON.parse(result.out);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'executor_failed');
  } finally {
    await ctx.cleanup();
  }
});

test('run：未分派任务 claim 失败且不创建孤儿 worktree', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const fixture = await seedAssignedRunTask(ctx.db, testCode(212), 'draft');
  const repoDir = ctx.makeRepo('repo-draft');
  try {
    const result = await ctx.runCli(
      ['task', 'run', fixture.task.code, '--profile', 'builder', '--repo', repoDir, '--command', 'echo hi'],
      { ACP_PRINCIPAL_CODE: fixture.owner.code },
    );
    const envelope = JSON.parse(result.out);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, 'claim_not_assigned');
    const orphanRuns = existsSync(ctx.workspacesDir)
      ? readdirSync(ctx.workspacesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[0-9A-HJKMNP-TV-Z]{20}$/.test(entry.name)).length
      : 0;
    assert.equal(orphanRuns, 0);
  } finally {
    await ctx.cleanup();
  }
});
