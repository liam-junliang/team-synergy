import { before, after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import ts from 'typescript';
let vite, api, helpers, assets, cases, executions, workbench, library, routing, switching, i18n, dialog;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [api, helpers, assets, cases, executions, workbench, library, routing, switching, i18n, dialog] = await Promise.all(['api.ts','testing.ts','TestAssets.tsx','TestCases.tsx','TestExecutions.tsx','TestingWorkbench.tsx','ProjectDocumentsWorkbench.tsx','workspaceRouting.ts','projectSwitching.ts','i18n.ts','WorkspaceDialog.tsx'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => i18n.setLocale('zh-CN', false));
const meta = { code: 'A', project_code: 'P', current_revision: 2, updated_at: '2026-10-18T00:00:00Z', owner_user_code: 'U', can_edit: true };
const assetContent = { title: '登录测试指南', summary: '登录与退出', purpose: 'guide', storage_kind: 'markdown', content: '# 指南\n\n**执行步骤**', url: null, file: null, git: null, module_code: null, requirement_codes: [], tags: ['登录'] };
const revision = { revision_code: 'R2', revision: 2, change_summary: '补充退出', created_by_user_code: 'U', created_at: '2026-10-18T00:00:00Z' };
const asset = { ...assetContent, ...meta, revisions: [{ ...assetContent, ...revision }, { ...assetContent, ...revision, revision: 1, revision_code: 'R1', title: '旧标题', content: '旧正文' }] };
const caseContent = { title: '登录成功', summary: '标准登录', module_code: null, requirement_codes: ['REQ'], priority: 'high', method: 'manual', suite: '冒烟', tags: ['登录'], preconditions: '账号已启用', steps: [{ action: '输入账号密码', expected: '进入首页' }], notes_markdown: '**检查登录状态**', asset_codes: ['A'] };
const testCase = { ...caseContent, ...meta, code: 'C', revisions: [{ ...caseContent, ...revision }] };
const execution = { code: 'E', project_code: 'P', title: '发布冒烟', tested_version: 'v1', environment: 'Chrome / staging', commit_sha: 'a'.repeat(40), source: 'manual', executor_user_code: 'U', created_at: meta.updated_at, task_code: null, notes_markdown: '', counts: { pass: 0, fail: 1, not_run: 0, blocked: 0, skipped: 0 }, assets: [], results: [{ case_code: 'C', case_revision: 1, result_code: 'ER', result: 'fail', actual_result: '仍在登录页', notes: '', report_urls: ['https://example.test/report'], snapshot: { ...caseContent, ...revision, revision: 1 }, defect_code: null, is_outdated: true }] };
function render(Component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of entries) client.setQueryData(key, value);
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
test('testing routes and project switching retain tab but discard foreign identifiers', () => {
  assert.deepEqual(routing.parseWorkspacePath('/projects/P/testing?tab=assets&item=A'), { view: 'testing', projectCode: 'P', testingTab: 'assets', testingCode: 'A' });
  assert.equal(switching.projectSwitchPath({ view: 'testing', projectCode: 'P', testingTab: 'executions', testingCode: 'E' }, 'Q'), '/projects/Q/testing?tab=executions');
  assert.ok(routing.isWorkspacePath('/projects/P/testing'));
  assert.equal(routing.PROJECT_SECTIONS.indexOf('testing') + 1, routing.PROJECT_SECTIONS.indexOf('defects'));
});
test('asset reader shares Markdown and version controls without a raw content editor', () => {
  const html = render(assets.TestAssetReader, { document: asset, onEdit() {} });
  assert.match(html, /<strong>执行步骤<\/strong>/); assert.match(html, /sticky top-0 z-10/); assert.match(html, /bg-white/);
  assert.match(html, /aria-controls="testing-history-A"/); assert.match(html, /编辑当前版本/); assert.doesNotMatch(html, /旧正文/);
  const readonly = render(assets.TestAssetReader, { document: { ...asset, can_edit: false }, onEdit() {} });
  assert.doesNotMatch(readonly, /编辑当前版本/); assert.match(readonly, /版本记录/);
});
test('case reader renders structured preconditions, ordered actions and expected results', () => {
  const html = render(cases.TestCaseReader, { document: testCase, onEdit() {} });
  for (const text of ['账号已启用', '输入账号密码', '进入首页', '冒烟', '检查登录状态']) assert.ok(html.includes(text));
  assert.match(html, /<ol/); assert.match(html, /testing\?tab=assets&amp;item=A/);
});
test('case and asset drafts detach mutable arrays and clear incompatible source on save', () => {
  const draft = helpers.testCaseDraft(testCase); draft.steps[0].action = '修改'; draft.tags.push('新');
  assert.equal(testCase.steps[0].action, '输入账号密码'); assert.deepEqual(testCase.tags, ['登录']);
  const mixed = { ...assetContent, storage_kind: 'url', url: 'https://example.test', file: { content_base64: 'AA==' }, git: { repository_code: 'REPO' } };
  const saved = helpers.testAssetWriteContent(mixed);
  assert.equal(saved.file, null); assert.equal(saved.git, null); assert.equal(saved.url, 'https://example.test');
  assert.notEqual(mixed.file, null);
  assert.deepEqual(helpers.splitTestTags(' smoke,登录，smoke\n api '), ['smoke', '登录', 'api']);
});
test('file upload retains exact bytes and digest, rejects oversize, never executes source', async () => {
  const input = '<script>alert("no")</script>\n中文';
  const file = await helpers.readTestFile(new File([input], 'script.html', { type: 'text/html' }));
  assert.equal(new TextDecoder().decode(helpers.testFileBytes(file)), input); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(helpers.testFilePreview(file), input);
  const html = render(assets.TestAssetContentView, { asset: { ...assetContent, storage_kind: 'file', file } });
  assert.match(html, /下载文件/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|<iframe|srcdoc/);
  await assert.rejects(() => helpers.readTestFile(new File([new Uint8Array(6 * 1024 * 1024 + 1)], 'large.zip')), /6 MiB/);
});
test('external references reject active schemes and credential-bearing links', () => {
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,test', 'file:///secret', 'https://user:pass@example.test']) assert.equal(helpers.safeTestUrl(unsafe), undefined);
  const html = render(assets.TestAssetContentView, { asset: { ...assetContent, storage_kind: 'url', url: 'javascript:alert(1)' } });
  assert.match(html, /链接无效/); assert.doesNotMatch(html, /href="javascript/);
  const valid = render(assets.TestAssetContentView, { asset: { ...assetContent, storage_kind: 'url', url: 'https://example.test/docs' } });
  assert.match(valid, /target="_blank" rel="noopener noreferrer"/);
});
test('execution reader preserves old case content and limits defect actions to writable failed results', () => {
  const html = render(executions.TestExecutionReader, { execution, canWrite: true });
  for (const text of ['仍在登录页', 'r1', '用例已有新版本', '输入账号密码', '创建或关联缺陷', '已保存的执行记录不可修改']) assert.ok(html.includes(text));
  assert.doesNotMatch(render(executions.TestExecutionReader, { execution, canWrite: false }), /创建或关联缺陷/);
  const passed = { ...execution, results: [{ ...execution.results[0], result: 'pass' }] };
  assert.doesNotMatch(render(executions.TestExecutionReader, { execution: passed, canWrite: true }), /创建或关联缺陷/);
});
test('testing system folder uses shared reader and refuses general document or subfolder creation', () => {
  const folders = [{ folder_code: 'F', system_role: 'testing', parent_folder_code: null, can_edit: false, can_create_folder: false }];
  assert.equal(library.isSourceDocumentFolder(folders, 'F'), true); assert.equal(library.canCreateHandoffSubfolder(folders, 'F'), false);
  const document = { document_code: 'A', project_code: 'P', source_kind: 'testing', testing_asset: asset, source_can_edit: true };
  const html = render(library.ProjectTestingDocument, { document }); assert.match(html, /登录测试指南/); assert.match(html, /执行步骤/);
  assert.doesNotMatch(render(library.ProjectTestingDocument, { document: { ...document, source_can_edit: false } }), /编辑当前版本/);
  assert.match(render(library.ProjectTestingDocument, { document: { ...document, testing_asset: { ...asset, project_code: 'Q' } } }), /读取不完整/);
});
test('unknown or Viewer project access keeps workbench read-only and deep links cannot show another project', () => {
  const entries = [[['test-cases', 'P', {}], [testCase]], [['test-case', 'C'], testCase]];
  const unknown = render(workbench.TestingWorkbench, { projectCode: 'P', tab: 'cases', itemCode: 'C' }, entries);
  assert.doesNotMatch(unknown, /新建测试用例|编辑当前版本/);
  const viewer = render(workbench.TestingWorkbench, { projectCode: 'P', tab: 'cases', itemCode: 'C' }, [...entries, [['project','P'], { code: 'P', role: 'viewer', status: 'active' }]]);
  assert.doesNotMatch(viewer, /新建测试用例|编辑当前版本/); assert.match(viewer, /只读状态/);
  const foreign = render(workbench.TestingWorkbench, { projectCode: 'P', tab: 'cases', itemCode: 'C' }, [[['test-case','C'], { ...testCase, project_code: 'Q' }]]);
  assert.match(foreign, /不属于当前项目/); assert.doesNotMatch(foreign, /输入账号密码/);
});
test('structured editors have labels, version guards, accessible dialog and fixed footer form submission', () => {
  const caseHtml = render(cases.TestCaseEditor, { projectCode: 'P', initial: testCase, onClose() {}, onSaved() {} });
  assert.match(caseHtml, /aria-modal="true"/); assert.match(caseHtml, /form="test-case-editor-form" type="submit"/); assert.match(caseHtml, /变更说明/); assert.match(caseHtml, /<textarea/); assert.doesNotMatch(caseHtml, /JSON 编辑器/);
  const fileHtml = render(assets.TestAssetEditor, { projectCode: 'P', onClose() {}, onSaved() {} }); assert.match(fileHtml, /资料来源/); assert.match(fileHtml, /Markdown/);
  const execHtml = render(executions.TestExecutionEditor, { projectCode: 'P', onClose() {}, onSaved() {} }); assert.match(execHtml, /保存后不可修改/); assert.match(execHtml, /required/); assert.match(execHtml, /保存执行记录/);
});
test('Web API uses encoded authenticated routes and sends exact base and execution revisions', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: execution }), { status: 200 }); };
  try {
    await api.listTestCases('P /1', { q: '登录 +', method: 'manual' });
    await api.reviseTestAsset('A /1', { base_revision: 2, change_summary: '修订', content: '新正文' });
    const input = { title: '执行', environment: 'test', tested_version: 'v1', results: [{ case_code: 'C', case_revision: 1, result: 'fail' }], asset_refs: [{ asset_code: 'A', revision: 1 }] };
    await api.createTestExecution('P', input);
    const linked = await api.linkTestResultDefect('E', 'ER', { defect_code: 'D' });
    assert.match(calls[0].url, /P%20%2F1\/test-cases\?q=/); assert.match(calls[0].url, /method=manual/);
    assert.equal(JSON.parse(calls[1].init.body).base_revision, 2); assert.deepEqual(JSON.parse(calls[2].init.body), input);
    assert.equal(calls[3].url, '/api/test-executions/E/results/ER/defect'); assert.equal(linked.code, 'E');
  } finally { globalThis.fetch = originalFetch; }
});
test('all testing interface messages have English translations without translating user content', () => {
  const missing = new Set();
  for (const file of ['TestingWorkbench.tsx', 'TestingShared.tsx', 'TestAssets.tsx', 'TestCases.tsx', 'TestExecutions.tsx', 'testing.ts']) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) { if (ts.isStringLiteralLike(node) && /\p{Script=Han}/u.test(node.text) && !i18n.englishMessages[node.text]) missing.add(`${file}: ${node.text}`); ts.forEachChild(node, visit); } visit(source);
  }
  assert.deepEqual([...missing], []);
  i18n.setLocale('en-US', false);
  assert.equal(i18n.systemFolderName({ name: '测试资料', system_role: 'testing' }), 'Test assets');
  const html = render(cases.TestCaseReader, { document: testCase, onEdit() {} }); assert.match(html, /Test cases/); assert.match(html, /登录成功/); assert.match(html, /Expected result/);
});

