import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

test('功能模块页只展示模块与 Feature，不渲染计划字段', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { ProjectStructureWorkbench, initializeModuleSelection } = await vite.ssrLoadModule('/src/ProjectStructureWorkbench.tsx');
    const projectCode = 'PROJECT-A';
    const client = new QueryClient();
    client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active' });
    client.setQueryData(['project-modules', projectCode], [
      { code: 'MODULE-1', project_code: projectCode, name: '需求结构', summary: null, status: 'active' },
    ]);
    client.setQueryData(['features', projectCode], [
      {
        code: 'FEATURE-1', project_code: projectCode, title: '模块 Feature 管理', goal: '保持职责单一', status: 'active',
        module_code: 'MODULE-1', module_name: '需求结构', milestone_code: 'MILESTONE-1', milestone_name: '计划节点',
        start_at: '2026-08-18', end_at: '2026-08-28',
      },
    ]);

    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(ProjectStructureWorkbench, { projectCode }),
    ));

    assert.match(html, /功能模块/);
    assert.match(html, /模块 Feature 管理/);
    assert.match(html, /需求结构/);
    assert.match(html, /搜索 Feature、模块/);
    assert.match(html, /调整模块顺序：需求结构/);
    assert.match(html, /调整 Feature 顺序：模块 Feature 管理/);
    assert.equal((html.match(/新增 Feature/g) ?? []).length, 1, 'Feature 列表只保留一个新增入口');
    assert.equal((html.match(/新增模块/g) ?? []).length, 1, '新增模块入口只出现在模块列表标题栏');
    assert.doesNotMatch(html, /新建 Feature/);
    assert.doesNotMatch(html, /里程碑|排期|MILESTONE-1|2026-08-18|2026-08-28/);
    for (const role of ['member', 'viewer', 'admin']) {
      client.setQueryData(['project', projectCode], { code: projectCode, role, status: 'active' });
      const rendered = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectStructureWorkbench, { projectCode })));
      if (role === 'admin') assert.match(rendered, /新增模块/);
      else assert.doesNotMatch(rendered, /新增模块|新增 Feature|编辑模块：|调整模块顺序：|调整 Feature 顺序：/);
      assert.match(rendered, /模块 Feature 管理/);
    }
    client.clear();
    assert.equal(initializeModuleSelection(undefined, [{ code: 'MODULE-1' }]), 'MODULE-1');
    assert.equal(initializeModuleSelection(null, [{ code: 'MODULE-1' }]), null, '用户选择全部后不能再次自动选中首个模块');
  } finally {
    await vite.close();
  }
});

test('Feature 编辑表单不再提交里程碑或日期字段', async () => {
  const source = await readFile(new URL('../src/ProjectStructureWorkbench.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /listProjectMilestones|ProjectMilestone|milestone_code|milestone_name|start_date|end_date/);
  assert.match(source, /description=\{t\("维护 Feature 的名称、目标、所属模块和状态。"\)\}/);
  assert.match(source, /project_code: projectCode/);
  assert.match(source, /aria-pressed=\{selectedModuleCode === null\}/);
  assert.match(source, /aria-pressed=\{selectedModuleCode === module\.code\}/);
  assert.match(source, /aria-label=\{t\("筛选模块：\{p0\}", \{ p0: module\.name \}\)\}/);
  assert.match(source, /ui-context-action-selected/);
  assert.match(source, /aria-label=\{t\("编辑模块：\{p0\}", \{ p0: module\.name \}\)\}/);
  assert.match(source, /updateModuleLifecycleMutation\.mutate/);
  assert.match(source, /aria-label=\{t\("编辑 Feature：\{p0\}", \{ p0: feature\.title \}\)\}/);
  assert.match(source, /reorderProjectModules/);
  assert.match(source, /reorderFeatures/);
  assert.match(source, /moveModuleWithKeyboard/);
  assert.match(source, /moveFeatureWithKeyboard/);
  assert.doesNotMatch(source, /text-xs font-semibold text-cyan-700 hover:text-cyan-800/);
  assert.doesNotMatch(source, /openEditFeature\(feature\)[\s\S]{0,120}ui-button-strong/);

  const moduleDialogSource = source.slice(source.indexOf('function ModuleDialog'), source.indexOf('function FeatureDialog'));
  assert.doesNotMatch(moduleDialogSource, /Field label="状态"|MODULE_STATUS_OPTIONS|setStatus/);
  assert.match(moduleDialogSource, /onSubmit\(\{ name: name\.trim\(\), summary: summary\.trim\(\) \|\| undefined \}\)/);
  assert.match(moduleDialogSource, /activeFeatureCount > 0/);
  assert.match(moduleDialogSource, /t\("仍有 \{count\} 个未归档 Feature", \{ count: state\.activeFeatureCount \}\)/);
  assert.match(moduleDialogSource, /归档模块/);

  const featureDialogSource = source.slice(source.indexOf('function FeatureDialog'), source.indexOf('function ModalShell'));
  assert.match(featureDialogSource, /交付状态/);
  assert.match(featureDialogSource, /归档 Feature/);
  assert.doesNotMatch(featureDialogSource, /draft|confirmed|implementing/);

  const apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /fetchEnvelope<RawProjectModule>\(`\/modules\/\$\{encodeURIComponent\(moduleCode\)\}`/);
  assert.match(apiSource, /\/modules\/order/);
  assert.match(apiSource, /\/features\/order/);
  assert.match(apiSource, /left\.order - right\.order/);
  assert.match(apiSource, /\[\.\.\.derived\.values\(\), \.\.\.modules\.map\(\(item\) => normalizeProjectModule\(item\)\)\]/);

});

test('自动轮询只保留在任务看板，不作为全站查询默认值', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { createWebQueryClient, TASK_BOARD_REFRESH_INTERVAL_MS } = await vite.ssrLoadModule('/src/queryPolicy.ts');
    const client = createWebQueryClient();
    const defaults = client.getDefaultOptions().queries;

    assert.equal(defaults.refetchInterval, undefined);
    assert.equal(defaults.refetchOnWindowFocus, false);
    assert.equal(defaults.staleTime, 30_000);
    assert.equal(TASK_BOARD_REFRESH_INTERVAL_MS, 10_000);

    const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
    assert.match(appSource, /queryKey: \['tasks', projectCode\][\s\S]{0,160}refetchInterval: TASK_BOARD_REFRESH_INTERVAL_MS/);
  } finally {
    await vite.close();
  }
});
