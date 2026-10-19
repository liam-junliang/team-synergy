import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;
before(async () => { vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', server: { middlewareMode: true, hmr: false } }); });
after(async () => { await vite?.close(); });

const baseline = version => ({ baseline_code: `BASE-${version}`, version, name: `历史范围 ${version}`, requirements: [{ requirement_code: 'REQ-A', revision: version }] });
const task = { code: 'TASK-A', project_code: 'PROJECT-A', requirement_code: 'REQ-A', source_requirement_revision: 1, status: 'assigned', runs: [], base_snapshot: 1, requirement_baseline_code: 'BASE-1', requirement_baseline_version: 1, requirement_baseline_name: '历史范围 1' };
async function render(taskData, baselines) {
  const { TaskBaselinePanel } = await vite.ssrLoadModule('/src/TaskBaselinePanel.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: 'owner', status: 'active' });
  client.setQueryData(['requirement-baselines', 'PROJECT-A'], { baselines, can_create: true });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(TaskBaselinePanel, { task: taskData })));
  client.clear();
  return html;
}

test('任务仍按固定需求修订筛选历史记录，执行后禁止更换', async () => {
  const html = await render(task, [baseline(1), baseline(2)]);
  assert.match(html, /value="BASE-1"/);
  assert.doesNotMatch(html, /value="BASE-2"/);
  assert.match(html, /历史范围 1/);
  assert.doesNotMatch(html, /href=|\/baselines/);
  const locked = await render({ ...task, runs: [{ run_code: 'RUN-A' }] }, [baseline(1)]);
  assert.doesNotMatch(locked, /任务绑定基线/);
  assert.match(locked, /历史范围 1/);
});

test('没有适用记录时不引导用户访问已经删除的页面', async () => {
  const html = await render({ ...task, requirement_baseline_code: null }, []);
  assert.match(html, /目前没有与此需求修订相符的历史基线记录/);
  assert.doesNotMatch(html, /href=|项目理解|基线页|\/baselines/);
});
