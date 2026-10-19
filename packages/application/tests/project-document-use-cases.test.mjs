import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createArchitectureDocumentUseCases, createProjectDocumentUseCases, createRequirementDocumentUseCases } from '../dist/index.js';
import { insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-HANDOFF',
    teamName: 'Handoff Team',
    projectLegacyCode: 'PROJECT-HANDOFF',
    projectName: 'handoff',
    users: [
      { key: 'author', legacyCode: 'handoff-author', account: 'handoff.author', displayName: 'Author', projectRole: 'member' },
      { key: 'owner', legacyCode: 'handoff-owner', account: 'handoff.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
      { key: 'reader', legacyCode: 'handoff-reader', account: 'handoff.reader', displayName: 'Reader', projectRole: 'member' },
    ],
  });

  // Module administration is separate from authoring documents.
  await db.insert(schema.projectModules).values(["AUTHMODULE","PRIVATE"].map(name => ({ project_id: seeded.project.id, name, status: 'active', created_at: 't0', updated_at: 't0' })));  const outsider = await insertUser(db, {
    legacyCode: 'handoff-outsider',
    account: 'handoff.outsider',
    displayName: 'Outsider',
  });
  return { db, ...seeded, outsider };
}

test('交接文档库：多级文件夹组织前后端接口文档', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const integration = await uc.createFolder({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    name: '接口与联调',
  });
  assert.equal(integration.ok, true, JSON.stringify(integration));
  const frontendBackend = await uc.createFolder({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    name: '前后端对接',
    parentFolderCode: integration.data.folder_code,
  });
  assert.equal(frontendBackend.ok, true, JSON.stringify(frontendBackend));

  const created = await uc.createDocument({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    folderCode: frontendBackend.data.folder_code,
    kind: 'api',
    title: '登录接口约定',
    summary: 'Web 与 Core API 的登录请求、响应和错误码。',
    content: '# 登录接口约定\n\n## 请求\n\n`POST /auth/login`\n\n## 错误码\n\n- unauthorized',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.kind, 'api');

  const library = await uc.listLibrary({
    projectCode: ctx.project.code,
    principalCode: ctx.users.owner.code,
    query: '错误码',
  });
  assert.equal(library.ok, true, JSON.stringify(library));
  assert.deepEqual(library.data.folders.map((folder) => folder.name), ['项目规范', '需求文档', '架构设计', '测试资料', '接口与联调', '前后端对接']);
  assert.deepEqual(library.data.documents.map((document) => document.title), ['登录接口约定']);
  assert.equal(library.data.documents[0].folder_code, frontendBackend.data.folder_code);
  assert.equal(library.data.documents[0].source_kind, 'project');
});

test('固定项目规范目录禁止新增子目录，既有子目录和文档完整保留', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const library = await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code });
  assert.equal(library.ok, true, JSON.stringify(library));
  const root = library.data.folders.find(folder => folder.system_role === 'standards');
  assert.equal(root.name, '项目规范');
  assert.equal(root.can_edit, false);
  assert.equal(root.can_create_folder, false);
  const rejected = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: 'Web', parentFolderCode: root.folder_code });
  assert.equal(rejected.error.code, 'project_document_folder_read_only');
  const [storedRoot] = await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.code, root.folder_code));
  const [legacy] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, parent_id: storedRoot.id,
    name: 'Web', created_by: ctx.users.author.id, created_at: 'old', updated_at: 'old' }).returning();
  const child = { data: { ...legacy, folder_code: legacy.code } };
  assert.equal(child.data.system_role, null);
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code]) {
    for (const change of [{ name: 'Renamed' }, { parentFolderCode: child.data.folder_code }, { status: 'archived' }]) {
      const response = await uc.updateFolder({ folderCode: root.folder_code, principalCode, ...change });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'project_document_folder_system');
    }
  }
  const outsider = await uc.updateFolder({ folderCode: root.folder_code, principalCode: ctx.outsider.code, name: 'No access' });
  assert.equal(outsider.error.code, 'project_document_folder_forbidden');
  const duplicate = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, name: '项目规范' });
  assert.equal(duplicate.error.code, 'project_document_folder_duplicate');
  const masquerade = await uc.updateFolder({ folderCode: child.data.folder_code, principalCode: ctx.users.author.code, name: '项目规范', parentFolderCode: null });
  assert.equal(masquerade.error.code, 'project_document_folder_duplicate');
  const renamed = await uc.updateFolder({ folderCode: child.data.folder_code, principalCode: ctx.users.author.code, name: 'Web conventions' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(renamed.data.can_create_folder, false);
  assert.equal((await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: 'Deeper', parentFolderCode: child.data.folder_code })).error.code, 'project_document_folder_read_only');
  const ordinary = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: 'Ordinary' });
  assert.equal((await uc.updateFolder({ folderCode: ordinary.data.folder_code, principalCode: ctx.users.author.code, parentFolderCode: child.data.folder_code })).error.code, 'project_document_folder_read_only');
  const doc = await uc.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, folderCode: child.data.folder_code,
    kind: 'doc', title: 'Existing branch document', content: '# Preserved' });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  assert.equal((await uc.getDocument(doc.data.document_code, ctx.users.owner.code)).data.content, '# Preserved');
  const archived = await uc.updateFolder({ folderCode: child.data.folder_code, principalCode: ctx.users.owner.code, status: 'archived' });
  assert.equal(archived.ok, true, JSON.stringify(archived));
});

