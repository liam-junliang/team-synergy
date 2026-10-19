import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
before(async () => { vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', server: { middlewareMode: true, hmr: false } }); });
after(async () => { await vite?.close(); });

const projectCode = 'PROJECT-STANDARDS';
const folders = [
  { folder_code: 'SYSTEM', parent_folder_code: null, name: '项目规范', status: 'active', system_role: 'standards', can_edit: true },
  { folder_code: 'CHILD', parent_folder_code: 'SYSTEM', name: '编码约定', status: 'active', system_role: null, can_edit: true },
];
const documents = [
  { document_code: 'DOC-OTHER', folder_code: null, title: '普通文档', content: '普通文档独有正文' },
  { document_code: 'DOC-STANDARD', folder_code: 'CHILD', title: '测试约定', content: '规范目录专属正文' },
].map((document) => ({ ...document, project_code: projectCode, kind: 'general', summary: '', current_revision: 1, status: 'active', can_edit: true, revisions: [], outline: [] }));

async function renderLibrary(props = {}, overrides = {}) {
  const { ProjectDocumentsWorkbench } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '规范测试' });
  client.setQueryData(['handoff-library', projectCode, ''], { project_code: projectCode, can_create: true, folders, documents, ...overrides });
  for (const document of documents) client.setQueryData(['handoff-document', document.document_code], { ...document, can_edit: overrides.can_create !== false });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode }, createElement(ProjectDocumentsWorkbench, { projectCode, ...props }))));
  client.clear();
  return html;
}

test('目录深链接选中固定目录并读取其子目录文档，不回落到无关正文', async () => {
  const html = await renderLibrary({ folderCode: 'SYSTEM' });
  assert.match(html, /aria-current="location"[^>]*><svg[\s\S]*?<\/svg><span[^>]*>项目规范/);
  assert.doesNotMatch(html, /▰|◆|text-amber-500/);
  assert.match(html, /规范目录专属正文/);
  assert.doesNotMatch(html, /普通文档独有正文/);
  assert.match(html, /系统固定目录，不可改名、移动、删除或新建子文件夹/);
  assert.doesNotMatch(html, /在项目规范下新建文件夹|在编码约定下新建文件夹/);
  assert.equal((html.match(/title="编辑文件夹"/g) ?? []).length, 1, '既有普通子目录仍可编辑，系统根不能编辑');
  assert.match(html, /<button[^>]*disabled=""[^>]*>新建文件夹<\/button>/);
  assert.match(html, /<button type="button" class="ui-button ui-button-primary">新建文档<\/button>/);
  assert.match(html, /aria-expanded="false" aria-controls="document-version-history"/);
  assert.doesNotMatch(html, /id="document-version-history"/);
});

test('新增规范复用文档表单并预选系统目录，保留普通目录可选', async () => {
  const html = await renderLibrary({ folderCode: 'SYSTEM', createDocument: true });
  assert.match(html, /新建项目文档/);
  assert.match(html, /<option value="SYSTEM" selected="">项目规范<\/option>/);
  assert.match(html, /<option value="CHILD">编码约定<\/option>/);
  assert.match(html, /Markdown 正文/);
});

test('成员与失效目录深链接不能打开创建表单，失效目录不会读取无关正文', async () => {
  const readonly = await renderLibrary({ folderCode: 'SYSTEM', createDocument: true }, { can_create: false, folders: folders.map((folder) => ({ ...folder, can_edit: false })) });
  assert.match(readonly, /规范目录专属正文/);
  assert.doesNotMatch(readonly, /role="dialog"|>新建文档<|title="新建子文件夹"|>编辑文档</);
  const missing = await renderLibrary({ folderCode: 'MISSING', createDocument: true });
  assert.match(missing, /该文件夹不存在或已归档/);
  assert.doesNotMatch(missing, /role="dialog"|普通文档独有正文|规范目录专属正文/);
});

test('空规范目录不展示其他文档正文，目录后代选择可处理循环且不修改输入', async () => {
  const empty = await renderLibrary({ folderCode: 'SYSTEM' }, { documents: documents.slice(0, 1) });
  assert.doesNotMatch(empty, /普通文档独有正文/);
  const { handoffFolderDocuments } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const cyclic = [...folders, { folder_code: 'LOOP', parent_folder_code: 'CHILD' }, { folder_code: 'CHILD', parent_folder_code: 'LOOP' }];
  assert.deepEqual(handoffFolderDocuments(documents, cyclic, 'SYSTEM'), [documents[1]]);
  assert.deepEqual(handoffFolderDocuments(documents, cyclic, 'UNKNOWN'), []);
  assert.equal(documents.length, 2);
});

test('文档或目录保存使当前项目首页和库缓存失效，活动首页立即刷新移出或归档结果', async () => {
  const { invalidateProjectDocumentQueries } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const homeKey = ['project-home', projectCode];
  client.setQueryData(homeKey, { standards: [{ document_code: 'DOC-STANDARD' }] });
  client.setQueryData(['project-home', 'OTHER'], { standards: [] });
  client.setQueryData(['handoff-library', projectCode, ''], { documents });
  client.setQueryData(['handoff-library', projectCode, '搜索'], { documents });
  client.setQueryData(['handoff-document', 'DOC-STANDARD'], documents[1]);
  let refreshes = 0;
  const observer = new QueryObserver(client, { queryKey: homeKey, queryFn: async () => { refreshes += 1; return { standards: [] }; }, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  await invalidateProjectDocumentQueries(client, projectCode, 'DOC-STANDARD');
  assert.equal(refreshes, 1);
  assert.deepEqual(client.getQueryData(homeKey), { standards: [] });
  assert.equal(client.getQueryState(['handoff-library', projectCode, '']).isInvalidated, true);
  assert.equal(client.getQueryState(['handoff-library', projectCode, '搜索']).isInvalidated, true);
  assert.equal(client.getQueryState(['handoff-document', 'DOC-STANDARD']).isInvalidated, true);
  assert.equal(client.getQueryState(['project-home', 'OTHER']).isInvalidated, false);
  await invalidateProjectDocumentQueries(client, projectCode);
  assert.equal(refreshes, 2, '目录移动也刷新规范集合');
  unsubscribe();
  client.clear();
});

test('创建与移动文档API保存目标目录，归档仍由原文档修订接口提交', async (t) => {
  const { createHandoffDocument, reviseHandoffDocument } = await vite.ssrLoadModule('/src/api.ts');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, data: documents[1] }), { status: 200 });
  });
  const draft = { kind: 'general', folder_code: 'SYSTEM', title: '规范', content: '# 规范' };
  await createHandoffDocument(projectCode, draft);
  await reviseHandoffDocument('DOC-STANDARD', { ...draft, folder_code: null, status: 'archived', change_summary: '归档过期约定' });
  assert.deepEqual(calls, [
    { path: `/api/projects/${projectCode}/handoff/documents`, method: 'POST', body: draft },
    { path: '/api/handoff-documents/DOC-STANDARD', method: 'PATCH', body: { ...draft, folder_code: null, status: 'archived', change_summary: '归档过期约定' } },
  ]);
});
