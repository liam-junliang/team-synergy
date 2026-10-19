import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test('缺陷工作台使用队列、详情、修复任务与回归动作组织闭环', async () => {
  const { DefectsWorkbench } = await vite.ssrLoadModule('/src/DefectsWorkbench.tsx');
  const projectCode = 'PROJECT-A';
  const client = new QueryClient();
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active' });
  client.setQueryData(['defects', projectCode], [{
    code: 'DEFECT-1',
    feature_code: 'FEATURE-1',
    title: '登录后项目看板空白',
    severity: 'high',
    status: 'fixing',
    reported_by: 'USER-1',
    description: '复现步骤：登录后进入项目。\n实际结果：页面空白。\n预期结果：显示任务看板。',
    found_in: 'v0.3.1 · Chrome',
    related_requirement_code: 'REQ-1',
    reported_at: '2026-08-17T08:00:00.000Z',
    fix_tasks: [{ task_code: 'TASK-1', title: '修复项目看板初始化', status: 'verified', assignee_principal_code: 'USER-2', created_at: '2026-08-17T08:30:00.000Z' }],
  }]);
  client.setQueryData(['features', projectCode], [{ code: 'FEATURE-1', project_code: projectCode, title: '任务看板', goal: null, status: 'active', module_code: null, module_name: null, milestone_code: null, milestone_name: null, start_at: null, end_at: null }]);
  client.setQueryData(['requirements', projectCode], [{ code: 'REQ-1', feature_code: 'FEATURE-1', module_code: null, module_name: null, document_code: null, title: '登录后查看任务', current_revision: 1, owner_code: 'USER-1', status: 'confirmed', summary: '', body: '', acceptance_criteria: [], open_questions: [], keywords: [], task_count: 1 }]);
  client.setQueryData(['members', projectCode], [{ code: 'USER-1', role: 'owner', display_name: 'Liam' }, { code: 'USER-2', role: 'member', display_name: '王构建' }]);

  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DefectsWorkbench, { projectCode })));

  assert.match(html, /缺陷工作台|DEFECT WORKBENCH/);
  assert.match(html, /搜索标题、描述或版本/);
  assert.match(html, /登录后项目看板空白/);
  assert.match(html, /复现步骤：登录后进入项目/);
  assert.match(html, /修复项目看板初始化/);
  assert.match(html, /王构建/);
  assert.match(html, /打开任务看板/);
  assert.match(html, /进入回归验证/);
  assert.match(html, /修复任务已完成验证/);
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'viewer', status: 'active' });
  const viewer = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DefectsWorkbench, { projectCode })));
  assert.doesNotMatch(viewer, />报告缺陷<|>进入回归验证<|>创建修复任务</);
  assert.match(viewer, /登录后项目看板空白/);
  client.clear();
});

test('缺陷 API 将 defect_code 写入修复任务并按公开编码流转', async () => {
  const { createDefect, createTask, transitionDefect } = await vite.ssrLoadModule('/src/api.ts');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path: String(path), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const data = String(path) === '/api/defects'
      ? { defect_code: 'DEFECT-1', status: 'reported' }
      : String(path) === '/api/tasks'
        ? { task_code: 'TASK-1', status: 'draft', base_snapshot: 0 }
        : { defect_code: 'DEFECT-1', status: init.body && JSON.parse(init.body).to };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    await createDefect({ feature_code: 'FEATURE-1', title: '空白页', severity: 'high', description: '稳定复现' });
    await createTask({ feature_code: 'FEATURE-1', defect_code: 'DEFECT-1', title: '修复空白页', brief: '完整上下文', profile: 'builder', source: 'defect-fix', acceptance: [{ id: 'AC-1', text: '回归通过' }] });
    await transitionDefect('DEFECT-1', { to: 'fixing', fix_task_code: 'TASK-1' });

    assert.deepEqual(calls.map((call) => [call.method, call.path]), [['POST', '/api/defects'], ['POST', '/api/tasks'], ['POST', '/api/defects/DEFECT-1/transition']]);
    assert.equal(calls[1].body.defect_code, 'DEFECT-1');
    assert.equal(calls[1].body.source, 'defect-fix');
    assert.equal(calls[2].body.fix_task_code, 'TASK-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
