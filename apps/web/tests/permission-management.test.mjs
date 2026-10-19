import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, api, permissions, i18n, ProjectMemberManagement, TeamsWorkspace, OwnershipTransferPanel;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  api = await vite.ssrLoadModule('/src/api.ts');
  permissions = await vite.ssrLoadModule('/src/projectManagement.ts');
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
  ({ ProjectMemberManagement } = await vite.ssrLoadModule('/src/ProjectMemberManagement.tsx'));
  ({ TeamsWorkspace } = await vite.ssrLoadModule('/src/TeamsWorkspace.tsx'));
  ({ OwnershipTransferPanel } = await vite.ssrLoadModule('/src/OwnershipTransferPanel.tsx'));
});
afterEach(() => i18n.setLocale('zh-CN', false));
after(async () => { await vite?.close(); });

const people = [
  { code: 'O', display_name: '唯一负责人', role: 'owner', effective_role: 'owner', access_source: 'owner', is_external: false },
  { code: 'A', display_name: '现有管理员', role: 'admin', effective_role: 'admin', access_source: 'explicit', is_external: false },
  { code: 'M', display_name: '团队成员', role: 'member', effective_role: 'member', access_source: 'team', is_external: false },
  { code: 'V', display_name: '指定只读成员', role: 'viewer', effective_role: 'viewer', access_source: 'explicit', is_external: false },
  { code: 'X', display_name: '外部成员', role: 'member', effective_role: 'member', access_source: 'explicit', is_external: true },
];
const project = { code: 'P', team_code: 'T', name: '用户项目', role: 'owner', status: 'active', member_policy: 'team_write', owner_code: 'O', created_by_code: 'V' };
function render(component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of [[['project-members', 'P'], people], [['team-members', 'T'], people.filter(p => !p.is_external)], [['ownership-transfers'], []], [['user-directory'], []], ...entries]) client.setQueryData(key, value);
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(component, props))); }
  finally { client.clear(); }
}
function elements(node) { return Array.isArray(node) ? node.flatMap(elements) : node?.props ? [node, ...elements(node.props.children)] : []; }
function teamPanel(role, ownership_pending = false) {
  let step = 0;
  function Probe() {
    const tree = TeamsWorkspace();
    const nodes = elements(tree);
    if (step === 0) { step++; nodes.find(node => node.props['aria-label'] === '查看团队项目：用户团队').props.onClick(); }
    else if (step === 1) { step++; nodes.find(node => node.type === 'button' && elements(node.props.children).length === 1 && node.props.children?.some?.(child => child === '团队管理'))?.props.onClick(); }
    return tree;
  }
  return render(Probe, {}, [[['teams'], [{ code: 'T', name: '用户团队', role, ownership_pending }]], [['projects', 'all', api.currentPrincipalCode()], []]]);
}

test('权限工具按服务端能力控制，观看者和归档项目不能写入，管理角色不能任免同级', () => {
  const { canProject, canManageMember, memberRemovalLabel } = permissions;
  assert.equal(canProject({ ...project, role: 'viewer' }, 'write'), false);
  assert.equal(canProject({ ...project, role: 'admin' }, 'manage_members'), true);
  assert.equal(canProject({ ...project, role: 'admin' }, 'manage_admins'), false);
  assert.equal(canProject({ ...project, status: 'archived' }, 'manage'), false);
  assert.equal(canProject({ ...project, ownership_pending: true }, 'transfer'), false);
  assert.equal(canProject({ ...project, capabilities: { manage_members: false } }, 'manage_members'), false);
  assert.equal(canManageMember('admin', people[1]), false);
  assert.equal(canManageMember('owner', people[0]), false);
  assert.equal(canManageMember('owner', people[1]), true);
  assert.equal(memberRemovalLabel(people[3], 'team_write'), '恢复团队默认权限');
  assert.equal(memberRemovalLabel(people[4], 'team_write'), '移出项目');
});

