import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { codeUnderstandingPath, parseWorkspacePath, isWorkspacePath } from '../src/workspaceRouting.ts';
import { uaReaderDocument, uaReaderNodeMessage, uaDomainGraph, uaStructuralGraph } from '../src/uaReaderBridge.ts';
import { projectSwitchPath } from '../src/projectSwitching.ts';
import { layoutCodeMap, nodeKey, codeNodeRelations, resolveCodeSelection } from '../src/codeUnderstandingMap.ts';
import { codeReaderStateForScope, codeRepositoryPath, codeRunMatchesRepository, resolveCodeRepositorySelection } from '../src/codeUnderstandingRepository.ts';

let vite, components, api, i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  components = await vite.ssrLoadModule('/src/CodeUnderstandingWorkbench.tsx');
  api = await vite.ssrLoadModule('/src/codeUnderstandingApi.ts');
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
});
after(async () => { await vite?.close(); });
const node = (id, run = 'RUN-A', extra = {}) => ({ id, native_id: id, provider: 'ua', label: `模块 ${id}`, kind: 'module', layer: '应用层', summary: '用户提供的职责说明', evidence_ids: [], verification: 'inferred', repository_code: run === 'RUN-A' ? 'REPO-A' : 'REPO-B', run_code: run, snapshot_id: 'snapshot', ...extra });
const edge = (id, source, target, run = 'RUN-A', extra = {}) => ({ id, source, target, run_code: run, repository_code: run === 'RUN-A' ? 'REPO-A' : 'REPO-B', snapshot_id: 'snapshot', provider: 'bridge', provenance: 'inferred', verification: 'inferred', type: 'implements', evidence_ids: [], ...extra });
const run = (code, kind = 'commit') => ({ code, repository_code: 'REPO-A', kind, status: 'succeeded', requested_ref: 'HEAD', snapshot: { commit: 'a'.repeat(40), captured_at: '2026-10-27T00:00:00Z', snapshot_id: 'a'.repeat(64) }, plugins: [], created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00Z' });
const context = { repositories: [{ code: 'REPO-A', name: '演示仓库', status: 'active' }], runs: [run('RUN-A'), run('RUN-DRAFT', 'draft')], views: [{ code: 'VIEW-A', kind: 'commit', selections: [{ repository_code: 'REPO-A', run_code: 'RUN-A' }] }], current_view: 'VIEW-A', current_draft_view: null, can_write: true, truncated: false };
const result = { source: 'published_projection', runs: [run('RUN-A')], view: null, nodes: [node('module'), node('symbol', 'RUN-A', { provider: 'codegraph', kind: 'function', path: 'src/auth.ts', line_start: 4, line_end: 8 })], edges: [edge('bridge', 'module', 'symbol')], evidence: [], tour: [], coverage: [], total_nodes: 2, offset: 0, limit: 64, truncated: false, capabilities: ['overview', 'node', 'relations'] };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
function renderWorkbench(route, data = context, graph = result, extraEntries = [], native = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['code-understanding-context', 'PROJECT-A'], data);
  client.setQueryData(['code-understanding-runtime', 'PROJECT-A'], { configured: false, model: null, message: '' });
  client.setQueryData(['code-understanding-analyses', 'PROJECT-A'], []);
  const selection = resolveCodeSelection(data, route);
  client.setQueryData(['code-understanding-graph', 'PROJECT-A', { ...selection.query, provider: 'ua', query: '', offset: 0, limit: 64 }], graph);
  for (const code of new Set([...data.runs.map(run => run.code), route.understandingRun].filter(Boolean))) {
    const item = data.runs.find(run => run.code === code) || run(code);
    client.setQueryData(['code-understanding-ua-map', 'PROJECT-A', code], { run: item, graph: native, projection: graph, metadata_complete: Boolean(native) });
  }
  for (const [key, value] of extraEntries) client.setQueryData(key, value);
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(components.CodeUnderstandingWorkbench, { projectCode: 'PROJECT-A', route }))); }
  finally { client.clear(); }
}

