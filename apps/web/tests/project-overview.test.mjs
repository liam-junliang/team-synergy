import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', server: { middlewareMode: true, hmr: false } });
});
after(async () => { await vite?.close(); });

const document = (code, title, content) => ({ document_code: code, title, summary: '', content, revision: 3, updated_at: '2026-10-15T08:00:00.000Z' });
const home = {
  project_code: 'PROJECT-A', can_edit: true,
  overview: document('DOC-OVERVIEW', '交付目标', '## 范围\n\n覆盖需求与任务交付。'),
  guide: document('DOC-GUIDE', '成员上手指南', '## 环境准备\n\n安装项目依赖后领取任务。'),
  standards: [
    { ...document('DOC-STANDARDS', '团队协作约定', '## 质量约定\n\n首页不应输出的协作规范长正文'), summary: '提交变更时附带测试证据。' },
    { ...document('DOC-CODE', '编码规范', '首页不应输出的编码规范长正文'), summary: '说明代码风格和评审约定。' },
  ],
  standards_folder_code: 'FOLDER-STANDARDS',
};

async function renderHome(overrides = {}, extra = {}) {
  const { ProjectOverviewWorkbench } = await vite.ssrLoadModule('/src/ProjectOverviewWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project-home', 'PROJECT-A'], { ...home, ...overrides });
  client.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', name: '协作平台', description: '让团队有序交付。', role: 'owner', member_management_supported: true });
  client.setQueryData(['project-members', 'PROJECT-A'], [
    { code: 'USER-A', display_name: 'Liam', account: 'liam', role: 'owner' }, { code: 'USER-B', display_name: '小陈', account: 'chen', role: 'member' },
  ]);
  client.setQueryData(['project-repositories', 'PROJECT-A'], [
    { code: 'REPO-A', name: '平台主仓库', purpose: 'Web 与 API', remote_url: 'https://example.com/platform.git', default_branch: 'main', status: 'active' },
    { code: 'REPO-B', name: '组件仓库', purpose: '共享组件', remote_url: 'https://example.com/components.git', default_branch: 'develop', status: 'active' },
    { code: 'REPO-OLD', name: '归档仓库', remote_url: 'https://example.com/old.git', status: 'archived' },
  ]);
  if (extra.project) client.setQueryData(['project', 'PROJECT-A'], extra.project);
  if (extra.membersPending) client.removeQueries({ queryKey: ['project-members', 'PROJECT-A'] });
  if (extra.membersError) client.getQueryCache().find({ queryKey: ['project-members', 'PROJECT-A'] }).setState({ status: 'error', error: new Error(extra.membersError) });
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectOverviewWorkbench, { projectCode: 'PROJECT-A' })));
  client.clear();
  return markup;
}

