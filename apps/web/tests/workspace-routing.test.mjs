import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_SECTIONS, parseWorkspacePath, projectWorkspacePath, projectHomeWorkspacePath, projectDocumentWorkspacePath, projectFolderWorkspacePath, requirementWorkspacePath, isWorkspacePath, legacyWorkspacePath, workspacePathAfterLogin, workspaceShareUrl } from '../src/workspaceRouting.ts';

test('工作区路由：顶层只保留团队/账号，项目能力必须携带 project code', () => {
  assert.deepEqual(parseWorkspacePath('/teams'), { view: 'teams' });
  assert.deepEqual(parseWorkspacePath('/account'), { view: 'account' });
  assert.deepEqual(parseWorkspacePath('/board'), { view: 'teams' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/requirements'), {
    view: 'requirements',
    projectCode: 'PROJECT-A',
    requirementsTab: 'ideas',
  });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/requirements?tab=table'), {
    view: 'requirements', projectCode: 'PROJECT-A', requirementsTab: 'checklist',
  });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/requirements?document=RDOC-AUTH'), {
    view: 'requirements', projectCode: 'PROJECT-A', requirementsTab: 'documents', documentCode: 'RDOC-AUTH',
  });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/requirements?tab=structure'), {
    view: 'overview', projectCode: 'PROJECT-A', projectTab: 'structure',
  });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/plan'), { view: 'plan', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/design'), { view: 'design', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/orchestration'), { view: 'overview', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/acceptance'), { view: 'overview', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A'), { view: 'overview', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/overview'), { view: 'overview', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/board'), { view: 'board', projectCode: 'PROJECT-A' });
  assert.equal(projectWorkspacePath('PROJECT A'), '/projects/PROJECT%20A/overview');
  assert.equal(projectWorkspacePath('PROJECT A', 'documents'), '/projects/PROJECT%20A/documents');
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/documents'), { view: 'documents', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/handovers?handover=TRANSFER-A'), { view: 'handovers', projectCode: 'PROJECT-A', handoverCode: 'TRANSFER-A' });
  assert.equal(projectWorkspacePath('PROJECT A', 'handovers'), '/projects/PROJECT%20A/handovers');
  assert.equal(requirementWorkspacePath('PROJECT A', { documentCode: 'RDOC-AUTH' }), '/projects/PROJECT%20A/requirements?tab=documents&document=RDOC-AUTH');
  assert.equal(requirementWorkspacePath('PROJECT A', { tab: 'topics' }), '/projects/PROJECT%20A/requirements?tab=topics');
  assert.equal(requirementWorkspacePath('PROJECT A', { tab: 'structure' }), '/projects/PROJECT%20A/overview?tab=structure');
});

test('项目内部概览、功能模块与架构设计使用可分享路径，架构资料编码支持往返', () => {
  assert.equal(projectHomeWorkspacePath('PROJECT A'), '/projects/PROJECT%20A/overview');
  assert.deepEqual(parseWorkspacePath(projectHomeWorkspacePath('PROJECT A', 'structure')), { view: 'overview', projectCode: 'PROJECT A', projectTab: 'structure' });
  assert.deepEqual(parseWorkspacePath(projectHomeWorkspacePath('项目 A/中文', 'architecture', 'ARCH A/+1')), { view: 'overview', projectCode: '项目 A/中文', projectTab: 'architecture', documentCode: 'ARCH A/+1' });
  assert.deepEqual(parseWorkspacePath('/projects/A/overview?tab=unknown&document=IGNORED'), { view: 'overview', projectCode: 'A' });
  assert.deepEqual(parseWorkspacePath('/projects/A/overview?tab=structure&document=IGNORED'), { view: 'overview', projectCode: 'A', projectTab: 'structure' });
});

test('项目首页文档链接直达对应正文，保留编码与刷新定位', () => {
  const path = projectDocumentWorkspacePath('项目 A/中文', 'DOC A/+1');
  assert.deepEqual(parseWorkspacePath(path), {
    view: 'documents', projectCode: '项目 A/中文', documentCode: 'DOC A/+1',
  });
});

