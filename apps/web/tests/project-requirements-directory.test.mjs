import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
});
after(async () => { await vite?.close(); });

const projectCode = 'PROJECT-REQ';
const folders = [
  { folder_code: 'REQ-FOLDER', parent_folder_code: null, name: '需求文档', status: 'active', system_role: 'requirements', can_edit: true },
  { folder_code: 'STANDARD-FOLDER', parent_folder_code: null, name: '项目规范', status: 'active', system_role: 'standards', can_edit: false },
  { folder_code: 'NORMAL-FOLDER', parent_folder_code: null, name: '接口资料', status: 'active', system_role: null, can_edit: true },
];
const projectedDocument = {
  document_code: 'RD-A', project_code: projectCode, folder_code: 'REQ-FOLDER', folder_name: '需求文档', source_kind: 'requirement', source_can_edit: true,
  kind: 'general', status: 'active', can_edit: false, title: '登录需求', summary: '当前摘要', content: '# 当前登录需求\n\n需求独有正文 **保留直接阅读**',
  current_revision: 2, updated_by_user_code: 'USER-A', updated_at: '2026-10-16T00:00:00Z', outline: [],
  revisions: [
    { revision_code: 'RD-A-R2', revision: 2, title: '登录需求', summary: '当前摘要', content: '# 当前登录需求\n\n需求独有正文 **保留直接阅读**', change_summary: '补充验证码', created_by_user_code: 'USER-A', created_at: '2026-10-16T00:00:00Z' },
    { revision_code: 'RD-A-R1', revision: 1, title: '初始需求', summary: '最初摘要', content: '# 历史登录需求\n\n历史版本专属内容', change_summary: '初始草稿', created_by_user_code: 'USER-B', created_at: '2026-10-15T00:00:00Z' },
  ],
};
const domainDocument = {
  code: projectedDocument.document_code, project_code: projectCode, module_key: '账户模块', title: projectedDocument.title, summary: projectedDocument.summary,
  content: projectedDocument.content, current_revision: 2, state: 'active', can_edit: true, keywords: ['账户'], change_summary: '补充验证码',
  owner_code: 'USER-A', updated_at: projectedDocument.updated_at, outline: [], linked_requirements: [],
  revisions: projectedDocument.revisions.map(revision => ({ ...revision, created_by: revision.created_by_user_code, keywords: ['账户'] })),
};

async function renderLibrary(props = {}, overrides = {}) {
  const { ProjectDocumentsWorkbench } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const documents = overrides.documents ?? [projectedDocument];
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '测试项目' });
  client.setQueryData(['handoff-library', projectCode, ''], { project_code: projectCode, can_create: true, folders, ...overrides, documents });
  for (const document of documents) client.setQueryData(['handoff-document', document.document_code], document);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode }, createElement(ProjectDocumentsWorkbench, { projectCode, ...props }))));
  client.clear();
  return html;
}

test('固定需求目录直接读取同一需求文档，保留共享渲染与版本入口并标明来源', async () => {
  const html = await renderLibrary({ folderCode: 'REQ-FOLDER', documentCode: 'RD-A' });
  assert.match(html, /aria-current="location"[^>]*>[\s\S]*?<span[^>]*>需求文档/);
  assert.match(html, /系统固定目录，不可改名、移动、删除或新建子文件夹/);
  assert.match(html, /class="markdown-document"/);
  assert.match(html, /需求独有正文 <strong>保留直接阅读<\/strong>/);
  assert.match(html, /aria-controls="document-version-history"/);
  assert.match(html, /href="\/projects\/PROJECT-REQ\/requirements\?tab=documents&amp;document=RD-A"[^>]*>在需求页编辑/);
  assert.doesNotMatch(html, /通用说明|>编辑文档<|提炼需求项|Revision 2 评审/);
});

