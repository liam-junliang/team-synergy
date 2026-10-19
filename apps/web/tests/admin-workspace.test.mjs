import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, routing, admin, navigation, settings, directory, users, api, webApi, errors, i18n;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [routing, admin, navigation, settings, directory, users, api, webApi, errors, i18n] = await Promise.all(['workspaceRouting.ts', 'AdminWorkspace.tsx', 'AdminNavigation.tsx', 'SystemSettings.tsx', 'AdminTeamsProjects.tsx', 'AccountWorkbench.tsx', 'adminApi.ts', 'api.ts', 'apiError.ts', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => { i18n.setLocale('zh-CN', false); globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
function render(Component, props = {}, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
const release = { schema_version: 1, version: '0.1.0', release: 'release-one', node_version: '22.23.3', artifacts: [
  { platform: 'win32', arch: 'x64', filename: 'a.zip', sha256: 'a'.repeat(64), size_bytes: 10, format: 'zip' },
  { platform: 'linux', arch: 'arm64', filename: 'b.tar.gz', sha256: 'b'.repeat(64), size_bytes: 10, format: 'tar.gz' },
] };

test('admins land in management while browser approval and explicit project links survive login', () => {
  for (const path of ['/', '/teams', '/teams/']) assert.equal(routing.workspacePathAfterLogin(`https://app.example${path}`, true), '/admin/teams');
  assert.equal(routing.workspacePathAfterLogin('https://app.example/#/teams', true), '/admin/teams');
  assert.equal(routing.workspacePathAfterLogin('https://app.example/teams', false), '/teams');
  for (const path of ['/agent/authorize?code=ABCD-EFGH', '/projects/P/overview', '/account', '/admin/settings']) assert.equal(routing.workspacePathAfterLogin(`https://app.example${path}`, true), path);
  for (const tab of ['teams', 'users', 'settings']) {
    assert.deepEqual(routing.parseWorkspacePath(`/admin/${tab}`), { view: 'admin', adminTab: tab });
    assert.equal(routing.isWorkspacePath(`/admin/${tab}`), true);
  }
  assert.equal(routing.isWorkspacePath('/admin/settings/download'), false);
  assert.equal(routing.isWorkspacePath('/api/admin/settings'), false);
});

test('ordinary users cannot mount any admin data surface or issue admin queries', () => {
  let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('unexpected fetch'); };
  for (const tab of ['teams', 'users', 'settings']) {
    const html = render(admin.AdminWorkspace, { tab, isSystemAdmin: false });
    assert.match(html, /只有系统管理员可以进入管理控制台/);
    assert.doesNotMatch(html, /form|table|CLI 安装包|创建用户/);
  }
  assert.equal(requests, 0);
});

test('admin navigation exposes configuration, team/project governance and users, without business menus', () => {
  const html = render(navigation.AdminNavigation, { tab: 'users' });
  assert.match(html, /系统配置/); assert.match(html, /团队项目管理/); assert.match(html, /用户管理/);
  assert.match(html, /href="\/admin\/users" aria-current="page"/);
  assert.doesNotMatch(html, /需求|任务|技能库/);
  i18n.setLocale('en-US', false);
  assert.match(render(navigation.AdminNavigation, { tab: 'settings' }), /Settings/);
});

test('release status reports all six targets using actual artifacts rather than OS assumptions', () => {
  const html = render(settings.CliReleaseStatus, {}, [[['cli-release'], release]]);
  for (const label of ['Windows', 'macOS', 'Linux', '22.23.3', 'release-one']) assert.ok(html.includes(label));
  assert.equal((html.match(/>已发布</g) ?? []).length, 2);
  assert.equal((html.match(/>未发布</g) ?? []).length, 4);
  assert.match(html, /刷新/);
});

test('settings form shows configured addresses and explains deployment boundary', () => {
  const html = render(settings.SettingsForm, { settings: { public_web_url: 'https://team.example', public_api_url: 'https://api.example/v1', revision: 3, updated_at: '2026-10-18T12:00:00Z', updated_by: 'ADMIN' } });
  assert.match(html, /https:\/\/team.example/); assert.match(html, /https:\/\/api.example\/v1/);
  assert.match(html, /不会修改服务监听端口或反向代理/);
  assert.match(html, /重新加载配置/);
});

test('team governance displays global ownership and no personal project entry', () => {
  const html = render(directory.AdminTeamsProjects, {}, [[['admin-teams', '', undefined], { total: 1, next_cursor: null, items: [{ team_code: 'T', name: 'Global Team', owner_name: 'Liam', members_count: 3, projects_count: 4, created_at: '2026-10-18' }] }]]);
  assert.match(html, /Global Team/); assert.match(html, /Liam/); assert.match(html, /3 人 · 4 项目/);
  assert.match(html, /查看项目/); assert.doesNotMatch(html, /我的团队|创建团队|href="\/projects/);
  const dialog = render(directory.AdminEditDialog, { selection: { kind: 'project', item: { project_code: 'P', name: 'Project', description: '', status: 'archived', current_snapshot: 8 } }, onClose() {} });
  assert.match(dialog, /调整原因/); assert.match(dialog, /required="" maxLength="1000"/);
  assert.match(dialog, /只读状态/); assert.doesNotMatch(dialog, /删除项目|转移/);
});

test('users page uses normalized API deletion states without mislabeling users as admins', async () => {
  const active = { code: 'U', account: 'user', display_name: 'User', status: 'active', is_system_admin: false, must_change_password: false };
  const deleted = { ...active, code: 'D', account: 'deleted', status: 'disabled', deleted_at: '2026-10-18' };
  const pending = { ...active, code: 'C', account: 'closing', pending_deletion: true };
  const systemAdmin = { ...active, code: 'A', account: 'admin', is_system_admin: true };
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [active, deleted, pending, systemAdmin] }), { status: 200 });
  const data = await webApi.listUsers();
  assert.equal(data[1].deleted_at, '2026-10-18'); assert.equal(data[2].pending_deletion, true);
  assert.equal(data[0].deleted_at, null); assert.equal(data[0].pending_deletion, false);
  const html = render(users.AccountWorkbench, {}, [[['users'], data], [['devices', 'U'], []]]);
  assert.match(html, /用户管理/); assert.match(html, /搜索账号、名称或编码/); assert.match(html, /登录会话/);
  const row = html.slice(html.indexOf('@deleted'), html.indexOf('@closing'));
  assert.match(row, /已注销/); assert.match(row, /disabled=""[^>]*>启用<\/button>/); assert.doesNotMatch(row, /ADMIN/);
  const pendingRow = html.slice(html.indexOf('@closing'), html.indexOf('@admin'));
  assert.match(pendingRow, /注销中/); assert.match(pendingRow, /disabled=""[^>]*>禁用<\/button>/); assert.doesNotMatch(pendingRow, /ADMIN/);
  assert.equal((html.match(/>ADMIN</g) ?? []).length, 1);
});

test('admin API preserves optimistic revision, reason and paginated query encoding', async () => {
  const requests = [];
  globalThis.window = { localStorage: { getItem: () => null } };
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  await api.updateSystemSettings({ public_web_url: null, public_api_url: 'https://team.example/api', base_revision: 7 });
  assert.equal(requests[0].url, '/api/admin/settings'); assert.equal(requests[0].init.method, 'PUT');
  assert.equal(JSON.parse(requests[0].init.body).base_revision, 7);
  await api.adminListProjects({ q: 'A & B', team_code: 'T/1', cursor: 'P/2', status: 'archived' });
  const params = new URL(requests[1].url, 'http://local').searchParams;
  assert.equal(params.get('q'), 'A & B'); assert.equal(params.get('team_code'), 'T/1'); assert.equal(params.get('cursor'), 'P/2');
  await api.adminUpdateProject('P/2', { name: 'New', description: null, status: 'archived', reason: 'Completed', base_snapshot: 8 });
  assert.equal(requests[2].url, '/api/admin/projects/P%2F2'); assert.equal(JSON.parse(requests[2].init.body).reason, 'Completed');
  assert.equal(JSON.parse(requests[2].init.body).base_snapshot, 8);
});

test('new administrative errors follow locale changes and retain original diagnostics', () => {
  i18n.setLocale('en-US', false);
  for (const [code, phrase] of [['settings_revision_conflict', 'Settings have changed'], ['settings_url_invalid', 'HTTPS URL'], ['admin_revision_conflict', 'This project has changed'], ['project_has_active_runs', 'pending handover'], ['user_deleted', 'cannot be restored']]) {
    const error = new errors.ApiError(code, '原始错误', 409);
    assert.ok(error.message.includes(phrase)); assert.equal(error.originalMessage, '原始错误');
  }
});

test('admin copy is translated while names supplied by users stay unchanged', () => {
  for (const file of ['AdminWorkspace.tsx', 'AdminNavigation.tsx', 'AdminTeamsProjects.tsx', 'SystemSettings.tsx']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) assert.ok(i18n.englishMessages[match[1]], `missing translation: ${match[1]}`);
  }
});
