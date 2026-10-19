import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let TeamsWorkspace;
let api;
let i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  ({ TeamsWorkspace } = await vite.ssrLoadModule('/src/TeamsWorkspace.tsx'));
  api = await vite.ssrLoadModule('/src/api.ts');
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
});
after(async () => { await vite?.close(); });

const ownTeam = { code: 'TEAM-A', name: '研发团队', role: 'owner', members_count: 3, projects_count: 1 };
const internal = { code: 'PROJECT-A', team_code: ownTeam.code, team_name: ownTeam.name, is_external: false, name: '内部项目', description: '内部说明', role: 'owner', status: 'active', members_count: 3 };
const external = { code: 'PROJECT-X', team_code: 'TEAM-X', team_name: '外部设计公司', is_external: true, name: '授权设计项目', description: '外部说明', role: 'member', status: 'active', members_count: 2 };
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  return node?.props ? [node, ...elements(node.props.children)] : [];
}

function renderWorkspace({ teams = [], projects = [external], scope, action, teamError, projectError, locale = 'zh-CN' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['teams'], teams);
  const projectKey = ['projects', 'all', api.currentPrincipalCode()];
  client.setQueryData(projectKey, projects);
  if (teamError) client.getQueryCache().find({ queryKey: ['teams'], exact: true }).setState({ status: 'error', error: new Error(teamError) });
  if (projectError) client.getQueryCache().find({ queryKey: projectKey, exact: true }).setState({ status: 'error', error: new Error(projectError) });
  const actions = [scope, action].filter(Boolean);
  let step = 0;
  function Probe() {
    const tree = TeamsWorkspace();
    if (step < actions.length) {
      const label = actions[step++];
      const button = elements(tree).find(item => item.type === 'button' && item.props['aria-label'] === label);
      assert.ok(button, `button ${label} exists`);
      button.props.onClick();
    }
    return tree;
  }
  try {
    i18n.setLocale(locale, false);
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  } finally { client.clear(); i18n.setLocale('zh-CN', false); }
}

test('没有团队但有获授权项目时，默认全部项目可直接进入，外部团队不混入我的团队', () => {
  const html = renderWorkspace();
  assert.match(html, /href="\/projects\/PROJECT-X\/overview"/);
  assert.match(html, /授权设计项目/);
  assert.match(html, /所属团队：外部设计公司/);
  assert.match(html, /aria-label="全部项目" aria-pressed="true"/);
  assert.match(html, /外部协作/);
  const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)[0];
  assert.doesNotMatch(sidebar, /外部设计公司/);
  assert.doesNotMatch(html, /请选择团队|请先创建|团队管理|>创建项目</);
});

test('默认展示全部已授权项目，外部和团队筛选互不混淆，跨团队列表不提供团队内排序', () => {
  const input = { teams: [ownTeam], projects: [internal, external] };
  const all = renderWorkspace(input);
  assert.match(all, /href="\/projects\/PROJECT-A\/overview"/);
  assert.match(all, /href="\/projects\/PROJECT-X\/overview"/);
  assert.doesNotMatch(all, /调整项目顺序：|团队管理/);
  const externalOnly = renderWorkspace({ ...input, scope: '外部协作' });
  assert.match(externalOnly, /href="\/projects\/PROJECT-X\/overview"/);
  assert.doesNotMatch(externalOnly, /href="\/projects\/PROJECT-A\/overview"|团队管理|>创建项目</);
  const teamOnly = renderWorkspace({ ...input, scope: '查看团队项目：研发团队' });
  assert.match(teamOnly, /href="\/projects\/PROJECT-A\/overview"/);
  assert.doesNotMatch(teamOnly, /href="\/projects\/PROJECT-X\/overview"/);
  assert.match(teamOnly, /团队管理|>创建项目</);
  assert.match(teamOnly, /调整项目顺序：内部项目/);
});

test('团队查询失败不阻塞项目，项目失败提供重试且不伪装成空列表', () => {
  const teamFailed = renderWorkspace({ teamError: '团队请求失败' });
  assert.match(teamFailed, /授权设计项目|外部设计公司/);
  assert.match(teamFailed, /重新读取团队/);
  const projectsFailed = renderWorkspace({ projects: [], projectError: '项目请求失败' });
  assert.match(projectsFailed, /项目列表读取失败/);
  assert.match(projectsFailed, /重新读取项目/);
  assert.doesNotMatch(projectsFailed, /还没有可访问的项目/);
});

test('没有团队和项目时不要求先建团队，英语页面保留用户内容', () => {
  const empty = renderWorkspace({ projects: [] });
  assert.match(empty, /还没有可访问的项目/);
  assert.doesNotMatch(empty, /请选择团队|请先创建/);
  const english = renderWorkspace({ locale: 'en-US' });
  assert.match(english, /All projects/);
  assert.match(english, /External collaboration/);
  assert.match(english, /授权设计项目|外部设计公司/);
  assert.doesNotMatch(english, /外部协作|全部项目|所属团队：/);
});

test('项目接口保留安全团队上下文，旧接口缺字段时不猜测外部身份', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: [external, { ...internal, team_name: undefined, is_external: undefined }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const projects = await api.listProjects();
    assert.equal(projects[0].team_name, external.team_name);
    assert.equal(projects[0].is_external, true);
    assert.equal(projects[1].is_external, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('全部与外部视图可按项目角色打开编辑和仓库，弹窗不依赖选中团队', () => {
  const all = renderWorkspace({ teams: [ownTeam], projects: [internal, external], action: '编辑项目：内部项目' });
  assert.match(all, /role="dialog"/);
  assert.match(all, /id="edit-project-dialog-title"/);
  assert.match(all, /value="内部项目"/);
  const externalOwner = { ...external, role: 'owner' };
  const outside = renderWorkspace({ projects: [externalOwner], scope: '外部协作', action: '编辑项目：授权设计项目' });
  assert.match(outside, /value="授权设计项目"/);
  assert.match(outside, /<strong[^>]*>外部设计公司<\/strong>/);
  assert.doesNotMatch(outside, /团队管理|>创建项目</);
  const member = renderWorkspace();
  assert.doesNotMatch(member, /aria-label="编辑项目：授权设计项目"/);
  const repositories = renderWorkspace({ scope: '外部协作', action: '代码仓库：授权设计项目' });
  assert.match(repositories, /id="project-repositories-dialog-title"/);
});

test('旧接口的未知协作身份不误标外部，也不阻止直接进入项目', () => {
  const legacy = { ...external, is_external: undefined, team_name: undefined };
  const all = renderWorkspace({ projects: [legacy], teamError: 'offline' });
  assert.match(all, /href="\/projects\/PROJECT-X\/overview"/);
  const outside = renderWorkspace({ projects: [legacy], teamError: 'offline', scope: '外部协作' });
  assert.match(outside, /部分项目的协作身份暂时无法确认/);
  assert.doesNotMatch(outside, /暂无外部协作项目|href="\/projects\/PROJECT-X\/overview"/);
});
