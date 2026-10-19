import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createDesignPrototypeUseCases, createTaskService } from '../dist/index.js';
import { insertFeature, insertRequirement, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const PUBLIC_CODE = /^[0-9A-HJKMNP-TV-Z]{20}$/;

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-DESIGN',
    teamName: 'Design Team',
    projectLegacyCode: 'PROJECT-DESIGN',
    projectName: 'Design Project',
    users: [
      { key: 'author', legacyCode: 'user-author', account: 'author', displayName: '原型作者', projectRole: 'member' },
      { key: 'owner', legacyCode: 'user-owner', account: 'owner', displayName: '项目 Owner', teamRole: 'owner', projectRole: 'owner' },
    ],
  });
  const feature = await insertFeature(db, {
    legacyCode: 'FEATURE-DESIGN', projectId: seeded.project.id, title: '设计工作台', status: 'active',
  });
  const requirement = await insertRequirement(db, {
    legacyCode: 'REQ-DESIGN',
    featureId: feature.id,
    title: '需求完成后可产出 HTML 原型',
    ownerPrincipalId: seeded.users.author.id,
  });
  return { db, ...seeded, feature, requirement };
}

test('设计原型：项目成员创建并关联需求，Owner 可新增不可变修订', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const created = await useCases.createPrototype({
    projectCode: ctx.project.code,
    title: '设计工作台交互原型',
    summary: '验证需求到开发之间的可交互设计产物。',
    htmlContent: '<!doctype html><html><body><button>开始设计</button></body></html>',
    notesMarkdown: '# 业务逻辑\n\n- 点击开始后进入设计画布。',
    requirementCodes: [ctx.requirement.code],
    principalCode: ctx.users.author.code,
  });

  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.prototype_code, PUBLIC_CODE);
  assert.equal(created.data.status, 'draft');
  assert.equal(created.data.content_kind, 'html');
  assert.equal(created.data.download_path, null);
  assert.equal(created.data.current_revision, 1);
  assert.match(created.data.notes_markdown, /业务逻辑/);
  assert.equal(created.data.can_edit, true);
  assert.deepEqual(created.data.linked_requirements, [{
    requirement_code: ctx.requirement.code,
    title: '需求完成后可产出 HTML 原型',
    status: 'confirmed',
    feature_code: ctx.feature.code,
    feature_name: '设计工作台',
  }]);

  const listed = await useCases.listPrototypes({
    projectCode: ctx.project.code,
    principalCode: ctx.users.owner.code,
    query: '交互',
  });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].prototype_code, created.data.prototype_code);

  const revised = await useCases.revisePrototype({
    prototypeCode: created.data.prototype_code,
    title: '设计工作台交互原型',
    summary: '补齐移动端入口与需求关联。',
    htmlContent: '<!doctype html><html><body><button>移动端预览</button></body></html>',
    notesMarkdown: '# 数据逻辑\n\n- 视口状态仅保存在客户端。',
    requirementCodes: [ctx.requirement.code],
    status: 'ready',
    changeSummary: '增加移动端预览入口',
    principalCode: ctx.users.owner.code,
  });

  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.status, 'ready');
  assert.equal(revised.data.current_revision, 2);
  assert.match(revised.data.html_content, /移动端预览/);
  assert.match(revised.data.notes_markdown, /数据逻辑/);
  assert.equal(revised.data.revisions[0].has_notes, true);
  assert.deepEqual(revised.data.revisions.map((revision) => revision.revision), [2, 1]);
  assert.deepEqual(revised.data.revisions.map((revision) => revision.change_summary), ['增加移动端预览入口', '初始原型']);

  const visualOnlyRevision = await useCases.revisePrototype({
    prototypeCode: created.data.prototype_code,
    title: '设计工作台交互原型',
    summary: '补齐移动端入口与需求关联。',
    htmlContent: '<!doctype html><html><body><button>视觉微调</button></body></html>',
    requirementCodes: [ctx.requirement.code],
    status: 'ready',
    changeSummary: '仅调整按钮视觉',
    principalCode: ctx.users.owner.code,
  });
  assert.equal(visualOnlyRevision.ok, true, JSON.stringify(visualOnlyRevision));
  assert.equal(visualOnlyRevision.data.current_revision, 3);
  assert.match(visualOnlyRevision.data.notes_markdown, /数据逻辑/);

  const [prototype] = await ctx.db.select().from(schema.designPrototypes)
    .where(eq(schema.designPrototypes.code, created.data.prototype_code)).limit(1);
  assert.equal(typeof prototype.id, 'bigint');
  const revisions = await ctx.db.select().from(schema.designPrototypeRevisions)
    .where(eq(schema.designPrototypeRevisions.prototype_id, prototype.id));
  assert.equal(revisions.length, 3);
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'design_prototype'),
    eq(schema.auditEvents.entity_id, prototype.id),
  ));
  assert.deepEqual(audits.map((audit) => audit.action), ['design_prototype.created', 'design_prototype.revised', 'design_prototype.revised']);
});

