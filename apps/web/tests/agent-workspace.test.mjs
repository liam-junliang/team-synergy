import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, api, routing, switching, helpers, workbench, agent, dialogs, i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [api, routing, switching, helpers, workbench, agent, dialogs, i18n] = await Promise.all(['api.ts', 'workspaceRouting.ts', 'projectSwitching.ts', 'skills.ts', 'SkillsWorkbench.tsx', 'AgentWorkspace.tsx', 'SkillDialogs.tsx', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => i18n.setLocale('zh-CN', false));
function render(Component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
const project = { code: 'P', name: 'Product', team_code: 'T', status: 'active', role: 'admin', capabilities: { read: true, write: true, manage: true } };
const skill = { code: 'S', name: 'review', description: 'Review changes', scope_type: 'team', scope_code: 'T', current_revision: 2, published_revision: 1, can_edit: true, can_manage: true, archived: false, available_revisions: [1], owner_user_code: 'U', updated_at: '2026-10-18T00:00:00Z', shares: [] };
const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), sha256: 'a'.repeat(64), size_bytes: Buffer.byteLength(content) });
const revision = (n, content, published = null) => ({ revision: n, name: 'review', description: 'Review changes', files: [file('SKILL.md', content), file('scripts/test.js', '<script>alert("test")</script>')], package_sha256: 'b'.repeat(64), size_bytes: 128, change_summary: `Revision ${n}`, created_at: '2026-10-18T00:00:00Z', created_by_user_code: 'U', published_at: published });
const detail = { ...skill, revisions: [revision(2, '# Current draft\n\n**New**'), revision(1, '# Published content\n\n**Old**', '2026-10-18T00:00:00Z')] };
const installations = { project_code: 'P', generation: 3, can_manage: true, installations: [] };

test('Agent routes survive direct loading, login and project switching without leaking prior details', () => {
  const path = routing.agentWorkspacePath('skills', { projectCode: 'P', teamCode: 'T', agentReturnPath: '/projects/P/documents?document=D' });
  assert.deepEqual(routing.parseWorkspacePath(path), { view: 'agent', agentTab: 'skills', projectCode: 'P', teamCode: 'T', agentReturnPath: '/projects/P/documents?document=D' });
  assert.ok(routing.isWorkspacePath('/agent/connect')); assert.ok(routing.isWorkspacePath('/agent/skills'));
  assert.equal(routing.isWorkspacePath('/agent/private-route'), false);
  assert.equal(routing.workspacePathAfterLogin(`http://localhost${path}`, false), path);
  const switched = routing.parseWorkspacePath(switching.projectSwitchPath(routing.parseWorkspacePath(path), 'Q'));
  assert.deepEqual(switched, { view: 'agent', agentTab: 'skills', projectCode: 'Q' });
  for (const unsafe of ['//example.com', '/\\example.com', 'https://example.com', '/api/skills', '/agent/connect?return=/agent/skills', '/projects/Q/documents']) assert.equal(routing.safeAgentReturnPath(unsafe, 'P'), '/projects/P/overview');
});

test('robot entry is accessible and original navigation retains Testing before Defects', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label=\{t\('Agent 工作台'\)\}/);
  assert.match(source, /aria-current=\{view === 'agent' \? 'page' : undefined\}/);
  assert.ok(source.indexOf("aria-label={t('Agent 工作台')}") < source.indexOf('<ProjectSwitcher route='));
  assert.equal(routing.PROJECT_SECTIONS.at(-3), 'testing'); assert.equal(routing.PROJECT_SECTIONS.at(-2), 'defects'); assert.equal(routing.PROJECT_SECTIONS.at(-1), 'handovers');
});

test('skill reader uses selected immutable revision, safe Markdown and manager-gated controls', () => {
  const props = { skill: detail, busy: false, onEdit() {}, onAction() {}, onInstall() {} };
  const writable = render(workbench.SkillContentReader, props);
  for (const value of ['Current draft', '修订技能包', '发布此版本', '共享版本', '版本记录']) assert.ok(writable.includes(value));
  assert.doesNotMatch(writable, /<script|<iframe|srcdoc/);
  const readonly = render(workbench.SkillContentReader, { ...props, initialRevision: 1, skill: { ...detail, can_edit: false, can_manage: false }, projectSkills: { ...installations, can_manage: false } });
  assert.match(readonly, /Published content/); assert.doesNotMatch(readonly, /Current draft|修订技能包|发布此版本|共享版本|归档技能|采用到当前项目/);
  const installer = render(workbench.SkillContentReader, { ...props, skill: { ...detail, can_edit: false, can_manage: false }, projectSkills: installations });
  assert.match(installer, /采用到当前项目/); assert.doesNotMatch(installer, /修订技能包|共享版本/);
  assert.match(writable, /shrink-0 space-y-3 border-b/); assert.match(writable, /min-h-0 min-w-0 overflow-y-auto overscroll-contain/);
});

