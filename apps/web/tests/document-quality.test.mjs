import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, ui, api, documents, markdown, architecture, i18n, rules;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, documents, markdown, architecture, i18n, rules] = await Promise.all([
    ...['DocumentQualityPanel.tsx', 'documentQualityApi.ts', 'ProjectDocumentsWorkbench.tsx', 'MarkdownDocument.tsx', 'ArchitectureWorkbench.tsx', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)),
    vite.ssrLoadModule(fileURLToPath(new URL('../../../packages/contracts/src/document-quality.ts', import.meta.url))),
  ]);
});
after(async () => { await vite?.close(); });
afterEach(() => {
  i18n.setLocale('zh-CN', false);
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

function report(overrides = {}) {
  return {
    ...rules.evaluateDocumentQuality({
      title: '任务领取需求规格', content: '# 任务领取\n\n用户角色为执行者。\n\n前置条件：任务已分派。\n\n权限不满足时拒绝领取。\n\n验收：仅已分派给当前用户的任务允许领取。',
      purpose: 'requirements', revision: 4, document_code: 'DOC', content_sha256: 'a'.repeat(64), checked_at: '2026-10-21T00:00:00Z',
    }),
    project_code: 'PROJECT', review: { status: 'not_requested', revision: 4 },
    adoption: { status: 'not_evaluated', note: '尚未核验执行基线。' }, ...overrides,
  };
}

function render(Component, props, entries = [], errors = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  errors.forEach(([queryKey, error]) => client.getQueryCache().build(client, { queryKey }).setState({ status: 'error', error }));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); }
  finally { client.clear(); }
}

const panelProps = { projectCode: 'PROJECT', documentCode: 'DOC', revision: 4 };
const queryKey = ['document-quality', 'PROJECT', 'DOC', 4, 'auto'];
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node?.props) return [];
  return [node, ...elements(node.props.children)];
}

test('summary separates completed rule checks from manual verification and inapplicable items', () => {
  const value = report({ ...rules.evaluateDocumentQuality({ title: '需求规格', content: '# 用户范围\n\n用户可以领取任务。\n\n## 验收\n\nTODO', purpose: 'requirements', revision: 4, document_code: 'DOC', content_sha256: 'a'.repeat(64), checked_at: '2026-10-21T00:00:00Z' }) });
  const { summary } = value;
  assert.ok(summary.failed > 0);
  assert.ok(summary.needs_review > 0);
  assert.equal(summary.checked, summary.passed + summary.failed);
  assert.equal(summary.applicable, summary.checked + summary.needs_review);
  const html = render(ui.QualityReportSummary, { report: value });
  assert.ok(html.includes(`适用 ${summary.applicable} 项 · 已检查 ${summary.checked} 项`));
  assert.ok(html.includes(`符合 ${summary.passed}`));
  assert.ok(html.includes(`待完善 ${summary.failed}`));
  assert.ok(html.includes(`待核验 ${summary.needs_review}`));
  assert.match(html, /人工待核验项不计入已检查分母/);
});

test('reference report displays inapplicable checks separately from applicable coverage', () => {
  const value = report({ ...rules.evaluateDocumentQuality({ title: '会议记录', content: '来源：产品会议，日期 2026-10-21。\n\n记录了任务领取讨论与待确认事项。', purpose: 'reference', revision: 4, document_code: 'DOC', content_sha256: 'a'.repeat(64), checked_at: '2026-10-21T00:00:00Z' }) });
  assert.ok(value.summary.not_applicable > 0);
  assert.equal(value.summary.applicable + value.summary.not_applicable, value.checks.length);
  const html = render(ui.QualityReportSummary, { report: value });
  assert.ok(html.includes(`不适用 ${value.summary.not_applicable}`));
});

test('passing text checks retain pending manual verification and never grant adoption', () => {
  const value = report();
  assert.equal(value.summary.failed, 0);
  const html = render(ui.DocumentQualityPanel, panelProps, [[queryKey, value]]);
  assert.match(html, /role="status"[^>]*>待人工核验/);
  assert.match(html, /人工评审.*尚未发起/);
  assert.match(html, /正式采用.*未核验/);
  assert.doesNotMatch(html, /规则检查通过|该版评审通过|已纳入基线|\d+\s*分|\d+%/);
});

test('panel displays the actual review result without changing rule findings', () => {
  const value = report({ review: { status: 'changes_requested', revision: 4, review_code: 'REVIEW' } });
  const html = render(ui.DocumentQualityPanel, panelProps, [[queryKey, value]]);
  assert.match(html, /人工评审.*需要修改/);
  assert.match(html, /待人工核验/);
  assert.doesNotMatch(html, /该版评审通过/);
});

test('summary preserves the review revision even when it differs from the checked document revision', () => {
  const html = render(ui.QualityReportSummary, { report: report({ review: { status: 'passed', revision: 3 } }) });
  assert.match(html, /该版评审通过 · r3/);
  assert.match(html, /正式采用/);
  assert.match(html, /未核验/);
});

