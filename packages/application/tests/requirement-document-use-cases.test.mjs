import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createRequirementDocumentUseCases, createRequirementUseCases } from '../dist/index.js';
import { insertFeature, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-DOCS',
    teamName: 'Docs Team',
    projectLegacyCode: 'PROJECT-DOCS',
    projectName: 'docs',
    users: [
      { key: 'author', legacyCode: 'author', account: 'author', displayName: 'Author', teamRole: 'member', projectRole: 'member' },
      { key: 'owner', legacyCode: 'owner', account: 'owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    ],
  });

  // Module administration is separate from authoring documents.
  await db.insert(schema.projectModules).values(["AUTH","ARCHIVED","TASK","GENERAL","PRIVATE"].map(name => ({ project_id: seeded.project.id, name, status: 'active', created_at: 't0', updated_at: 't0' })));  const feature = await insertFeature(db, { legacyCode: 'FEATURE-AUTH', projectId: seeded.project.id, title: '身份模块', status: 'active' });
  return { db, ...seeded, feature };
}

test('需求文档：项目成员按模块创建，摘要/关键词/目录支持快速查阅', async () => {
  const ctx = await seededDb();
  const uc = createRequirementDocumentUseCases(ctx.db);
  const created = await uc.createDocument({
    projectCode: ctx.project.code,
    moduleKey: 'AUTH',
    title: '账号与权限需求说明',
    summary: '覆盖账号登录、首次改密和权限边界。',
    content: '# 账号与权限\n\n## 背景\n\n统一身份。\n\n## 业务规则\n\n- 登录使用账号。',
    keywords: ['登录', '账号', '权限', '登录'],
    principalCode: ctx.users.author.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.state, 'active');
  assert.deepEqual(created.data.keywords, ['登录', '账号', '权限']);

  const index = await uc.listDocuments({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, query: '首次改密' });
  assert.equal(index.ok, true, JSON.stringify(index));
  assert.deepEqual(index.data.map((item) => item.document_code), [created.data.document_code]);

  const detail = await uc.getDocument(created.data.document_code, ctx.users.author.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.deepEqual(detail.data.outline.map((item) => item.title), ['账号与权限', '背景', '业务规则']);
  assert.equal(detail.data.can_edit, true);
  assert.equal('available_transitions' in detail.data, false);
});

test('归档项目的需求文档保持可读，所有原始写入口拒绝修改且不改变版本', async () => {
  const ctx = await seededDb();
  const uc = createRequirementDocumentUseCases(ctx.db);
  const input = { projectCode: ctx.project.code, principalCode: ctx.users.author.code, moduleKey: 'ARCHIVED',
    title: '保留需求', summary: '摘要', content: '# 原正文' };
  const created = await uc.createDocument(input);
  assert.equal(created.ok, true, JSON.stringify(created));
  const original = await uc.getDocument(created.data.document_code, ctx.users.author.code);
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code]) {
    const detail = await uc.getDocument(created.data.document_code, principalCode);
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.data.can_edit, false);
    assert.deepEqual(detail.data.revisions, original.data.revisions);
    assert.equal(detail.data.content, original.data.content);
    const create = await uc.createDocument({ ...input, principalCode, moduleKey: 'MUST-NOT-BE-CREATED' });
    assert.equal(create.error.code, 'project_archived');
    const revise = await uc.reviseDocument({ ...input, principalCode, documentCode: created.data.document_code,
      content: '# 不能覆盖', changeSummary: '不允许', moduleKey: 'MUST-NOT-BE-CREATED' });
    assert.equal(revise.error.code, 'project_archived');
  }
  const listed = await uc.listDocuments({ projectCode: ctx.project.code, principalCode: ctx.users.author.code });
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].current_revision, 1);
  assert.equal((await ctx.db.select().from(schema.projectModules).where(eq(schema.projectModules.name, 'MUST-NOT-BE-CREATED'))).length, 0);
});

