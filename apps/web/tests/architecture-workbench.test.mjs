import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let helpers;
let components;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  helpers = await vite.ssrLoadModule('/src/architectureDocuments.ts');
  components = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
});
after(async () => { await vite?.close(); });

const imageSource = 'data:image/png;base64,iVBORw0KGgo=';
const architecture = {
  document_code: 'ARCH-A', project_code: 'PROJECT-A', title: '服务部署架构', summary: '应用和数据服务的边界',
  content_kind: 'image', current_revision: 2, owner_principal_code: 'USER-A', updated_at: '2026-10-16T00:00:00Z', can_edit: true,
  source_content: imageSource, notes_markdown: '## 组件职责\n\n当前说明 **在本页直接阅读**', preview_svg: null,
  revisions: [
    { revision_code: 'REV-2', revision: 2, title: '服务部署架构', summary: '当前边界', content_kind: 'image', source_content: imageSource, notes_markdown: '当前说明', preview_svg: null, change_summary: '补充数据库', created_by_user_code: 'USER-A', created_at: '2026-10-16T00:00:00Z' },
    { revision_code: 'REV-1', revision: 1, title: '最初架构', summary: '最初边界', content_kind: 'mermaid', source_content: 'graph LR\nA-->B', notes_markdown: '历史说明', preview_svg: null, change_summary: '初稿', created_by_user_code: 'USER-A', created_at: '2026-10-15T00:00:00Z' },
  ],
};

test('架构资料原地展示图片、Markdown说明、版本和源文件下载，权限控制编辑入口', () => {
  const html = renderToStaticMarkup(createElement(components.ArchitectureDocumentReader, { document: architecture, onEdit() {} }));
  assert.match(html, /alt="服务部署架构"/);
  assert.ok(html.includes(imageSource));
  assert.match(html, /<strong>在本页直接阅读<\/strong>/);
  assert.match(html, /class="markdown-document"/);
  assert.match(html, /aria-expanded="false" aria-controls="architecture-version-history"/);
  assert.doesNotMatch(html, /<select|id="architecture-version-history"/);
  assert.match(html, /下载图源/);
  assert.match(html, /编辑当前版本/);
  assert.doesNotMatch(html, /最初架构|历史说明|跳转文档库/);
  const readonly = renderToStaticMarkup(createElement(components.ArchitectureDocumentReader, { document: { ...architecture, can_edit: false }, onEdit() {} }));
  assert.doesNotMatch(readonly, /编辑当前版本/);
  assert.match(readonly, /版本记录/);
});