test('负责人可以编辑管理员，管理员只能编辑成员和观看者，负责人不进入普通角色下拉框', () => {
  const owner = render(ProjectMemberManagement, { project, onClose() {} });
  assert.match(owner, /aria-label="成员角色：现有管理员"/);
  assert.doesNotMatch(owner, /aria-label="成员角色：唯一负责人"/);
  assert.match(owner, /项目访问方式|预览权限影响/);
  assert.match(owner, /恢复团队默认权限/);
  assert.match(owner, /外部协作/);
  const admin = render(ProjectMemberManagement, { project: { ...project, role: 'admin' }, onClose() {} });
  assert.doesNotMatch(admin, /aria-label="成员角色：现有管理员"|aria-label="成员角色：唯一负责人"|发起所有权转移/);
  assert.match(admin, /aria-label="成员角色：指定只读成员"/);
  assert.match(admin, /添加项目成员/);
  const viewer = render(ProjectMemberManagement, { project: { ...project, role: 'viewer' }, onClose() {} });
  assert.doesNotMatch(viewer, /role="combobox"|添加项目成员|恢复团队默认权限|发起所有权转移/);
  assert.match(viewer, /团队规则|指定只读成员/);
});

test('角色英文短标签和权限面板翻译不改变用户内容', () => {
  i18n.setLocale('en-US', false);
  assert.equal(permissions.roleMeta('owner').label, 'Owner');
  assert.equal(permissions.roleMeta('admin').label, 'Admin');
  assert.equal(permissions.roleMeta('member').label, 'Member');
  assert.equal(permissions.roleMeta('viewer').label, 'Viewer');
  const html = render(ProjectMemberManagement, { project, onClose() {} });
  assert.match(html, /Members &amp; permissions|Team collaboration/);
  assert.match(html, /用户项目|唯一负责人/);
  assert.doesNotMatch(html, /成员与权限|项目访问方式|负责人和创建者|单独授权优先/);
});

test('所有权接收独立于编辑权限，创建者和负责人分别展示', () => {
  const current = api.currentPrincipalCode();
  const html = render(OwnershipTransferPanel, { scope: 'project', scopeCode: 'P', teamCode: 'T', ownerCode: 'O', createdByCode: 'V', pending: false, mayTransfer: false, actorRole: 'viewer', members: people }, [[['ownership-transfers'], [{ code: 'TR', scope: 'project', scope_code: 'P', target_user_code: current, status: 'pending', expires_at: '2026-12-01' }]]]);
  assert.match(html, /当前负责人[\s\S]*唯一负责人/);
  assert.match(html, /历史创建者[\s\S]*指定只读成员/);
  assert.match(html, /接受转移/);
  assert.doesNotMatch(html, /发起所有权转移/);
});

test('团队管理员可管理普通成员和创建项目，不出现授予Owner的选项', () => {
  const html = teamPanel('admin');
  assert.match(html, /创建项目/);
  assert.match(html, /新增团队成员/);
  assert.doesNotMatch(html, /授予 Owner|value="owner"|设为管理员|发起所有权转移/);
  const owner = teamPanel('owner');
  assert.match(owner, /设为管理员|设为成员/);
  assert.doesNotMatch(owner, /授予 Owner|value="owner"/);
});