test('设计原型：非项目成员不能读取，跨项目需求不能关联', async () => {
  const ctx = await seededDb();
  const outsiderTeam = await ctx.db.insert(schema.teams).values({ name: 'Other Team', created_at: 't0' }).returning();
  const [outsider] = await ctx.db.insert(schema.users).values({
    account: 'outsider', display_name: '局外人', status: 'active', created_at: 't0',
  }).returning();
  const [otherProject] = await ctx.db.insert(schema.projects).values({
    team_id: outsiderTeam[0].id, name: 'Other Project', current_snapshot: 0, created_at: 't0',
  }).returning();
  const otherFeature = await insertFeature(ctx.db, { projectId: otherProject.id, title: '其他功能' });
  const otherRequirement = await insertRequirement(ctx.db, {
    featureId: otherFeature.id,
    title: '其他项目需求',
    ownerPrincipalId: outsider.id,
  });
  const useCases = createDesignPrototypeUseCases(ctx.db);

  const mismatch = await useCases.createPrototype({
    projectCode: ctx.project.code,
    title: '错误关联',
    htmlContent: '<html><body>no</body></html>',
    requirementCodes: [otherRequirement.code],
    principalCode: ctx.users.author.code,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'design_prototype_requirement_project_mismatch');

  const denied = await useCases.listPrototypes({
    projectCode: ctx.project.code,
    principalCode: outsider.code,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'design_prototype_forbidden');
});

test('设计原型：允许保存适合图片 data URL 的自包含 HTML', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const imagePayload = 'A'.repeat(700 * 1024);
  const created = await useCases.createPrototype({
    projectCode: ctx.project.code,
    title: '界面截图原型',
    htmlContent: `<!doctype html><html><body><img src="data:image/png;base64,${imagePayload}" alt="界面截图"></body></html>`,
    principalCode: ctx.users.author.code,
  });

  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.html_content, /data:image\/png;base64/);
  assert.equal(created.data.html_content.length > 512 * 1024, true);
});

test('设计原型：兼容旧图片标记，未提供正文的修订保留图片', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const html = '<html><head><meta name="acp-prototype-kind" content="image"></head><body><img src="data:image/png;base64,AA=="></body></html>';
  const created = await useCases.createPrototype({ projectCode: ctx.project.code, title: '旧图片', htmlContent: html, principalCode: ctx.users.author.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.content_kind, 'image');
  const revised = await useCases.revisePrototype({ prototypeCode: created.data.prototype_code, title: '旧图片', summary: '', notesMarkdown: '新说明', changeSummary: '更新说明', principalCode: ctx.users.author.code });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.html_content, html);
  assert.equal(revised.data.content_kind, 'image');
});

test('设计原型：链接支持说明修订和任务上下文，拒绝非 HTTP(S) 和嵌入凭据', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const input = { projectCode: ctx.project.code, title: '在线原型', contentKind: 'url', requirementCodes: [ctx.requirement.code], principalCode: ctx.users.author.code };
  for (const externalUrl of ['javascript:alert(1)', 'data:text/html,hello', 'file:///design.fig', '/relative', 'https://user:secret@example.com/', 'https://user@example.com/', 'https://example.com/\nsecret']) {
    const rejected = await useCases.createPrototype({ ...input, externalUrl });
    assert.equal(rejected.ok, false, externalUrl);
    assert.equal(rejected.error.code, 'design_prototype_url_invalid', externalUrl);
  }
  const created = await useCases.createPrototype({ ...input, externalUrl: 'https://example.com/prototype?node=3#screen', notesMarkdown: '登录流程' });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.html_content, '');
  assert.equal(created.data.external_url, 'https://example.com/prototype?node=3#screen');
  const revised = await useCases.revisePrototype({ prototypeCode: created.data.prototype_code, title: input.title, summary: '', requirementCodes: [ctx.requirement.code], notesMarkdown: '新增说明', changeSummary: '更新说明', principalCode: ctx.users.author.code });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.external_url, created.data.external_url);
  assert.equal(revised.data.content_kind, 'url');
  const task = await insertTask(ctx.db, { featureId: ctx.feature.id, requirementId: ctx.requirement.id, title: '实现设计', profile: 'builder', acceptance: [] });
  const taskResult = await createTaskService(ctx.db).getTaskStatus(task.code, ctx.users.author.code);
  assert.equal(taskResult.ok, true, JSON.stringify(taskResult));
  assert.equal(taskResult.data.design_prototypes[0].external_url, created.data.external_url);
  assert.equal(taskResult.data.design_prototypes[0].content_kind, 'url');
});