test('英文文档库按角色翻译固定目录和阅读操作，用户目录与正文保持原样', async () => {
  const { setLocale } = await vite.ssrLoadModule('/src/i18n.ts');
  try {
    setLocale('en-US', false);
    const html = await renderLibrary({ folderCode: 'REQ-FOLDER', documentCode: 'RD-A' });
    assert.match(html, /aria-current="location"[^>]*>[\s\S]*?<span[^>]*>Requirements/);
    assert.match(html, /Project standards/);
    assert.match(html, /接口资料/);
    assert.match(html, /登录需求/);
    assert.match(html, /需求独有正文 <strong>保留直接阅读<\/strong>/);
    assert.match(html, /Edit in Requirements/);
    assert.match(html, /Version history/);
    assert.match(html, /<span class="truncate">Requirements documents<\/span>/);
    setLocale('zh-CN', false);
    assert.match(await renderLibrary({ folderCode: 'REQ-FOLDER', documentCode: 'RD-A' }), /在需求页编辑/);
  } finally {
    setLocale('zh-CN', false);
  }
});

test('需求目录不允许通用创建、子目录或根目录编辑，直接创建链接也不打开表单', async () => {
  const html = await renderLibrary({ folderCode: 'REQ-FOLDER', createDocument: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*>新建文件夹<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>新建文档<\/button>/);
  assert.doesNotMatch(html, /role="dialog"|在需求文档下新建文件夹/);
  assert.doesNotMatch(html, /在项目规范下新建文件夹/);
  assert.equal((html.match(/title="编辑文件夹"/g) ?? []).length, 1, '仅普通目录可编辑，即使固定目录误报 can_edit');
});

test('通用文档可写入普通或规范目录，但需求目录及其后代不出现在目标选项中', async () => {
  const descendants = [...folders, { folder_code: 'REQ-CHILD', parent_folder_code: 'REQ-FOLDER', name: '保留的旧子目录', status: 'active', system_role: null, can_edit: true }];
  const html = await renderLibrary({ createDocument: true }, { folders: descendants });
  assert.match(html, /role="dialog"/);
  assert.match(html, /<option value="STANDARD-FOLDER">项目规范/);
  assert.match(html, /<option value="NORMAL-FOLDER">接口资料/);
  assert.doesNotMatch(html, /<option value="REQ-(?:FOLDER|CHILD)"|在保留的旧子目录下新建文件夹/);
  const blockedChild = await renderLibrary({ folderCode: 'REQ-CHILD', createDocument: true }, { folders: descendants });
  assert.doesNotMatch(blockedChild, /role="dialog"/);
  const { isRequirementDocumentFolder } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  assert.equal(isRequirementDocumentFolder(descendants, 'REQ-CHILD'), true);
  assert.equal(isRequirementDocumentFolder(descendants, 'STANDARD-FOLDER'), false);
  assert.equal(isRequirementDocumentFolder(descendants, null), false);
  assert.equal(isRequirementDocumentFolder(descendants, 'MISSING'), false);
  const cyclic = [{ folder_code: 'A', parent_folder_code: 'B' }, { folder_code: 'B', parent_folder_code: 'A' }];
  assert.equal(isRequirementDocumentFolder(cyclic, 'A'), false);
});

test('只读需求文档仍显示正文，需求源即使误报普通编辑权限也不能进入通用编辑', async () => {
  const html = await renderLibrary({ folderCode: 'REQ-FOLDER' }, { can_create: false, documents: [{ ...projectedDocument, source_can_edit: false, can_edit: true }] });
  assert.match(html, /需求独有正文/);
  assert.doesNotMatch(html, /在需求页编辑|>编辑文档<|role="dialog"/);
  const empty = await renderLibrary({ folderCode: 'REQ-FOLDER' }, { documents: [] });
  assert.match(empty, /需求文档在此自动归集/);
  assert.doesNotMatch(empty, /需求独有正文/);
});

test('需求投影历史记录保留实际版本映射、标题和摘要，历史态不显示编辑入口', async () => {
  const { ProjectDocumentHeader, ProjectDocumentHistory, MarkdownDocument } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const selections = [];
  const tree = ProjectDocumentHistory({ document: projectedDocument, viewRevision: 1, onSelect: value => selections.push(value), onClose() {} });
  const elements = node => Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : [];
  const buttons = elements(tree).filter(node => node.type === 'button' && node.props['aria-pressed'] !== undefined);
  assert.equal(buttons[1].props['aria-pressed'], true);
  buttons[1].props.onClick();
  buttons[0].props.onClick();
  assert.deepEqual(selections, [1, null]);
  const historical = projectedDocument.revisions.find(revision => revision.revision === selections[0]);
  const html = renderToStaticMarkup(createElement('article', null,
    createElement(ProjectDocumentHeader, { document: projectedDocument, historical, authorName: '初始作者', historyOpen: true, onToggleHistory() {}, onReturnCurrent() {}, onEdit() {} }),
    createElement(MarkdownDocument, { content: historical.content })));
  assert.match(html, /初始需求/);
  assert.match(html, /最初摘要/);
  assert.match(html, /Revision 1/);
  assert.match(html, /历史版本专属内容/);
  assert.doesNotMatch(html, /需求独有正文|在需求页编辑|>编辑文档</);
});

test('需求页直接阅读并保留本地编辑、评审及需求提炼入口，无需跳转文档库', async () => {
  const { RequirementsWorkbench } = await vite.ssrLoadModule('/src/RequirementsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active' });
  for (const key of ['features', 'project-modules', 'requirements']) client.setQueryData([key, projectCode], []);
  client.setQueryData(['requirement-documents', projectCode], [domainDocument]);
  client.setQueryData(['requirement-document', 'RD-A'], domainDocument);
  client.setQueryData(['requirement-document-reviews', 'RD-A'], []);
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode }, createElement(RequirementsWorkbench, { projectCode, documentCode: 'RD-A', initialTab: 'documents' }))));
  const html = render();
  assert.match(html, /文档统一归集在文档库「需求文档」目录，可在此直接阅读与编辑/);
  assert.match(html, /需求独有正文 <strong>保留直接阅读<\/strong>/);
  assert.match(html, /<button[^>]*>[\s\S]*?编辑文档<\/button>/);
  assert.match(html, /Revision 2 评审/);
  assert.match(html, /提炼需求项/);
  assert.doesNotMatch(html, /href="[^\"]*\/documents(?:\?|"|\/)/);
  client.setQueryData(['requirement-document', 'RD-A'], { ...domainDocument, can_edit: false });
  assert.doesNotMatch(render(), /编辑文档<\/button>/);
  client.setQueryData(['requirement-document', 'RD-A'], { ...domainDocument, can_edit: true });
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'viewer', status: 'active' });
  const viewer = render();
  assert.doesNotMatch(viewer, />编辑文档<|>提炼需求项<|>发起评审<|>上传 \/ 新建文档</);
  assert.match(viewer, /需求独有正文/);
  client.clear();
});