test('权限接口保留有效角色、来源及能力；成员更新使用PATCH而继承授权使用POST', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body && JSON.parse(init.body) });
    const data = String(url).endsWith('/members') && !init?.method ? people.map(({ code, ...item }) => ({ user_code: code, ...item }))
      : String(url).endsWith('/members') || String(url).includes('/members/') ? { user_code: 'M', role: 'viewer', effective_role: 'viewer', access_source: 'explicit', is_external: false }
      : { project_code: 'P', team_code: 'T', name: '用户项目', role: 'viewer', effective_role: 'viewer', access_source: 'team', capabilities: { read: true, write: false }, member_policy: 'team_read', owner_code: 'O', created_by_code: 'V', ownership_pending: false };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const detail = await api.getProject('P');
    assert.equal(detail.effective_role, 'viewer'); assert.equal(detail.capabilities.write, false); assert.equal(detail.owner_code, 'O');
    const roster = await api.listProjectMembers('P');
    assert.equal(roster[2].access_source, 'team'); assert.equal(roster[4].is_external, true);
    await api.updateProjectMemberRole('P', 'M', 'viewer');
    await api.addProjectMember('P', { user_code: 'M', role: 'viewer' });
    assert.deepEqual(calls.at(-2), { url: '/api/projects/P/members/M', method: 'PATCH', body: { role: 'viewer' } });
    assert.deepEqual(calls.at(-1), { url: '/api/projects/P/members', method: 'POST', body: { user_code: 'M', role: 'viewer' } });
  } finally { globalThis.fetch = previous; }
});


test('评审发起人降为观看者后也只读，普通成员可投票但仅管理员可结束评审', async () => {
  const { RequirementReviewPanel } = await vite.ssrLoadModule('/src/RequirementDiscoveryWorkbench.tsx');
  const review = { review_code: 'REVIEW', revision: 1, status: 'open', requested_by: api.currentPrincipalCode(), votes: [] };
  const entries = [[['requirement-document-reviews', 'RD'], [review]]];
  const viewer = render(RequirementReviewPanel, { documentCode: 'RD', currentRevision: 1, canWrite: false, canManage: false }, entries);
  assert.match(viewer, /评审中/);
  assert.doesNotMatch(viewer, />表达意见<|>通过评审<|>暂无共识</);
  const member = render(RequirementReviewPanel, { documentCode: 'RD', currentRevision: 1, canWrite: true, canManage: false }, entries);
  assert.match(member, /表达意见/); assert.doesNotMatch(member, /通过评审|暂无共识/);
  const admin = render(RequirementReviewPanel, { documentCode: 'RD', currentRevision: 1, canWrite: true, canManage: true }, entries);
  assert.match(admin, /通过评审/);
});

test('过期转移不显示接收操作', () => {
  const expired = render(OwnershipTransferPanel, { scope: 'project', scopeCode: 'P', teamCode: 'T', ownerCode: 'O', createdByCode: 'V', mayTransfer: false, actorRole: 'viewer', members: people }, [[['ownership-transfers'], [{ code: 'OLD', scope: 'project', scope_code: 'P', target_user_code: api.currentPrincipalCode(), status: 'pending', expires_at: '2000-01-01' }]]]);
  assert.doesNotMatch(expired, /接受转移|等待接收人确认/);
});

test('账号注销清单阻止遗漏交接，普通用户可接收所有权且待注销不可接收', async () => {
  const { AccountClosurePanel } = await vite.ssrLoadModule('/src/AccountClosurePanel.tsx');
  const status = { pending_deletion: true, teams: [{ code: 'T', name: '待交接团队' }], projects: [{ code: 'P', name: '待交接项目', status: 'active' }], open_tasks: [{ code: 'TASK', title: '未完成任务' }], active_runs: [{ code: 'RUN', status: 'active' }] };
  const inbox = [{ code: 'TR', scope: 'project', scope_code: 'P', scope_name: '转入项目', initiated_by_code: 'O', target_user_code: api.currentPrincipalCode(), status: 'pending', expires_at: '2099-01-01' }];
  const props = { onClose() {}, onClosed() {} };
  const blocked = render(AccountClosurePanel, props, [[['account-closure'], status], [['ownership-transfers'], inbox]]);
  for (const value of ['待交接团队', '待交接项目', '未完成任务', 'RUN']) assert.match(blocked, new RegExp(value));
  assert.match(blocked, /<button[^>]*disabled=""[^>]*>确认注销账号<\/button>/);
  assert.match(blocked, /<button[^>]*disabled=""[^>]*>接受转移<\/button>/);
  const active = render(AccountClosurePanel, props, [[['account-closure'], { ...status, pending_deletion: false }], [['ownership-transfers'], inbox]]);
  assert.match(active, /<button type="button" class="[^"]*">接受转移<\/button>/);
  assert.match(active, /开始注销流程/);
  i18n.setLocale('en-US', false);
  const english = render(AccountClosurePanel, props, [[['account-closure'], status], [['ownership-transfers'], inbox]]);
  assert.match(english, /My account/);
  assert.doesNotMatch(english, /注销前的交接清单|接受转移|确认注销账号/);
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /aria-label=\{t\("我的账号"\)\}/);
  assert.match(app, /accountOpen && <AccountClosurePanel/);
});

