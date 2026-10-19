import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let ProjectDocumentHeader;
let ProjectDocumentHistory;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  ({ ProjectDocumentHeader, ProjectDocumentHistory } = await vite.ssrLoadModule('/src/ProjectDocumentsWorkbench.tsx'));
});
after(async () => { await vite?.close(); });

const revisions = [2, 1].map(revision => ({ revision_code: `REV-${revision}`, revision, title: `版本标题 ${revision}`, summary: '文档摘要', content: '文档正文', change_summary: `修订说明 ${revision}`, created_at: '2026-10-16T00:00:00Z' }));
const document = { document_code: 'DOC-A', folder_name: '项目规范', kind: 'general', title: '当前标题', summary: '文档摘要', current_revision: 2, can_edit: true, updated_at: '2026-10-16T00:00:00Z', revisions };
const headerProps = { document, historical: null, authorName: 'Liam', historyOpen: false, onToggleHistory() {}, onReturnCurrent() {}, onEdit() {} };

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  return [node, ...elements(node.props.children)];
}

test('历史版本的返回操作位于标题上方工具栏，与当前版本编辑操作使用同一位置和尺寸', () => {
  const current = renderToStaticMarkup(createElement(ProjectDocumentHeader, headerProps));
  const historical = renderToStaticMarkup(createElement(ProjectDocumentHeader, { ...headerProps, historical: revisions[1] }));
  const toolbar = html => html.match(/<div role="group" aria-label="文档操作"[\s\S]*?<\/div>/)[0];
  assert.match(toolbar(current), /w-28 justify-center">编辑文档/);
  assert.match(toolbar(historical), /w-28 justify-center">返回当前版本/);
  assert.doesNotMatch(historical, /编辑文档/);
  assert.match(historical, /版本标题 1/);
  for (const html of [current, historical]) {
    assert.ok(html.lastIndexOf('</button>') < html.indexOf('<h2'), '操作按钮都在标题和摘要上方，不追加内容行');
    assert.match(html, /min-h-8/);
  }
});

test('版本入口提供展开状态，返回当前版本和展开操作分别触发对应回调', () => {
  const actions = [];
  const tree = ProjectDocumentHeader({ ...headerProps, historical: revisions[1], historyOpen: true,
    onReturnCurrent: () => actions.push('current'), onToggleHistory: () => actions.push('history') });
  const buttons = elements(tree).filter(node => node.type === 'button');
  buttons.find(node => node.props.children === '返回当前版本').props.onClick();
  const toggle = buttons.find(node => node.props['aria-controls'] === 'document-version-history');
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  assert.deepEqual(actions, ['current', 'history']);
});

test('展开的版本面板可收起，选择历史版本与当前版本保留正确的版本映射', () => {
  const selected = [];
  let closed = false;
  const props = { document, viewRevision: 1, onSelect: revision => selected.push(revision), onClose: () => { closed = true; } };
  const tree = ProjectDocumentHistory(props);
  const buttons = elements(tree).filter(node => node.type === 'button');
  const versions = buttons.filter(node => node.props['aria-pressed'] !== undefined);
  assert.equal(versions[0].props['aria-pressed'], false);
  assert.equal(versions[1].props['aria-pressed'], true);
  versions[1].props.onClick();
  versions[0].props.onClick();
  assert.deepEqual(selected, [1, null]);
  buttons.find(node => node.props['aria-label'] === '收起版本记录').props.onClick();
  assert.equal(closed, true);
  const html = renderToStaticMarkup(createElement(ProjectDocumentHistory, props));
  assert.match(html, /id="document-version-history"/);
  assert.match(html, /absolute inset-y-0 right-0/);
  assert.match(html, /xl:static/);
});

test('DOC、API与架构图复用吸顶页头，图表外壳不截断阅读区的滚动祖先', async () => {
  const { DocumentReaderHeader } = await vite.ssrLoadModule('/src/DocumentReaderHeader.tsx');
  const { ArchitectureDocumentHeader, ArchitectureDocumentReader } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  const architecture = { document_code: 'ARCH-A', project_code: 'PROJECT-A', title: '系统架构', summary: '组件边界',
    current_revision: 1, content_kind: 'image', source_content: 'data:image/png;base64,iVBORw0KGgo=',
    notes_markdown: '架构说明', preview_svg: null, updated_at: document.updated_at, can_edit: true, revisions: [] };
  const architectureProps = { ...headerProps, document: architecture, onDownload() {} };
  const headers = [
    ...['doc', 'api'].map(kind => ProjectDocumentHeader({ ...headerProps, document: { ...document, kind } })),
    ArchitectureDocumentHeader(architectureProps),
  ];
  for (const tree of headers) {
    assert.equal(tree.type, DocumentReaderHeader, '共享组件统一页头结构和滚动行为');
    const html = renderToStaticMarkup(tree);
    assert.match(html, /^<header class="sticky top-0 z-10 /);
    assert.match(html, /\bbg-white\s/);
    assert.doesNotMatch(html, /bg-white\/|backdrop-blur/, '正文不能透过吸顶页头显示');
    assert.match(html, /flex max-w-full flex-wrap items-center gap-2/);
  }
  const diagramHeader = renderToStaticMarkup(headers[2]);
  assert.match(diagramHeader, /架构设计<\/span><span>\/<\/span><span[^>]*>diagram<\/span>/);
  for (const embedded of [false, true]) {
    const html = renderToStaticMarkup(createElement(ArchitectureDocumentReader, { document: architecture, embedded, onEdit() {} }));
    const ancestors = html.slice(0, html.indexOf('<header'));
    assert.match(ancestors, /overflow-clip/);
    assert.doesNotMatch(ancestors, /overflow-(?:hidden|auto|scroll)|overflow-[xy]-(?:hidden|auto|scroll)/,
      '页头与实际阅读滚动区之间不能建立另一个滚动容器');
  }
});

test('文档页滚动视口不留顶部空隙，需求与架构目录共享独立滚动侧栏', async () => {
  const { ArchitectureWorkbench } = await vite.ssrLoadModule('/src/ArchitectureWorkbench.tsx');
  const { RequirementsWorkbench } = await vite.ssrLoadModule('/src/RequirementsWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  for (const key of ['architecture-documents', 'requirement-documents', 'requirements', 'project-modules', 'features']) {
    client.setQueryData([key, 'PROJECT-A'], []);
  }
  try {
    for (const component of [ArchitectureWorkbench, RequirementsWorkbench]) {
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(component, { projectCode: 'PROJECT-A', initialTab: 'documents' })));
      const main = html.match(/<main class="([^"]+)"/)[1];
      assert.match(main, /overflow-y-auto/);
      assert.doesNotMatch(main, /(?:^|\s)(?:\w+:)?p(?:[ty])?-/, '顶部留白应在内容层，避免正文从吸顶栏上方露出');
      assert.match(html, /<section class="[^"]*\bp-\d/, '页面初始留白保留在内部内容层');
      const sidebar = html.match(/<aside[^>]*class="document-library-sidebar"[\s\S]*?<\/aside>/)?.[0];
      assert.ok(sidebar, '两种目录使用相同的桌面吸顶与小屏堆叠规则');
      assert.match(sidebar, /shrink-0 border-b/, '搜索区不随目录条目滚动');
      assert.match(sidebar, /min-h-0 flex-1 overflow-y-auto overscroll-contain/, '长目录在自己的可收缩区域内滚动');
    }
  } finally {
    client.clear();
  }
});

test('标题换行或切换语言后，章节定位偏移跟随实际头部高度且卸载时清理', async (context) => {
  const { trackDocumentReaderHeaderHeight } = await vite.ssrLoadModule('/src/DocumentReaderHeader.tsx');
  const original = globalThis.ResizeObserver;
  const values = new Map();
  let resize;
  let height = 180;
  let disconnected = false;
  const header = { getBoundingClientRect: () => ({ height }), parentElement: { style: {
    setProperty: (name, value) => values.set(name, value), removeProperty: name => values.delete(name),
  } } };
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(target) { assert.equal(target, header); }
    disconnect() { disconnected = true; }
  };
  context.after(() => {
    if (original === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = original;
  });
  const cleanup = trackDocumentReaderHeaderHeight(header);
  assert.equal(values.get('--document-reader-header-height'), '180px');
  height = 260;
  resize();
  assert.equal(values.get('--document-reader-header-height'), '260px');
  cleanup();
  assert.equal(disconnected, true);
  assert.equal(values.size, 0);
});
