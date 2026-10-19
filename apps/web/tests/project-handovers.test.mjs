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

const record = (code, status, extra = {}) => ({ handover_code: code, task_code: `TASK-${code}`, task_title: `任务 ${code}`, status,
  version: 1, source_run_code: 'RUN-A', source_user_code: 'USER-A', target_user_code: 'USER-B', source_user_name: '小王', target_user_name: '小李', ...extra });

test('交接详情与上下文请求仍通过开发代理到达 API', () => {
  const matchers = Object.keys(vite.config.server.proxy ?? {}).map(pattern => new RegExp(pattern));
  for (const url of ['/api/handovers/HANDOVER-A', '/api/context-snapshots/CONTEXT-A', '/api/context-snapshots/CONTEXT-A/diff']) {
    assert.ok(matchers.some(matcher => matcher.test(url)), `API request must not fall back to HTML: ${url}`);
  }
});

test('项目交接筛选区分待处理、进行中与历史，支持任务及人名搜索且不改变原数组', async () => {
  const { filterProjectHandovers, needsHandoverAttention } = await vite.ssrLoadModule('/src/ProjectHandoversWorkbench.tsx');
  const rows = [record('A', 'published', { can_accept: true }), record('B', 'restoring'), record('C', 'completed'), record('D', 'cancelled')];
  const filter = (queue, search = '', status = '') => filterProjectHandovers(rows, { queue, search, status, principal: 'USER-B' }).map(row => row.handover_code);
  assert.deepEqual(filter('mine'), ['A', 'B']);
  assert.deepEqual(filter('active'), ['A', 'B']);
  assert.deepEqual(filter('history'), ['C', 'D']);
  assert.deepEqual(filter('all', '任务 A'), ['A']);
  assert.deepEqual(filter('all', '小李', 'completed'), ['C']);
  assert.equal(needsHandoverAttention(record('E', 'completed', { can_publish: true }), 'USER-A'), false);
  assert.deepEqual(rows.map(row => row.handover_code), ['A', 'B', 'C', 'D']);
});

test('独立交接页汇总多任务，深链接选中指定记录并复用上下文操作', async () => {
  const { ProjectHandoversWorkbench } = await vite.ssrLoadModule('/src/ProjectHandoversWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const first = record('FIRST', 'completed', { summary: { goal: '历史交接' } });
  const second = record('SECOND', 'published', { can_publish: false, can_accept: true, requirement_baseline_code: 'BASE-HISTORY', requirement_baseline_version: 1, requirement_baseline_name: '历史需求范围', summary: { goal: '准确恢复并继续开发', remaining: ['补充并发测试'] } });
  client.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: 'owner', status: 'active' });
  client.setQueryData(['project-handovers', 'PROJECT-A'], [first, second]);
  client.setQueryData(['task', second.task_code], { code: second.task_code, title: second.task_title, project_code: 'PROJECT-A', runs: [] });
  client.setQueryData(['task-handovers', second.task_code], [second]);
  client.setQueryData(['handover', second.handover_code], second);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectHandoversWorkbench, { projectCode: 'PROJECT-A', handoverCode: 'SECOND' })));
  assert.match(html, /项目 · 交接/);
  assert.match(html, /全部交接/); assert.match(html, /待我处理/);
  assert.match(html, /任务 FIRST/); assert.match(html, /任务 SECOND/);
  assert.match(html, /小王/); assert.match(html, /小李/);
  assert.match(html, /准确恢复并继续开发/); assert.match(html, /补充并发测试/);
  assert.match(html, /接收交接/);
  assert.match(html, /历史需求范围/);
  assert.doesNotMatch(html, /\/baselines/);
  assert.doesNotMatch(html, /历史交接/);
  assert.doesNotMatch(html, /搜索项目文档|新建文件夹/);
  client.setQueryData(['project', 'PROJECT-A'], { code: 'PROJECT-A', role: 'viewer', status: 'active' });
  const viewer = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectHandoversWorkbench, { projectCode: 'PROJECT-A', handoverCode: 'SECOND' })));
  assert.doesNotMatch(viewer, />接收交接<|>发布交接<|tsp handover activate/);
  assert.match(viewer, /准确恢复并继续开发/);
  client.clear();
});

test('无交接记录时引导从任务发起，并区分文档资料入口', async () => {
  const { ProjectHandoversWorkbench } = await vite.ssrLoadModule('/src/ProjectHandoversWorkbench.tsx');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project-handovers', 'PROJECT-A'], []);
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ProjectHandoversWorkbench, { projectCode: 'PROJECT-A' })));
  assert.match(html, /还没有交接记录/); assert.match(html, /打开任务看板/);
  assert.match(html, /\/projects\/PROJECT-A\/board/); assert.match(html, /请前往“文档”/);
  client.clear();
});