test('项目首页展示说明和指引正文，规范仅显示目录列表并附成员与活动仓库', async () => {
  const markup = await renderHome();
  for (const label of ['协作平台', '让团队有序交付', '项目说明', '参与指引', '项目规范', '覆盖需求与任务交付', '安装项目依赖后领取任务', '提交变更时附带测试证据', 'Liam', '负责人', '小陈', '平台主仓库', '组件仓库', '共享组件', 'https://example.com/platform.git', 'https://example.com/components.git']) assert.ok(markup.includes(label), label);
  assert.match(markup, /项目成员<span[^>]*>2<\/span>/);
  assert.match(markup, />成员<\/span>/);
  assert.match(markup, />@liam<\/span>/);
  assert.match(markup, />@chen<\/span>/);
  assert.match(markup, /代码仓库<span[^>]*>2<\/span>/);
  assert.doesNotMatch(markup, /默认分支|>main<|>develop</);
  assert.match(markup, /功能目标、业务规则和验收标准/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/documents\?document=DOC-OVERVIEW"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/plan"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/requirements"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/board"/);
  assert.equal((markup.match(/>编辑正文</g) ?? []).length, 2);
  assert.equal((markup.match(/>更换文档</g) ?? []).length, 2);
  assert.match(markup, /团队协作约定/);
  assert.match(markup, /编码规范/);
  assert.match(markup, /2 份/);
  assert.match(markup, /line-clamp-2/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/documents\?document=DOC-STANDARDS"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/documents\?document=DOC-CODE"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/documents\?folder=FOLDER-STANDARDS"/);
  assert.match(markup, /href="\/projects\/PROJECT-A\/documents\?folder=FOLDER-STANDARDS&amp;create=document"/);
  assert.doesNotMatch(markup, /首页不应输出的/);
  assert.doesNotMatch(markup, /归档仓库|old\.git/);
});

test('普通成员能阅读首页及打开文档，但没有正文或绑定编辑入口', async () => {
  const markup = await renderHome({ can_edit: false });
  assert.match(markup, /覆盖需求与任务交付/);
  assert.equal((markup.match(/>打开文档</g) ?? []).length, 2);
  assert.match(markup, /打开规范：团队协作约定/);
  assert.match(markup, /打开项目规范目录/);
  assert.doesNotMatch(markup, /编辑正文|更换文档|绑定已有文档|新建文档|创建并绑定|新增规范|create=document/);
});

test('成员正在加载或请求失败时不显示零人和空名单', async () => {
  const loading = await renderHome({}, { membersPending: true });
  const loadingSection = loading.split('项目成员<span')[1].split('</section>')[0];
  assert.match(loadingSection, /正在加载成员/);
  assert.doesNotMatch(loadingSection, />0<|暂无项目成员信息/);
  const failed = await renderHome({}, { membersError: '成员数据加载失败' });
  const failedSection = failed.split('项目成员<span')[1].split('</section>')[0];
  assert.match(failedSection, /成员数据加载失败/);
  assert.doesNotMatch(failedSection, />0<|暂无项目成员信息/);
});

test('规范长正文不进入首页HTML，长摘要限制两行并提供空摘要提示', async () => {
  const markup = await renderHome({ standards: [
    { ...document('DOC-LONG', '完整规范', 'PRIVATE_BODY_MARKER'.repeat(2000)), summary: '较长规范摘要'.repeat(80) },
    document('DOC-EMPTY', '无摘要规范', 'PRIVATE_BODY_MARKER'.repeat(2000)),
  ] });
  assert.doesNotMatch(markup, /PRIVATE_BODY_MARKER/);
  assert.match(markup, /<p class="[^"]*line-clamp-2[^"]*">较长规范摘要/);
  assert.match(markup, /暂无摘要，打开文档查看规范/);
  assert.match(markup, /r3 ·/);
  assert.match(markup, /打开规范：完整规范/);
});

test('未配置首页时为 Owner 提供设置入口，成员看到清楚的只读空态', async () => {
  const empty = { overview: null, guide: null, standards: [] };
  const ownerMarkup = await renderHome(empty);
  assert.equal((ownerMarkup.match(/>绑定已有文档</g) ?? []).length, 2);
  assert.equal((ownerMarkup.match(/>新建文档</g) ?? []).length, 2);
  assert.match(ownerMarkup, /尚未设置参与指引/);
  assert.match(ownerMarkup, /暂无项目规范/);
  assert.match(ownerMarkup, /新增规范/);
  assert.match(ownerMarkup, /将已有文档移入/);
  const memberMarkup = await renderHome({ ...empty, can_edit: false });
  assert.match(memberMarkup, /项目负责人或管理员设置后，成员可在这里查看/);
  assert.doesNotMatch(memberMarkup, /绑定已有文档|新建文档/);
});

test('首页绑定候选仅包含活动项目文档，排除需求和架构来源并兼容旧数据', async () => {
  const { activeHomeDocuments } = await vite.ssrLoadModule('/src/ProjectOverviewWorkbench.tsx');
  const documents = [
    { document_code: 'DOC-A', status: 'active' }, { document_code: 'DOC-B', status: 'archived' },
    { document_code: 'RD-A', status: 'active', source_kind: 'requirement' },
    { document_code: 'DOC-C', status: 'active', source_kind: 'project' },
    { document_code: 'ARCH-A', status: 'active', source_kind: 'architecture' },
  ];
  assert.deepEqual(activeHomeDocuments(documents), [documents[0], documents[3]]);
  assert.equal(documents.length, 5);
});

test('从首页编辑正文保留目录与状态，省略类型以保留旧分类', async () => {
  const { homeDocumentRevision } = await vite.ssrLoadModule('/src/ProjectOverviewWorkbench.tsx');
  const input = homeDocumentRevision({ kind: 'deployment', folder_code: 'FOLDER-OPS', status: 'active' }, {
    title: '  环境准备  ', summary: '  新环境  ', content: '# 安装\n\n安装依赖。', change_summary: '补充环境说明',
  });
  assert.deepEqual(input, {
    title: '环境准备', summary: '新环境', content: '# 安装\n\n安装依赖。', change_summary: '补充环境说明',
    folder_code: 'FOLDER-OPS', status: 'active',
  });
});

test('首页接口保留实时文档正文，绑定只更新目标栏目而不会重写其他栏目', async (t) => {
  const { getProjectHome, bindProjectHomeDocument } = await vite.ssrLoadModule('/src/api.ts');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, data: home }), { status: 200 });
  });
  assert.deepEqual(await getProjectHome('PROJECT A'), home);
  await bindProjectHomeDocument('PROJECT A', 'guide', 'DOC-NEW');
  await bindProjectHomeDocument('PROJECT A', 'overview', null);
  assert.deepEqual(calls, [
    { path: '/api/projects/PROJECT%20A/home', method: 'GET', body: null },
    { path: '/api/projects/PROJECT%20A/home', method: 'PUT', body: { guide_document_code: 'DOC-NEW' } },
    { path: '/api/projects/PROJECT%20A/home', method: 'PUT', body: { overview_document_code: null } },
  ]);
});

