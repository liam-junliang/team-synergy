import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, ui, api, library, i18n;
const originalFetch = globalThis.fetch;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, library, i18n] = await Promise.all(['ProjectMemoryPanel.tsx', 'memoryManagementApi.ts', 'ProjectDocumentsWorkbench.tsx', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => { await vite?.close(); });
afterEach(() => { globalThis.fetch = originalFetch; i18n.setLocale('zh-CN', false); });

function status(overrides = {}) {
  return {
    projectCode: 'PROJECT', serviceConfigured: true, enabled: true, bindingState: 'ready', canManage: true,
    storage: 'native_pg', retrievalEnabled: true,
    counts: { total: 2, pending: 0, processing: 0, synced: 2, needsReconcile: 0, notQueued: 0 },
    documents: [
      { documentCode: 'DOC-A', title: '项目背景', currentRevision: 3, source: 'MEM-PRIVATE-KEY', projectionStatus: 'synced' },
      { documentCode: 'DOC-B', title: '开发规范', currentRevision: 1, source: 'MEM-B', projectionStatus: 'synced' },
    ], documentsTruncated: false, ...overrides,
  };
}
const summaryProps = { expanded: true, pending: false, onToggle() {}, onAction() {}, onRefresh() {} };
function render(Component, props, value, error) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const queryKey = api.projectMemoryQueryKey('PROJECT');
  if (value) client.setQueryData(queryKey, value);
  if (error) client.getQueryCache().build(client, { queryKey }).setState({ status: 'error', error });
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); }
  finally { client.clear(); }
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  return [node, ...elements(node.props.children)];
}

test('shared search presents current document revisions and preserves decision and delivery distinctions', () => {
  const html = render(ui.ProjectMemorySummary, { ...summaryProps, value: status() });
  assert.match(html, /索引可用/);
  assert.match(html, /已索引 2\/2 份资料/);
  assert.match(html, /项目背景/);
  assert.match(html, /当前版本 r3/);
  assert.match(html, /索引就绪不代表方案已确认或工作已完成/);
  assert.doesNotMatch(html, /native_pg|MEM-PRIVATE-KEY|wiki|API Key/);
});

test('paused connections retain document sync history without advertising available retrieval', () => {
  const value = status({ enabled: false, retrievalEnabled: false });
  assert.equal(ui.projectMemoryPresentation(value).label, '索引维护已暂停');
  assert.deepEqual(api.projectMemoryActions(value), []);
  const html = render(ui.ProjectMemorySummary, { ...summaryProps, value });
  assert.match(html, /索引维护已暂停/);
  assert.doesNotMatch(html, /恢复同步|启用项目记忆/);
  assert.match(html, /已索引 2\/2 份资料/);
  assert.doesNotMatch(html, /索引可用|成员的 Agent 可以检索/);
});

test('off, preparing, failed and unconfigured states explain the available next action', () => {
  for (const [changes, label, actions] of [
    [{ enabled: false, bindingState: 'not_enabled' }, '正在准备索引', []],
    [{ bindingState: 'provisioning', retrievalEnabled: false }, '正在准备索引', []],
    [{ bindingState: 'failed', retrievalEnabled: false }, '索引连接待恢复', []],
    [{ serviceConfigured: false, enabled: false, bindingState: 'not_enabled' }, '索引服务未配置', []],
    [{ serviceConfigured: false }, '索引服务未配置', []],
  ]) {
    const value = status(changes);
    assert.equal(ui.projectMemoryPresentation(value).label, label);
    assert.deepEqual(api.projectMemoryActions(value), actions);
  }
});

test('only server management permission offers changes, including initial enable and retry', () => {
  for (const changes of [{}, { enabled: false, bindingState: 'not_enabled' }, { bindingState: 'failed' }, { counts: { ...status().counts, synced: 1, needsReconcile: 1 } }]) {
    const value = status({ ...changes, canManage: false });
    const html = render(ui.ProjectMemorySummary, { ...summaryProps, value });
    assert.deepEqual(api.projectMemoryActions(value), []);
    assert.doesNotMatch(html, /<button[^>]*>(启用项目记忆|恢复同步|重试连接|暂停同步|重试文档同步)<\/button>/);
    assert.match(html, /查看来源状态|收起详情/);
  }
});

test('the member panel has only read controls, including while requests are pending', () => {
  const changes = [];
  const tree = ui.ProjectMemorySummary({ ...summaryProps, value: status({ enabled: false, bindingState: 'not_enabled' }), pending: true, onAction: action => changes.push(action) });
  const buttons = elements(tree).filter(node => node.type === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons.find(node => node.props['aria-label'] === '刷新资料索引状态').props.disabled, true);
  assert.deepEqual(changes, []);
  assert.doesNotMatch(renderToStaticMarkup(tree), /启用项目记忆|暂停同步|恢复同步/);
});

