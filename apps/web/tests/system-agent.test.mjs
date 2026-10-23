import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, api, ui, i18n, rules;
const originalFetch = globalThis.fetch;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [api, ui, i18n, rules] = await Promise.all([
    ...['systemAgentApi.ts', 'SystemAgentPanel.tsx', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)),
    vite.ssrLoadModule(fileURLToPath(new URL('../../../packages/contracts/src/document-quality.ts', import.meta.url))),
  ]);
});
after(async () => { await vite?.close(); });
afterEach(() => { globalThis.fetch = originalFetch; i18n.setLocale('zh-CN', false); });

const makeJob = (overrides = {}) => ({
  job_code: 'JOB', project_code: 'PROJECT', document_code: 'DOC', document_title: '发布说明',
  base_revision: 3, base_title: '旧标题', base_summary: '旧摘要', base_content: '# 流程\n执行发布\n验证健康',
  instruction: '补充失败分支', quote: '执行发布',
  proposal: { title: '新标题', summary: '新摘要', content: '# 流程\n执行发布\n失败时停止后续步骤\n验证健康', rationale: '保留已验证步骤，明确失败分支。', evidence: ['当前文档 r3'], warnings: ['恢复时限尚待确认'] },
  proposal_hash: 'a'.repeat(64), quality: null, execution_metadata: null,
  status: 'awaiting_review', error: null, created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z', applied_revision: null, can_apply: true,
  ...overrides,
});
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
function elements(node) { if (Array.isArray(node)) return node.flatMap(elements); if (!node?.props) return []; return [node, ...elements(node.props.children)]; }

test('create and adopt API retain project, exact base revision, quote, request key and proposal digest', async () => {
  const requests = [];
  globalThis.fetch = async (url, options = {}) => { requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) }); return new Response(JSON.stringify({ ok: true, data: makeJob() }), { status: 200 }); };
  await api.createSystemAgentJob('P/1', { document_code: 'D', base_revision: 7, quote: '原文\n行', instruction: '请检查', request_key: 'same-request' });
  await api.applySystemAgentJob('J/1', { base_revision: 7, proposal_hash: 'a'.repeat(64) });
  assert.deepEqual(requests, [
    { url: '/api/projects/P%2F1/system-agent/jobs', method: 'POST', body: { document_code: 'D', base_revision: 7, quote: '原文\n行', instruction: '请检查', request_key: 'same-request' } },
    { url: '/api/system-agent/jobs/J%2F1/apply', method: 'POST', body: { base_revision: 7, proposal_hash: 'a'.repeat(64) } },
  ]);
});

test('cancellation and rejection are explicit separate job endpoints; errors are not successful jobs', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, method: options.method }); return new Response(JSON.stringify({ ok: true, data: makeJob() }), { status: 200 }); };
  await api.cancelSystemAgentJob('J'); await api.rejectSystemAgentJob('J');
  assert.deepEqual(requests.map(value => value.url), ['/api/system-agent/jobs/J/cancel', '/api/system-agent/jobs/J/reject']);
  assert.ok(requests.every(value => value.method === 'POST'));
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'REVISION_CONFLICT', message: '文档已更新' } }), { status: 409 });
  await assert.rejects(api.applySystemAgentJob('J', { base_revision: 3, proposal_hash: 'a'.repeat(64) }), /文档已更新/);
});

test('document selection excludes source projections, archived, readonly and unknown-source documents', () => {
  const doc = { source_kind: 'project', status: 'active', can_edit: true };
  assert.equal(api.systemAgentDocumentEligible(doc), true);
  for (const source_kind of ['requirement', 'architecture', 'testing', undefined]) assert.equal(api.systemAgentDocumentEligible({ ...doc, source_kind }), false);
  assert.equal(api.systemAgentDocumentEligible({ ...doc, status: 'archived' }), false);
  assert.equal(api.systemAgentDocumentEligible({ ...doc, can_edit: false }), false);
});

test('annotations preserve an exact source quote and reject ambiguous rendered text', () => {
  const content = '# 任务\n\n用户必须 **拥有权限** 才可发布。\n错误时停止。';
  assert.equal(api.exactSystemAgentQuote(content, '  错误时停止。  '), '错误时停止。');
  assert.equal(api.exactSystemAgentQuote(content, '用户必须 拥有权限 才可发布。'), null);
  assert.equal(api.exactSystemAgentQuote(content, '   '), null);
  assert.equal(api.exactSystemAgentQuote(content, '拥有权限'), '拥有权限');
  assert.equal(api.exactSystemAgentQuote('x'.repeat(20_001), 'x'.repeat(20_001)), null);
  assert.equal(api.exactSystemAgentQuote('x'.repeat(20_001), 'x'.repeat(20_000)).length, 20_000);
});