test('交接文档：作者和 Owner 可修订，历史 Revision 不可变', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const created = await uc.createDocument({
    projectCode: ctx.project.code,
    principalCode: ctx.users.author.code,
    kind: 'deployment',
    title: '部署说明',
    content: '# 部署说明\n\n## 环境\n\n测试环境。',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const revised = await uc.reviseDocument({
    documentCode: created.data.document_code,
    principalCode: ctx.users.owner.code,
    kind: 'deployment',
    title: '部署与回滚说明',
    content: '# 部署与回滚说明\n\n## 环境\n\n测试环境。\n\n## 回滚\n\n恢复上一个镜像。',
    changeSummary: '补充回滚步骤',
  });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.data.current_revision, 2);
  assert.deepEqual(revised.data.revisions.map((revision) => revision.revision), [2, 1]);
  assert.equal(revised.data.revisions[1].content.includes('回滚'), false);
  assert.equal(revised.data.revisions[0].change_summary, '补充回滚步骤');
});

test('交接文档库：非项目成员不可查阅，目录移动禁止形成循环', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const parent = await uc.createFolder({
    projectCode: ctx.project.code,
    principalCode: ctx.users.owner.code,
    name: '数据与迁移',
  });
  const child = await uc.createFolder({
    projectCode: ctx.project.code,
    principalCode: ctx.users.owner.code,
    name: '数据库',
    parentFolderCode: parent.data.folder_code,
  });
  const cycle = await uc.updateFolder({
    folderCode: parent.data.folder_code,
    principalCode: ctx.users.owner.code,
    parentFolderCode: child.data.folder_code,
  });
  assert.equal(cycle.ok, false);
  assert.equal(cycle.error.code, 'project_document_folder_cycle');

  const forbidden = await uc.listLibrary({
    projectCode: ctx.project.code,
    principalCode: ctx.outsider.code,
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'project_document_forbidden');
});