test('设计原型：附件保留原字节和历史版本，修改说明复用附件且不泄露 Base64', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const bytes = Buffer.from([0, 255, 128, 1, 10, 13, 42]);
  const created = await useCases.createPrototype({ projectCode: ctx.project.code, title: '源文件', contentKind: 'file', fileName: '设计源文件.fig',
    fileMimeType: 'application/octet-stream', fileContentBase64: bytes.toString('base64'), requirementCodes: [ctx.requirement.code], principalCode: ctx.users.author.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.html_content, '');
  assert.equal(created.data.file_size, bytes.length);
  assert.equal(created.data.file_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(created.data.download_path, `/design-prototypes/${created.data.prototype_code}/file?revision=1`);
  assert.equal('file_content_base64' in created.data, false);
  assert.equal('file_content_base64' in created.data.revisions[0], false);
  const command = { prototypeCode: created.data.prototype_code, title: '源文件', summary: '', notesMarkdown: '修改说明', requirementCodes: [ctx.requirement.code], changeSummary: '说明更新', principalCode: ctx.users.owner.code };
  const notesOnly = await useCases.revisePrototype(command);
  assert.equal(notesOnly.ok, true, JSON.stringify(notesOnly));
  assert.equal(notesOnly.data.file_sha256, created.data.file_sha256);
  assert.equal(notesOnly.data.file_name, created.data.file_name);
  assert.match(notesOnly.data.download_path, /revision=2$/);
  const replaced = await useCases.revisePrototype({ ...command, contentKind: 'file', fileName: 'next.fig', fileContentBase64: Buffer.from('next version').toString('base64') });
  assert.equal(replaced.ok, true, JSON.stringify(replaced));
  assert.notEqual(replaced.data.file_sha256, created.data.file_sha256);
  for (const revision of [1, 2]) {
    const downloaded = await useCases.getPrototypeFile(created.data.prototype_code, ctx.users.author.code, revision);
    assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
    assert.deepEqual(downloaded.data.bytes, bytes);
    assert.equal(downloaded.data.file_name, '设计源文件.fig');
  }
  const current = await useCases.getPrototypeFile(created.data.prototype_code, ctx.users.author.code);
  assert.equal(current.data.bytes.toString(), 'next version');
  const task = await insertTask(ctx.db, { featureId: ctx.feature.id, requirementId: ctx.requirement.id, title: '实现附件设计', profile: 'builder', acceptance: [] });
  const taskResult = await createTaskService(ctx.db).getTaskStatus(task.code, ctx.users.author.code);
  assert.equal(taskResult.ok, true, JSON.stringify(taskResult));
  assert.match(taskResult.data.design_prototypes[0].download_path, /revision=3$/);
  assert.equal('file_content_base64' in taskResult.data.design_prototypes[0], false);
  const [outsider] = await ctx.db.insert(schema.users).values({ account: 'file-outsider', display_name: 'Outsider', status: 'active', created_at: 't0' }).returning();
  const denied = await useCases.getPrototypeFile(created.data.prototype_code, outsider.code, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'design_prototype_forbidden');
});

test('设计原型：附件校验拒绝损坏的编码、不安全文件名和超限文件', async () => {
  const ctx = await seededDb();
  const useCases = createDesignPrototypeUseCases(ctx.db);
  const input = { projectCode: ctx.project.code, title: '附件', contentKind: 'file', fileName: 'source.fig', fileContentBase64: 'YWJj', principalCode: ctx.users.author.code };
  for (const fileName of ['../bad.fig', 'a\\b.fig', 'NUL.fig', 'a\r\nb.fig', 'C:bad.fig', 'bad.']) {
    const rejected = await useCases.createPrototype({ ...input, fileName });
    assert.equal(rejected.ok, false, fileName);
    assert.equal(rejected.error.code, 'design_prototype_file_name_invalid');
  }
  for (const fileContentBase64 of ['not-base64!', 'YQ', 'YQ==\n', 'YR==', 'Y===']) {
    const rejected = await useCases.createPrototype({ ...input, fileContentBase64 });
    assert.equal(rejected.ok, false, fileContentBase64);
    assert.equal(rejected.error.code, 'design_prototype_file_encoding_invalid');
  }
  const oversized = await useCases.createPrototype({ ...input, fileContentBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, 'design_prototype_file_too_large');
});