test('knowledge URLs preserve encoded version/node context and project switches drop foreign identities', () => {
  const path = codeUnderstandingPath('项目/A', { repository: 'REPO-A', run: 'RUN-A', node: 'ua:module/a?x=1', view: 'VIEW-A' });
  assert.equal(isWorkspacePath(path), true);
  const route = parseWorkspacePath(path);
  assert.equal(route.projectCode, '项目/A');
  assert.equal(route.understandingNode, 'ua:module/a?x=1');
  assert.equal(route.understandingRun, 'RUN-A');
  assert.equal(projectSwitchPath(route, 'PROJECT-B'), '/projects/PROJECT-B/understanding');
});

test('each repository opens its adopted mainline and other branches never replace it', () => {
  const newer = { ...run('RUN-NEW', 'draft'), updated_at: '2026-11-12T00:00:00Z' };
  const data = { ...context, runs: [...context.runs, newer, { ...newer, code: 'PENDING', status: 'indexing', updated_at: '2026-11-13T00:00:00Z' }] };
  assert.deepEqual(resolveCodeSelection(data, { view: 'understanding' }).query, { run_code: 'RUN-A' });
  assert.deepEqual(resolveCodeSelection(data, { view: 'understanding', understandingRepository: 'REPO-A' }).query, { run_code: 'RUN-A' });
  assert.equal(resolveCodeSelection({ ...data, current_view: null }, { view: 'understanding' }).query, null);
  const mainline = { ...data, current_view: null, repositories: [{ ...data.repositories[0], default_branch: 'main' }],
    runs: [...data.runs, { ...run('RUN-MAIN'), requested_ref: 'refs/heads/main' }, { ...newer, code: 'FEATURE', kind: 'commit', requested_ref: 'feature/new' }] };
  assert.equal(resolveCodeSelection(mainline, { view: 'understanding' }).run.code, 'RUN-MAIN');
  assert.equal(resolveCodeSelection(mainline, { view: 'understanding', understandingRun: 'RUN-MAIN', understandingRepository: 'REPO-A' }).mainline, true);
  assert.equal(resolveCodeSelection(mainline, { view: 'understanding', understandingRun: 'FEATURE' }).mainline, false);
  assert.equal(resolveCodeSelection(data, { view: 'understanding', understandingView: 'VIEW-A' }).run.code, 'RUN-A');
  assert.equal(resolveCodeSelection(context, { view: 'understanding', understandingRun: 'MISSING' }).invalid, true);
  assert.equal(resolveCodeSelection(context, { view: 'understanding', understandingRun: 'RUN-A', understandingRepository: 'REPO-B' }).invalid, true);
  assert.equal(resolveCodeSelection(context, { view: 'understanding', understandingRun: 'RUN-DRAFT' }).run.kind, 'draft');
  const second = { ...data, repositories: [...data.repositories, { code: 'REPO-B', name: '第二仓库' }] };
  assert.equal(resolveCodeSelection(second, { view: 'understanding', understandingRepository: 'REPO-B' }).run, undefined);
  assert.equal(resolveCodeSelection(second, { view: 'understanding', understandingRepository: 'REPO-B', understandingView: 'VIEW-A' }).invalid, true);
  assert.equal(resolveCodeSelection(data, { view: 'understanding', understandingRepository: 'MISSING' }).invalid, true);
  const html = renderWorkbench({ view: 'understanding' }, data);
  assert.match(html, /aria-label="规格"/);
  assert.match(html, /<summary>分析来源<\/summary>/);
  assert.doesNotMatch(html, /cu-reader-header/);
  assert.doesNotMatch(html, /切换版本|切换分析版本|返回项目主线|role="dialog"/);
  assert.doesNotMatch(html, /<select|知识版本选择|尚未选择项目视图/);
});

test('an explicit historical citation retains its snapshot and offers a direct return to mainline', () => {
  const html = renderWorkbench({ view: 'understanding', understandingRun: 'RUN-DRAFT' });
  assert.match(html, /返回项目主线/);
  assert.match(html, /RUN-DRAFT/);
  assert.doesNotMatch(html, /切换版本|切换分析版本|role="dialog"/);
  const mainline = renderWorkbench({ view: 'understanding', understandingRun: 'RUN-A' });
  assert.doesNotMatch(mainline, /返回项目主线/);
});