test('架构版本操作与文档页一致：标题上方展开记录，历史版本在原位置返回当前版本', () => {
  const actions = [];
  const props = { document: architecture, historyOpen: false,
    onToggleHistory: () => actions.push('history'), onReturnCurrent: () => actions.push('current'),
    onEdit: () => actions.push('edit'), onDownload: () => actions.push('download') };
  const current = renderToStaticMarkup(createElement(components.ArchitectureDocumentHeader, props));
  const historyProps = { ...props, historical: architecture.revisions[1], historyOpen: true };
  const historical = renderToStaticMarkup(createElement(components.ArchitectureDocumentHeader, historyProps));
  assert.match(current, /w-28 justify-center">编辑当前版本/);
  assert.match(historical, /w-28 justify-center">返回当前版本/);
  assert.match(historical, /最初架构|正在查看历史版本 r1/);
  assert.doesNotMatch(historical, /编辑当前版本|查看版本|<select/);
  for (const html of [current, historical]) {
    assert.ok(html.lastIndexOf('</button>') < html.indexOf('<h2'), '操作保持在标题上方，不占用单独的版本表单行');
    assert.match(html, /role="group" aria-label="架构文档操作"/);
  }
  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node?.props ? [node, ...elements(node.props.children)] : [];
  }
  const buttons = elements(components.ArchitectureDocumentHeader(historyProps)).filter(node => node.type === 'button');
  const toggle = buttons.find(node => node.props['aria-controls'] === 'architecture-version-history');
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  buttons.find(node => node.props.children === '返回当前版本').props.onClick();
  buttons.find(node => node.props.children === '下载图源').props.onClick();
  assert.deepEqual(actions, ['history', 'current', 'download']);
});

test('架构资料复用右侧版本面板，历史与当前版本映射正确并支持收起', async () => {
  const { DocumentVersionHistory } = await vite.ssrLoadModule('/src/DocumentVersionHistory.tsx');
  const { ProjectDocumentHistory } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx');
  assert.equal(DocumentVersionHistory, ProjectDocumentHistory, '两个资料入口使用同一个版本组件');
  const selected = [];
  let closed = false;
  const props = { id: 'architecture-version-history', document: architecture, viewRevision: 1,
    onSelect: revision => selected.push(revision), onClose: () => { closed = true; } };
  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node?.props ? [node, ...elements(node.props.children)] : [];
  }
  const buttons = elements(DocumentVersionHistory(props)).filter(node => node.type === 'button');
  const versions = buttons.filter(node => node.props['aria-pressed'] !== undefined);
  assert.deepEqual(versions.map(node => node.props['aria-pressed']), [false, true]);
  versions[1].props.onClick();
  versions[0].props.onClick();
  buttons.find(node => node.props['aria-label'] === '收起版本记录').props.onClick();
  assert.deepEqual(selected, [1, null]);
  assert.equal(closed, true);
  const html = renderToStaticMarkup(createElement(DocumentVersionHistory, props));
  assert.match(html, /id="architecture-version-history" aria-labelledby="architecture-version-history-heading"/);
  assert.match(html, /absolute inset-y-0 right-0/);
  assert.match(html, /xl:static/);
  assert.match(html, /补充数据库|初稿/);
});

test('项目二级导航用模块数量，需求工作台移除模块管理入口', async () => {
  const { ProjectWorkspaceNavigation } = await vite.ssrLoadModule('/src/ProjectWorkspace.tsx');
  const html = renderToStaticMarkup(createElement(ProjectWorkspaceNavigation, { projectCode: 'PROJECT-A', tab: 'structure', moduleCount: 10 }));
  assert.match(html, /功能模块<span[^>]*>10<\/span>/);
  assert.match(html, /href="\/projects\/PROJECT-A\/overview\?tab=structure" aria-current="page"/);
  assert.match(html, /href="\/projects\/PROJECT-A\/overview\?tab=architecture"/);
  const { RequirementsWorkbench } = await vite.ssrLoadModule('/src/RequirementsWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  for (const key of ['requirement-documents', 'requirements', 'project-modules', 'features']) client.setQueryData([key, 'PROJECT-A'], []);
  const requirementsHtml = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RequirementsWorkbench, { projectCode: 'PROJECT-A', initialTab: 'documents' })));
  assert.match(requirementsHtml, /需求文档|需求清单/);
  assert.doesNotMatch(requirementsHtml, /功能模块|tab=structure/);
  client.clear();
});

test('架构工作台直达文档，跨项目误配缓存不展示正文，搜索涵盖标题摘要编码和格式', () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['architecture-documents', 'PROJECT-A'], [architecture]);
  client.setQueryData(['architecture-document', 'ARCH-A'], architecture);
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(components.ArchitectureWorkbench, { projectCode: 'PROJECT-A', documentCode: 'ARCH-A' })));
  assert.match(render(), /当前说明 <strong>在本页直接阅读<\/strong>/);
  client.setQueryData(['architecture-document', 'ARCH-A'], { ...architecture, project_code: 'OTHER' });
  const wrongProject = render();
  assert.doesNotMatch(wrongProject, /当前说明|在本页直接阅读/);
  assert.match(wrongProject, /不属于当前项目/);
  for (const query of ['部署', '数据服务', 'arch-a', '架构图片']) assert.equal(components.filterArchitectureDocuments([architecture], query).length, 1);
  assert.equal(components.filterArchitectureDocuments([architecture], '不匹配').length, 0);
  client.clear();
});

