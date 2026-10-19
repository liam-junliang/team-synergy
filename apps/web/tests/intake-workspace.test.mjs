import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, ui, api, routing, switching, navigation, i18n, errors;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, routing, switching, navigation, i18n, errors] = await Promise.all(['IntakeWorkbench.tsx', 'intakeApi.ts', 'workspaceRouting.ts', 'projectSwitching.ts', 'ProjectWorkspace.tsx', 'i18n.ts', 'apiError.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => { i18n.setLocale('zh-CN', false); globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
function render(Component, props = {}, entries = [], errorEntries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  errorEntries.forEach(([queryKey, error]) => client.getQueryCache().build(client, { queryKey }).setState({ status: 'error', error }));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
const item = { key: 'module.auth', kind: 'module', title: '账户权限', summary: 'Role rules', content_markdown: '## Evidence\n\n| Name | Rule |\n| --- | --- |\n| Admin | Explicit access |', evidence: [{ path: 'src/auth.ts', sha256: 'a'.repeat(64), line_start: 10, line_end: 20, symbol: 'authorize' }], assessment: 'observed_in_code', tests: [{ path: 'tests/auth.test.ts', name: 'reject viewer', status: 'passed' }], gaps: ['Browser interaction not checked'] };
const source = { commit: 'a'.repeat(40), dirty: true, scope: ['src', 'tests'], files: [{ path: 'src/auth.ts', sha256: 'a'.repeat(64) }], manifest_sha256: 'b'.repeat(64), complete: false, exclusions: ['src/legacy unreadable'], analyzed_at: '2026-10-18T00:00:00Z', skill_version: '1.0.0' };
const view = { item, decision: null, status: 'pending', target_code: null, error: null, existing_binding: null };
const batch = { code: 'BATCH', project_code: 'PROJECT', repository_code: 'REPOSITORY', namespace: 'auth-intake', status: 'draft', revision: 1, created_by: 'LIAM', created_at: '2026-10-18', updated_at: '2026-10-18', item_count: 1, applied_count: 0, plan_hash: null, source, items: [view], can_review: true, can_edit: true, stop_requested: false, targets: [] };
const callbacks = { onSaved: async () => {}, onRefresh() {}, onDecision() {}, onRetry() {} };

test('intake lives under Project and project switching preserves only the tab', () => {
  const route = routing.parseWorkspacePath('/projects/P/overview?tab=intake&document=OLD');
  assert.deepEqual(route, { view: 'overview', projectCode: 'P', projectTab: 'intake' });
  assert.equal(switching.projectSwitchPath(route, 'NEXT'), '/projects/NEXT/overview?tab=intake');
  const html = render(navigation.ProjectWorkspaceNavigation, { projectCode: 'P', tab: 'intake' });
  assert.match(html, /href="\/projects\/P\/overview\?tab=intake" aria-current="page"/);
  assert.match(html, /代码规格/);
});

test('upload preview rejects wrong project, legacy pilot schema, invalid JSON and oversized UTF-8', () => {
  const bundle = { schema_version: 1, project_code: 'PROJECT', namespace: 'auth', source, items: [item] };
  assert.deepEqual(api.parseIntakeUpload(JSON.stringify(bundle), 'PROJECT'), bundle);
  assert.throws(() => api.parseIntakeUpload(JSON.stringify(bundle), 'OTHER'), /不属于当前项目/);
  assert.throws(() => api.parseIntakeUpload(JSON.stringify({ ...bundle, schema_version: 'intake-pilot/0.1' }), 'PROJECT'), /格式不正确/);
  assert.throws(() => api.parseIntakeUpload('null', 'PROJECT'), /格式不正确/);
  assert.throws(() => api.parseIntakeUpload('{invalid', 'PROJECT'), /有效的 JSON/);
  assert.throws(() => api.parseIntakeUpload(JSON.stringify({ ...bundle, namespace: '文'.repeat(3_500_000) }), 'PROJECT'), /10 MiB/);
});

test('review never defaults to approval and prevents skipped dependency publication', () => {
  assert.match(api.intakeReviewProblem(batch, {}), /逐项选择/);
  assert.equal(api.intakeReviewProblem(batch, { [item.key]: { key: item.key, action: 'create' } }), null);
  const feature = { ...view, item: { ...item, key: 'feature.auth', kind: 'feature', module_key: item.key } };
  const dependent = { ...batch, items: [view, feature] };
  assert.match(api.intakeReviewProblem(dependent, { [item.key]: { key: item.key, action: 'skip' }, 'feature.auth': { key: 'feature.auth', action: 'create' } }), /依赖项未批准/);
  const html = render(ui.IntakeBatchReader, { batch, ...callbacks });
  assert.match(html, /<option value="" disabled="" selected="">请选择动作<\/option>/);
  assert.match(html, /disabled="">冻结发布计划/);
  assert.doesNotMatch(html, /发布已审阅项|继续发布|删除|结束任务/);
});

test('links require the same kind and current target fingerprint, and existing mappings cannot create duplicates', () => {
  const target = { kind: 'module', code: 'EXISTING', title: 'Existing module', fingerprint: 'current' };
  const linked = { ...batch, targets: [target] };
  const decision = { key: item.key, action: 'bind', target_code: target.code, target_fingerprint: target.fingerprint };
  assert.equal(api.intakeReviewProblem(linked, { [item.key]: decision }), null);
  assert.match(api.intakeReviewProblem(linked, { [item.key]: { ...decision, target_fingerprint: 'stale' } }), /目标已变化/);
  assert.match(api.intakeReviewProblem({ ...linked, targets: [{ ...target, kind: 'feature' }] }, { [item.key]: decision }), /目标已变化/);
  assert.match(api.intakeReviewProblem({ ...batch, items: [{ ...view, existing_binding: target }] }, { [item.key]: { key: item.key, action: 'create' } }), /已有映射/);
});

test('publish gates depend on server capability and a frozen plan, including resumption', () => {
  assert.equal(api.intakeCanPublish(batch, false), false);
  const ready = { ...batch, status: 'ready', plan_hash: 'f'.repeat(64), can_edit: false };
  assert.equal(api.intakeCanPublish(ready, false), true);
  assert.equal(api.intakeCanPublish(ready, true), false);
  assert.equal(api.intakeCanPublish({ ...ready, can_review: false }, false), false);
  for (const status of ['draft', 'applying', 'applied', 'cancelled']) assert.equal(api.intakeCanPublish({ ...ready, status }, false), false);
  for (const status of ['partial', 'stopped']) assert.equal(api.intakeCanPublish({ ...ready, status }, false), true);
  const html = render(ui.IntakeBatchReader, { batch: { ...ready, can_review: false }, ...callbacks });
  assert.doesNotMatch(html, /<button[^>]*>发布已审阅项|审阅动作|调整审阅|冻结发布计划|替换未冻结候选/);
  assert.match(html, /由项目负责人或管理员完成/);
});

test('candidate preview uses shared Markdown and shows source limits and client-reported test evidence', () => {
  const html = render(ui.IntakeCandidateReader, { batch, view, editable: false, ...callbacks });
  assert.match(html, /<table>/); assert.match(html, /Admin/);
  assert.match(html, /src\/auth.ts:10–20/); assert.match(html, /authorize/);
  assert.match(html, /客户端报告，平台未独立验证/); assert.match(html, /报告通过/);
  assert.match(html, /Browser interaction not checked/);
  const snapshot = render(ui.IntakeSource, { source });
  for (const text of ['有未提交改动', '扫描未完整', '不代表已部署版本', 'src/legacy unreadable', 'b'.repeat(64)]) assert.ok(snapshot.includes(text));
});

test('binding compares existing and candidate content and never offers overwrite', () => {
  const target = { kind: 'module', code: 'M1', title: 'Target module', fingerprint: 'fingerprint', summary: 'Existing summary', content_markdown: '**Existing body**' };
  const html = render(ui.IntakeCandidateReader, { batch: { ...batch, targets: [target, { ...target, kind: 'feature', code: 'F1', title: 'Wrong type' }] }, view, decision: { key: item.key, action: 'bind', target_code: 'M1', target_fingerprint: 'fingerprint' }, editable: true, ...callbacks });
  assert.match(html, /<strong>Existing body<\/strong>/); assert.match(html, /候选内容/);
  assert.match(html, /不覆盖已有正文或创建新版本/); assert.doesNotMatch(html, /Wrong type/);
  assert.doesNotMatch(html, /value="(?:overwrite|delete|update)"/);
});

test('binding an existing Mermaid architecture previews its graph source even when it has no notes', () => {
  const target = { kind: 'architecture', code: 'ARCH', title: 'Existing graph', fingerprint: 'fingerprint', content_markdown: '', diagram: { content_kind: 'mermaid', source_content: 'flowchart LR\nExistingA-->ExistingB', preview_svg: null } };
  const architecture = { ...view, item: { ...item, kind: 'architecture', diagram_source: 'flowchart LR\nCandidateA-->CandidateB' } };
  const html = render(ui.IntakeCandidateReader, { batch: { ...batch, targets: [target] }, view: architecture, decision: { key: item.key, action: 'bind', target_code: 'ARCH', target_fingerprint: 'fingerprint' }, editable: true, ...callbacks });
  assert.match(html, /aria-label="Existing graph"/);
  assert.match(html, /ExistingA--&gt;ExistingB/);
  assert.match(html, /CandidateA--&gt;CandidateB/);
  assert.match(html, /Mermaid 图源/);
  assert.doesNotMatch(html, /此目标没有正文/);
});

test('existing draw.io target uses safe image preview, keeps XML escaped, and falls back to its read-only frame', () => {
  const target = { kind: 'architecture', code: 'ARCH', title: 'Existing draw.io', fingerprint: 'fingerprint', content_markdown: '', diagram: { content_kind: 'drawio', source_content: '<mxfile><diagram name="Current"><mxGraphModel /></diagram></mxfile>', preview_svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><text>Current drawing</text></svg>' } };
  const html = render(ui.IntakeTargetContent, { target });
  assert.match(html, /<img src="data:image\/svg\+xml/);
  assert.match(html, /alt="Existing draw.io"/);
  assert.match(html, /&lt;mxfile&gt;/);
  assert.doesNotMatch(html, /<mxfile>|<svg |此目标没有正文/);
  const fallback = render(ui.IntakeTargetContent, { target: { ...target, diagram: { ...target.diagram, preview_svg: null } } });
  assert.match(fallback, /<iframe/); assert.match(fallback, /sandbox="/);
  assert.match(fallback, /title="Existing draw.io"/);
});

test('existing architecture links to its original reader in a safe new tab even without an inline diagram', () => {
  const target = { kind: 'architecture', code: 'IMAGE/1', title: 'Existing image architecture', fingerprint: 'fingerprint', content_markdown: '' };
  const architecture = { ...view, item: { ...item, kind: 'architecture', diagram_source: 'flowchart LR\nCandidateA-->CandidateB' } };
  const html = render(ui.IntakeCandidateReader, { batch: { ...batch, targets: [target] }, view: architecture, decision: { key: item.key, action: 'bind', target_code: target.code, target_fingerprint: target.fingerprint }, editable: true, ...callbacks });
  assert.match(html, /href="\/projects\/PROJECT\/overview\?tab=architecture&amp;document=IMAGE%2F1" target="_blank" rel="noopener noreferrer">查看现有架构<\/a>/);
  assert.equal(i18n.englishMessages['查看现有架构'], 'Open existing architecture');
});

test('permission errors hide stale cached candidates instead of exposing the former member preview', () => {
  for (const [code, status] of [['forbidden', 403], ['intake_forbidden', 200], ['project_forbidden', 200]]) {
    const html = render(ui.IntakeWorkbench, { projectCode: 'PROJECT' }, [
      [['intakes', 'PROJECT'], { can_submit: true, can_review: true, batches: [batch] }],
      [['intake', 'PROJECT', 'BATCH'], batch],
    ], [[['intakes', 'PROJECT'], new errors.ApiError(code, 'Forbidden', status)]]);
    assert.match(html, /当前身份不能访问代码候选/); assert.match(html, /观看者/);
    assert.doesNotMatch(html, /账户权限|src\/auth.ts|上传候选 JSON|接入批次列表/);
  }
});

test('intake errors translate stable codes in both locales and retain original diagnostics', () => {
  for (const [code, chinese, english] of [['intake_invalid', '请检查候选格式', 'Check the candidate format'], ['intake_conflict', '批次、关联目标', 'The batch, target'], ['intake_forbidden', '当前项目权限', 'Your current project permissions'], ['intake_not_found', '当前项目中', 'This intake batch']]) {
    const error = new errors.ApiError(code, 'Original validation message', 200);
    i18n.setLocale('zh-CN', false); assert.ok(error.message.includes(chinese));
    i18n.setLocale('en-US', false); assert.ok(error.message.includes(english));
    assert.equal(error.originalMessage, 'Original validation message');
  }
});

test('filters cover kinds, real committed state and conflict attention without treating a recommendation as publication', () => {
  const values = [view, { ...view, item: { ...item, key: 'mapped' }, existing_binding: { code: 'M1' } }, { ...view, item: { ...item, key: 'bound' }, status: 'bound' }, { ...view, item: { ...item, key: 'blocked', kind: 'feature' }, status: 'blocked' }];
  assert.deepEqual(api.filterIntakeItems(values, '', 'applied', '').map(value => value.item.key), ['bound']);
  assert.deepEqual(api.filterIntakeItems(values, '', 'conflict', '').map(value => value.item.key), ['mapped', 'blocked']);
  assert.equal(api.filterIntakeItems(values, 'feature', '', 'blocked').length, 1);
});

test('stop remains enabled while apply runs and reading structure clips body above the opaque sticky header', () => {
  const running = { ...batch, status: 'applying', plan_hash: 'f'.repeat(64), can_edit: false };
  const html = render(ui.IntakeBatchReader, { batch: running, applyPending: true, ...callbacks });
  const stop = html.match(/<button[^>]*>停止此批次<\/button>/)?.[0];
  assert.ok(stop); assert.doesNotMatch(stop, /disabled/);
  assert.match(html, /候选清单/); assert.match(html, /min-h-0 flex-1 overflow-y-auto overscroll-contain/);
  assert.match(html, /overflow-clip rounded-xl/);
  assert.match(html, /scroll-region max-h-\[calc\(100dvh-12rem\)\] min-h-\[20rem\] overflow-y-auto overscroll-contain"><header class="sticky top-0 z-10 border-b border-slate-200 bg-white/);
  const source = readFileSync(new URL('../src/IntakeWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /applying \|\| query.state.data\?\.status === 'applying'/);
  assert.match(source, /const current = await getIntake[\s\S]*return stopIntake\(batch.project_code, batch.code, current.revision\)/);
});

test('a remounted publishing batch explains stop-and-resume recovery without promising its old request key or automatically resuming', () => {
  const running = { ...batch, status: 'applying', plan_hash: 'f'.repeat(64), can_edit: false };
  const html = render(ui.IntakeBatchReader, { batch: running, applyPending: false, ...callbacks });
  assert.match(html, /请重新读取发布结果；若持续显示发布中且没有进展，可停止此批次后继续发布，已完成项会保留/);
  const stop = html.match(/<button[^>]*>停止此批次<\/button>/)?.[0];
  assert.ok(stop); assert.doesNotMatch(stop, /disabled/);
  assert.doesNotMatch(html, /重试发布会复用本次请求标识|<button[^>]*>继续发布<\/button>/);
  const active = render(ui.IntakeBatchReader, { batch: running, applyPending: true, ...callbacks });
  assert.doesNotMatch(active, /请重新读取发布结果；若持续显示/);
  const reader = render(ui.IntakeBatchReader, { batch: { ...running, can_review: false }, ...callbacks });
  assert.doesNotMatch(reader, /可停止此批次后继续发布|<button[^>]*>停止此批次<\/button>/);
  const stopped = render(ui.IntakeBatchReader, { batch: { ...running, status: 'stopped', stop_requested: true }, ...callbacks });
  assert.match(stopped, /<button[^>]*>继续发布<\/button>/);
  const source = readFileSync(new URL('../src/IntakeWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(source, /onError: \(_error, action\) => \{\s*if \(action === 'apply'\) \{[\s\S]*?onNotice\?\.\(t\(publicationRecoveryMessage\)\);\s*onRefresh\(\)/);
  assert.doesNotMatch(source, /重试发布会复用本次请求标识/);
});

test('CLI guide separates preparation from Agent filling and supplies stable idempotency keys', () => {
  const html = render(ui.IntakeSetup, { projectCode: 'PROJECT', context: { repositories: [{ code: 'REPOSITORY', name: 'Main repo' }], skill_version: '1.0.0' }, canSubmit: true, ...callbacks });
  assert.match(html, /--project PROJECT --repository REPOSITORY/);
  assert.match(html, /\.tsp\/intake\/first-intake/);
  assert.match(html, /先让 Agent 阅读生成的 SKILL.md 并填写 intake.json/);
  assert.match(html, /--idempotency-key intake-REPOSITORY-first-intake/);
  assert.match(html, /不自动启动模型/); assert.match(html, /10 MiB/);
});

test('API preserves project path escaping, revision, target fingerprint and request identity', async () => {
  const requests = [];
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: batch }), { headers: { 'Content-Type': 'application/json' } }); };
  await api.submitIntake('P/1', { items: [] }, 'stable-upload-key');
  await api.reviewIntake('P/1', 'B/2', { base_revision: 4, decisions: [{ key: 'm', action: 'bind', target_code: 'M', target_fingerprint: 'hash' }] });
  await api.applyIntake('P/1', 'B/2', 'plan', 'stable-apply-key');
  await api.stopIntake('P/1', 'B/2', 5);
  await api.replaceIntake('P/1', 'B/2', { items: [] }, 6);
  assert.equal(requests[0].url, '/api/projects/P%2F1/intake');
  assert.equal(JSON.parse(requests[0].init.body).idempotency_key, 'stable-upload-key');
  assert.equal(requests[1].url, '/api/projects/P%2F1/intake/B%2F2/review');
  assert.equal(JSON.parse(requests[1].init.body).base_revision, 4);
  assert.equal(JSON.parse(requests[1].init.body).decisions[0].target_fingerprint, 'hash');
  assert.deepEqual(JSON.parse(requests[2].init.body), { plan_hash: 'plan', idempotency_key: 'stable-apply-key' });
  assert.equal(JSON.parse(requests[3].init.body).base_revision, 5);
  assert.equal(requests[4].init.method, 'PUT'); assert.equal(JSON.parse(requests[4].init.body).base_revision, 6);
});

test('all intake copy has English translations while source content is preserved', () => {
  const missing = [];
  for (const file of ['IntakeWorkbench.tsx', 'intakeApi.ts']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) if (!i18n.englishMessages[match[1]]) missing.push(match[1]);
  }
  assert.deepEqual(missing, []);
  i18n.setLocale('en-US', false);
  const html = render(ui.IntakeCandidateReader, { batch, view, editable: true, ...callbacks });
  assert.match(html, /Code specifications/); assert.match(html, /client-reported/); assert.match(html, /Choose an action/);
  assert.match(html, /账户权限/);
});