test('hosted analysis is gated by runtime and permissions and is available without a published map', () => {
  const route = { view: 'understanding' };
  const empty = { ...context, current_view: null, runs: [] };
  const disabled = renderWorkbench(route, empty);
  assert.match(disabled, /服务器分析服务未配置/);
  assert.match(disabled, /<button[^>]*disabled=""[^>]*>更新主线分析<\/button>/);
  const configured = [[['code-understanding-runtime', 'PROJECT-A'], { configured: true, model: 'model-fixture', message: '' }]];
  const ready = renderWorkbench(route, empty, result, configured);
  assert.match(ready, /model-fixture/);
  assert.match(ready, /<button type="button" class="ui-button ui-button-primary">更新主线分析<\/button>/);
  assert.doesNotMatch(ready, /cu-reader-header|切换版本|<select/);
  const readonly = renderWorkbench(route, { ...empty, can_write: false }, result, configured);
  assert.match(readonly, /更新需要项目写入权限/);
  assert.match(readonly, /<button[^>]*disabled=""[^>]*>更新主线分析<\/button>/);
});

test('hosted job status stays repository scoped and a failed job never replaces the published map', () => {
  const job = { job_code: 'JOB-A', repository_code: 'REPO-A', branch: 'main', status: 'failed', run_code: null, error: 'fixture analysis failed', created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:01:00Z' };
  const entries = [
    [['code-understanding-runtime', 'PROJECT-A'], { configured: true, model: 'fixture', message: '' }],
    [['code-understanding-analyses', 'PROJECT-A'], [job, { ...job, repository_code: 'REPO-B', error: 'foreign job error' }]],
  ];
  const failed = renderWorkbench({ view: 'understanding' }, context, result, entries);
  assert.match(failed, /<summary>分析来源<\/summary>[\s\S]*主线分析失败/);
  assert.match(failed, /fixture analysis failed/);
  assert.match(failed, /<svg/);
  assert.match(failed, /分析记录 RUN-A/);
  assert.doesNotMatch(failed, /foreign job error/);
  entries[1][1] = [{ ...job, status: 'running', error: null }];
  const active = renderWorkbench({ view: 'understanding' }, context, result, entries);
  assert.match(active, /服务器分析中/);
  assert.match(active, /<button[^>]*disabled=""[^>]*>分析进行中<\/button>/);
  assert.match(active, /<svg/);
});

test('requirements handoff pins a successful run, quotes node scope, and rejects unavailable or unsafe versions', () => {
  const project = 'A'.repeat(20), runCode = 'C'.repeat(20);
  const published = { ...run(runCode), artifact_sha256: 'b'.repeat(64) };
  const command = components.codeRequirementsPreparationCommand(project, published, "ua:flow:owner's-import");
  assert.match(command, new RegExp(`--project ${project} --code-run ${runCode}`));
  assert.ok(command.includes("--code-node 'ua:flow:owner''s-import'"));
  assert.doesNotMatch(command, /--scope|--repository|intake submit|intake apply/);
  for (const unavailable of [undefined, { ...published, status: 'awaiting_agent' }, { ...published, snapshot: null }, { ...published, artifact_sha256: null }, { ...published, code: 'bad;command' }]) {
    assert.equal(components.codeRequirementsPreparationCommand(project, unavailable), null);
  }
  assert.equal(components.codeRequirementsPreparationCommand('bad;command', published), null);
  assert.ok(components.codeRequirementsPreparationCommand(project, { ...published, kind: 'draft' }).includes(`--code-run ${runCode}`));
  assert.equal(components.codeRequirementsPreparationCommand(project, { ...published, runner: 'server_git' }), null);
  assert.ok(components.codeRequirementsPreparationCommand(project, { ...published, runner: 'member_cli' }).includes(`--code-run ${runCode}`));
});

test('hosted analysis shows its executor without offering a member-only preparation command', () => {
  const project = 'A'.repeat(20), runCode = 'C'.repeat(20), repository = 'B'.repeat(20);
  const published = { ...run(runCode), repository_code: repository, runner: 'server_git', artifact_sha256: 'b'.repeat(64) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['code-understanding-context', project], { ...context, repositories: [{ code: repository, name: '仓库' }], runs: [published], current_view: null });
  client.setQueryData(['code-understanding-ua-map', project, runCode], { run: published, graph: null, projection: result, metadata_complete: false });
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(components.CodeUnderstandingWorkbench, { projectCode: project, route: { view: 'understanding', understandingRun: runCode } })));
    assert.match(html, /执行端 · 服务器/);
    assert.match(html, /<svg/);
    assert.doesNotMatch(html, /从本次分析生成需求|tsp intake prepare|cu-reader-header/);
  } finally { client.clear(); }
});