test('需求文档在固定目录单源展示，搜索与修订实时同步并保持原始版本', async () => {
  const ctx = await seededDb();
  const docs = createRequirementDocumentUseCases(ctx.db);
  const library = createProjectDocumentUseCases(ctx.db);
  const created = await docs.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
    moduleKey: 'AUTHMODULE', title: '账号说明', summary: '审批摘要', keywords: ['独有关键词'], content: '# 账号\n\n原始正文标记' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const folders = await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, ctx.project.id)).orderBy(asc(schema.projectDocumentFolders.id));
  assert.deepEqual(folders.map(folder => folder.system_role), ['standards', 'requirements', 'architecture', 'testing'], '需求创建自身保证固定目录存在');
  const originalRows = await ctx.db.select().from(schema.requirementDocumentRevisions);
  assert.equal(originalRows.length, 1);
  for (const query of ['账号说明', '审批摘要', '独有关键词', 'AUTHMODULE', '原始正文标记']) {
    const result = await library.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.reader.code, query });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.data.documents.map(doc => doc.document_code), [created.data.document_code]);
    const projection = result.data.documents[0];
    assert.equal(projection.source_kind, 'requirement');
    assert.equal(projection.kind, 'doc');
    assert.equal(projection.folder_code, folders[1].code);
    assert.equal(projection.status, 'active');
    assert.equal(projection.can_edit, false);
    assert.equal(projection.source_can_edit, false);
  }
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code]) {
    const result = await library.listLibrary({ projectCode: ctx.project.code, principalCode });
    assert.equal(result.data.documents[0].source_can_edit, true);
  }
  const revised = await docs.reviseDocument({ documentCode: created.data.document_code, principalCode: ctx.users.owner.code,
    title: '账号说明更新', summary: '新摘要', content: '# 更新\n\n新的正文标记', keywords: ['新关键词'], changeSummary: '补充约束' });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const current = await library.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.reader.code, query: '新的正文标记' });
  assert.equal(current.data.documents[0].current_revision, 2);
  const obsolete = await library.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.reader.code, query: '原始正文标记' });
  assert.deepEqual(obsolete.data.documents, []);
  const detail = await library.getDocument(created.data.document_code, ctx.users.author.code);
  const source = await docs.getDocument(created.data.document_code, ctx.users.author.code);
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.equal(detail.data.document_code, source.data.document_code);
  assert.equal(detail.data.content, source.data.content);
  assert.equal(detail.data.source_can_edit, true);
  assert.equal(detail.data.can_edit, false);
  assert.deepEqual(detail.data.revisions.map(({ title, ...revision }) => revision), source.data.revisions);
  assert.deepEqual(detail.data.revisions.map(revision => revision.revision), [2, 1]);
  assert.equal(detail.data.revisions[1].revision_code, originalRows[0].code);
  const [preserved] = await ctx.db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, originalRows[0].id));
  assert.deepEqual(preserved, originalRows[0]);
  assert.deepEqual(await ctx.db.select().from(schema.projectDocuments), [], '不复制项目文档');
  assert.deepEqual(await ctx.db.select().from(schema.projectDocumentRevisions), [], '不复制版本历史');

  await ctx.db.update(schema.requirementDocuments).set({ state: 'archived' }).where(eq(schema.requirementDocuments.code, created.data.document_code));
  const archived = await library.getDocument(created.data.document_code, ctx.users.owner.code);
  assert.equal(archived.data.status, 'archived');
  assert.equal(archived.data.source_can_edit, false);
});

test('需求文档关联沿用项目权限，文档库写入口不能修改需求原文', async () => {
  const ctx = await seededDb();
  const docs = createRequirementDocumentUseCases(ctx.db);
  const library = createProjectDocumentUseCases(ctx.db);
  const created = await docs.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
    moduleKey: 'PRIVATE', title: '内部需求', content: '# 内部要求' });
  assert.equal(created.ok, true, JSON.stringify(created));
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code, ctx.users.reader.code]) {
    const read = await library.getDocument(created.data.document_code, principalCode);
    assert.equal(read.ok, true, JSON.stringify(read));
    const write = await library.reviseDocument({ documentCode: created.data.document_code, principalCode,
      title: '篡改', content: '# 改写', changeSummary: '不允许' });
    assert.equal(write.error.code, 'project_document_source_read_only');
  }
  const denied = await library.getDocument(created.data.document_code, ctx.outsider.code);
  assert.equal(denied.error.code, 'requirement_document_forbidden');
  const deniedWrite = await library.reviseDocument({ documentCode: created.data.document_code, principalCode: ctx.outsider.code,
    title: '篡改', content: '# 改写', changeSummary: '不允许' });
  assert.equal(deniedWrite.error.code, 'requirement_document_forbidden');
  const other = await seedWorkspaceProject(ctx.db, {
    teamName: 'Other', projectName: 'Other',
    users: [{ key: 'owner', account: 'other.owner', displayName: 'Other Owner', teamRole: 'owner', projectRole: 'owner' }],
  });
  assert.equal((await library.getDocument(created.data.document_code, other.users.owner.code)).error.code, 'requirement_document_forbidden');
  const otherLibrary = await library.listLibrary({ projectCode: other.project.code, principalCode: other.users.owner.code });
  assert.deepEqual(otherLibrary.data.documents, []);
  const source = await docs.getDocument(created.data.document_code, ctx.users.author.code);
  assert.equal(source.data.current_revision, 1);
  assert.equal(source.data.content, '# 内部要求');
});

