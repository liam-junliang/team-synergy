import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { filterSwitchableProjects, isExternalProject, projectSwitchPath, projectTeamName } from '../src/projectSwitching.ts';
import { parseWorkspacePath, PROJECT_SECTIONS } from '../src/workspaceRouting.ts';

const projects = [
  { code: 'PROJECT-A', team_code: 'TEAM-A', name: 'Team Synergy', status: 'active' },
  { code: 'PROJECT-B', team_code: 'TEAM-B', name: '需求平台', status: 'active' },
  { code: 'PROJECT-C', team_code: 'TEAM-A', name: 'Archived product', status: 'archived' },
];
const teams = [{ code: 'TEAM-A', name: 'Engineering' }, { code: 'TEAM-B', name: '产品团队' }];

test('switching project preserves every project menu and clears previous-project detail state', () => {
  for (const view of PROJECT_SECTIONS) {
    const target = parseWorkspacePath(projectSwitchPath({ view, projectCode: 'OLD', documentCode: 'OLD-DOC', folderCode: 'OLD-FOLDER', createDocument: true, handoverCode: 'OLD-HANDOVER' }, 'NEW'));
    assert.equal(target.projectCode, 'NEW');
    assert.equal(target.view, view);
    for (const key of ['documentCode', 'folderCode', 'createDocument', 'handoverCode']) assert.equal(target[key], undefined, `${view} drops ${key}`);
  }
});

test('switching preserves legitimate project and requirement tabs with encoded project codes', () => {
  for (const projectTab of ['overview', 'structure', 'architecture']) {
    const route = parseWorkspacePath(projectSwitchPath({ view: 'overview', projectCode: 'OLD', projectTab, documentCode: 'ARCH-OLD' }, '项目 / B'));
    assert.equal(route.projectCode, '项目 / B');
    assert.equal(route.projectTab ?? 'overview', projectTab);
    assert.equal(route.documentCode, undefined);
  }
  for (const requirementsTab of ['ideas', 'topics', 'documents', 'checklist']) {
    assert.deepEqual(parseWorkspacePath(projectSwitchPath({ view: 'requirements', projectCode: 'OLD', requirementsTab, documentCode: 'REQ-OLD' }, 'NEW')), { view: 'requirements', projectCode: 'NEW', requirementsTab });
  }
  assert.equal(projectSwitchPath({ view: 'teams' }, 'NEW'), '/projects/NEW/overview');
  assert.equal(projectSwitchPath({ view: 'account' }, 'NEW'), '/projects/NEW/overview');
});

test('search finds authorized projects by project or team name/code without changing data or dropping archived projects', () => {
  const original = JSON.stringify({ projects, teams });
  assert.deepEqual(filterSwitchableProjects(projects, teams, '  synergy '), [projects[0]]);
  assert.deepEqual(filterSwitchableProjects(projects, teams, 'PROJECT-b'), [projects[1]]);
  assert.deepEqual(filterSwitchableProjects(projects, teams, 'engineering'), [projects[0], projects[2]]);
  assert.deepEqual(filterSwitchableProjects(projects, teams, '产品'), [projects[1]]);
  assert.deepEqual(filterSwitchableProjects(projects, [], 'TEAM-B'), [projects[1]], 'team-code search works even when team labels are unavailable');
  assert.deepEqual(filterSwitchableProjects(projects, teams, 'unknown'), []);
  assert.equal(filterSwitchableProjects(projects, teams, ''), projects);
  assert.equal(JSON.stringify({ projects, teams }), original);
});

test('owning team metadata names and finds external projects without fetching that team', () => {
  const external = { ...projects[0], code: 'EXTERNAL-PROJECT', team_code: 'OUTSIDE-TEAM', team_name: 'Partner Studio', is_external: true };
  assert.equal(projectTeamName(external, teams), 'Partner Studio');
  assert.equal(projectTeamName({ ...projects[0], team_name: 'Current Engineering' }, teams), 'Current Engineering', 'server name wins over an older team list');
  assert.equal(projectTeamName({ ...projects[0], team_name: '  ' }, teams), 'Engineering');
  assert.equal(projectTeamName(projects[0], []), 'TEAM-A');
  assert.deepEqual(filterSwitchableProjects([...projects, external], teams, '  PARTNER '), [external]);
  assert.deepEqual(filterSwitchableProjects([external], [], 'Studio'), [external], 'search works while the user team list is loading or unavailable');
});

test('external classification respects server metadata and never infers exclusion from an unavailable team list', () => {
  const external = { ...projects[0], team_code: 'OUTSIDE-TEAM' };
  assert.equal(isExternalProject({ ...external, is_external: true }, [], false), true);
  assert.equal(isExternalProject({ ...external, is_external: false }, [], true), false);
  assert.equal(isExternalProject({ ...projects[0], is_external: true }, teams, true), true, 'explicit project metadata wins');
  assert.equal(isExternalProject(projects[0], teams, false), false, 'known membership remains internal while refetching');
  assert.equal(isExternalProject(projects[0], [], false), undefined, 'loading or failed team data cannot establish external membership');
  assert.equal(isExternalProject(external, teams, true), true);
  assert.equal(isExternalProject(external, [], true), true, 'a successfully loaded empty team list still permits external projects');
});