test('成员兼容查询保持项目范围，缺少项目不会查询全局名单', async () => {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(url); return new Response(JSON.stringify({ ok: true, data: [] })); };
  try {
    assert.deepEqual(await api.listMembers(), []);
    await api.listProjectMembers('P', true);
    assert.deepEqual(calls, ['/api/members?project_code=P']);
  } finally { globalThis.fetch = previous; }
});


test('团队治理显示归属元数据，仅已授权项目提供访问链接', async () => {
  const { TeamProjectsGovernance } = await vite.ssrLoadModule('/src/TeamsWorkspace.tsx');
  const html = render(TeamProjectsGovernance, { teamCode: 'T' }, [[['team-projects-governance', 'T'], [
    { project_code: 'PRIVATE', name: '私人项目', status: 'active', owner_name: '私人项目负责人', can_access: false },
    { project_code: 'SHARED', name: '已授权项目', status: 'active', owner_name: '公开项目负责人', can_access: true },
  ]]]);
  assert.match(html, /私人项目负责人|未获项目访问权限/);
  assert.doesNotMatch(html, /href="[^"]*PRIVATE/);
  assert.match(html, /href="\/projects\/SHARED\/overview"/);
});


test('注销成功清理本机登录状态，注销被拒绝时保留用于交接的登录', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const storage = new Map([['acp.device_token', 'test-only-token'], ['acp.auth_user', '{}']]);
  globalThis.window = { localStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key) } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'account_closure_blocked', message: '尚有交接' } }), { status: 400 });
    await assert.rejects(api.completeAccountClosure(), /尚有交接/);
    assert.equal(storage.has('acp.device_token'), true);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: { pending_deletion: false, closed: true, teams: [], projects: [], open_tasks: [], active_runs: [] } }));
    await api.completeAccountClosure();
    assert.equal(storage.has('acp.device_token'), false); assert.equal(storage.has('acp.auth_user'), false);
  } finally { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});


test('项目访问策略预览明确显示失去写权限人数，并兼容旧预览缓存', () => {
  for (const lostWrite of [3, undefined]) {
    let stage = 0;
    function Probe() {
      const tree = ProjectMemberManagement({ project, onClose() {} });
      const nodes = elements(tree);
      if (stage === 0) { stage++; nodes.find(node => node.props.ariaLabel === '项目访问方式').props.onChange('team_read'); }
      else if (stage === 1) { stage++; nodes.find(node => node.type === 'button' && node.props.children === '预览权限影响').props.onClick(); }
      return tree;
    }
    const preview = { member_policy: 'team_write', proposed_policy: 'team_read', impact: { gained_read: 0, gained_write: 0, lost_write: lostWrite, lost_access: 0, explicit_exceptions: 2 } };
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: preview }));
    try {
      const html = render(Probe, {}, [[['project-policy-preview', 'P', 'team_read'], preview]]);
      assert.ok(html.includes(`失去写权限 ${lostWrite ?? 0} 人`));
      assert.match(html, /确认修改访问方式/);
    } finally { globalThis.fetch = previous; }
  }
});