test('需求文档固定目录禁止更名、移动、归档及写入普通文件或子目录', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const library = await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code });
  const root = library.data.folders.find(folder => folder.system_role === 'requirements');
  assert.equal(root.name, '需求文档');
  assert.equal(root.can_edit, false);
  const plain = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '普通目录' });
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code]) {
    for (const change of [{ name: '改名' }, { parentFolderCode: plain.data.folder_code }, { status: 'archived' }]) {
      const response = await uc.updateFolder({ folderCode: root.folder_code, principalCode, ...change });
      assert.equal(response.error.code, 'project_document_folder_system');
    }
  }
  assert.equal((await uc.updateFolder({ folderCode: root.folder_code, principalCode: ctx.outsider.code, name: '改名' })).error.code, 'project_document_folder_forbidden');
  const createChild = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '子目录', parentFolderCode: root.folder_code });
  assert.equal(createChild.error.code, 'project_document_folder_read_only');
  const moveFolder = await uc.updateFolder({ folderCode: plain.data.folder_code, principalCode: ctx.users.author.code, parentFolderCode: root.folder_code });
  assert.equal(moveFolder.error.code, 'project_document_folder_read_only');
  const duplicate = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '需求文档' });
  assert.equal(duplicate.error.code, 'project_document_folder_duplicate');
  const rename = await uc.updateFolder({ folderCode: plain.data.folder_code, principalCode: ctx.users.author.code, name: '需求文档' });
  assert.equal(rename.error.code, 'project_document_folder_duplicate');
  const input = { projectCode: ctx.project.code, principalCode: ctx.users.author.code, title: '普通文档', content: '# 正文', kind: 'general' };
  assert.equal((await uc.createDocument({ ...input, folderCode: root.folder_code })).error.code, 'project_document_folder_read_only');
  const document = await uc.createDocument(input);
  assert.equal(document.ok, true, JSON.stringify(document));
  const moveDocument = await uc.reviseDocument({ ...input, documentCode: document.data.document_code, folderCode: root.folder_code, changeSummary: '移动' });
  assert.equal(moveDocument.error.code, 'project_document_folder_read_only');
  const unchanged = await uc.getDocument(document.data.document_code, ctx.users.author.code);
  assert.equal(unchanged.data.current_revision, 1);
  assert.equal(unchanged.data.folder_code, null);
});

test('历史项目鉴权后幂等补齐需求目录，同名普通目录不被静默收编', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  assert.equal((await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.outsider.code })).error.code, 'project_document_forbidden');
  assert.deepEqual(await ctx.db.select().from(schema.projectDocumentFolders), []);
  const [ordinary] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id,
    name: '需求文档', created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const results = await Promise.all([ctx.users.author.code, ctx.users.owner.code].map(principalCode =>
    uc.listLibrary({ projectCode: ctx.project.code, principalCode })));
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  const requirements = results.map(result => result.data.folders.find(folder => folder.system_role === 'requirements'));
  assert.equal(requirements[0].folder_code, requirements[1].folder_code);
  const all = await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, ctx.project.id));
  assert.equal(all.length, 5);
  const retained = all.find(folder => folder.id === ordinary.id);
  assert.equal(retained.system_role, null);
  assert.equal(retained.name, `需求文档（原目录 ${ordinary.code}）`);
});