test('需求正文沿用不透明吸顶阅读头部，保留完整标题、操作和目录定位空间', async () => {
  const { RequirementsWorkbench } = await vite.ssrLoadModule('/src/RequirementsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const document = {
    ...domainDocument,
    title: '跨团队需求文档的完整长标题应在滚动时保留，而不是随着正文消失',
    summary: '摘要、模块、编码与版本继续提供当前阅读上下文。',
    content: '# 阅读定位\n\n长篇正文。\n\n![架构图片](https://example.test/architecture.png)\n\n```mermaid\nflowchart TD\nA-->B\n```',
    outline: [{ title: '阅读定位', level: 1, anchor: 'reading-target' }],
  };
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active' });
  for (const key of ['features', 'project-modules', 'requirements']) client.setQueryData([key, projectCode], []);
  client.setQueryData(['requirement-documents', projectCode], [document]);
  client.setQueryData(['requirement-document', 'RD-A'], document);
  client.setQueryData(['requirement-document-reviews', 'RD-A'], []);
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode }, createElement(RequirementsWorkbench, { projectCode, documentCode: 'RD-A', initialTab: 'documents' }))));
    const reader = html.slice(html.indexOf('<article class="min-w-0">'));
    const header = reader.match(/^<article[^>]*>(<header[\s\S]*?<\/header>)/)?.[1];
    assert.ok(header, '正文的第一个内容区是共享阅读头部');
    assert.match(header, /class="sticky top-0 z-10 border-b border-slate-200 bg-white /);
    for (const value of [document.title, document.summary, document.module_key, document.code, 'Revision 2', '#账户', '复制分享链接', '编辑文档', '提炼需求项']) assert.ok(header.includes(value), `头部保留 ${value}`);
    assert.match(header, /role="group" aria-label="文档操作"/);
    assert.match(header, />doc<\/span>/);
    assert.doesNotMatch(header, />DOC<\/span>/);
    assert.match(header, /<h2 class="break-words /, '长标题可换行，不做截断');
    assert.match(html, /<section class="min-w-0 overflow-clip rounded-xl[^>]*><article/);
    assert.doesNotMatch(header, /overflow-hidden|overflow-auto|bg-slate-50\/70/);
    assert.match(reader, /sticky top-\[calc\(var\(--document-reader-header-height,0px\)\+1rem\)\]/);
    assert.match(reader, /href="#reading-target"/);
    assert.match(reader, /<h1 id="reading-target"/);
    assert.match(reader, /Revision 2 评审|修改记录|架构图片/);
    const source = readFileSync(new URL('../src/RequirementsWorkbench.tsx', import.meta.url), 'utf8');
    assert.match(source, /<article className="min-w-0" onClick=\{handleMarkdownAnchorClick\}>/, '外置目录与 Markdown 共用焦点和历史记录处理');
  } finally { client.clear(); }
});