test('published analysis exposes the fixed-source preparation entry without a business mutation', () => {
  const project = 'A'.repeat(20), runCode = 'C'.repeat(20), repository = 'B'.repeat(20);
  const published = { ...run(runCode), repository_code: repository, artifact_sha256: 'b'.repeat(64) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['code-understanding-context', project], { ...context, repositories: [{ code: repository, name: '仓库' }], runs: [published], current_view: null });
  client.setQueryData(['code-understanding-ua-map', project, runCode], { run: published, graph: null, projection: result, metadata_complete: false });
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(components.CodeUnderstandingWorkbench, { projectCode: project, route: { view: 'understanding', understandingRun: runCode } })));
    assert.match(html, /从本次分析生成需求/);
    assert.ok(html.includes(`--project ${project} --code-run ${runCode}`));
    assert.match(html, /准备完成后，让 Agent 阅读 AGENT.md/);
    assert.doesNotMatch(html, /intake submit|intake apply/);
  } finally { client.clear(); }
});

test('layout and adjacency qualify native identifiers by run and exclude off-page edges', () => {
  const nodes = [node('same'), node('target'), node('same', 'RUN-B'), node('target', 'RUN-B', { layer: '数据层' })];
  const edges = [edge('same-edge', 'same', 'target'), edge('same-edge', 'same', 'target', 'RUN-B'), edge('offpage', 'same', 'absent')];
  const layout = layoutCodeMap(nodes, edges);
  assert.equal(new Set(layout.nodes.map(nodeKey)).size, 4);
  assert.equal(layout.links.length, 2);
  assert.equal(layout.links[1].targetNode.run_code, 'RUN-B');
  assert.equal(layoutCodeMap(nodes, edges, '数据层').links.length, 0);
  const outgoing = codeNodeRelations({ ...result, nodes, edges }, nodes[0], 'out');
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[0].node.run_code, 'RUN-A');
  assert.equal(codeNodeRelations({ ...result, nodes, edges }, nodes[0], 'in').length, 0);
});

