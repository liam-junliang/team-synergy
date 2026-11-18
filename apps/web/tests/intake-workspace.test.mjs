import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, ui, api, routing, switching, navigation, i18n, errors, quality, coverage, materials;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [ui, api, routing, switching, navigation, i18n, errors, quality, coverage, materials] = await Promise.all(['IntakeWorkbench.tsx', 'intakeApi.ts', 'workspaceRouting.ts', 'projectSwitching.ts', 'ProjectWorkspace.tsx', 'i18n.ts', 'apiError.ts', 'IntakeQualityReport.tsx', 'IntakeCoverage.tsx', 'IntakeMaterialSetup.tsx'].map(file => vite.ssrLoadModule(`/src/${file}`)));
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
const qualityGate = { status: 'eligible', blockers: 0, warnings: 1, needs_review: 1, note: 'Pilot candidates can be saved and reviewed.' };
const batch = { profile: 'pilot', quality_report: null, quality_rule_version: null, quality_gate: qualityGate, publication: { status: 'not_started', created: 0, bound: 0, skipped: 0, total: 1 }, dossier: { required: 11, present: 0, missing: ['requirements'], complete: false, published: 0, bound: 0, skipped: 0, all_required_published: false, content_verified: false }, approval: { status: 'not_requested', note: 'No formal approval recorded.' }, code: 'BATCH', project_code: 'PROJECT', repository_code: 'REPOSITORY', namespace: 'auth-intake', status: 'draft', revision: 1, created_by: 'LIAM', created_at: '2026-10-18', updated_at: '2026-10-18', item_count: 1, applied_count: 0, plan_hash: null, source, items: [view], can_review: true, can_edit: true, stop_requested: false, targets: [] };
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
  for (const [code, status] of [['forbidden', 403], ['project_forbidden', 200]]) {
    const html = render(ui.IntakeWorkbench, { projectCode: 'PROJECT' }, [
      [['intakes', 'PROJECT'], { can_submit: true, can_review: true, batches: [batch] }],
      [['intake', 'PROJECT', 'BATCH'], batch],
    ], [[['intakes', 'PROJECT'], new errors.ApiError(code, 'Forbidden', status)]]);
    assert.match(html, /当前身份不能访问代码候选/);
    assert.doesNotMatch(html, /观看者|账户权限|src\/auth.ts|上传候选 JSON|接入批次列表/);
  }
});

test('viewers see the localized code candidate access notice and can open project documents', () => {
  for (const [locale, heading, description, link] of [
    ['zh-CN', '查看权限受限', '查看代码候选和源码证据需要项目成员权限', '查看项目文档'],
    ['en-US', 'Viewing access is limited', 'Viewing code candidates and source code evidence requires project membership', 'View project documents'],
  ]) {
    i18n.setLocale(locale, false);
    const html = render(ui.IntakeWorkbench, { projectCode: 'PROJECT' }, [
      [['intakes', 'PROJECT'], { can_submit: true, can_review: true, batches: [batch] }],
      [['intake', 'PROJECT', 'BATCH'], batch],
    ], [[['intakes', 'PROJECT'], new errors.ApiError('intake_forbidden', 'Forbidden', 403)]]);
    assert.ok(html.includes(heading));
    assert.ok(html.includes(description));
    assert.ok(html.includes(`href="/projects/PROJECT/documents">${link}</a>`));
    assert.doesNotMatch(html, /intake_forbidden|重试|Retry|账户权限|src\/auth.ts|上传候选 JSON|接入批次列表/);
  }
  const html = render(ui.IntakeWorkbench, { projectCode: 'PROJECT' }, [
    [['intakes', 'PROJECT'], { batches: [] }],
  ], [
    [['intakes', 'PROJECT'], new errors.ApiError('internal_error', 'Temporary failure', 500)],
  ]);
  assert.match(html, /Unable to load intake batches/);
  assert.match(html, />Retry<\/button>/);
});

