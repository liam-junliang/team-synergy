import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
let i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', server: { middlewareMode: true, hmr: false } });
  i18n = await vite.ssrLoadModule('/src/i18n.ts');
});
afterEach(() => i18n.setLocale('zh-CN', false));
after(async () => { await vite?.close(); });

function render(component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [key, value] of entries) client.setQueryData(key, value);
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(component, props)));
  } finally { client.clear(); }
}

test('workspace navigation and team labels switch after modules load while user names stay unchanged', async () => {
  const { ProjectWorkspaceNavigation } = await vite.ssrLoadModule('/src/ProjectWorkspace.tsx');
  const { TeamsWorkspace } = await vite.ssrLoadModule('/src/TeamsWorkspace.tsx');
  const { currentPrincipalCode } = await vite.ssrLoadModule('/src/api.ts');
  assert.match(render(ProjectWorkspaceNavigation, { projectCode: 'P', tab: 'structure', moduleCount: 3 }), /功能模块/);
  i18n.setLocale('en-US', false);
  const navigation = render(ProjectWorkspaceNavigation, { projectCode: 'P', tab: 'structure', moduleCount: 3 });
  assert.match(navigation, /Modules/);
  assert.match(navigation, /Architecture/);
  assert.match(navigation, /aria-label="Project workspace views"/);
  const entries = [
    [['teams'], [{ code: 'T', name: '用户团队', role: 'owner', projects_count: 1, members_count: 1200 }]],
    [['projects', 'all', currentPrincipalCode()], [{ code: 'P', team_code: 'T', name: '用户项目', description: '用户项目说明', role: 'owner', members_count: 1200, status: 'active' }]],
    [['team-members', 'T'], []],
  ];
  const html = render(TeamsWorkspace, {}, entries);
  assert.match(html, /Teams &amp; projects/);
  assert.match(html, /Create team/);
  assert.match(html, /All projects/);
  assert.match(html, /Teams: 1/);
  assert.match(html, /Members: 1,200/);
  assert.match(html, /用户团队/);
  assert.match(html, /用户项目说明/);
  assert.doesNotMatch(html, /创建团队|团队管理|个团队/);
});

test('project home translates system sections without changing documents, people, or repositories', async () => {
  const { ProjectOverviewWorkbench } = await vite.ssrLoadModule('/src/ProjectOverviewWorkbench.tsx');
  const home = { project_code: 'P', can_edit: true, overview: { document_code: 'D', title: '用户文档标题', content: '用户正文 **原样保留**', summary: '', revision: 1, updated_at: '2026-10-16T00:00:00Z' }, guide: null, standards: [], standards_folder_code: 'S' };
  const entries = [
    [['project-home', 'P'], home],
    [['project', 'P'], { code: 'P', name: '用户项目', role: 'owner' }],
    [['project-members', 'P'], [{ code: 'U', display_name: '用户姓名', role: 'member' }]],
    [['project-repositories', 'P'], [{ code: 'R', name: '用户仓库', purpose: '用户用途', remote_url: 'https://example.com/repo.git', status: 'active' }]],
  ];
  const before = structuredClone(home);
  i18n.setLocale('en-US', false);
  const english = render(ProjectOverviewWorkbench, { projectCode: 'P' }, entries);
  assert.match(english, /Project standards/);
  assert.match(english, /Getting started is not configured/);
  assert.match(english, /Open document/);
  assert.match(english, /用户文档标题/);
  assert.match(english, /<strong>原样保留<\/strong>/);
  assert.match(english, /用户姓名/);
  assert.match(english, /用户仓库/);
  i18n.setLocale('zh-CN', false);
  const chinese = render(ProjectOverviewWorkbench, { projectCode: 'P' }, entries);
  assert.match(chinese, /项目规范/);
  assert.match(chinese, /尚未设置参与指引/);
  assert.deepEqual(home, before);
});

test('Gantt status labels and date scales use the current locale without rewriting schedule dates', async () => {
  const { buildPlanGanttTasks } = await vite.ssrLoadModule('/src/projectPlanGantt.ts');
  const { ganttScales } = await vite.ssrLoadModule('/src/ProjectPlanWorkbench.tsx');
  const phases = [{ code: 'PH', project_code: 'P', name: '用户阶段', summary: '', status: 'active', order: 0, start_at: '2026-10-01', end_at: '2026-10-31' }];
  const milestones = [{ code: 'M', project_code: 'P', phase_code: 'PH', name: '用户里程碑', status: 'at_risk', order: 0, start_at: '2026-10-01', target_at: '2026-10-31' }];
  const before = structuredClone([phases, milestones]);
  assert.equal(buildPlanGanttTasks(phases, milestones, [])[0].statusLabel, '进行中');
  i18n.setLocale('en-US', false);
  const tasks = buildPlanGanttTasks(phases, milestones, []);
  assert.equal(tasks[0].text, '用户阶段');
  assert.equal(tasks[0].statusLabel, 'In progress');
  assert.equal(tasks[1].statusLabel, 'At risk');
  assert.equal(tasks[0].scheduleLabel, '10/1 - 10/31');
  assert.equal(ganttScales('month')[1].format(new Date(2026, 9, 1)), 'October');
  assert.equal(ganttScales('day')[0].format(new Date(2026, 9, 1)), 'October 2026');
  assert.equal(buildPlanGanttTasks(phases, milestones, [], { locale: 'zh-CN' })[0].statusLabel, '进行中');
  assert.equal(ganttScales('day', new Date(2026, 9, 1), 'zh-CN')[0].format(new Date(2026, 9, 1)), '2026年10月');
  assert.deepEqual([phases, milestones], before);
});
