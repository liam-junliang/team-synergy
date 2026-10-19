import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

async function seedProjectMembers(db) {
  const team = await insertTeam(db, { code: testCode(400) });
  const chen = await insertUser(db, {
    code: testCode(401),
    legacyCode: 'user-chen',
    account: 'chen',
    displayName: 'chen',
  });
  const wang = await insertUser(db, {
    code: testCode(402),
    legacyCode: 'user-wang',
    account: 'wang',
    displayName: 'wang',
  });
  const project = await insertProject(db, { code: testCode(403), legacyCode: 'PROJECT-A', teamId: team.id });
  await insertMember(db, { principalId: chen.id, projectId: project.id, role: 'owner', displayName: 'chen' });
  await insertMember(db, { principalId: wang.id, projectId: project.id, role: 'member', displayName: 'wang' });
  const [overview] = await db.insert(schema.projectDocuments).values({
    code: testCode(404),
    project_id: project.id,
    title: 'ACP 项目文档',
    content: '# 项目原则\n\nCLI 执行任务前必须读取这段完整项目上下文。',
    revision: 3,
    created_by: chen.id,
    created_at: 't0',
    updated_by: chen.id,
    updated_at: 't0',
  }).returning();
  await db.update(schema.projects).set({ overview_document_id: overview.id }).where(eq(schema.projects.id, project.id));
  return { chen, wang, project, overview };
}