test('viewer denial on intake context or detail hides the entire cached candidate workspace', () => {
  const props = { projectCode: 'PROJECT' };
  const entries = [
    [['intakes', 'PROJECT'], { can_submit: true, can_review: true, batches: [batch] }],
    [['intake-context', 'PROJECT'], { repositories: [], skill_version: '1.0.0' }],
    [['intake', 'PROJECT', 'BATCH'], batch],
  ];
  const detailKey = ['intake', 'PROJECT', 'BATCH'];
  assert.match(render(ui.IntakeWorkbench, props, entries), /接入批次列表/);
  for (const key of [['intake-context', 'PROJECT'], detailKey]) {
    const html = render(ui.IntakeWorkbench, props, entries, [[key, new errors.ApiError('intake_forbidden', 'Forbidden', 403)]]);
    assert.match(html, /查看权限受限/);
    assert.doesNotMatch(html, /接入已有代码|接入批次列表|账户权限|src\/auth.ts|上传候选 JSON|重试|重新读取批次|Forbidden/);
  }
  const html = render(ui.IntakeWorkbench, props, entries, [[detailKey, new Error('Retryable detail failure')]]);
  assert.match(html, /Retryable detail failure.*>重新读取批次<\/button>/);
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
  assert.match(html, /--profile enterprise/);
  assert.match(html, /<option value="enterprise" selected="">企业档位（推荐）/);
  assert.match(html, /<option value="pilot">试点档位/);
  assert.match(html, /\.tsp\/intake\/first-intake/);
  assert.match(html, /先让 Agent 阅读生成的 SKILL.md 并填写 intake.json/);
  assert.match(html, /--idempotency-key intake-REPOSITORY-first-intake/);
  assert.match(html, /不自动启动模型/); assert.match(html, /10 MiB/);
});

test('preparation commands explicitly preserve either profile and translate the profile choice', () => {
  for (const profile of ['pilot', 'enterprise']) {
    const command = ui.intakePreparationCommand('PROJECT', 'REPOSITORY', profile, 'delivery-v2');
    assert.match(command, new RegExp(`--profile ${profile} --scope`));
    assert.match(command, /--out \.tsp\/intake\/delivery-v2/);
    assert.match(command, /--idempotency-key intake-REPOSITORY-delivery-v2/);
  }
  i18n.setLocale('en-US', false);
  const html = render(ui.IntakeSetup, { projectCode: 'PROJECT', context: { repositories: [{ code: 'REPOSITORY', name: 'Main repo' }], skill_version: '1.0.0' }, canSubmit: true, ...callbacks });
  assert.match(html, /Delivery profile for candidate preparation/);
  assert.match(html, /Enterprise profile \(recommended\)/);
  assert.match(html, /Pilot profile/);
  assert.match(html, /--profile enterprise/);
});

test('material-only projects can prepare and export specifications without a registered code repository', () => {
  const html = render(ui.IntakeSetup, { projectCode: 'PROJECT', context: { repositories: [], skill_version: '1.2.0' }, canSubmit: true, ...callbacks });
  assert.match(html, /当前没有代码仓库，可从下方团队资料开始准备规格/);
  assert.match(html, /纯资料项目可以直接准备，无需绑定代码仓库/);
  assert.match(html, /UTF-8 文本/); assert.match(html, /Word、PDF 等需先转换为文本并保留原件及来源说明/);
  assert.match(html, /prepare 后让 Agent 按生成的 SKILL.md 盘点能力、编写规格并记录冲突/);
  assert.match(html, /tsp intake prepare --project PROJECT --material team=work\/materials --profile enterprise/);
  assert.match(html, /tsp intake validate outbox\/material-spec\/intake.json/);
  assert.match(html, /tsp intake export outbox\/material-spec\/intake.json --out outbox\/material-spec-export/);
  assert.doesNotMatch(html, /--repository|请先在项目中绑定代码仓库/);
  for (const profile of ['pilot', 'enterprise']) {
    const command = materials.intakeMaterialPreparationCommand('PROJECT', profile);
    assert.ok(command.includes(`--profile ${profile}`));
    assert.doesNotMatch(command, /--repository|intake apply|intake submit/);
  }
  i18n.setLocale('en-US', false);
  const english = render(ui.IntakeSetup, { projectCode: 'PROJECT', context: { repositories: [], skill_version: '1.2.0' }, canSubmit: true, ...callbacks });
  assert.match(english, /without a linked code repository/); assert.match(english, /have your Agent follow the generated SKILL.md/);
  assert.doesNotMatch(english, /[\u4e00-\u9fff]/);
});