test('draft restore retains idempotency and selected revision while refusing cross-project or malformed state', () => {
  const draft = { target: { project_code: 'P', document_code: 'D', title: '文档', base_revision: 4, quote: '原文' }, instruction: '完善', request_key: 'original-request', selected_job: 'J' };
  const storage = { getItem: () => JSON.stringify(draft) };
  assert.deepEqual(api.readSystemAgentDraft(storage, 'user/P', 'P'), draft);
  assert.equal(api.readSystemAgentDraft(storage, 'user/Q', 'Q').target, null);
  for (const value of ['{bad json', JSON.stringify({ ...draft, target: { ...draft.target, base_revision: -1 } }), JSON.stringify({ ...draft, target: { ...draft.target, quote: 7 } })]) assert.equal(api.readSystemAgentDraft({ getItem: () => value }, 'x', 'P').target, null);
  assert.equal(api.readSystemAgentDraft({ getItem: () => { throw Error('disabled'); } }, 'x', 'P').instruction, '');
});

test('explicit new task starts a distinct request and waits for a fresh document snapshot while retry retains its request', () => {
  const previous = { target: { project_code: 'P', document_code: 'D', title: '文档', base_revision: 3, quote: '旧引用' }, instruction: '补充失败分支', request_key: 'old-request', selected_job: 'completed-job' };
  const next = api.newSystemAgentDraft(previous.instruction, 'new-request');
  assert.equal(next.instruction, previous.instruction);
  assert.equal(next.target, null, 'stale revision and old quote must not be submitted while reloading the document');
  assert.equal(next.selected_job, null);
  assert.notEqual(next.request_key, previous.request_key);
  assert.equal(api.readSystemAgentDraft({ getItem: () => JSON.stringify(previous) }, 'user/P', 'P').request_key, previous.request_key, 'an uncertain submission retries with its original key');
});

test('manual document and homepage editing send the revision being edited for atomic conflict protection', async () => {
  const [library, overview] = await Promise.all(['ProjectDocumentsWorkbench.tsx', 'ProjectOverviewWorkbench.tsx'].map(file => vite.ssrLoadModule(`/src/${file}`)));
  const document = { current_revision: 3, kind: 'doc', folder_code: 'F', status: 'active' };
  const draft = { title: 'edited', content: 'draft', kind: 'doc', base_revision: 999 };
  assert.equal(library.handoffRevisionInput(document, draft).base_revision, 3);
  assert.equal(overview.homeDocumentRevision(document, draft).base_revision, 3);
});

test('line comparison is lossless for additions, removals, repeated lines, CRLF and large content', () => {
  const cases = [
    ['', ''], ['a\nb\nc', 'a\nx\nc'], ['a\nx\na\nb', 'a\nb\na\nc'], ['a\r\nb\r\n', 'a\r\nc\r\n'], ['tail', 'head\ntail'],
    [Array.from({ length: 1200 }, (_, i) => `before ${i}`).join('\n'), Array.from({ length: 1200 }, (_, i) => `after ${i}`).join('\n')],
  ];
  for (const [before, after] of cases) {
    const diff = api.systemAgentLineDiff(before, after);
    assert.equal(diff.filter(line => line.kind !== 'added').map(line => line.text).join('\n'), before);
    assert.equal(diff.filter(line => line.kind !== 'removed').map(line => line.text).join('\n'), after);
    assert.deepEqual(diff.filter(line => line.before).map(line => line.before), before.split('\n').map((_, i) => i + 1));
    assert.deepEqual(diff.filter(line => line.after).map(line => line.after), after.split('\n').map((_, i) => i + 1));
  }
});

test('approval requires a ready proposal, digest and current permission for every terminal/active state', () => {
  assert.equal(api.systemAgentCanApply(makeJob()), true);
  for (const status of ['queued', 'running', 'applied', 'rejected', 'failed', 'cancelled']) assert.equal(api.systemAgentCanApply(makeJob({ status })), false);
  for (const changes of [{ proposal_hash: null }, { proposal: null }, { can_apply: false }]) assert.equal(api.systemAgentCanApply(makeJob(changes)), false);
  assert.equal(api.systemAgentJobActive(makeJob({ status: 'running' })), true);
  assert.equal(api.systemAgentJobActive(makeJob({ status: 'awaiting_review' })), false);
});

test('proposal screen includes complete title/summary/content changes, rationale, evidence and unknowns without approving', () => {
  const job = makeJob();
  const html = render(ui.SystemAgentProposalReview, { job, mode: 'diff', onModeChange() {} });
  for (const text of ['旧标题', '新标题', '旧摘要', '新摘要', '失败时停止后续步骤', '验证健康', '当前文档 r3', '恢复时限尚待确认', '完整修改对比', '尚无草稿规则检查结果']) assert.ok(html.includes(text), text);
  assert.match(html, /system-agent-diff-added/);
  assert.match(html, /system-agent-diff-removed/);
  assert.match(html, /若原文已更新，平台会拒绝覆盖/);
  const escaped = render(ui.SystemAgentProposalReview, { job: makeJob({ proposal: { ...job.proposal, content: '<script>alert(1)</script>' } }), mode: 'preview', onModeChange() {} });
  assert.doesNotMatch(escaped, /<script>/);
});