test('expanded sources link to the chosen current document and collapse without editing it', () => {
  const selected = [], toggles = [];
  const props = { ...summaryProps, value: status(), onSelectDocument: code => { selected.push(code); return true; }, onToggle: () => toggles.push(true) };
  const tree = ui.ProjectMemorySummary(props);
  const buttons = elements(tree).filter(node => node.type === 'button');
  const link = elements(tree).filter(node => node.type === 'a')[1];
  let prevented = false;
  assert.equal(link.props.href, '/projects/PROJECT/documents?document=DOC-B');
  link.props.onClick({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  buttons.find(node => node.props['aria-controls'] === 'project-memory-documents').props.onClick();
  assert.deepEqual(selected, ['DOC-B']);
  assert.deepEqual(toggles, [true]);
  const collapsed = render(ui.ProjectMemorySummary, { ...props, expanded: false });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /当前版本 r3|项目背景<\/p>|当前资料索引状态/);
});

test('source deep links remain usable when the document is outside the active library filter', () => {
  let prevented = false;
  const tree = ui.ProjectMemorySummary({ ...summaryProps, value: status(), onSelectDocument: () => false });
  const link = elements(tree).find(node => node.type === 'a');
  link.props.onClick({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(link.props.href, '/projects/PROJECT/documents?document=DOC-A');
});

test('partial sync exposes retryable current sources without leaking engine errors', () => {
  const value = status({ counts: { total: 2, synced: 1, pending: 0, processing: 0, needsReconcile: 1, notQueued: 0 }, documentsTruncated: true,
    documents: [{ ...status().documents[0], projectionStatus: 'needs_reconcile', lastError: 'secret.engine.failure' }], lastError: 'internal secret' });
  assert.deepEqual(api.projectMemoryActions(value), []);
  const html = render(ui.ProjectMemorySummary, { ...summaryProps, value, actionFailed: true });
  assert.match(html, /部分索引待恢复/);
  assert.doesNotMatch(html, /重试文档同步/);
  assert.match(html, /这里只显示部分资料/);
  assert.match(html, /后台将继续重试/);
  assert.doesNotMatch(html, /secret|internal|engine/);
});

test('an empty connected project invites documents instead of claiming background is searchable', () => {
  const html = render(ui.ProjectMemorySummary, { ...summaryProps, value: status({ counts: { total: 0, synced: 0, pending: 0, processing: 0, needsReconcile: 0, notQueued: 0 }, documents: [] }) });
  assert.match(html, /等待项目资料/);
  assert.match(html, /项目资料会自动建立目录索引/);
  assert.doesNotMatch(html, /索引可用/);
});

test('panel rejects another project in cache instead of showing its sources or controls', () => {
  const html = render(ui.ProjectMemoryPanel, { projectCode: 'PROJECT' }, status({ projectCode: 'OTHER' }));
  assert.match(html, /状态暂不可用/);
  assert.doesNotMatch(html, /索引可用|暂停同步|项目背景|开发规范/);
});

test('failed and forbidden refreshes hide stale cached documents and administrative actions', () => {
  for (const code of [403, 503]) {
    const html = render(ui.ProjectMemoryPanel, { projectCode: 'PROJECT' }, status(), Object.assign(new Error('secret service message'), { status: code }));
    assert.match(html, /状态暂不可用/);
    assert.match(html, /刷新状态/);
    assert.doesNotMatch(html, /暂停同步|索引可用|secret|项目背景/);
  }
});

test('unsupported services do not offer enable or automatic retry against a missing endpoint', () => {
  const html = render(ui.ProjectMemoryPanel, { projectCode: 'PROJECT' }, undefined, Object.assign(new Error('Not found'), { status: 404 }));
  assert.match(html, /资料索引状态暂时无法读取/);
  assert.doesNotMatch(html, /启用项目记忆|正在读取/);
});

test('management API encodes project paths, uses shared session transport and sends no actor or resource IDs', async () => {
  const requests = [], code = 'PROJECT/中文 ?#', value = status({ projectCode: code });
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: value }), { headers: { 'Content-Type': 'application/json' } }); };
  assert.deepEqual(await api.getProjectMemoryManagement(code), value);
  for (const action of ['enableProjectMemory', 'pauseProjectMemory', 'retryProjectMemory']) assert.deepEqual(await api[action](code), value);
  const path = `/api/projects/${encodeURIComponent(code)}/memory/management`;
  assert.deepEqual(requests.map(request => request.url), [path, `${path}/enable`, `${path}/pause`, `${path}/retry`]);
  assert.equal(requests[0].init.body, undefined);
  for (const { init } of requests) assert.equal(init.credentials, 'same-origin');
  for (const { init } of requests.slice(1)) { assert.equal(init.method, 'POST'); assert.equal(init.body, '{}'); assert.equal(init.headers.get('Content-Type'), 'application/json'); }
});

test('API rejects mismatched project responses and propagates stable permission failures', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: status({ projectCode: 'OTHER' }) }));
  await assert.rejects(api.enableProjectMemory('PROJECT'), error => error.code === 'memory_project_mismatch');
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'Forbidden' } }), { status: 403 });
  await assert.rejects(api.pauseProjectMemory('PROJECT'), error => error.code === 'forbidden' && error.status === 403);
});

test('document saves invalidate only the active project memory status', async () => {
  const client = new QueryClient();
  const current = api.projectMemoryQueryKey('PROJECT'), other = api.projectMemoryQueryKey('OTHER');
  client.setQueryData(current, status());
  client.setQueryData(other, status({ projectCode: 'OTHER' }));
  try {
    await library.invalidateProjectDocumentQueries(client, 'PROJECT', 'DOC-A');
    assert.equal(client.getQueryState(current).isInvalidated, true);
    assert.equal(client.getQueryState(other).isInvalidated, false);
  } finally { client.clear(); }
});

test('source titles are escaped and English locale covers all management states', () => {
  i18n.setLocale('en-US', false);
  const html = render(ui.ProjectMemorySummary, { ...summaryProps, value: status({ documents: [{ ...status().documents[0], title: '<script>alert(1)</script>' }] }) });
  assert.match(html, /Material search index/);
  assert.match(html, /Indexes available/);
  assert.match(html, /2\/2 materials indexed/);
  assert.match(html, /Current revision r3/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|[\u4e00-\u9fff]/);
});