test('API preserves project path escaping, revision, target fingerprint and request identity', async () => {
  const requests = [];
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: batch }), { headers: { 'Content-Type': 'application/json' } }); };
  await api.submitIntake('P/1', { items: [] }, 'stable-upload-key');
  await api.reviewIntake('P/1', 'B/2', { base_revision: 4, profile: 'enterprise', decisions: [{ key: 'm', action: 'bind', target_code: 'M', target_fingerprint: 'hash' }] });
  await api.applyIntake('P/1', 'B/2', 'plan', 'stable-apply-key');
  await api.stopIntake('P/1', 'B/2', 5);
  await api.replaceIntake('P/1', 'B/2', { items: [] }, 6);
  assert.equal(requests[0].url, '/api/projects/P%2F1/intake');
  assert.equal(JSON.parse(requests[0].init.body).idempotency_key, 'stable-upload-key');
  assert.equal(requests[1].url, '/api/projects/P%2F1/intake/B%2F2/review');
  assert.equal(JSON.parse(requests[1].init.body).base_revision, 4);
  assert.equal(JSON.parse(requests[1].init.body).profile, 'enterprise');
  assert.equal(JSON.parse(requests[1].init.body).decisions[0].target_fingerprint, 'hash');
  assert.deepEqual(JSON.parse(requests[2].init.body), { plan_hash: 'plan', idempotency_key: 'stable-apply-key' });
  assert.equal(JSON.parse(requests[3].init.body).base_revision, 5);
  assert.equal(requests[4].init.method, 'PUT'); assert.equal(JSON.parse(requests[4].init.body).base_revision, 6);
});

test('all intake copy has English translations while source content is preserved', () => {
  const missing = [];
  for (const file of ['IntakeWorkbench.tsx', 'intakeApi.ts', 'IntakeQualityReport.tsx', 'IntakeCoverage.tsx', 'IntakeMaterialSetup.tsx']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) if (!i18n.englishMessages[match[1]]) missing.push(match[1]);
  }
  assert.deepEqual(missing, []);
  i18n.setLocale('en-US', false);
  const html = render(ui.IntakeCandidateReader, { batch, view, editable: true, ...callbacks });
  assert.match(html, /Code specifications/); assert.match(html, /client-reported/); assert.match(html, /Choose an action/);
  assert.match(html, /账户权限/);
  const qualityHtml = render(quality.IntakeQualityReport, { batch });
  assert.match(qualityHtml, /Enterprise artifact catalog/);
  assert.doesNotMatch(qualityHtml, /[\u4e00-\u9fff]/);
});

test('legacy or explicitly unknown coverage remains unknown even when the artifact catalog is complete', () => {
  for (const report of [null, { coverage: { status: 'unknown' } }]) {
    const html = render(coverage.IntakeCoverage, { batch: { ...batch, quality_report: report, dossier: { ...batch.dossier, present: 11, complete: true, missing: [] } } });
    assert.match(html, /尚无能力清单，业务覆盖范围未知/);
    assert.match(html, /资料目录齐全不能代替功能覆盖/);
    assert.doesNotMatch(html, /100%|已形成规格 \/ 待补|范围内能力<\/dt>|结构化需求 \d/);
  }
});