test('架构设计在文档库共享图源、说明与全部历史，权限与原始资料一致', async () => {
  const ctx = await seededDb();
  const source = createArchitectureDocumentUseCases(ctx.db);
  const library = createProjectDocumentUseCases(ctx.db);
  const created = await source.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
    title: '旧架构', summary: '旧摘要', contentKind: 'mermaid', sourceContent: 'flowchart LR\n A --> B', notesMarkdown: '# 旧说明' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const before = await ctx.db.select().from(schema.architectureDocumentRevisions);
  const revised = await source.reviseDocument({ documentCode: created.data.document_code, principalCode: ctx.users.author.code,
    baseRevision: 1, title: '当前架构', summary: '当前摘要', sourceContent: 'flowchart LR\n A --> C', notesMarkdown: '# 新说明', changeSummary: '调整服务' });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  const result = await library.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.reader.code, query: '当前架构' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const folder = result.data.folders.find(item => item.system_role === 'architecture');
  assert.equal(folder.name, '架构设计');
  assert.equal(folder.can_create_folder, false);
  assert.equal(folder.can_edit, false);
  const item = result.data.documents[0];
  assert.equal(item.kind, 'diagram');
  assert.equal(item.source_kind, 'architecture');
  assert.equal(item.folder_code, folder.folder_code);
  assert.equal(item.can_edit, false);
  assert.equal(item.source_can_edit, false);
  assert.equal('source_content' in item, false);
  for (const principalCode of [ctx.users.author.code, ctx.users.owner.code, ctx.users.reader.code]) {
    const detail = await library.getDocument(created.data.document_code, principalCode);
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.equal(detail.data.content, '# 新说明');
    assert.equal(detail.data.source_can_edit, principalCode !== ctx.users.reader.code);
    assert.equal(detail.data.can_edit, false);
    assert.deepEqual(detail.data.architecture_document, (await source.getDocument(created.data.document_code, principalCode)).data);
    assert.deepEqual(detail.data.revisions.map(revision => [revision.revision, revision.title, revision.summary, revision.content]),
      [[2, '当前架构', '当前摘要', '# 新说明'], [1, '旧架构', '旧摘要', '# 旧说明']]);
    const write = await library.reviseDocument({ documentCode: created.data.document_code, principalCode,
      title: 'Overwrite', content: 'Wrong source', changeSummary: 'No' });
    assert.equal(write.error.code, 'project_document_source_read_only');
  }
  assert.equal((await library.getDocument(created.data.document_code, ctx.outsider.code)).error.code, 'architecture_document_forbidden');
  assert.equal((await library.reviseDocument({ documentCode: created.data.document_code, principalCode: ctx.outsider.code,
    title: 'No', content: 'No', changeSummary: 'No' })).error.code, 'architecture_document_forbidden');
  const [preserved] = await ctx.db.select().from(schema.architectureDocumentRevisions).where(eq(schema.architectureDocumentRevisions.id, before[0].id));
  assert.deepEqual(preserved, before[0]);
  assert.deepEqual(await ctx.db.select().from(schema.projectDocuments), []);
  assert.deepEqual(await ctx.db.select().from(schema.projectDocumentRevisions), []);
  await ctx.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, ctx.project.id));
  const archived = await library.getDocument(created.data.document_code, ctx.users.owner.code);
  assert.equal(archived.data.source_can_edit, false);
  assert.equal(archived.data.architecture_document.source_content, revised.data.source_content);
  const archivedLibrary = await library.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code });
  assert.equal(archivedLibrary.data.can_create, false);
  assert.equal(archivedLibrary.data.documents[0].source_can_edit, false);
});

test('三个系统目录统一限制，架构目录不接收普通文档，普通目录仍可嵌套', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const result = await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.author.code });
  const plain = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '普通目录' });
  const document = await uc.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
    title: '普通文档', content: '# 保持正文', kind: 'doc' });
  for (const root of result.data.folders) {
    assert.equal(root.can_create_folder, false);
    for (const change of [{ name: '改名' }, { status: 'archived' }, { parentFolderCode: plain.data.folder_code }]) {
      assert.equal((await uc.updateFolder({ folderCode: root.folder_code, principalCode: ctx.users.owner.code, ...change })).error.code, 'project_document_folder_system');
    }
    assert.equal((await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '新子目录', parentFolderCode: root.folder_code })).error.code, 'project_document_folder_read_only');
    assert.equal((await uc.updateFolder({ folderCode: plain.data.folder_code, principalCode: ctx.users.author.code, parentFolderCode: root.folder_code })).error.code, 'project_document_folder_read_only');
    const moved = await uc.reviseDocument({ documentCode: document.data.document_code, principalCode: ctx.users.author.code,
      folderCode: root.folder_code, title: '普通文档', content: '# 保持正文', changeSummary: '移动' });
    assert.equal(moved.ok, root.system_role === 'standards', JSON.stringify(moved));
    if (!moved.ok) assert.equal(moved.error.code, 'project_document_folder_read_only');
  }
  const nested = await uc.createFolder({ projectCode: ctx.project.code, principalCode: ctx.users.author.code, name: '普通子目录', parentFolderCode: plain.data.folder_code });
  assert.equal(nested.ok, true, JSON.stringify(nested));
  assert.equal(nested.data.can_create_folder, true);
});