test('cached quality reports must match project, document, revision and selected purpose', () => {
  const value = report();
  assert.equal(api.qualityReportMatches(value, 'PROJECT', 'DOC', 4), true);
  assert.equal(api.qualityReportMatches(value, 'PROJECT', 'DOC', 4, 'requirements'), true);
  for (const args of [['OTHER', 'DOC', 4], ['PROJECT', 'OTHER', 4], ['PROJECT', 'DOC', 3], ['PROJECT', 'DOC', 4, 'api']]) {
    assert.equal(api.qualityReportMatches(value, ...args), false);
  }
  assert.equal(api.qualityReportMatches(undefined, 'PROJECT', 'DOC', 4), false);
});

test('panel hides findings and review conclusions from another document version or project', () => {
  for (const changes of [{ project_code: 'OTHER' }, { document_code: 'OTHER' }, { revision: 3 }]) {
    const html = render(ui.DocumentQualityPanel, panelProps, [[queryKey, report({ ...changes, review: { status: 'passed', revision: 4 } })]]);
    assert.match(html, /检查版本已变化/);
    assert.doesNotMatch(html, /该版评审通过|人工评审|正式采用/);
  }
});

test('a failed quality request hides previously cached findings and approval conclusions', () => {
  const html = render(ui.DocumentQualityPanel, panelProps, [[queryKey, report({ review: { status: 'passed', revision: 4 } })]], [[queryKey, new Error('Forbidden')]]);
  assert.match(html, /检查未完成/);
  assert.doesNotMatch(html, /该版评审通过|人工评审|正式采用/);
});

test('quality API encodes document codes and explicitly binds revision and optional purpose', async () => {
  const requests = [];
  const value = report();
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: value }), { headers: { 'Content-Type': 'application/json' } }); };
  assert.deepEqual(await api.getDocumentQuality('DOC/中文 ?#', 4, 'requirements'), value);
  await api.getDocumentQuality('DOC', 3);
  assert.equal(requests[0].url, '/api/handoff-documents/DOC%2F%E4%B8%AD%E6%96%87%20%3F%23/quality?revision=4&purpose=requirements');
  assert.equal(requests[1].url, '/api/handoff-documents/DOC/quality?revision=3');
  assert.equal(requests[0].init.body, undefined);
});

test('quality API propagates service validation errors with their stable code and status', async () => {
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'document_quality_invalid', message: 'Unknown purpose' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(api.getDocumentQuality('DOC', 4, 'requirements'), error => error.code === 'document_quality_invalid' && error.status === 400 && error.originalMessage === 'Unknown purpose');
});

test('quality API reports non-JSON service failures instead of accepting an empty report', async () => {
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(api.getDocumentQuality('DOC', 4), /HTTP 503/);
});

test('findings prioritize actionable failures, preserve original checks and locate the reported source line', () => {
  const common = { category: '内容', severity: 'info', message: '说明', suggestion: '建议内容', standard_ids: [] };
  const checks = [
    { ...common, id: 'pass', title: 'Passed item', status: 'passed' },
    { ...common, id: 'manual', title: 'Manual item', status: 'needs_review' },
    { ...common, id: 'failed', title: 'Failed item', status: 'failed', severity: 'blocker', line_start: 12 },
    { ...common, id: 'na', title: 'Inapplicable item', status: 'not_applicable' },
  ];
  const located = [];
  const tree = ui.QualityCheckList({ checks, onLocate: line => located.push(line) });
  const html = renderToStaticMarkup(tree);
  assert.ok(html.indexOf('Failed item') < html.indexOf('Manual item'));
  assert.ok(html.indexOf('Manual item') < html.indexOf('Passed item'));
  assert.ok(html.indexOf('Passed item') < html.indexOf('Inapplicable item'));
  assert.match(html, /关键问题/);
  elements(tree).find(node => node.type === 'button').props.onClick();
  assert.deepEqual(located, [12]);
  assert.deepEqual(checks.map(check => check.id), ['pass', 'manual', 'failed', 'na']);
});

test('read-only findings show source locations without offering unavailable navigation', () => {
  const value = report();
  const html = render(ui.QualityCheckList, { checks: [{ ...value.checks[0], status: 'failed', line_start: 9 }] });
  assert.match(html, /正文第 9 行/);
  assert.doesNotMatch(html, /<button/);
});

test('report prose and findings escape malicious content instead of rendering executable markup', () => {
  const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const value = report({ scope_note: malicious });
  const summary = render(ui.QualityReportSummary, { report: value });
  const findings = render(ui.QualityCheckList, { checks: [{ ...value.checks[0], id: malicious, title: malicious, message: malicious, suggestion: malicious, status: 'failed' }] });
  for (const html of [summary, findings]) {
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<img|<script/);
  }
});

test('standards provide primary-source links and rule mappings without claiming standards certification', () => {
  const value = report();
  const html = render(ui.QualityStandards, { report: value });
  for (const standard of value.standards) {
    assert.ok(html.includes(`href="${standard.url}" target="_blank" rel="noopener noreferrer"`));
  }
  assert.match(html, /https:\/\/www\.iso\.org\/standard\/72089\.html/);
  assert.match(html, /requirements\.acceptance/);
  assert.match(html, /不提供标准符合性评分/);
  assert.match(html, /不证明标准符合性、认证或人工批准/);
  assert.match(html, /SHA-256/);
});