test('partial capability coverage distinguishes specified, pending, unconfirmed and excluded without implying test execution', () => {
  const requirement = { ...view, item: { ...item, kind: 'requirement', key: 'req.document', title: 'Document access', acceptance_criteria: [{ id: 'AC-1', text: 'Reject unauthorized edits' }] } };
  const report = { coverage: { status: 'gaps', scope: 'Only document access; billing has not been inventoried.', discovery_status: 'partial',
    declared: 4, in_scope: 2, specified: 1, pending: 1, unknown: 1, excluded: 1, open_conflicts: 1,
    requirements: 2, with_acceptance: 1, with_verification: 1, rows: [
      { key: 'cap.access', title: 'Document access', disposition: 'included', state: 'specified', requirement_keys: ['req.document'], reason: '' },
      { key: 'cap.revisions', title: 'Revision history', disposition: 'included', state: 'pending', requirement_keys: [], reason: 'Exception scenarios need evidence.' },
      { key: 'cap.billing', title: 'Billing', disposition: 'unknown', state: 'unknown', requirement_keys: [], reason: 'Scope owner has not confirmed this area.' },
      { key: 'cap.import', title: '<script>external import</script>', disposition: 'excluded', state: 'excluded', requirement_keys: [], reason: 'Excluded from this intake.' },
    ] } };
  const checked = { ...batch, quality_report: report, items: [view, requirement] };
  const html = render(coverage.IntakeCoverage, { batch: checked, onSelect() {} });
  assert.match(html, /Only document access; billing has not been inventoried/);
  for (const label of ['已形成规格', '待补规格', '范围待确认', '范围外']) assert.ok(html.includes(`>${label}</span>`), label);
  assert.match(html, /已形成规格 \/ 待补<\/dt><dd[^>]*>1 \/ 1<\/dd>/);
  assert.match(html, /范围待确认 \/ 范围外<\/dt><dd[^>]*>1 \/ 1<\/dd>/);
  assert.match(html, /结构化需求 2 · 有验收标准 1 · 有逐条验证计划 1/);
  assert.match(html, /数字仅针对声明的能力清单；有验证计划不代表已执行或通过/);
  assert.match(html, /能力盘点尚未完成范围复核/); assert.match(html, /· 1 AC/);
  assert.match(html, /&lt;script&gt;external import&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|100%|报告通过|全部功能已覆盖/);
  const reviewed = render(coverage.IntakeCoverage, { batch: { ...checked, quality_report: { coverage: { ...report.coverage, discovery_status: 'reviewed' } } } });
  assert.doesNotMatch(reviewed, /能力盘点尚未完成范围复核/);
  assert.match(reviewed, /有验证计划不代表已执行或通过/);
  i18n.setLocale('en-US', false);
  const english = render(coverage.IntakeCoverage, { batch: checked });
  assert.match(english, /Specified \/ pending/); assert.match(english, /Specification pending/); assert.match(english, /Scope unconfirmed/);
  assert.match(english, /A verification plan does not establish execution or a passing result/);
  assert.doesNotMatch(english, /[\u4e00-\u9fff]/);
});

test('documented and proposed candidates do not claim code implementation or executed tests', () => {
  for (const [assessment, expected] of [['documented', '资料记载，尚不代表已实现'], ['proposed', '目标方案，尚待确认']]) {
    const material = { ...view, item: { ...item, assessment, tests: [], evidence: [{ ...item.evidence[0], path: 'materials/team/decisions.md' }] } };
    const html = render(ui.IntakeCandidateReader, { batch: { ...batch, repository_code: null }, view: material, editable: false, ...callbacks });
    assert.ok(html.includes(expected)); assert.match(html, /materials\/team\/decisions.md/); assert.match(html, /没有测试记录/);
    assert.doesNotMatch(html, /已观察到代码实现|报告通过/);
  }
});