test('graph renders actual layers, labelled interactive nodes and evidence links without inserting HTML', () => {
  const graph = { ...result, nodes: [node('<script>alert(1)</script>'), result.nodes[1]], edges: [edge('bridge', '<script>alert(1)</script>', 'symbol')] };
  const html = render(components.CodeUnderstandingMap, { result: graph, onSelect() {} });
  assert.match(html, /<svg/);
  assert.match(html, /应用层/);
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /implements · inferred/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('node detail shows bidirectional bridge provenance and bounded uploaded evidence only', () => {
  const symbol = { ...result.nodes[1], evidence_ids: ['E'] };
  const data = { ...result, nodes: [result.nodes[0], symbol], evidence: [{ id: 'E', run_code: 'RUN-A', path: 'src/auth.ts', line_start: 4, line_end: 8, snippet: 'return authorized;', sha256: 'a'.repeat(64) }] };
  const html = render(components.CodeNodeDetail, { result: data, node: symbol, direction: 'both', onDirection() {}, onSelect() {} });
  assert.match(html, /← implements · bridge · inferred/);
  assert.match(html, /模块 module/);
  assert.match(html, /src\/auth.ts:4–8/);
  assert.match(html, /return authorized;/);
  assert.doesNotMatch(html, /file-content\.json|iframe|dangerouslySetInnerHTML/);
});

test('read-only workspace presents unselected, running, committed and draft states without mutation actions', () => {
  const route = { view: 'understanding' };
  assert.match(renderWorkbench(route, { ...context, current_view: null, runs: [] }), /这里将呈现项目规格地图/);
  const running = { ...context, runs: [{ ...run('RUN-A'), status: 'awaiting_agent', message: '等待批次 2' }] };
  assert.match(renderWorkbench({ ...route, understandingRun: 'RUN-A' }, running), /等待批次 2/);
  const committed = renderWorkbench({ ...route, understandingRun: 'RUN-A' });
  assert.match(committed, /分析记录 RUN-A/);
  assert.match(committed, /<svg/);
  const draft = renderWorkbench({ ...route, understandingRun: 'RUN-DRAFT' });
  assert.match(draft, /分析记录 RUN-DRAFT/);
  assert.doesNotMatch(committed, /开始分析|编辑解释|选择为当前|上传文件/);
});

test('project view exposes a compact repository selector without branch or version selection', () => {
  const data = { ...context, repositories: [...context.repositories, { code: 'REPO-B', name: '另一仓', status: 'active' }],
    runs: [...context.runs, { ...run('RUN-B'), repository_code: 'REPO-B' }],
    views: [{ ...context.views[0], selections: [...context.views[0].selections, { repository_code: 'REPO-B', run_code: 'RUN-B' }] }] };
  const html = renderWorkbench({ view: 'understanding' }, data);
  assert.match(html, /aria-label="代码仓库"/);
  assert.match(html, /另一仓/);
  assert.match(html, /<option value="REPO-A" selected="">演示仓库<\/option>/);
  assert.match(html, /<option value="REPO-B">另一仓<\/option>/);
  assert.doesNotMatch(html, /cu-repository-tabs|切换版本|选择分支/);
});

test('repository selection keeps mainlines independent and preserves matching historical links', () => {
  const data = { ...context, repositories: [...context.repositories, { code: 'REPO-B', name: '服务仓库', status: 'active', default_branch: 'main' }, { code: 'REPO-C', name: '未分析仓库', status: 'active', default_branch: 'main' }],
    runs: [...context.runs, { ...run('RUN-B'), repository_code: 'REPO-B', requested_ref: 'main' }, { ...run('OLD-B'), repository_code: 'REPO-B', requested_ref: 'feature/old' }],
    views: [{ ...context.views[0], selections: [...context.views[0].selections, { repository_code: 'REPO-B', run_code: 'RUN-B' }] }] };
  assert.equal(resolveCodeRepositorySelection(data, { view: 'understanding' }).repositoryCode, 'REPO-A');
  assert.equal(resolveCodeRepositorySelection(data, { view: 'understanding', understandingRepository: 'REPO-B' }).run.code, 'RUN-B');
  const historical = resolveCodeRepositorySelection(data, { view: 'understanding', understandingRun: 'OLD-B' });
  assert.equal(historical.repositoryCode, 'REPO-B');
  assert.equal(historical.run.code, 'OLD-B');
  assert.equal(historical.mainline, false);
  const loadingHistory = resolveCodeRepositorySelection(data, { view: 'understanding', understandingRun: 'NOT-LISTED' });
  assert.equal(loadingHistory.repositoryCode, undefined); assert.equal(loadingHistory.requestedRun, 'NOT-LISTED'); assert.equal(loadingHistory.needsRun, true);
  const empty = resolveCodeRepositorySelection(data, { view: 'understanding', understandingRepository: 'REPO-C' });
  assert.equal(empty.repositoryCode, 'REPO-C'); assert.equal(empty.run, undefined); assert.equal(empty.query, null);
  const wrong = resolveCodeRepositorySelection(data, { view: 'understanding', understandingRepository: 'REPO-B', understandingRun: 'RUN-A' });
  assert.equal(wrong.invalid, true); assert.equal(wrong.query, null);
  const missing = resolveCodeRepositorySelection(data, { view: 'understanding', understandingRepository: 'MISSING', understandingRun: 'OLD-UNKNOWN' });
  assert.equal(missing.invalid, true); assert.equal(missing.needsRun, false); assert.equal(missing.requestedRun, undefined);
  const path = codeRepositoryPath('PROJECT-A', 'REPO-B');
  assert.deepEqual(parseWorkspacePath(path), { view: 'understanding', projectCode: 'PROJECT-A', understandingRepository: 'REPO-B', understandingRun: undefined, understandingNode: undefined, understandingView: undefined });
});

test('switching repository resets query state before querying and rejects mismatched cached map identity', () => {
  const old = { scope: 'PROJECT-A:REPO-A:RUN-A', search: 'old symbol', offset: 128, direction: 'in', evidenceOpen: true };
  assert.equal(codeReaderStateForScope(old, old.scope), old);
  assert.deepEqual(codeReaderStateForScope(old, 'PROJECT-A:REPO-B:RUN-B'), { scope: 'PROJECT-A:REPO-B:RUN-B', search: '', offset: 0, direction: 'both', evidenceOpen: false });
  assert.deepEqual(codeReaderStateForScope(old, 'PROJECT-A:REPO-C:'), { scope: 'PROJECT-A:REPO-C:', search: '', offset: 0, direction: 'both', evidenceOpen: false });
  assert.equal(codeReaderStateForScope(null, 'PROJECT-A:REPO-B:OLD-B', 'cg:function').evidenceOpen, true);
  assert.equal(codeRunMatchesRepository(run('RUN-A'), 'RUN-A', 'REPO-A'), true);
  assert.equal(codeRunMatchesRepository(run('RUN-A'), 'RUN-B', 'REPO-B'), false);
  assert.equal(codeRunMatchesRepository({ ...run('RUN-B'), repository_code: 'REPO-A' }, 'RUN-B', 'REPO-B'), false);
});

test('repository controls remain available for empty and invalid maps while single repositories need no selector', () => {
  const data = { ...context, repositories: [...context.repositories, { code: 'REPO-B', name: '未分析仓库', status: 'active' }] };
  const empty = renderWorkbench({ view: 'understanding', understandingRepository: 'REPO-B' }, data);
  assert.match(empty, /aria-label="代码仓库"/); assert.match(empty, /<option value="REPO-B" selected="">未分析仓库<\/option>/);
  assert.match(empty, /此仓库尚无可读的主线分析/); assert.doesNotMatch(empty, /分析记录 RUN-A|<iframe|<svg/);
  const invalid = renderWorkbench({ view: 'understanding', understandingRepository: 'MISSING' }, data);
  assert.match(invalid, /aria-label="代码仓库"/); assert.match(invalid, /所选版本不存在/); assert.match(invalid, /返回项目主线/); assert.doesNotMatch(invalid, /分析记录 RUN-A|<iframe|<svg/);
  const single = renderWorkbench({ view: 'understanding' });
  assert.match(single, /class="cu-reader-repository"[^>]*>演示仓库/); assert.doesNotMatch(single, /<select/);
  const unregistered = renderWorkbench({ view: 'understanding' }, { ...context, repositories: [], runs: [], views: [], current_view: null });
  assert.doesNotMatch(unregistered, /cu-reader-strip|<select/); assert.match(unregistered, /请先登记项目代码仓库和主分支/);
});

test('a mismatched UA response cannot render another repository under the selected one', () => {
  const html = renderWorkbench({ view: 'understanding' }, context, result, [
    [['code-understanding-ua-map', 'PROJECT-A', 'RUN-A'], { run: { ...run('WRONG'), repository_code: 'REPO-B' }, graph: null, projection: result, metadata_complete: false }],
  ]);
  assert.match(html, /分析结果与所选仓库不一致/); assert.doesNotMatch(html, /<iframe|<svg/);
});

test('complete native graph uses an opaque sandbox reader instead of the paginated SVG', () => {
  const native = { version: '1.0.0', project: { name: '演示', gitCommitHash: 'a'.repeat(40) }, nodes: [{ id: 'module', type: 'module' }], edges: [], layers: [], tour: [] };
  const html = renderWorkbench({ view: 'understanding' }, context, result, [], native);
  assert.match(html, /title="UA 原生项目地图"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin|<svg|上一页|下一页/);
  assert.match(html, /代码关系与证据/);
});

test('native reader bridge scopes selection and evidence messages and blocks inline tag breakout', () => {
  const graph = { nodes: [{ id: 'same', type: 'domain' }, { id: 'flow', type: 'flow' }, { id: 'source', type: 'file' }], edges: [{ source: 'same', target: 'flow' }, { source: 'flow', target: 'source' }], layers: [], tour: [] };
  assert.deepEqual(uaReaderNodeMessage({ type: 'tsp.ua.select', channel: 'expected', node_id: 'same' }, 'expected', graph), { type: 'select', id: 'ua:same' });
  assert.equal(uaReaderNodeMessage({ type: 'tsp.ua.select', channel: 'foreign', node_id: 'same' }, 'expected', graph), null);
  assert.equal(uaReaderNodeMessage({ type: 'tsp.ua.evidence', channel: 'expected', node_id: 'absent' }, 'expected', graph), null);
  assert.equal(uaReaderNodeMessage({ type: 'execute', channel: 'expected', node_id: 'same' }, 'expected', graph), null);
  assert.equal(uaDomainGraph(graph).nodes.length, 2);
  assert.equal(uaDomainGraph(graph).edges.length, 1);
  const original = { ...graph, layers: [{ id: 'business', nodeIds: ['same', 'flow'] }, { id: 'code', nodeIds: ['source'] }], tour: [{ order: 9, nodeIds: ['flow'] }, { order: 4, nodeIds: ['source', 'flow'] }] };
  const structural = uaStructuralGraph(original);
  assert.deepEqual(structural.nodes.map(n => n.id), ['source']);
  assert.equal(structural.layers.length, 1);
  assert.deepEqual(structural.tour, [{ order: 0, nodeIds: ['source'] }]);
  assert.equal(original.tour[0].order, 9);
  const html = uaReaderDocument('const label="</script><img src=x>";', '</style><img src=x>', '</script>');
  assert.equal((html.match(/<script>/g) || []).length, 2);
  const outsideRawText = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(outsideRawText, /<img src=x>/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
});

test('trusted full-system reader profile preserves the complete system graph and legacy responses keep split navigation', () => {
  const graph = { version: '1.0.0', kind: 'codebase', project: { name: 'System' }, nodes: [
    { id: 'module:identity', type: 'module', domainMeta: { businessRules: ['Trust authenticated identity'] } },
    { id: 'capability:login', type: 'domain' }, { id: 'flow:login', type: 'flow' }, { id: 'file:auth.ts', type: 'file' },
  ], edges: [{ source: 'module:identity', target: 'file:auth.ts', type: 'contains' },
    { source: 'module:identity', target: 'capability:login', type: 'serves' },
    { source: 'flow:login', target: 'capability:login', type: 'flow_step' }],
  layers: [{ id: 'identity', nodeIds: ['module:identity', 'capability:login', 'flow:login', 'file:auth.ts'] }],
  tour: [{ order: 0, nodeIds: ['module:identity'] }, { order: 1, nodeIds: ['flow:login', 'capability:login'] }] };
  const before = structuredClone(graph);
  assert.deepEqual(uaStructuralGraph(graph, 'full_system'), graph);
  assert.equal(uaDomainGraph(graph, 'full_system'), null);
  assert.deepEqual(uaStructuralGraph(graph).nodes.map(node => node.id), ['module:identity', 'file:auth.ts']);
  assert.deepEqual(uaDomainGraph(graph).nodes.map(node => node.id), ['capability:login', 'flow:login']);
  assert.deepEqual(uaStructuralGraph(graph, 'legacy_split'), uaStructuralGraph(graph));
  assert.deepEqual(graph, before);
  assert.equal(uaStructuralGraph(graph, 'full_system').edges.some(edge => edge.type === 'contains_flow'), false);
  assert.deepEqual(uaReaderNodeMessage({ type: 'tsp.ua.select', channel: 'full', node_id: 'flow:login' }, 'full', graph), { type: 'select', id: 'ua:flow:login' });
  const html = renderWorkbench({ view: 'understanding' }, context, result, [
    [['code-understanding-ua-map', 'PROJECT-A', 'RUN-A'], { run: run('RUN-A'), graph, projection: result, metadata_complete: true, reader_profile: 'full_system' }],
  ], graph);
  assert.match(html, /data-reader-profile="full_system"/);
  assert.match(renderWorkbench({ view: 'understanding' }, context, result, [], graph), /data-reader-profile="legacy_split"/);
});

test('authorized node details expose file and module rules, uncertainty and downstream metadata as escaped text', () => {
  for (const kind of ['module', 'file']) {
    const selected = node(`metadata-${kind}`, 'RUN-A', { kind, domain_meta: { entities: ['AuthenticatedActor'],
      userPurposes: ['帮助成员复用已有背景', '<img src=x onerror=alert(1)>'], unknowns: ['当前调用链的边界仍不确定。'],
      businessRules: ['身份来自认证上下文。', '未知：跨项目权限仍需核对。', '<script>alert(1)</script>'],
      crossDomainInteractions: ['认证完成后进入任务权限校验。'] } });
    const html = render(components.CodeNodeDetail, { result: { ...result, nodes: [selected], edges: [] }, node: selected, direction: 'both', onDirection() {}, onSelect() {} });
    for (const value of ['AuthenticatedActor', '用途', '帮助成员复用已有背景', '未决事项', '当前调用链的边界仍不确定。', '身份来自认证上下文。', '未知：跨项目权限仍需核对。', '认证完成后进入任务权限校验。', '&lt;script&gt;', '&lt;img']) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /<script>|<img|dangerouslySetInnerHTML/);
    assert.match(html, /REPO-A · RUN-A/);
  }
});

test('historical run links resolve beyond the bounded context list instead of silently choosing current', () => {
  const route = { view: 'understanding', understandingRun: 'RUN-OLD' };
  const html = renderWorkbench(route, context, result, [
    [['code-understanding-run', 'PROJECT-A', 'RUN-OLD'], run('RUN-OLD')],
    [['code-understanding-graph', 'PROJECT-A', { run_code: 'RUN-OLD', provider: 'ua', query: '', offset: 0, limit: 64 }], { ...result, runs: [run('RUN-OLD')] }],
  ]);
  assert.match(html, /RUN-OLD/);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /所选版本不存在/);
});

test('API requests use authenticated GET and preserve node identity through query encoding', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: result }), { status: 200 }); };
  try {
    assert.deepEqual(await api.getCodeUnderstandingGraph('项目/A', { run_code: 'RUN-A', node_id: 'ua:a/b?x=1', direction: 'in', limit: 200 }), result);
    assert.equal(requests[0].init.credentials, 'same-origin');
    assert.equal(requests[0].init.method ?? 'GET', 'GET');
    const url = new URL(requests[0].url, 'https://platform.invalid');
    assert.equal(url.pathname, '/api/projects/%E9%A1%B9%E7%9B%AE%2FA/code-understanding/graph');
    assert.equal(url.searchParams.get('node_id'), 'ua:a/b?x=1');
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'code_understanding_forbidden', message: 'Denied' } }), { status: 403 });
    await assert.rejects(api.getCodeUnderstandingContext('A'), /Denied/);
  } finally { globalThis.fetch = originalFetch; }
});