test('归档项目只读、项目状态加载或失败时不能新建，现有架构与历史版本仍可阅读', () => {
  for (const state of ['active', 'archived', 'pending', 'error', 'viewer', 'admin']) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(['architecture-documents', 'PROJECT-A'], [architecture]);
    client.setQueryData(['architecture-document', 'ARCH-A'], { ...architecture, can_edit: ['active', 'viewer', 'admin'].includes(state) });
    if (state !== 'pending') client.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: state === 'viewer' ? 'viewer' : state === 'admin' ? 'admin' : 'owner', status: state === 'archived' ? 'archived' : 'active' });
    if (state === 'error') client.getQueryCache().find({ queryKey: ['project', 'PROJECT-A'] }).setState({ status: 'error', error: new Error('读取项目失败') });
    const render = (documentCode) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(components.ArchitectureWorkbench, { projectCode: 'PROJECT-A', documentCode })));
    const html = render('ARCH-A');
    assert.match(html, /当前说明 <strong>在本页直接阅读<\/strong>/);
    assert.match(html, /aria-expanded="false" aria-controls="architecture-version-history"/);
    if (state === 'active' || state === 'admin') {
      assert.match(html, /<button[^>]*>新建架构设计<\/button>/);
      assert.match(html, /编辑当前版本/);
    } else {
      assert.doesNotMatch(html, /<button[^>]*>新建架构设计<\/button>|编辑当前版本/);
      if (state === 'archived') assert.match(html, /项目已归档，架构设计为只读状态/);
      if (state === 'pending') assert.match(html, /正在读取项目状态/);
      if (state === 'error') assert.match(html, /暂时无法确认项目状态/);
      client.setQueryData(['architecture-documents', 'PROJECT-A'], []);
      const empty = render();
      assert.doesNotMatch(empty, /<button[^>]*>新建架构设计<\/button>|为项目添加第一份架构设计/);
    }
    client.clear();
  }
});

test('修订包含原始base_revision和同一版本完整图源说明，旧预览只在图源未变化时保留', () => {
  const draft = { ...helpers.architectureDraft(architecture), content_kind: 'drawio', source_content: '<mxfile/>', preview_svg: '<svg>old</svg>', change_summary: '新边界' };
  assert.equal(helpers.updateArchitectureSource(draft, draft.source_content).preview_svg, '<svg>old</svg>');
  const changed = helpers.updateArchitectureSource(draft, '<mxfile><diagram/></mxfile>');
  assert.equal(changed.preview_svg, null);
  const rendered = helpers.updateArchitectureSource(draft, '<mxfile><diagram/></mxfile>', '<svg>new</svg>');
  assert.equal(rendered.preview_svg, '<svg>new</svg>');
  const input = helpers.architectureWriteInput(changed, 2);
  assert.equal(input.base_revision, 2);
  assert.equal(input.notes_markdown, architecture.notes_markdown);
  assert.equal(input.preview_svg, null);
  assert.equal(input.source_content, '<mxfile><diagram/></mxfile>');
  assert.equal(input.change_summary, '新边界');
  assert.equal(helpers.architectureDraft(architecture).change_summary, '');
  assert.equal(helpers.isArchitectureRevisionConflict(new Error('architecture_document_revision_conflict: 已有新版本')), true);
  assert.equal(helpers.isArchitectureRevisionConflict(new Error('HTTP 409：/architecture-documents/ARCH-A')), true);
  assert.equal(helpers.isArchitectureRevisionConflict(new Error('HTTP 500')), false);
  assert.deepEqual(draft.preview_svg, '<svg>old</svg>', '修订输入不应改变仍需恢复的本地草稿');
});