test('external project readers see installed skills without team membership or manager actions', () => {
  const readonly = { ...project, role: 'viewer', is_external: true, capabilities: { read: true, write: false, manage: false } };
  const pinned = { skill_code: 'S', revision: 1, alias: 'shared-review', enabled: true, name: 'review', description: 'Review changes', scope_type: 'team', scope_code: 'T', package_sha256: 'b'.repeat(64), available_revisions: [1], blocked: false, blocked_reason: null };
  const html = render(workbench.SkillsWorkbench, { project: readonly }, [
    [['skills', 'catalog', 'project', 'P', 'project'], []],
    [['skills', 'installed', 'P'], { ...installations, can_manage: false, installations: [pinned] }],
    [['skills', 'detail', 'project', 'P', 'S'], { ...detail, current_revision: 1, can_edit: false, can_manage: false, revisions: [detail.revisions[1]] }],
  ]);
  assert.match(html, /shared-review/); assert.match(html, /Published content/);
  assert.doesNotMatch(html, /新建技能包|修订技能包|共享版本|采用到当前项目|>停用</);
  assert.match(html, /disabled=""[^>]*>团队技能/);
});

test('revoked skill installation stays visible but never renders cached package content', () => {
  const blocked = { skill_code: 'S', revision: 1, alias: 'old-review', enabled: true, name: 'review', description: 'Old summary', scope_type: 'team', scope_code: 'T', package_sha256: 'b'.repeat(64), available_revisions: [], blocked: true, blocked_reason: 'revoked' };
  const html = render(workbench.SkillsWorkbench, { project }, [
    [['skills', 'catalog', 'project', 'P', 'project'], []], [['skills', 'installed', 'P'], { ...installations, installations: [blocked] }],
    [['skills', 'detail', 'project', 'P', 'S'], detail],
  ]);
  assert.match(html, /授权不可用/); assert.match(html, /old-review/); assert.match(html, />停用</);
  assert.doesNotMatch(html, /Current draft|Published content|共享版本/);
});

test('project scope changes do not use a cached detail from another project', () => {
  const html = render(workbench.SkillsWorkbench, { project: { ...project, code: 'Q' } }, [
    [['skills', 'catalog', 'project', 'Q', 'project'], []], [['skills', 'installed', 'Q'], { ...installations, project_code: 'Q' }],
    [['skills', 'detail', 'project', 'P', 'S'], detail],
  ]);
  assert.doesNotMatch(html, /Current draft|Published content/);
});

test('package import preserves UTF-8 and binary bytes and rejects unsafe or oversized packages', async () => {
  const markdown = new File(['---\nname: hello\ndescription: 测试\n---\n# Hello'], 'SKILL.md');
  const binary = new File([new Uint8Array([0, 255, 1])], 'asset.bin');
  Object.defineProperty(markdown, 'webkitRelativePath', { value: 'package/SKILL.md' });
  Object.defineProperty(binary, 'webkitRelativePath', { value: 'package/assets/asset.bin' });
  const result = await helpers.readSkillFiles([markdown, binary]);
  assert.equal(result[0].path, 'SKILL.md'); assert.match(helpers.skillFileText(result[0]), /测试/);
  assert.equal(result[1].path, 'assets/asset.bin'); assert.deepEqual(Buffer.from(result[1].content_base64, 'base64'), Buffer.from([0, 255, 1]));
  assert.equal(helpers.skillFileText(result[1]), undefined);
  for (const path of ['../secret', '/absolute', 'C:/file', 'refs\\bad', '.git/config', 'refs/CON.txt', 'trailing.', 'a//b', 'a/../b']) assert.equal(helpers.validSkillPath(path), false, path);
  assert.equal(helpers.validSkillPath('references/指南.md'), true);
  await assert.rejects(() => helpers.readSkillFiles([new File(['bad'], 'readme.md')]), /SKILL.md/);
  await assert.rejects(() => helpers.readSkillFiles([markdown, new File([new Uint8Array(6 * 1024 * 1024)], 'big.bin')]), /6 MiB/);
  await assert.rejects(() => helpers.readSkillFiles([new File(['A'], 'SKILL.md'), new File(['B'], 'skill.md')]), /大小写/);
});