test('execution file retrieval selects exact revision and refuses missing or changed historical files', async () => {
  const oldFile = await helpers.readTestFile(new File(['old bytes'], 'report.txt', { type: 'text/plain' }));
  const newFile = await helpers.readTestFile(new File(['new bytes'], 'report.txt', { type: 'text/plain' }));
  const ref = { asset_code: 'A', revision: 1, snapshot: { ...assetContent, ...revision, storage_kind: 'file', file: { ...oldFile, content_base64: undefined } } };
  const detail = { ...asset, file: newFile, revisions: [{ ...asset.revisions[0], revision: 2, file: newFile }, { ...asset.revisions[1], revision: 1, file: oldFile }] };
  assert.equal(helpers.testExecutionFile(ref, detail), oldFile);
  assert.equal(helpers.testExecutionFile(ref, { ...detail, revisions: [detail.revisions[0]] }), undefined);
  assert.equal(helpers.testExecutionFile(ref, { ...detail, revisions: [{ ...detail.revisions[1], file: newFile }] }), undefined);
  assert.equal(helpers.testExecutionFile(ref, { ...detail, code: 'OTHER' }), undefined);
  const html = render(executions.TestExecutionAssetSnapshot, { asset: ref }); assert.match(html, /下载执行时的文件/);
  assert.doesNotMatch(render(executions.TestExecutionReader, { execution, canWrite: false }), /testing\?tab=assets/);
});
test('LAN HTTP without SubtleCrypto still uploads bytes and delegates the digest to the server', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let file;
  try { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} }); file = await helpers.readTestFile(new File(['hello'], 'script.txt', { type: 'text/plain' })); } finally { Object.defineProperty(globalThis, 'crypto', cryptoDescriptor); }
  assert.equal(file.sha256, ''); assert.equal(new TextDecoder().decode(helpers.testFileBytes(file)), 'hello');
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, data: asset })); };
  try { await api.createTestAsset('P', { title: '上传', storage_kind: 'file', file }); await api.reviseTestAsset('A', { base_revision: 1, change_summary: '更新', file }); }
  finally { globalThis.fetch = originalFetch; }
  for (const input of calls) { assert.equal(Object.hasOwn(input.file, 'sha256'), false); assert.equal(input.file.content_base64, file.content_base64); }
});
test('safe uploaded raster images preview inline while HTML and SVG remain inert', () => {
  const file = { file_name: 'screen.png', mime_type: 'image/png', content_base64: 'iVBORw0KGgo=', size_bytes: 8, sha256: 'a'.repeat(64) };
  assert.match(render(assets.TestAssetContentView, { asset: { ...assetContent, storage_kind: 'file', file } }), /<img[^>]+src="data:image\/png;base64/);
  const svg = render(assets.TestAssetContentView, { asset: { ...assetContent, storage_kind: 'file', file: { ...file, mime_type: 'image/svg+xml', file_name: 'unsafe.svg' } } });
  assert.doesNotMatch(svg, /<img|<svg|<iframe/);
});
test('testing mutation invalidates linked defect and library caches without touching other projects', async () => {
  const shared = await vite.ssrLoadModule('/src/TestingShared.tsx');
  const client = new QueryClient();
  for (const key of [['defects', 'P'], ['defects','Q'], ['handoff-library','P'], ['test-execution','E']]) client.setQueryData(key, []);
  await shared.invalidateTestingQueries(client, 'P', 'E');
  assert.equal(client.getQueryState(['defects','P']).isInvalidated, true);
  assert.equal(client.getQueryState(['defects','Q']).isInvalidated, false);
  assert.equal(client.getQueryState(['handoff-library','P']).isInvalidated, true);
  assert.equal(client.getQueryState(['test-execution','E']).isInvalidated, true);
  client.clear();
});
