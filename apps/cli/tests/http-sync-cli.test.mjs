import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('HTTP 同步模式：agentctl 经 core-api 完成状态同步与 requirement 操作', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const repoDir = ctx.makeRepo('http-sync-repo');
    const team = await insertTeam(ctx.db, { code: testCode(500) });
    const owner = await insertUser(ctx.db, { code: testCode(501), legacyCode: 'owner', account: 'owner', displayName: 'o' });
    const builder = await insertUser(ctx.db, { code: testCode(502), legacyCode: 'builder', account: 'builder', displayName: 'b' });
    const project = await insertProject(ctx.db, { code: testCode(503), legacyCode: 'PROJECT-A', teamId: team.id });
    await insertMember(ctx.db, { principalId: owner.id, projectId: project.id, role: 'owner', displayName: 'o' });
    await insertMember(ctx.db, { principalId: builder.id, projectId: project.id, role: 'member', displayName: 'b' });
    const [feature] = await ctx.db.insert(schema.features).values({
      code: testCode(504),
      legacy_code: 'FEATURE-1',
      project_id: project.id,
      title: 'f',
      status: 'active',
    }).returning();
    const [task] = await ctx.db.insert(schema.tasks).values({
      code: testCode(505),
      legacy_code: 'TASK-HTTP',
      feature_id: feature.id,
      title: 'http sync',
      profile: 'builder',
      source: 'requirement',
      status: 'assigned',
      assignee_principal_id: builder.id,
      acceptance: JSON.stringify([{ id: 'AC-1', text: '同步' }]),
      base_snapshot: 1,
      created_at: 't0',
    }).returning();
    const [externalTask] = await ctx.db.insert(schema.tasks).values({
      code: testCode(506),
      legacy_code: 'TASK-EXTERNAL',
      feature_id: feature.id,
      title: 'external agent',
      brief: '目标：验证外部 Agent 绑定。\n\n交付：生成独立 Run Context Pack。',
      profile: 'builder',
      source: 'ad-hoc',
      status: 'assigned',
      assignee_principal_id: builder.id,
      acceptance: JSON.stringify([{ id: 'AC-1', text: '绑定' }]),
      base_snapshot: 1,
      created_at: 't0',
    }).returning();

    const remoteUrl = 'git@example.com:team/http-sync-repo.git';
    const [projectRepository] = await ctx.db.insert(schema.projectRepositories).values({
      code: testCode(507),
      project_id: project.id,
      name: 'HTTP Sync Repository',
      purpose: 'CLI 按需检出验证',
      remote_url: remoteUrl,
      default_branch: 'main',
      created_by: owner.id,
      created_at: 't0',
      updated_at: 't0',
    }).returning();

    const projectWorkspaceDir = path.join(ctx.tmp, 'project-workspace');
    const workspaceInit = await ctx.runCli([
      'workspace', 'init', project.code,
      '--dir', projectWorkspaceDir,
      '--name', 'Builder 项目工作空间',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const initialized = JSON.parse(workspaceInit.out);
    assert.equal(initialized.ok, true, workspaceInit.out);
    assert.equal(initialized.data.binding.project_code, project.code);
    assert.match(initialized.data.binding.project_workspace_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.equal(existsSync(path.join(projectWorkspaceDir, '.git')), true);
    assert.match(readFileSync(path.join(projectWorkspaceDir, '.gitignore'), 'utf8'), /^\/code\/$/m);

    const repositoryList = await ctx.runCli(['repository', 'list'], { ACP_PRINCIPAL_CODE: builder.code }, { cwd: projectWorkspaceDir });
    assert.deepEqual(JSON.parse(repositoryList.out).data.map((item) => ({ code: item.repository_code, status: item.checkout_status })), [
      { code: projectRepository.code, status: 'not_checked_out' },
    ]);
    const localCheckout = ctx.makeRepo('project-repository-checkout');
    const addRemote = spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: localCheckout, encoding: 'utf8' });
    assert.equal(addRemote.status, 0, addRemote.stderr);
    const attachedRepository = await ctx.runCli([
      'repository', 'attach', projectRepository.code, '--dir', localCheckout,
    ], { ACP_PRINCIPAL_CODE: builder.code }, { cwd: projectWorkspaceDir });
    assert.equal(JSON.parse(attachedRepository.out).ok, true, attachedRepository.out);
    const repositoryStatus = await ctx.runCli(['repository', 'status'], { ACP_PRINCIPAL_CODE: builder.code }, { cwd: projectWorkspaceDir });
    assert.deepEqual(JSON.parse(repositoryStatus.out).data.map((item) => ({ code: item.repository_code, status: item.checkout_status, dirty: item.dirty })), [
      { code: projectRepository.code, status: 'ready', dirty: false },
    ]);

    const whoami = await ctx.runCli(['whoami'], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(whoami.out).data.sync_mode, 'http');

    const attached = await ctx.runCli([
      'task', 'attach', externalTask.code,
      '--profile', 'builder',
      '--workspace', repoDir,
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const attachedData = JSON.parse(attached.out);
    assert.equal(attachedData.ok, true, attached.out);
    assert.equal(attachedData.data.execution_mode, 'external_shared');
    assert.equal(attachedData.data.shared_workspace, true);
    assert.ok(existsSync(attachedData.data.pack));
    const attachedBrief = readFileSync(attachedData.data.pack, 'utf8');
    assert.match(attachedBrief, /验证外部 Agent 绑定/);
    assert.match(attachedBrief, /当前共享工作目录/);
    assert.doesNotMatch(attachedBrief, /Run 工作区的 `repo\//);

    const list = await ctx.runCli(['task', 'list'], { ACP_PRINCIPAL_CODE: builder.code });
    const listed = JSON.parse(list.out);
    assert.equal(listed.ok, true, list.out);
    assert.equal(listed.data.some((item) => item.task_code === task.code), true);
    assert.equal(listed.data.some((item) => item.task_code === externalTask.code), true);

    const status = await ctx.runCli(['task', 'status', task.code], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(status.out).data.base_snapshot, 1);

    const claim = await ctx.runCli(['task', 'claim', task.code, '--profile', 'builder', '--repo', repoDir], { ACP_PRINCIPAL_CODE: builder.code });
    const claimed = JSON.parse(claim.out);
    assert.equal(claimed.ok, true, claim.out);
    assert.equal(claimed.data.status, 'running');
    const workspaceRoot = path.join(ctx.workspacesDir, claimed.data.run_code);
    assert.ok(existsSync(path.join(workspaceRoot, 'repo', 'README.md')));
    const brief = readFileSync(path.join(workspaceRoot, '.agent', 'project-state', 'brief.md'), 'utf8');
    assert.ok(brief.includes('AC-1'));

    const runningStatus = await ctx.runCli(['task', 'status', task.code], { ACP_PRINCIPAL_CODE: builder.code });
    const status2 = JSON.parse(runningStatus.out);
    assert.equal(status2.data.status, 'running');
    assert.equal(status2.data.base_snapshot, 2);

    const submit = await ctx.runCli([
      'task', 'submit', task.code,
      '--run-code', claimed.data.run_code,
      '--artifact-kind', 'commit',
      '--artifact-uri', 'git:x',
      '--artifact-hash', 'h',
      '--evidence-type', 'self_test',
      '--evidence-result', 'pass',
      '--acceptance-refs', 'AC-1',
      '--evidence-command', 'node --test',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(submit.out).data.status, 'submitted');

    const hijack = await ctx.runCli([
      'task', 'submit', task.code,
      '--run-code', claimed.data.run_code,
      '--artifact-kind', 'commit',
      '--artifact-uri', 'git:z',
      '--artifact-hash', 'h',
      '--evidence-type', 'self_test',
      '--evidence-result', 'pass',
      '--acceptance-refs', 'AC-1',
    ], { ACP_PRINCIPAL_CODE: owner.code });
    assert.equal(JSON.parse(hijack.out).ok, false);

    const history = await ctx.runCli(['task', 'history', task.code], { ACP_PRINCIPAL_CODE: owner.code });
    const actions = JSON.parse(history.out).data.map((event) => event.action);
    assert.ok(actions.includes('task.claimed'));
    assert.ok(actions.includes('task.submitted'));

    const requirementCreate = await ctx.runCli(['requirement', 'create', '--feature', feature.code, '--title', 'CLI 需求', '--body', '由 agentctl 创建'], { ACP_PRINCIPAL_CODE: builder.code });
    const requirementCode = JSON.parse(requirementCreate.out).data.requirement_code;
    assert.match(requirementCode, /^[0-9A-HJKMNP-TV-Z]{20}$/);

    const requirementRow = (await ctx.db.select({ id: schema.requirements.id }).from(schema.requirements).where(eq(schema.requirements.code, requirementCode)))[0];
    await ctx.db.update(schema.tasks).set({ requirement_id: null }).where(eq(schema.tasks.id, task.id));
    await ctx.db.update(schema.tasks).set({ requirement_id: requirementRow.id }).where(eq(schema.tasks.id, task.id));

    const requirementList = await ctx.runCli(['requirement', 'list', '--project', project.code], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(requirementList.out).data.some((item) => item.requirement_code === requirementCode), true);

    const requirementSearch = await ctx.runCli(['requirement', 'search', 'CLI', '--project', project.code], { ACP_PRINCIPAL_CODE: builder.code });
    assert.deepEqual(JSON.parse(requirementSearch.out).data.map((item) => item.requirement_code), [requirementCode]);

    const requirementShow = await ctx.runCli(['requirement', 'show', requirementCode], { ACP_PRINCIPAL_CODE: builder.code });
    assert.deepEqual(JSON.parse(requirementShow.out).data.tasks.map((item) => item.task_code), [task.code]);

    const designFile = path.join(ctx.tmp, 'design-prototype.html');
    const designNotesFile = path.join(ctx.tmp, 'design-prototype.md');
    writeFileSync(designFile, '<!doctype html><html><body><button>原型 v1</button></body></html>', 'utf8');
    writeFileSync(designNotesFile, '# 业务逻辑\n\n- 点击按钮进入主流程。', 'utf8');
    const designCreate = await ctx.runCli([
      'design', 'create', '--project', project.code,
      '--title', 'CLI 交互原型', '--summary', 'Agent 上传的 HTML 原型',
      '--file', designFile, '--notes-file', designNotesFile,
      '--requirements', requirementCode, '--status', 'ready',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const designCreated = JSON.parse(designCreate.out);
    assert.equal(designCreated.ok, true, designCreate.out);
    const prototypeCode = designCreated.data.prototype_code;
    assert.match(prototypeCode, /^[0-9A-HJKMNP-TV-Z]{20}$/);

    const designList = await ctx.runCli(['design', 'list', '--project', project.code, '--query', 'CLI'], { ACP_PRINCIPAL_CODE: builder.code });
    assert.deepEqual(JSON.parse(designList.out).data.map((item) => item.prototype_code), [prototypeCode]);

    const exportPath = path.join(ctx.tmp, 'exported-prototype.html');
    const notesExportPath = path.join(ctx.tmp, 'exported-prototype.md');
    const designShow = await ctx.runCli(['design', 'show', prototypeCode, '--output', exportPath, '--notes-output', notesExportPath], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(designShow.out).data.exported_path, exportPath);
    assert.equal(JSON.parse(designShow.out).data.notes_exported_path, notesExportPath);
    assert.match(readFileSync(exportPath, 'utf8'), /原型 v1/);
    assert.match(readFileSync(notesExportPath, 'utf8'), /业务逻辑/);

    writeFileSync(designFile, '<!doctype html><html><body><button>原型 v2</button></body></html>', 'utf8');
    writeFileSync(designNotesFile, '# 数据逻辑\n\n- 从任务接口读取当前状态。', 'utf8');
    const designRevise = await ctx.runCli([
      'design', 'revise', prototypeCode, '--file', designFile, '--notes-file', designNotesFile, '--change', '补齐开发前主路径',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(designRevise.out).data.current_revision, 2, designRevise.out);

    const [designTask] = await ctx.db.insert(schema.tasks).values({
      code: testCode(507),
      legacy_code: 'TASK-DESIGN-CONTEXT',
      feature_id: feature.id,
      requirement_id: requirementRow.id,
      title: '实现原型对应功能',
      brief: '按关联需求和 HTML 原型实现。',
      profile: 'builder',
      source: 'requirement',
      status: 'assigned',
      assignee_principal_id: builder.id,
      acceptance: JSON.stringify([{ id: 'AC-DESIGN', text: '实现与原型一致' }]),
      base_snapshot: 1,
      created_at: 't0',
    }).returning();
    const designClaim = await ctx.runCli([
      'task', 'claim', designTask.code, '--profile', 'builder', '--repo', repoDir,
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const designClaimed = JSON.parse(designClaim.out);
    assert.equal(designClaimed.ok, true, designClaim.out);
    assert.ok(existsSync(designClaimed.data.design_index));
    assert.equal(designClaimed.data.design_prototypes.length, 1);
    assert.equal(designClaimed.data.design_notes.length, 1);
    assert.match(readFileSync(designClaimed.data.design_index, 'utf8'), /CLI 交互原型/);
    assert.match(readFileSync(designClaimed.data.design_prototypes[0], 'utf8'), /原型 v2/);
    assert.match(readFileSync(designClaimed.data.design_notes[0], 'utf8'), /数据逻辑/);
    assert.match(readFileSync(designClaimed.data.pack, 'utf8'), /关联设计原型/);

    const urlCreate = await ctx.runCli([
      'design', 'create', '--project', project.code, '--title', '外部设计链接',
      '--url', 'https://example.com/design?frame=one', '--requirements', requirementCode,
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const urlCreated = JSON.parse(urlCreate.out);
    assert.equal(urlCreated.ok, true, urlCreate.out);
    assert.equal(urlCreated.data.content_kind, 'url');
    assert.equal(urlCreated.data.external_url, 'https://example.com/design?frame=one');
    const originalFile = path.join(ctx.tmp, 'design-source.fig');
    const originalBytes = Buffer.from([0, 255, 11, 32, 127]);
    writeFileSync(originalFile, originalBytes);
    const fileRevision = await ctx.runCli([
      'design', 'revise', urlCreated.data.prototype_code, '--attachment', originalFile, '--change', '保存原始设计文件',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    const fileRevised = JSON.parse(fileRevision.out);
    assert.equal(fileRevised.ok, true, fileRevision.out);
    assert.equal(fileRevised.data.content_kind, 'file');
    assert.equal(fileRevised.data.file_size, originalBytes.length);
    assert.equal('file_content_base64' in fileRevised.data, false);
    const fileMetadataRevision = await ctx.runCli([
      'design', 'revise', urlCreated.data.prototype_code, '--title', '设计源文件', '--change', '仅更新名称',
    ], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(fileMetadataRevision.out).data.file_sha256, fileRevised.data.file_sha256, fileMetadataRevision.out);
    const originalDownload = path.join(ctx.tmp, 'original-design-revision.fig');
    const download = await ctx.runCli([
      'design', 'download', urlCreated.data.prototype_code, '--revision', '2', '--out', originalDownload,
    ], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(download.out).ok, true, download.out);
    assert.deepEqual(readFileSync(originalDownload), originalBytes);

    const memberUpdate = await ctx.runCli(['requirement', 'update', requirementCode, '--title', '成员更新', '--body', '不应写入'], { ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(memberUpdate.out).error.code, 'requirement_forbidden');

    const ownerUpdate = await ctx.runCli(['requirement', 'update', requirementCode, '--title', 'Owner 更新', '--body', '更新后的正文'], { ACP_PRINCIPAL_CODE: owner.code });
    const updated = JSON.parse(ownerUpdate.out);
    assert.equal(updated.ok, true, ownerUpdate.out);
    assert.equal(updated.data.title, 'Owner 更新');
    assert.equal(updated.data.body, '更新后的正文');

    const down = await ctx.runCli(['task', 'list'], { ACP_API_URL: 'http://127.0.0.1:1', ACP_PRINCIPAL_CODE: builder.code });
    assert.equal(JSON.parse(down.out).error.code, 'api_unreachable');
  } finally {
    await ctx.cleanup();
  }
});