test('需求文档：修订不可变，结构化 REQ 条目可链接回来源文档', async () => {
  const ctx = await seededDb();
  const docs = createRequirementDocumentUseCases(ctx.db);
  const created = await docs.createDocument({
    projectCode: ctx.project.code,
    moduleKey: 'TASK',
    title: '任务闭环',
    summary: '任务领取到交付。',
    content: '# 任务闭环\n\n## 状态\n\n草稿。',
    principalCode: ctx.users.author.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const revised = await docs.reviseDocument({
    documentCode: created.data.document_code,
    moduleKey: 'TASK',
    title: '任务闭环需求说明',
    summary: '任务领取、执行和验收闭环。',
    content: '# 任务闭环\n\n## 状态\n\n完整闭环。',
    keywords: ['任务', '验收'],
    changeSummary: '补充验收边界',
    principalCode: ctx.users.author.code,
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.current_revision, 2);

  const requirement = await createRequirementUseCases(ctx.db).createRequirement({
    featureCode: ctx.feature.code,
    documentCode: created.data.document_code,
    title: '任务领取',
    body: '成员领取自己的任务。',
    principalCode: ctx.users.author.code,
  });
  assert.equal(requirement.ok, true, JSON.stringify(requirement));
  assert.equal(requirement.data.document_code, created.data.document_code);

  const detail = await docs.getDocument(created.data.document_code, ctx.users.owner.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.deepEqual(detail.data.revisions.map((item) => item.revision), [2, 1]);
  assert.equal(detail.data.revisions[1].content.includes('草稿'), true);
  assert.deepEqual(detail.data.linked_requirements.map((item) => item.requirement_code), [requirement.data.requirement_code]);
});

test('需求文档协作：上传后立即可读，作者和项目 Owner 可持续修订', async () => {
  const ctx = await seededDb();
  const uc = createRequirementDocumentUseCases(ctx.db);
  const created = await uc.createDocument({
    projectCode: ctx.project.code,
    moduleKey: 'GENERAL',
    title: '生命周期',
    summary: '验证文档治理。',
    content: '# 生命周期\n\n## 规则\n\n按 Revision 管理。',
    principalCode: ctx.users.author.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const revised = await uc.reviseDocument({
    documentCode: created.data.document_code,
    moduleKey: 'GENERAL',
    title: '协作文档 v2',
    summary: '验证直接协作修订。',
    content: '# 协作文档\n\n## 规则\n\n上传后直接共享。',
    changeSummary: '补充共享规则',
    principalCode: ctx.users.author.code,
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.current_revision, 2);
  const ownerRevision = await uc.reviseDocument({
    documentCode: created.data.document_code,
    moduleKey: 'GENERAL',
    title: '协作文档 v3',
    summary: 'Owner 可协助维护。',
    content: '# 协作文档\n\n## 规则\n\n保留版本历史。',
    changeSummary: 'Owner 补充版本规则',
    principalCode: ctx.users.owner.code,
  });
  assert.equal(ownerRevision.ok, true, JSON.stringify(ownerRevision));
  assert.equal(ownerRevision.data.current_revision, 3);

  const [documentRow] = await ctx.db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.code, created.data.document_code)).limit(1);
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'requirement_document'),
    eq(schema.auditEvents.entity_id, documentRow.id),
  ));
  assert.deepEqual(audits.map((item) => item.action), [
    'requirement_document.created',
    'requirement_document.revised',
    'requirement_document.revised',
  ]);
});

test('需求文档：非项目成员不能列出或读取', async () => {
  const ctx = await seededDb();
  const uc = createRequirementDocumentUseCases(ctx.db);
  const created = await uc.createDocument({
    projectCode: ctx.project.code,
    moduleKey: 'PRIVATE',
    title: '内部文档',
    summary: '仅项目成员可见。',
    content: '# 内部',
    principalCode: ctx.users.author.code,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const list = await uc.listDocuments({ projectCode: ctx.project.code, principalCode: '00000000000000000000' });
  assert.equal(list.ok, false);
  assert.equal(list.error.code, 'user_not_found');
  const detail = await uc.getDocument(created.data.document_code, '00000000000000000000');
  assert.equal(detail.ok, false);
  assert.equal(detail.error.code, 'user_not_found');
});