test('需求修订同时刷新两种阅读入口，其他项目和文档缓存不受影响', async () => {
  const { invalidateRequirementDocumentQueries } = await vite.ssrLoadModule('/src/RequirementsWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const invalidatedKeys = [['requirement-documents', projectCode], ['requirement-document', 'RD-A'], ['handoff-library', projectCode, ''], ['handoff-library', projectCode, '登录']];
  const untouchedKeys = [['requirement-documents', 'OTHER'], ['requirement-document', 'RD-OTHER'], ['handoff-library', 'OTHER', ''], ['handoff-document', 'RD-OTHER']];
  [...invalidatedKeys, ...untouchedKeys].forEach(key => client.setQueryData(key, {}));
  const detailKey = ['handoff-document', 'RD-A'];
  client.setQueryData(detailKey, projectedDocument);
  let refreshed = 0;
  const observer = new QueryObserver(client, { queryKey: detailKey, staleTime: Infinity, queryFn: async () => { refreshed += 1; return { ...projectedDocument, current_revision: 3, content: '修订后的同一正文' }; } });
  const unsubscribe = observer.subscribe(() => {});
  await invalidateRequirementDocumentQueries(client, projectCode, 'RD-A');
  invalidatedKeys.forEach(key => assert.equal(client.getQueryState(key).isInvalidated, true));
  untouchedKeys.forEach(key => assert.equal(client.getQueryState(key).isInvalidated, false));
  assert.equal(refreshed, 1);
  assert.equal(client.getQueryData(detailKey).content, '修订后的同一正文');
  unsubscribe();
  client.clear();
});

test('库接口保留需求来源和完整版本，需求创建与修订仍只调用需求接口', async (t) => {
  const { getHandoffDocument, createRequirementDocument, reviseRequirementDocument } = await vite.ssrLoadModule('/src/api.ts');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, data: init.method ? domainDocument : projectedDocument }), { status: 200 });
  });
  const document = await getHandoffDocument('RD-A');
  assert.equal(document.source_kind, 'requirement');
  assert.equal(document.source_can_edit, true);
  assert.equal(document.can_edit, false);
  assert.equal(document.revisions[1].content, projectedDocument.revisions[1].content);
  const input = { module_code: 'MODULE-A', module_key: '账户模块', title: '登录需求', summary: '摘要', content: '# 登录', keywords: ['账户'] };
  await createRequirementDocument(projectCode, input);
  await reviseRequirementDocument('RD-A', { ...input, change_summary: '补充约束' });
  assert.deepEqual(calls, [
    { path: '/api/handoff-documents/RD-A', method: 'GET', body: undefined },
    { path: '/api/projects/PROJECT-REQ/requirement-documents', method: 'POST', body: input },
    { path: '/api/requirement-documents/RD-A', method: 'PATCH', body: { ...input, change_summary: '补充约束' } },
  ]);
});
