import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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

function task(code, overrides = {}) {
  return {
    code,
    feature_code: 'FEATURE-A',
    title: `任务 ${code}`,
    brief: null,
    profile: 'builder',
    source: 'requirement',
    status: 'assigned',
    assignee_code: 'USER-A',
    acceptance: [],
    base_snapshot: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

test('任务看板支持关键字、Feature、负责人和来源组合筛选', async () => {
  const { DEFAULT_TASK_BOARD_FILTERS, filterBoardTasks } = await vite.ssrLoadModule('/src/taskBoardFilters.ts');
  const tasks = [
    task('TASK-1', { title: '修复登录', brief: '处理会话过期' }),
    task('TASK-2', { feature_code: 'FEATURE-B', assignee_code: 'USER-B', source: 'defect-fix', title: '看板排序' }),
  ];

  assert.deepEqual(filterBoardTasks(tasks, { ...DEFAULT_TASK_BOARD_FILTERS, keyword: '会话' }).map((item) => item.code), ['TASK-1']);
  assert.deepEqual(filterBoardTasks(tasks, { ...DEFAULT_TASK_BOARD_FILTERS, featureCode: 'FEATURE-B', assigneeCode: 'USER-B', source: 'defect-fix' }).map((item) => item.code), ['TASK-2']);
});

test('已完成列默认使用关闭时间倒序，且可切换为正序', async () => {
  const { sortBoardTasks } = await vite.ssrLoadModule('/src/taskBoardFilters.ts');
  const tasks = [
    task('TASK-OLD', { status: 'closed', created_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-15T08:00:00.000Z' }),
    task('TASK-NEW', { status: 'closed', created_at: '2026-08-01T00:00:00.000Z', completed_at: '2026-08-17T08:00:00.000Z' }),
  ];

  assert.deepEqual(sortBoardTasks(tasks, 'done', 'newest').map((item) => item.code), ['TASK-NEW', 'TASK-OLD']);
  assert.deepEqual(sortBoardTasks(tasks, 'done', 'oldest').map((item) => item.code), ['TASK-OLD', 'TASK-NEW']);
});

test('非完成列按创建时间排序，缺少关闭审计的历史完成任务回退创建时间', async () => {
  const { sortBoardTasks, taskBoardTime } = await vite.ssrLoadModule('/src/taskBoardFilters.ts');
  const tasks = [
    task('TASK-OLD', { created_at: '2026-08-01T00:00:00.000Z' }),
    task('TASK-NEW', { created_at: '2026-08-17T00:00:00.000Z' }),
  ];

  assert.deepEqual(sortBoardTasks(tasks, 'todo', 'newest').map((item) => item.code), ['TASK-NEW', 'TASK-OLD']);
  assert.equal(taskBoardTime(task('TASK-LEGACY', { status: 'closed', created_at: '2026-08-03T00:00:00.000Z' }), 'done'), Date.parse('2026-08-03T00:00:00.000Z'));
});

test('已取消列使用取消时间排序', async () => {
  const { sortBoardTasks } = await vite.ssrLoadModule('/src/taskBoardFilters.ts');
  const tasks = [
    task('TASK-CANCEL-OLD', { status: 'cancelled', cancelled_at: '2026-08-10T08:00:00.000Z' }),
    task('TASK-CANCEL-NEW', { status: 'cancelled', cancelled_at: '2026-08-17T08:00:00.000Z' }),
  ];
  assert.deepEqual(sortBoardTasks(tasks, 'cancelled', 'newest').map((item) => item.code), ['TASK-CANCEL-NEW', 'TASK-CANCEL-OLD']);
});