test('CLI 全链路：feature → task → assign → claim → submit → verify → close → history', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const fixture = await seedProjectMembers(ctx.db);
    const repoDir = ctx.makeRepo('full-loop-repo');

    const envChen = { ACP_PRINCIPAL_CODE: fixture.chen.code };
    const envWang = { ACP_PRINCIPAL_CODE: fixture.wang.code };

    const moduleResult = await ctx.runCli([
      'module', 'create', '--project', fixture.project.code, '--name', '交付',
    ], envChen);
    assert.equal(moduleResult.status, 0, moduleResult.out);
    const moduleCode = JSON.parse(moduleResult.out).data.module_code;

    const phaseResult = await ctx.runCli([
      'phase', 'create', '--project', fixture.project.code, '--name', 'MVP',
      '--start-date', '2026-08-01', '--end-date', '2026-09-30',
    ], envChen);
    assert.equal(phaseResult.status, 0, phaseResult.out);
    const phaseData = JSON.parse(phaseResult.out).data;
    assert.equal(phaseData.start_date, '2026-08-01');
    assert.equal(phaseData.end_date, '2026-09-30');

    const milestoneResult = await ctx.runCli([
      'milestone', 'create', '--project', fixture.project.code, '--phase', phaseData.phase_code,
      '--name', '协作闭环可用', '--start-date', '2026-08-10', '--target-date', '2026-08-31',
    ], envChen);
    assert.equal(milestoneResult.status, 0, milestoneResult.out);
    const milestoneData = JSON.parse(milestoneResult.out).data;
    assert.equal(milestoneData.start_date, '2026-08-10');
    assert.equal(milestoneData.target_date, '2026-08-31');

    const feature = await ctx.runCli([
      'feature', 'create', '--project', fixture.project.code, '--module', moduleCode,
      '--milestone', milestoneData.milestone_code, '--start-date', '2026-08-12',
      '--end-date', '2026-08-24', '--title', '任务闭环骨架',
    ], envChen);
    assert.equal(feature.status, 0, feature.out);
    assert.equal(JSON.parse(feature.out).ok, true);
    assert.equal(JSON.parse(feature.out).data.start_date, '2026-08-12');
    assert.equal(JSON.parse(feature.out).data.end_date, '2026-08-24');
    const featureCode = JSON.parse(feature.out).data.feature_code;

    const requirementDocumentFile = path.join(ctx.tmp, 'delivery-requirements.md');
    writeFileSync(requirementDocumentFile, '# 交付模块需求\n\n## 目标\n\nAgent 执行任务前必须读取关联需求文档。\n\n## 验收策略\n\n保留可追溯索引。\n', 'utf8');
    const createdDocument = await ctx.runCli([
      'requirement-doc', 'create', '--project', fixture.project.code, '--module', moduleCode,
      '--title', '交付模块需求', '--summary', '定义交付任务上下文', '--keywords', 'agent,交付', '--file', requirementDocumentFile,
    ], envChen);
    assert.equal(createdDocument.status, 0, createdDocument.out);
    const documentCode = JSON.parse(createdDocument.out).data.document_code;

    const searchedDocument = await ctx.runCli(['requirement-doc', 'search', 'Agent', '--project', fixture.project.code], envChen);
    assert.equal(JSON.parse(searchedDocument.out).data[0].document_code, documentCode);
    const shownDocument = await ctx.runCli(['requirement-doc', 'show', documentCode], envChen);
    assert.match(JSON.parse(shownDocument.out).data.content, /执行任务前必须读取/);

    const createdRequirement = await ctx.runCli([
      'requirement', 'create', '--feature', featureCode, '--document', documentCode,
      '--title', '任务启动时注入需求上下文', '--body', '任务执行器可以快速查阅需求索引与关联文档。',
    ], envChen);
    assert.equal(JSON.parse(createdRequirement.out).ok, true, createdRequirement.out);
    const requirementCode = JSON.parse(createdRequirement.out).data.requirement_code;

    const acceptance = JSON.stringify([{ id: 'AC-1', text: 'CLI 全链路可跑通' }, { id: 'AC-2', text: 'brief.md 已渲染' }]);
    const createdTask = await ctx.runCli(['task', 'create', '--feature', featureCode, '--requirement', requirementCode, '--title', '跑通闭环', '--profile', 'builder', '--source', 'requirement', '--acceptance', acceptance], envChen);
    assert.equal(createdTask.status, 0, createdTask.out);
    assert.equal(JSON.parse(createdTask.out).ok, true, createdTask.out);
    const taskCode = JSON.parse(createdTask.out).data.task_code;

    const forbiddenTask = await ctx.runCli(['task', 'create', '--feature', featureCode, '--title', 'x', '--profile', 'builder', '--source', 'requirement', '--acceptance', acceptance], envWang);
    assert.equal(JSON.parse(forbiddenTask.out).ok, false);
    assert.equal(JSON.parse(forbiddenTask.out).error.code, 'create_task_forbidden');

    const adHocTask = await ctx.runCli(['task', 'create', '--feature', featureCode, '--title', '临时任务', '--profile', 'builder', '--source', 'ad-hoc', '--acceptance', acceptance], envWang);
    assert.equal(JSON.parse(adHocTask.out).ok, true, adHocTask.out);

    const assign = await ctx.runCli(['task', 'assign', taskCode, '--assignee', fixture.wang.code], envChen);
    assert.equal(JSON.parse(assign.out).ok, true, assign.out);

    const claim = await ctx.runCli(['task', 'claim', taskCode, '--profile', 'builder', '--repo', repoDir], envWang);
    const claimed = JSON.parse(claim.out);
    assert.equal(claimed.ok, true, claim.out);
    const workspaceRoot = path.join(ctx.workspacesDir, claimed.data.run_code);
    assert.ok(existsSync(path.join(workspaceRoot, 'repo', 'README.md')));
    const brief = readFileSync(path.join(workspaceRoot, '.agent', 'project-state', 'brief.md'), 'utf8');
    assert.ok(brief.includes(taskCode));
    assert.ok(brief.includes('AC-1'));
    assert.ok(brief.includes(fixture.wang.code));
    assert.match(brief, /项目必读资料/);
    assert.match(brief, /执行前阅读以下已绑定资料/);
    const overviewLink = brief.match(/项目说明：\[ACP 项目文档\]\(([^)]+)\).*Revision 3/);
    assert.ok(overviewLink, 'Brief must identify the bound overview document and its exact revision');
    assert.equal(path.resolve(path.dirname(claimed.data.pack), overviewLink[1]), claimed.data.project_document);
    assert.ok(brief.includes('交付模块需求'));
    assert.equal(claimed.data.project_code, fixture.project.code);
    assert.ok(existsSync(claimed.data.project_document));
    const overviewContent = readFileSync(claimed.data.project_document, 'utf8');
    assert.match(overviewContent, /CLI 执行任务前必须读取这段完整项目上下文/);
    assert.match(overviewContent, new RegExp(`Document Code: ${fixture.overview.code} .* Revision: 3`));
    assert.ok(existsSync(claimed.data.handoff_index));
    assert.equal(claimed.data.handoff_documents.length, 1);
    assert.match(readFileSync(claimed.data.handoff_documents[0], 'utf8'), /完整项目上下文/);
    assert.ok(existsSync(claimed.data.requirements_index));
    const requirementIndex = readFileSync(claimed.data.requirements_index, 'utf8');
    assert.match(requirementIndex, new RegExp(documentCode));
    assert.match(requirementIndex, /交付模块需求/);
    assert.ok(existsSync(claimed.data.requirement_document));
    assert.match(readFileSync(claimed.data.requirement_document, 'utf8'), /Agent 执行任务前必须读取关联需求文档/);
    const workspaceMeta = readFileSync(path.join(workspaceRoot, '.agent', 'workspace.yaml'), 'utf8');
    assert.match(workspaceMeta, new RegExp(`project_code: ${fixture.project.code}`));

    const submit = await ctx.runCli([
      'task', 'submit', taskCode,
      '--run-code', claimed.data.run_code,
      '--artifact-kind', 'commit',
      '--artifact-uri', 'git:HEAD',
      '--artifact-hash', 'abc',
      '--evidence-type', 'self_test',
      '--evidence-result', 'pass',
      '--acceptance-refs', 'AC-1,AC-2',
      '--evidence-command', 'node --test',
    ], envWang);
    assert.equal(JSON.parse(submit.out).ok, true, submit.out);

    const verifierClaim = await ctx.runCli(['task', 'claim', taskCode, '--profile', 'verifier', '--repo', repoDir], envWang);
    const claimV = JSON.parse(verifierClaim.out);
    assert.equal(claimV.ok, true, verifierClaim.out);
    assert.equal(claimV.data.status, 'submitted');

    const verify = await ctx.runCli(['task', 'verify', taskCode, '--run-code', claimV.data.run_code, '--evidence-result', 'pass', '--acceptance-refs', 'AC-1,AC-2', '--evidence-summary', '独立复核通过'], envWang);
    assert.equal(JSON.parse(verify.out).ok, true, verify.out);

    const builderVerify = await ctx.runCli(['task', 'verify', taskCode, '--run-code', claimed.data.run_code, '--evidence-result', 'pass', '--acceptance-refs', 'AC-1,AC-2'], envWang);
    assert.equal(JSON.parse(builderVerify.out).error.code, 'verify_profile_forbidden');

    const close = await ctx.runCli(['task', 'close', taskCode], envChen);
    assert.equal(JSON.parse(close.out).ok, true, close.out);

    const history = await ctx.runCli(['task', 'history', taskCode], envChen);
    const actions = JSON.parse(history.out).data.map((event) => event.action);
    for (const expected of ['task.created', 'task.assigned', 'task.claimed', 'task.self_tested', 'task.submitted', 'task.verification_claimed', 'task.verified', 'task.closed']) {
      assert.ok(actions.includes(expected), `history 应含 ${expected}，实际 ${actions.join(',')}`);
    }

    const projectMembers = await ctx.runCli(['project', 'members', fixture.project.code], envChen);
    assert.ok(JSON.parse(projectMembers.out).data.some((member) => member.user_code === fixture.wang.code));
    const whoami = await ctx.runCli(['whoami'], envWang);
    assert.equal(JSON.parse(whoami.out).data.principal_code, fixture.wang.code);
  } finally {
    await ctx.cleanup();
  }
});