test('DOC/API/DIAGRAM统一输出且保留旧用途和不可变版本，只有显式类型变更才替换旧值', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  for (const kind of ['general', 'integration', 'deployment', 'data', 'operations', 'release', 'doc', 'api', 'diagram']) {
    const document = await uc.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.author.code,
      title: kind, content: `# Original ${kind}`, kind });
    assert.equal(document.ok, true, JSON.stringify(document));
    const canonical = ['doc', 'api', 'diagram'].includes(kind);
    assert.equal(document.data.kind, canonical ? kind : 'doc');
    assert.equal(document.data.legacy_kind, canonical ? undefined : kind);
    const before = await uc.getDocument(document.data.document_code, ctx.users.author.code);
    const revised = await uc.reviseDocument({ documentCode: document.data.document_code, principalCode: ctx.users.author.code,
      title: kind, content: '# New body', changeSummary: '说明修订' });
    assert.equal(revised.data.legacy_kind, canonical ? undefined : kind);
    assert.deepEqual(revised.data.revisions[1], before.data.revisions[0]);
    const [stored] = await ctx.db.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.code, document.data.document_code));
    assert.equal(stored.kind, kind);
  }
  const old = (await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.author.code })).data.documents.find(item => item.legacy_kind === 'deployment');
  const changed = await uc.reviseDocument({ documentCode: old.document_code, principalCode: ctx.users.author.code,
    title: old.title, kind: 'api', content: '# API body', changeSummary: '明确类型变更' });
  assert.equal(changed.data.kind, 'api');
  assert.equal(changed.data.legacy_kind, undefined);
  assert.equal(changed.data.revisions.length, 3);
});

test('架构系统目录按成员身份幂等补齐，同名普通目录及内容保持独立', async () => {
  const ctx = await seededDb();
  const uc = createProjectDocumentUseCases(ctx.db);
  const [ordinary] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, name: '架构设计',
    created_by: ctx.users.owner.id, created_at: 'old', updated_at: 'old' }).returning();
  const created = await uc.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, folderCode: ordinary.code,
    title: '旧架构说明', content: '# 原内容', kind: 'general' });
  const before = await uc.getDocument(created.data.document_code, ctx.users.owner.code);
  const denied = await uc.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.outsider.code });
  assert.equal(denied.error.code, 'project_document_forbidden');
  assert.equal((await ctx.db.select().from(schema.projectDocumentFolders)).length, 1);
  const results = await Promise.all([ctx.users.owner.code, ctx.users.reader.code].map(principalCode => uc.listLibrary({ projectCode: ctx.project.code, principalCode })));
  const roots = results.map(result => result.data.folders.find(folder => folder.system_role === 'architecture'));
  assert.equal(roots[0].folder_code, roots[1].folder_code);
  const folders = await ctx.db.select().from(schema.projectDocumentFolders);
  assert.equal(folders.length, 5);
  assert.deepEqual(folders.find(folder => folder.id === ordinary.id), { ...ordinary, name: `架构设计（原目录 ${ordinary.code}）` });
  const after = await uc.getDocument(created.data.document_code, ctx.users.owner.code);
  assert.equal(after.data.folder_code, ordinary.code);
  assert.equal(after.data.source_kind, 'project');
  assert.deepEqual(after.data.revisions, before.data.revisions);
  assert.equal(after.data.content, before.data.content);
});