let vite;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
});
after(async () => { await vite?.close(); });

test('project switcher shows the unmodified project name and an accessible collapsed trigger', async () => {
  const { ProjectSwitcher } = await vite.ssrLoadModule('/src/ProjectSwitcher.tsx');
  const { setLocale } = await vite.ssrLoadModule('/src/i18n.ts');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => { calls.push(args); throw new Error('Collapsed switcher must not fetch'); };
  try {
    setLocale('en-US', false);
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectSwitcher, { route: { view: 'documents', projectCode: 'P-A' }, currentProjectName: '用户项目中文名' })));
    assert.match(html, /用户项目中文名/);
    assert.match(html, /aria-label="Switch project"/);
    assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(html, /class="relative min-w-0 max-w-36 sm:max-w-52"/);
    assert.match(html, /class="inline-flex h-8 max-w-full /);
    assert.doesNotMatch(html, /role="dialog"/);
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = originalFetch; setLocale('zh-CN', false); client.clear(); }
});

test('external switcher options show owning team, role and translated badge without a team drilldown', async () => {
  const { ProjectSwitcherOption } = await vite.ssrLoadModule('/src/ProjectSwitcher.tsx');
  const { setLocale } = await vite.ssrLoadModule('/src/i18n.ts');
  const project = { ...projects[0], name: '外部项目原名', team_code: 'OUTSIDE-TEAM', team_name: '外部团队原名', is_external: true, role: 'member' };
  const path = '/projects/PROJECT-A/requirements?tab=documents';
  const props = { project, teams: [], teamMembershipKnown: false, selected: true, path, onClick() {} };
  try {
    for (const [locale, badge, currentLabel] of [['zh-CN', '外部协作', '当前项目'], ['en-US', 'External collaboration', 'Current project']]) {
      setLocale(locale, false);
      const html = renderToStaticMarkup(createElement(ProjectSwitcherOption, props));
      assert.match(html, /外部项目原名/);
      assert.match(html, /外部团队原名/);
      assert.ok(html.includes(badge));
      assert.ok(html.includes(currentLabel));
      assert.match(html, locale === 'zh-CN' ? />成员<\/span>/ : />Member<\/span>/);
      assert.match(html, /aria-current="page"/);
      assert.equal((html.match(/<a\b/g) ?? []).length, 1);
      assert.ok(html.includes(`href="${path}"`));
      assert.doesNotMatch(html, /href="[^\"]*\/teams\//);
    }
    const events = [];
    const option = ProjectSwitcherOption({ ...props, onClick: event => events.push(event) });
    const event = { button: 0 };
    option.props.children.props.onClick(event);
    assert.deepEqual(events, [event]);
  } finally { setLocale('zh-CN', false); }
});

test('internal and legacy switcher options keep safe labels while team data is loading or fails', async () => {
  const { ProjectSwitcherOption } = await vite.ssrLoadModule('/src/ProjectSwitcher.tsx');
  const render = (project, knownTeams, teamMembershipKnown = false) => renderToStaticMarkup(createElement(ProjectSwitcherOption, {
    project: { ...project, role: 'owner' }, teams: knownTeams, teamMembershipKnown, selected: false,
    path: '/projects/PROJECT-A/overview', onClick() {},
  }));
  const internal = render({ ...projects[0], team_name: 'Engineering', is_external: false }, [], true);
  assert.match(internal, /Engineering/);
  assert.doesNotMatch(internal, /外部协作/);
  const known = render(projects[0], teams);
  assert.match(known, /Engineering/);
  assert.doesNotMatch(known, /外部协作/);
  const unavailable = render(projects[0], []);
  assert.match(unavailable, /TEAM-A/);
  assert.doesNotMatch(unavailable, /外部协作/);
  assert.match(render(projects[2], teams), /已归档/);
});

test('project listing uses the existing membership-scoped endpoint without an arbitrary principal or team filter', async () => {
  const { listProjects, listTeams } = await vite.ssrLoadModule('/src/api.ts');
  const originalFetch = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async path => {
    paths.push(String(path));
    return new Response(JSON.stringify({ ok: true, data: String(path) === '/api/projects' ? [{ project_code: 'MEMBER-PROJECT', team_code: 'TEAM-A', name: 'Private project', status: 'active', role: 'member' }] : [] }), { status: 200 });
  };
  try {
    assert.equal((await listProjects())[0].code, 'MEMBER-PROJECT');
    await listTeams();
    assert.deepEqual(paths, ['/api/projects', '/api/teams']);
  } finally { globalThis.fetch = originalFetch; }
});