test('hosted API calls preserve project and job identity and request only registered repositories', async () => {
  const originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }); };
  try {
    await api.getCodeAnalysisRuntime('项目/A');
    await api.listCodeAnalyses('项目/A');
    await api.getCodeAnalysis('项目/A', 'job/A');
    await api.requestCodeAnalysis('项目/A', { idempotency_key: 'web-fixture', repository_codes: ['REPO-A'] });
    assert.ok(requests.every(row => row.init.credentials === 'same-origin'));
    assert.ok(requests[0].url.endsWith('/code-understanding/runtime'));
    assert.ok(requests[1].url.endsWith('/code-understanding/analyses'));
    assert.ok(requests[2].url.endsWith('/code-understanding/analyses/job%2FA'));
    assert.equal(requests[3].init.method, 'POST');
    assert.deepEqual(JSON.parse(requests[3].init.body), { idempotency_key: 'web-fixture', repository_codes: ['REPO-A'] });
    assert.doesNotMatch(requests[3].init.body, /workspace|local_path|branch|ref/);
  } finally { globalThis.fetch = originalFetch; }
});

test('English interface keeps repository and semantic content intact', () => {
  i18n.setLocale('en-US', false);
  try {
    const html = renderWorkbench({ view: 'understanding' });
    assert.match(html, /Specifications/);
    assert.match(html, /UA overview map/);
    assert.match(html, /演示仓库/);
    assert.match(html, /用户提供的职责说明/);
    assert.doesNotMatch(html, /代码理解|固定提交版本|阅读导览/);
    const selected = node('purpose-localization', 'RUN-A', { domain_meta: { userPurposes: ['用户的原始用途'], unknowns: ['用户的原始未知项'] } });
    const details = render(components.CodeNodeDetail, { result: { ...result, nodes: [selected], edges: [] }, node: selected, direction: 'both', onDirection() {}, onSelect() {} });
    assert.match(details, /Purposes/); assert.match(details, /Open questions/);
    assert.match(details, /用户的原始用途/); assert.match(details, /用户的原始未知项/);
  } finally { i18n.setLocale('zh-CN', false); }
});