test('file changes distinguish additions, removals and exact byte changes', () => {
  const changes = helpers.skillFileChanges([file('SKILL.md', 'new'), file('new.bin', 'x')], [file('SKILL.md', 'old'), file('gone.md', 'g')]);
  assert.deepEqual(changes, [{ path: 'SKILL.md', kind: 'changed' }, { path: 'gone.md', kind: 'removed' }, { path: 'new.bin', kind: 'added' }]);
});

test('sharing and adoption forms disclose exact revisions, scope and external-member impact', () => {
  const html = render(dialogs.SkillShareEditor, { skill: detail, onClose() {}, async onSaved() {} });
  assert.match(html, /目标项目编码/); assert.match(html, /允许交付给含外部协作者的项目/); assert.match(html, /后续新版本不会自动共享/);
  assert.match(html, />r1</); assert.doesNotMatch(html, />r2</);
  const adopt = render(dialogs.SkillInstallEditor, { skill: detail, projectSkills: installations, onClose() {}, async onSaved() {} });
  assert.match(adopt, /r1 · Revision 1/); assert.doesNotMatch(adopt, /r2 · Revision 2/);
});

test('CLI guide uses supported commands and only the current user device records', () => {
  i18n.setLocale('en-US', false);
  const html = render(agent.CliConnectionGuide, { user: { code: 'U', account: 'liam', display_name: 'Liam' }, project }, [
    [['platform-client-config'], { public_web_url: null, public_api_url: null }],
    [['devices', 'U'], [{ code: 'D', device_name: 'My laptop', created_at: '2026-10-18T00:00:00Z' }]],
    [['devices', 'OTHER'], [{ code: 'OTHER', device_name: 'Private device', created_at: '' }]],
  ]);
  assert.doesNotMatch(html, /tsp auth login-password|BIND_TOKEN|npm link|pnpm -r build/); assert.match(html, /tsp auth login --api/); assert.match(html, /tsp project bind P/); assert.match(html, /tsp skill sync --project P --check/);
  assert.match(html, /My laptop/); assert.doesNotMatch(html, /Private device|device_token|web-login|在线设备/);
  assert.match(html, /do not indicate online status/);
});

test('new UI messages have English translations and keep user-authored names unchanged', () => {
  for (const name of ['AgentWorkspace.tsx', 'SkillsWorkbench.tsx', 'SkillDialogs.tsx', 'SkillShared.tsx', 'skills.ts']) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) assert.ok(i18n.englishMessages[match[1]], `missing ${match[1]}`);
  }
  i18n.setLocale('en-US', false);
  const html = render(workbench.SkillContentReader, { skill: { ...detail, name: '项目专属技能' }, busy: false, onEdit() {}, onAction() {}, onInstall() {} });
  assert.match(html, /Publish version|Version history/);
});

test('API mutations retain exact revision and optimistic installation generation', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body && JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, data: detail }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    await api.listSkills('project', 'P', 'shared'); await api.getSkill('S', 'P');
    await api.reviseSkill('S', { base_revision: 2, files: [file('SKILL.md', 'test')], change_summary: 'change' });
    await api.shareSkill('S', { target_type: 'team', target_code: 'OTHER', revisions: [1], allow_projects: true, allow_external: false });
    await api.installProjectSkill('P', 'S', { revision: 1, alias: 'review', enabled: true, base_generation: 3 });
    await api.revokeSkillShare('S', 'SHARE');
    assert.equal(calls[0].url, '/api/skills?project_code=P&view=shared'); assert.equal(calls[1].url, '/api/skills/S?project_code=P');
    assert.equal(calls[2].body.base_revision, 2); assert.deepEqual(calls[3].body.revisions, [1]); assert.equal(calls[3].body.allow_external, false);
    assert.deepEqual(calls[4].body, { revision: 1, alias: 'review', enabled: true, base_generation: 3 });
    assert.equal(calls[5].method, 'DELETE'); assert.equal(calls[5].url, '/api/skills/S/shares/SHARE');
  } finally { globalThis.fetch = previousFetch; }
});