test('项目详情返回 project_code 时仍请求当前项目成员接口，不误用空名单兼容分支', async (t) => {
  const { getProject, listProjectMembers } = await vite.ssrLoadModule('/src/api.ts');
  const projectCode = 'TBP8SXKNJ092Y9086176';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    calls.push(path);
    const data = path.endsWith('/members')
      ? [{ user_code: 'USER-OWNER', display_name: 'Liam', account: 'liam', role: 'owner' }, { user_code: 'USER-MEMBER', display_name: '小陈', role: 'member' }]
      : { project_code: projectCode, team_code: 'TEAM-A', name: '协作平台', status: 'active', role: 'owner' };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  const project = await getProject(projectCode);
  const members = await listProjectMembers(project.code, project.member_management_supported === false);
  assert.equal(project.member_management_supported, true);
  assert.deepEqual(members, [{ code: 'USER-OWNER', display_name: 'Liam', account: 'liam', role: 'owner' }, { code: 'USER-MEMBER', display_name: '小陈', role: 'member' }]);
  assert.deepEqual(calls, [`/api/projects/${projectCode}`, `/api/projects/${projectCode}/members`]);
});

test('后端拒绝跨项目或失效的文档绑定时保留错误，页面不会得到假成功', async (t) => {
  const { bindProjectHomeDocument } = await vite.ssrLoadModule('/src/api.ts');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_DOCUMENT', message: '只能绑定当前项目的活动文档' } }), { status: 400 }));
  await assert.rejects(bindProjectHomeDocument('PROJECT-A', 'overview', 'OTHER-PROJECT-DOC'), /只能绑定当前项目的活动文档/);
});

test('深层页面中的 JSON API 请求仍使用站点根目录的 /api 路径', async (t) => {
  const { getProjectHome } = await vite.ssrLoadModule('/src/api.ts');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: new URL('https://workspace.test/projects/PROJECT-A/documents/DOC-A?revision=2#验收'),
    localStorage: { getItem: () => null },
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path) => {
    calls.push(new URL(path, globalThis.window.location.href).href);
    return new Response(JSON.stringify({ ok: true, data: home }), { status: 200 });
  });
  assert.deepEqual(await getProjectHome('PROJECT A'), home);
  assert.deepEqual(calls, ['https://workspace.test/api/projects/PROJECT%20A/home']);
});

test('首页通过现有 Markdown 渲染器显示文本，不执行文档中的 HTML', async () => {
  const markup = await renderHome({ overview: document('DOC-RAW', '资料', '<script>alert("injected")</script>') });
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
});

test('观看者不能通过历史 can_edit 标记编辑首页，管理员可管理首页', async () => {
  const viewer = await renderHome({}, { project: { code: 'PROJECT-A', role: 'viewer', status: 'active' } });
  assert.doesNotMatch(viewer, /编辑正文|更换文档|新增规范/);
  assert.match(viewer, /覆盖需求与任务交付/);
  const admin = await renderHome({}, { project: { code: 'PROJECT-A', role: 'admin', status: 'active' } });
  assert.match(admin, /编辑正文/);
});