test('draft quality presents separate check and review counts plus each finding', () => {
  const quality = rules.evaluateDocumentQuality({ title: '需求规格', content: '# 范围\n用户领取任务。\nTODO', purpose: 'requirements', revision: 4, document_code: 'D', content_sha256: 'a'.repeat(64), checked_at: '2026-10-21T00:00:00Z' });
  const html = render(ui.SystemAgentProposalReview, { job: makeJob({ quality }), mode: 'diff', onModeChange() {} });
  assert.ok(html.includes(`符合 ${quality.summary.passed} · 待完善 ${quality.summary.failed} · 待核验 ${quality.summary.needs_review}`));
  for (const check of quality.checks) assert.ok(html.includes(check.title));
  assert.doesNotMatch(html, /人工评审通过|认证通过/);
});

test('candidate preview never fetches model-supplied images while preserving explicit safe links', () => {
  const content = [
    '![远程图片](https://example.com/collect?secret=private-content)',
    '![相对路径](/api/collect?secret=private-content)',
    '![内联图片](data:image/png;base64,aGVsbG8=)',
    '![引用图片][asset]',
    '[asset]: //example.com/collect?secret=private-content',
    '[用户主动打开](https://example.com/reference)',
  ].join('\n\n');
  const job = makeJob();
  const html = render(ui.SystemAgentProposalReview, { job: { ...job, proposal: { ...job.proposal, content } }, mode: 'preview', onModeChange() {} });
  assert.doesNotMatch(html, /<(?:img|link)\b|\bsrc=|private-content|data:image/);
  for (const alt of ['远程图片', '相对路径', '内联图片', '引用图片']) assert.ok(html.includes(alt));
  assert.match(html, /图片预览已禁用/);
  assert.match(html, /<a[^>]*href="https:\/\/example\.com\/reference"[^>]*rel="noopener noreferrer"/);
  const diagram = render(ui.SystemAgentProposalReview, { job: { ...job, proposal: { ...job.proposal, content: '```mermaid\ngraph TD; A-->B;\n```' } }, mode: 'preview', onModeChange() {} });
  assert.match(diagram, /<pre\b[^>]*><code class="language-mermaid">/);
  assert.doesNotMatch(diagram, /diagram-preview|正在生成图表/);
});

test('only an explicit enabled approval click calls adoption; cancelled and applied jobs cannot adopt', () => {
  const calls = [];
  const props = { job: makeJob(), pending: false, applying: false, canWrite: true, refreshing: false, onAction: kind => calls.push(kind), onNew() {}, onRefresh() {} };
  const buttons = elements(ui.SystemAgentJobActions(props)).filter(element => element.type === 'button');
  const approve = buttons.find(button => button.props.children === '确认采用并保存新版本');
  assert.deepEqual(calls, []);
  assert.equal(approve.props.disabled, false);
  approve.props.onClick(); assert.deepEqual(calls, ['apply']);
  for (const changes of [{ canWrite: false }, { pending: true }, { job: makeJob({ can_apply: false }) }]) {
    const button = elements(ui.SystemAgentJobActions({ ...props, ...changes })).find(element => element.type === 'button' && element.props.children === '确认采用并保存新版本');
    assert.equal(button.props.disabled, true); button.props.onClick();
  }
  assert.deepEqual(calls, ['apply']);
  for (const status of ['cancelled', 'applied', 'failed', 'running']) assert.doesNotMatch(render(ui.SystemAgentJobActions, { ...props, job: makeJob({ status }) }), /确认采用并保存新版本/);
});

test('job context preserves annotation and execution provenance and translates actionable UI', () => {
  const job = makeJob({ execution_metadata: { engine: 'dsh', engine_version: '0.9', model: 'model-name', skill_version: '1.0', skill_sha256: 'b'.repeat(64) } });
  const html = render(ui.SystemAgentJobContext, { job });
  for (const text of ['执行发布', '补充失败分支', '基于文档 r3', '执行依据', 'model-name', 'b'.repeat(64)]) assert.ok(html.includes(text));
  i18n.setLocale('en-US', false);
  const translated = render(ui.SystemAgentJobActions, { job, pending: false, applying: false, canWrite: true, refreshing: false, onAction() {}, onNew() {}, onRefresh() {} });
  assert.match(translated, /Confirm adoption and save new revision/);
  assert.doesNotMatch(translated, /确认采用|拒绝这份|刷新状态/);
});