test('material source snapshots omit Git state while repository and mixed sources retain it', () => {
  const materialSource = { ...source, mode: 'materials', commit: null, dirty: false, scope: ['materials/team'],
    files: [{ path: 'materials/team/decisions.md', sha256: 'd'.repeat(64) }],
    inputs: [{ key: 'team', kind: 'team_note', label: 'Access decisions', prefix: 'materials/team', revision: 'r2' }],
    exclusions: ['Original PDF has not been converted.'],
  };
  const html = render(ui.IntakeSource, { source: materialSource });
  assert.match(html, /资料快照/); assert.match(html, /扫描未完整/); assert.match(html, /不代表已实现或已部署/);
  assert.match(html, /SHA-256/); assert.ok(html.includes(source.manifest_sha256));
  assert.match(html, /团队说明 · Access decisions/); assert.match(html, /materials\/team/); assert.match(html, /r2/);
  assert.ok(html.includes(source.analyzed_at)); assert.match(html, /Original PDF has not been converted/);
  assert.doesNotMatch(html, /Commit:|无提交记录|干净工作区|有未提交改动/);
  for (const mode of [undefined, 'repository', 'mixed']) {
    const repositoryHtml = render(ui.IntakeSource, { source: { ...source, mode } });
    assert.match(repositoryHtml, /有未提交改动/); assert.match(repositoryHtml, /Commit:/); assert.ok(repositoryHtml.includes(source.commit));
    const cleanHtml = render(ui.IntakeSource, { source: { ...source, mode, dirty: false } });
    assert.match(cleanHtml, /干净工作区/); assert.doesNotMatch(cleanHtml, /资料快照/);
  }
  i18n.setLocale('en-US', false);
  const english = render(ui.IntakeSource, { source: materialSource });
  assert.match(english, /Material snapshot/); assert.match(english, /implementation and deployment are unverified/);
  assert.doesNotMatch(english, /Commit:|No commit|Clean worktree|Uncommitted changes|[\u4e00-\u9fff]/);
});

test('pinned code analysis sources never claim the current checkout state', () => {
  for (const dirty of [false, true]) {
    const fixed = { ...source, dirty, mode: 'mixed', inputs: [{ key: 'repository', kind: 'code', label: 'repository', prefix: '.', revision: `snapshot:${'a'.repeat(64)}` }] };
    i18n.setLocale('zh-CN', false);
    const html = render(ui.IntakeSource, { source: fixed });
    assert.match(html, /固定分析快照/);
    assert.match(html, /不代表当前工作区或已部署版本/);
    assert.doesNotMatch(html, /干净工作区|有未提交改动|来源是本次工作区快照/);
    i18n.setLocale('en-US', false);
    const english = render(ui.IntakeSource, { source: fixed });
    assert.match(english, /Pinned analysis snapshot/);
    assert.doesNotMatch(english, /Clean worktree|Uncommitted changes|[\u4e00-\u9fff]/);
  }
  i18n.setLocale('zh-CN', false);
});

test('legacy batches require explicit profile confirmation and cannot imply a prior quality pass', () => {
  const legacy = { ...batch, profile: null, quality_gate: { ...qualityGate, status: 'unknown', note: '' } };
  assert.match(api.intakeFreezeProblem(legacy), /明确本批次的交付档位/);
  assert.equal(api.intakeFreezeProblem(legacy, 'enterprise'), null);
  const html = render(ui.IntakeBatchReader, { batch: legacy, ...callbacks });
  assert.match(html, /未知历史档位/); assert.match(html, /尚无可用的持久化质量报告/);
  assert.match(html, /<option value="" disabled="" selected="">请选择交付档位/);
  assert.doesNotMatch(html, /<button[^>]*>发布已审阅项|规则检查通过|标准认证/);
  assert.equal(api.intakeCanPublish({ ...legacy, status: 'ready', plan_hash: 'plan' }, false), false);
  assert.equal(api.intakeCanPublish({ ...legacy, status: 'ready', plan_hash: 'plan', quality_gate: qualityGate }, false), false);
});