test('each standard lists only the checks mapped to that standard', () => {
  const value = report({ standards: [{ id: 'A', title: 'Standard A', url: 'https://www.iso.org/standard/72089.html', note: 'Reference only' }, { id: 'B', title: 'Standard B', url: 'https://www.iso.org/standard/74393.html', note: 'Reference only' }], checks: [
    { ...report().checks[0], id: 'rule-a', title: 'Only A', standard_ids: ['A'] },
    { ...report().checks[0], id: 'rule-b', title: 'Only B', standard_ids: ['B'] },
  ] });
  const html = render(ui.QualityStandards, { report: value });
  const sectionA = html.slice(html.indexOf('Standard A'), html.indexOf('Standard B'));
  assert.match(sectionA, /rule-a/);
  assert.doesNotMatch(sectionA, /rule-b|Only B/);
});

test('Markdown keeps source line attributes on actual rendered blocks for quality findings', () => {
  const html = render(markdown.MarkdownDocument, { content: '# 需求\n\n任务领取规则。\n\n- 当前负责人\n- 已分派状态\n\n| 角色 | 权限 |\n| --- | --- |\n| 执行者 | 领取 |' });
  assert.match(html, /<h1[^>]*data-source-line="1"[^>]*>需求<\/h1>/);
  assert.match(html, /<p data-source-line="3">任务领取规则。<\/p>/);
  assert.match(html, /<li data-source-line="5">当前负责人<\/li>/);
  assert.match(html, /<div class="markdown-table-scroll" data-source-line="8"[^>]*><table>/);
});

test('quality source annotations preserve inline formatting and the existing semantic table markup', () => {
  const html = render(markdown.MarkdownDocument, { content: '**关键规则** 与 `task_code`。\n\n| 角色 | 权限 |\n| --- | --- |\n| 执行者 | 领取 |' });
  assert.match(html, /<strong>关键规则<\/strong>/);
  assert.match(html, /<code>task_code<\/code>/);
  assert.match(html, /<table><thead><tr><th>角色<\/th><th>权限<\/th><\/tr><\/thead><tbody><tr><td>执行者<\/td><td>领取<\/td><\/tr><\/tbody><\/table>/);
});

test('quality translations preserve the established Test assets name across the application', () => {
  i18n.setLocale('en-US', false);
  assert.equal(i18n.t('测试资料'), 'Test assets');
  const html = render(ui.QualityReportSummary, { report: report({ purpose: 'testing' }) });
  assert.match(html, /Test assets/);
  assert.doesNotMatch(html, /Test material/);
});

function sourceElement(line) {
  const calls = [];
  return { dataset: { sourceLine: String(line) }, calls,
    scrollIntoView: value => calls.push(['scroll', value]),
    setAttribute: (...args) => calls.push(['attribute', ...args]),
    focus: value => calls.push(['focus', value]),
  };
}

test('finding navigation selects the nearest preceding rendered block and focuses it without a second scroll', () => {
  const nodes = [sourceElement(8), sourceElement(1), sourceElement(15)];
  const container = { querySelectorAll: selector => { assert.equal(selector, '.markdown-document [data-source-line]'); return nodes; } };
  assert.equal(documents.locateDocumentQualityLine(container, 12), true);
  assert.deepEqual(nodes[0].calls, [['scroll', { block: 'start', behavior: 'smooth' }], ['attribute', 'tabindex', '-1'], ['focus', { preventScroll: true }]]);
  assert.deepEqual(nodes[1].calls, []);
  assert.deepEqual(nodes[2].calls, []);
});

test('finding navigation safely reports no target when the reader or preceding source block is absent', () => {
  const future = sourceElement(8);
  const container = { querySelectorAll: () => [future] };
  assert.equal(documents.locateDocumentQualityLine(null, 8), false);
  assert.equal(documents.locateDocumentQualityLine(container, 0), false);
  assert.equal(documents.locateDocumentQualityLine(container, 7), false);
  assert.equal(documents.locateDocumentQualityLine({ querySelectorAll: () => [] }, 9), false);
  assert.deepEqual(future.calls, []);
});

test('embedded architecture reader requests a quality notice for its current revision', () => {
  const seen = [];
  const document = { document_code: 'ARCH', project_code: 'PROJECT', title: '组件设计', summary: '组件边界', current_revision: 7, content_kind: 'image', source_content: 'data:image/png;base64,iVBORw0KGgo=', notes_markdown: '', preview_svg: null, updated_at: '2026-10-21T00:00:00Z', can_edit: false, revisions: [] };
  const html = render(architecture.ArchitectureDocumentReader, { document, embedded: true, onEdit() {}, renderNotice: revision => { seen.push(revision); return createElement('p', null, `Quality revision ${revision}`); } });
  assert.deepEqual(seen, [7]);
  assert.match(html, /Quality revision 7/);
});