test('路径识别仅接受工作台页面，忽略页面锚点且无效编码不会崩溃', () => {
  for (const path of ['/', '/teams', '/account/', '/projects/PROJECT-A', ...PROJECT_SECTIONS.map(section => `/projects/PROJECT-A/${section}`)]) {
    assert.equal(isWorkspacePath(path), true, path);
  }
  for (const path of ['/api/projects/PROJECT-A', '/projects/PROJECT-A/home', '/projects/PROJECT-A/handoff', '/projects/PROJECT-A/documents/download', '/teams/TEAM-A/projects', '/assets/index.js', '/projects//board', '/projects/%ZZ/board']) {
    assert.equal(isWorkspacePath(path), false, path);
  }
  assert.deepEqual(parseWorkspacePath('/projects/%ZZ/board'), { view: 'teams' });
  assert.deepEqual(parseWorkspacePath('/projects/P/documents?document=D#installation'), { view: 'documents', projectCode: 'P', documentCode: 'D' });
  assert.equal(legacyWorkspacePath('#/projects/P/requirements?tab=documents&document=D%2B1'), '/projects/P/requirements?tab=documents&document=D%2B1');
  for (const hash of ['#installation', '#/getting-started', '#/projects/%ZZ/board', '#/api/projects/P']) assert.equal(legacyWorkspacePath(hash), null, hash);
});

test('登录及强制改密后保留当前深链接，分享链接不拼接旧页面路径', () => {
  const path = projectDocumentWorkspacePath('PROJECT-A', 'DOC A/+1');
  for (const admin of [false, true]) {
    assert.equal(workspacePathAfterLogin(`https://app.example${path}#setup`, admin), `${path}#setup`);
    assert.equal(workspacePathAfterLogin(`https://app.example/stale?old=1#${path}`, admin), path);
    assert.equal(workspacePathAfterLogin('https://app.example/teams', admin), admin ? '/admin/teams' : '/teams');
  }
  assert.equal(workspacePathAfterLogin('https://app.example/', false), '/teams');
  assert.equal(workspacePathAfterLogin('https://app.example/', true), '/admin/teams');
  assert.equal(workspacePathAfterLogin('https://app.example/unknown', false), '/teams');
  const share = requirementWorkspacePath('PROJECT-A', { documentCode: 'DOC A/+1' });
  assert.equal(workspaceShareUrl(share, 'https://app.example/projects/OLD/board?old=1#stale'),
    'https://app.example/projects/PROJECT-A/requirements?tab=documents&document=DOC+A%2F%2B1');
});

test('规范目录链接支持编码往返与预选目录创建，其他页面不接受目录动作', () => {
  const folder = '目录 A/+1';
  assert.deepEqual(parseWorkspacePath(projectFolderWorkspacePath('项目 A/中文', folder)), {
    view: 'documents', projectCode: '项目 A/中文', folderCode: folder,
  });
  assert.deepEqual(parseWorkspacePath(projectFolderWorkspacePath('PROJECT-A', folder, true)), {
    view: 'documents', projectCode: 'PROJECT-A', folderCode: folder, createDocument: true,
  });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/documents?create=document'), { view: 'documents', projectCode: 'PROJECT-A' });
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/plan?folder=OTHER&create=document'), { view: 'plan', projectCode: 'PROJECT-A' });
});

test('已删除的项目理解链接回到同项目需求文档并丢弃旧参数', () => {
  assert.ok(!PROJECT_SECTIONS.includes('baselines'));
  assert.deepEqual(parseWorkspacePath('/projects/PROJECT-A/baselines'), {
    view: 'requirements', projectCode: 'PROJECT-A', requirementsTab: 'documents',
  });
  const legacyRoute = parseWorkspacePath('/projects/PROJECT%20A%2F%E4%B8%AD%E6%96%87/baselines?baseline=BASE+1&compare_to=current&tab=topics&document=OLD-DOC');
  assert.deepEqual(legacyRoute, {
    view: 'requirements', projectCode: 'PROJECT A/中文', requirementsTab: 'documents',
  });
  assert.equal(requirementWorkspacePath(legacyRoute.projectCode, { tab: legacyRoute.requirementsTab }),
    '/projects/PROJECT%20A%2F%E4%B8%AD%E6%96%87/requirements?tab=documents');
});