test('导入和导出保留Mermaid/draw.io源文件及图片原始字节，拒绝危险XML与伪图片', async () => {
  const mmd = 'flowchart LR\n  服务A --> 服务B\n';
  const imported = await helpers.importArchitectureSource(new File([mmd], '系统.mmd', { type: 'text/plain' }));
  assert.deepEqual(imported, { content_kind: 'mermaid', source_content: mmd });
  const mmdExport = helpers.architectureSourceFile('mermaid', mmd, '系统/架构', 3);
  assert.equal(mmdExport.filename, '系统_架构-r3.mmd');
  assert.equal(await mmdExport.blob.text(), mmd);
  const xml = '<mxfile><diagram name="架构"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
  const drawio = await helpers.importArchitectureSource(new File([xml], '系统.drawio'));
  assert.equal(drawio.content_kind, 'drawio');
  assert.equal(await helpers.architectureSourceFile('drawio', drawio.source_content, '系统', 1).blob.text(), xml);
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = await helpers.importArchitectureSource(new File([bytes], '图.png', { type: 'image/png' }));
  assert.equal(png.content_kind, 'image');
  assert.equal(png.source_content, imageSource);
  assert.deepEqual(new Uint8Array(await helpers.architectureSourceFile('image', png.source_content, '架构').blob.arrayBuffer()), bytes);
  await assert.rejects(() => helpers.importArchitectureSource(new File(['<!DOCTYPE mxfile [<!ENTITY x SYSTEM "file:///secret">]><mxfile/>'], 'bad.drawio')), /有效的 draw.io/);
  await assert.rejects(() => helpers.importArchitectureSource(new File(['<script>alert(1)</script>'], 'bad.png')), /不是有效/);
  await assert.rejects(() => helpers.importArchitectureSource(new File(['<svg/>'], 'bad.svg')), /请选择/);
  await assert.rejects(() => helpers.importArchitectureSource(new File([new Uint8Array(helpers.ARCHITECTURE_SOURCE_LIMIT + 1)], 'large.mmd')), /6 MiB/);
});

test('保存前校验必填字段、图片类型和同版预览大小，修订必须说明变更', () => {
  const draft = { ...helpers.architectureDraft(), title: '总体架构' };
  assert.equal(helpers.validateArchitectureDraft(draft), null);
  assert.match(helpers.validateArchitectureDraft({ ...draft, title: ' ' }), /名称/);
  assert.match(helpers.validateArchitectureDraft({ ...draft, source_content: '' }), /图源/);
  assert.match(helpers.validateArchitectureDraft(draft, true), /修改/);
  assert.match(helpers.validateArchitectureDraft({ ...draft, content_kind: 'image', source_content: 'data:image/svg+xml;base64,PHN2Zy8+' }), /PNG/);
  assert.match(helpers.validateArchitectureDraft({ ...draft, preview_svg: 'x'.repeat(helpers.ARCHITECTURE_PREVIEW_LIMIT + 1) }), /2 MiB/);
  assert.match(helpers.validateArchitectureDraft({ ...draft, source_content: 'x'.repeat(helpers.ARCHITECTURE_SOURCE_LIMIT + 1) }), /6 MiB/);
});

test('架构API使用认证API前缀，创建与修订原样提交图源、说明、预览和版本基线', async () => {
  const api = await vite.ssrLoadModule('/src/api.ts');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: architecture }), { status: 200 }); };
  try {
    await api.listArchitectureDocuments('项目 A/1', '部署 + 数据');
    await api.getArchitectureDocument('ARCH A/1');
    const input = { title: '新版', content_kind: 'drawio', source_content: '<mxfile><diagram/></mxfile>', notes_markdown: '## 边界', preview_svg: null };
    await api.createArchitectureDocument('PROJECT-A', input);
    await api.reviseArchitectureDocument('ARCH-A', { ...input, base_revision: 2, change_summary: '更新边界' });
    assert.equal(calls[0].url, '/api/projects/%E9%A1%B9%E7%9B%AE%20A%2F1/architecture-documents?q=%E9%83%A8%E7%BD%B2%20%2B%20%E6%95%B0%E6%8D%AE');
    assert.equal(calls[1].url, '/api/architecture-documents/ARCH%20A%2F1');
    assert.equal(calls[2].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[2].init.body), input);
    assert.equal(calls[3].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[3].init.body), { ...input, base_revision: 2, change_summary: '更新边界' });
  } finally { globalThis.fetch = originalFetch; }
});
