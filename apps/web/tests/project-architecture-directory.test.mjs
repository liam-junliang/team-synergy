import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let libraryComponents;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  libraryComponents = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
});
after(async () => { await vite?.close(); });

const projectCode = 'PROJECT-ARCH';
const image = 'data:image/png;base64,iVBORw0KGgo=';
const architecture = {
  document_code: 'ARCH-A', project_code: projectCode, title: '平台架构', summary: '服务边界', content_kind: 'image',
  source_content: image, notes_markdown: '## 架构说明\n\n图与说明 **直接阅读**', preview_svg: null, current_revision: 2, can_edit: true,
  updated_at: '2026-10-16T00:00:00Z', revisions: [2, 1].map(revision => ({
    revision_code: `ARCH-REV-${revision}`, revision, title: `平台架构 r${revision}`, summary: `边界 r${revision}`, content_kind: 'image',
    source_content: image, notes_markdown: `说明 r${revision}`, preview_svg: null, change_summary: `修订 r${revision}`, created_at: '2026-10-16T00:00:00Z',
  })),
};
const projected = {
  document_code: architecture.document_code, project_code: projectCode, source_kind: 'architecture', source_can_edit: true,
  folder_code: 'ARCHITECTURE', folder_name: '架构设计', kind: 'diagram', title: architecture.title, summary: architecture.summary,
  content: architecture.notes_markdown, current_revision: 2, status: 'active', can_edit: false, architecture_document: architecture,
  revisions: architecture.revisions.map(revision => ({ ...revision, content: revision.notes_markdown })), outline: [],
};
const folders = [
  ...[['STANDARDS', '项目规范', 'standards'], ['REQUIREMENTS', '需求文档', 'requirements'], ['ARCHITECTURE', '架构设计', 'architecture']]
    .map(([folder_code, name, system_role]) => ({ folder_code, name, system_role, parent_folder_code: null, can_edit: true, status: 'active' })),
  { folder_code: 'OLD-CHILD', name: '旧规范目录', parent_folder_code: 'STANDARDS', system_role: null, can_edit: true, status: 'active' },
  { folder_code: 'REGULAR', name: '其他资料', parent_folder_code: null, system_role: null, can_edit: true, status: 'active' },
];

async function renderLibrary(props = {}, overrides = {}) {
  const { ProjectDisplayNamesProvider } = await vite.ssrLoadModule('/src/ProjectDisplayNames.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const documents = overrides.documents ?? [projected];
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active', name: '测试项目' });
  client.setQueryData(['handoff-library', projectCode, ''], { project_code: projectCode, can_create: true, folders, documents, ...overrides });
  documents.forEach(document => client.setQueryData(['handoff-document', document.document_code], document));
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectDisplayNamesProvider, { projectCode },
    createElement(libraryComponents.ProjectDocumentsWorkbench, { projectCode, ...props }))));
  client.clear();
  return html;
}