test('enterprise blockers prevent new freeze and all noneligible gates prevent new publication', () => {
  const enterprise = { ...batch, profile: 'enterprise', quality_gate: { ...qualityGate, status: 'blocked', blockers: 2 }, items: [{ ...view, decision: { key: item.key, action: 'create' } }] };
  assert.match(api.intakeFreezeProblem(enterprise, 'enterprise'), /仍有阻断项/);
  assert.match(api.intakeFreezeProblem(enterprise, 'pilot'), /不能降为试点/);
  const html = render(ui.IntakeBatchReader, { batch: enterprise, ...callbacks });
  assert.match(html, /disabled="">冻结发布计划/);
  assert.match(html, /disabled=""><option value="" disabled="">请选择交付档位/);
  assert.match(html, /企业档位不能降档/);
  for (const status of ['blocked', 'stale', 'unknown']) assert.equal(api.intakeCanPublish({ ...enterprise, status: 'ready', plan_hash: 'plan', quality_gate: { ...qualityGate, status } }, false), false);
  assert.equal(api.intakeFreezeProblem({ ...enterprise, quality_gate: { ...qualityGate, status: 'stale' } }, 'enterprise'), null, 're-review must be allowed to refresh a stale basis');
  assert.equal(api.intakeFreezeProblem(batch, 'enterprise'), null, 'pilot upgrades are evaluated by the server during freeze');
});

test('candidate quality report binds rule and candidate revision without treating catalog coverage or bindings as approval', () => {
  const report = { rule_version: '2.0.0+document.1.1.0', profile: 'enterprise', batch_revision: 7, payload_hash: 'c'.repeat(64), status: 'blocked', summary: { blockers: 1, warnings: 0, needs_review: 1 }, artifacts: { required: 11, present: 11, missing: [], complete: true }, scope_note: 'Uploaded candidate scope only.', issues: [
    { rule_id: 'dq.placeholder', item_key: item.key, artifact_type: 'requirements', severity: 'blocker', message: '<script>alert("bad")</script>', suggestion: 'Replace the placeholder.', line_start: 3 },
    { rule_id: 'evidence.verify', severity: 'needs_review', message: 'Verify meaning.', suggestion: 'Review code evidence.' },
  ] };
  const checked = { ...batch, revision: 7, profile: 'enterprise', quality_report: report, quality_rule_version: report.rule_version, quality_gate: { ...qualityGate, status: 'blocked', blockers: 1 }, publication: { status: 'completed', created: 0, bound: 1, skipped: 1, total: 2 }, dossier: { ...batch.dossier, present: 11, complete: true, missing: [], bound: 1, skipped: 1 } };
  const html = render(quality.IntakeQualityReport, { batch: checked, onSelect() {} });
  for (const text of ['2.0.0+document.1.1.0', '候选 r7', 'c'.repeat(64), '未记录正式批准', '执行完成', '候选覆盖 11 / 11 类', '关联或跳过必交项，不代表全部企业资料已发布并核验', '定位候选第 3 行', 'module.auth', '功能需求规格', '企业资料标准目录']) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|质量评分|全部产物已发布并核验/);
  const linked = render(ui.IntakeCandidateReader, { batch, view, decision: { key: item.key, action: 'bind' }, editable: true, ...callbacks });
  assert.match(linked, /候选检查结果不代表关联目标正文已通过质检/);
});

test('line navigation scopes candidate Markdown and focuses its nearest source block', () => {
  const calls = [];
  const node = line => ({ dataset: { sourceLine: String(line) }, setAttribute: (...args) => calls.push(['attr', line, ...args]), scrollIntoView: options => calls.push(['scroll', line, options]), focus: options => calls.push(['focus', line, options]) });
  const first = node(1), third = node(3), fifth = node(5);
  const markdown = { ...node(0), querySelectorAll: selector => { assert.equal(selector, '[data-source-line]'); return [first, third, fifth]; } };
  const container = { querySelector: selector => { assert.equal(selector, '[data-intake-candidate-content]'); return markdown; } };
  assert.equal(quality.locateIntakeQualityLine(container, 4), true);
  assert.equal(calls[1][0], 'scroll'); assert.equal(calls[1][1], 3); assert.equal(calls[2][1], 3);
  assert.equal(quality.locateIntakeQualityLine(null, 4), false);
  assert.equal(quality.locateIntakeQualityLine({ querySelector: () => null }, 4), false);
});