test('架构系统目录直接复用图、说明、源下载与版本阅读器，仅有一个版本入口并原地编辑', async () => {
  const html = await renderLibrary({ folderCode: 'ARCHITECTURE', documentCode: 'ARCH-A' });
  assert.ok(html.includes(image));
  assert.match(html, /alt="平台架构"/);
  assert.match(html, /图与说明 <strong>直接阅读<\/strong>/);
  assert.match(html, />diagram<\/span>/);
  assert.match(html, /下载图源|编辑当前版本/);
  assert.match(html, /aria-expanded="false" aria-controls="architecture-version-history"/);
  assert.equal((html.match(/>版本记录<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /aria-controls="document-version-history"|>编辑文档<|<select/);
  assert.match(html, /架构设计在此自动归集/);
});

test('架构源权限优先，文档投影不可绕过只读或项目边界', async () => {
  const readonly = await renderLibrary({ folderCode: 'ARCHITECTURE' }, { documents: [{ ...projected, source_can_edit: false, can_edit: true }] });
  assert.match(readonly, /直接阅读/);
  assert.doesNotMatch(readonly, /编辑当前版本|>编辑文档<|role="dialog"/);
  for (const architecture_document of [undefined, { ...architecture, document_code: 'OTHER' }, { ...architecture, project_code: 'OTHER' }]) {
    const incomplete = await renderLibrary({ folderCode: 'ARCHITECTURE' }, { documents: [{ ...projected, architecture_document }] });
    assert.match(incomplete, /架构资料读取不完整/);
    assert.doesNotMatch(incomplete, /alt="平台架构"|编辑当前版本/);
  }
});

test('库内编辑锁定打开时的架构快照，409后缓存刷新不会抬高旧草稿的版本基线', async () => {
  const { ArchitectureDocumentEditor, ArchitectureDocumentReader } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  const { architectureDraft, architectureWriteInput } = await vite.ssrLoadModule('/src/architectureDocuments.ts');
  const refreshed = { ...projected, current_revision: 3, architecture_document: { ...architecture, current_revision: 3, source_content: 'data:image/png;base64,YQ==' } };
  let stage = 0;
  let submitted;
  function EditingConflictProbe() {
    const [current, setCurrent] = useState(projected);
    // Render-phase updates let React retain the real hook state without a DOM.
    const tree = libraryComponents.ProjectArchitectureDocument({ document: current });
    const children = tree.props.children;
    const reader = children.find(child => child?.type === ArchitectureDocumentReader);
    if (stage === 0) {
      stage = 1;
      reader.props.onEdit();
    } else if (stage === 1) {
      stage = 2;
      setCurrent(refreshed);
    } else {
      const editor = children.find(child => child?.type === ArchitectureDocumentEditor);
      assert.equal(reader.props.document.current_revision, 3, '冲突刷新后阅读器已看到最新版本');
      assert.equal(editor.props.initial.current_revision, 2, '编辑草稿仍绑定打开时的版本');
      const draft = { ...architectureDraft(editor.props.initial), change_summary: '提交保留的草稿' };
      submitted = architectureWriteInput(draft, editor.props.initial.current_revision);
    }
    return null;
  }
  renderToStaticMarkup(createElement(EditingConflictProbe));
  assert.equal(stage, 2);
  assert.equal(submitted.base_revision, 2);
  assert.equal(submitted.source_content, image);
});

test('三个系统树一律不能创建或移入子文件夹，保留的子目录仍可存放规范文档', async () => {
  const { canCreateHandoffSubfolder, handoffSystemFolderRole, isSourceDocumentFolder, handoffFolderParents } = libraryComponents;
  for (const code of ['STANDARDS', 'REQUIREMENTS', 'ARCHITECTURE', 'OLD-CHILD']) assert.equal(canCreateHandoffSubfolder(folders, code), false);
  assert.equal(canCreateHandoffSubfolder(folders, 'REGULAR'), true);
  assert.equal(canCreateHandoffSubfolder(folders, null), true);
  assert.equal(canCreateHandoffSubfolder(folders, 'MISSING'), false);
  assert.equal(canCreateHandoffSubfolder([{ ...folders.at(-1), can_create_folder: false }], 'REGULAR'), false);
  assert.equal(handoffSystemFolderRole(folders, 'OLD-CHILD'), 'standards');
  assert.equal(isSourceDocumentFolder(folders, 'OLD-CHILD'), false);
  assert.equal(isSourceDocumentFolder(folders, 'ARCHITECTURE'), true);
  assert.deepEqual(handoffFolderParents(folders).map(folder => folder.folder_code), ['REGULAR']);
  assert.deepEqual(handoffFolderParents(folders, folders.find(folder => folder.folder_code === 'OLD-CHILD')).map(folder => folder.folder_code), ['STANDARDS', 'REGULAR'], '旧子目录可保留当前父目录改名，也可移出，但不能移入其他系统目录');
  const html = await renderLibrary({ folderCode: 'ARCHITECTURE', createDocument: true });
  assert.doesNotMatch(html, /role="dialog"|在(?:项目规范|需求文档|架构设计|旧规范目录)下新建文件夹/);
  assert.match(html, /在其他资料下新建文件夹/);
  assert.equal((html.match(/title="编辑文件夹"/g) ?? []).length, 2, '保留普通子目录的编辑入口');
  for (const label of ['新建文件夹', '新建文档']) assert.ok(html.includes(`disabled="" class="ui-button ui-button-${label === '新建文件夹' ? 'secondary' : 'primary'}">${label}`));
});

test('新建文档只提供DOC、API、DIAGRAM，需求和架构不作为通用文档目标，旧类型显示兼容', async () => {
  const html = await renderLibrary({ folderCode: 'STANDARDS', createDocument: true });
  const dialog = html.slice(html.indexOf('role="dialog"'));
  assert.match(dialog, /<option value="doc" selected="">doc · 普通文档<\/option>/);
  assert.match(dialog, /<option value="api">api · 接口文档<\/option>/);
  assert.match(dialog, /<option value="diagram">diagram · 图表<\/option>/);
  assert.doesNotMatch(dialog, /<option value="(?:general|integration|deployment|data|operations|release|REQUIREMENTS|ARCHITECTURE)"/);
  assert.match(dialog, /<option value="STANDARDS" selected="">项目规范/);
  assert.match(dialog, /<option value="OLD-CHILD">旧规范目录/);
  assert.match(dialog, /<option value="REGULAR">其他资料/);
  for (const kind of ['general', 'integration', 'deployment', 'data', 'operations', 'release']) assert.equal(libraryComponents.canonicalDocumentKind(kind), 'doc');
});

test('只修订内容省略类型以保存旧用途，显式切换类型则提交新类型', () => {
  const { handoffRevisionInput } = libraryComponents;
  const draft = { kind: 'doc', title: '发布手册', content: '新版内容', change_summary: '增加说明' };
  for (const document of [{ kind: 'release' }, { kind: 'doc', legacy_kind: 'release' }, { kind: 'doc' }]) {
    const payload = JSON.parse(JSON.stringify(handoffRevisionInput(document, draft)));
    assert.equal(Object.hasOwn(payload, 'kind'), false);
    assert.equal(payload.content, '新版内容');
  }
  assert.equal(handoffRevisionInput({ kind: 'release' }, { ...draft, kind: 'api' }).kind, 'api');
  assert.equal(handoffRevisionInput({ kind: 'api' }, draft).kind, 'doc');
});

test('架构保存和冲突刷新同一项目的两个列表及同一文档，活动库阅读器获取最新版本', async () => {
  const { invalidateArchitectureDocumentQueries } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const changed = [['architecture-documents', projectCode], ['architecture-document', 'ARCH-A'], ['handoff-library', projectCode, ''], ['handoff-library', projectCode, '服务']];
  const unchanged = [['architecture-documents', 'OTHER'], ['architecture-document', 'ARCH-B'], ['handoff-library', 'OTHER', ''], ['handoff-document', 'ARCH-B']];
  [...changed, ...unchanged].forEach(key => client.setQueryData(key, {}));
  const detailKey = ['handoff-document', 'ARCH-A'];
  client.setQueryData(detailKey, projected);
  let refreshes = 0;
  const observer = new QueryObserver(client, { queryKey: detailKey, queryFn: async () => {
    refreshes += 1;
    return { ...projected, current_revision: 3, architecture_document: { ...architecture, current_revision: 3 } };
  }, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  await invalidateArchitectureDocumentQueries(client, projectCode, 'ARCH-A');
  assert.equal(refreshes, 1);
  assert.equal(client.getQueryData(detailKey).architecture_document.current_revision, 3);
  changed.forEach(key => assert.equal(client.getQueryState(key).isInvalidated, true));
  unchanged.forEach(key => assert.equal(client.getQueryState(key).isInvalidated, false));
  unsubscribe();
  client.clear();
});
