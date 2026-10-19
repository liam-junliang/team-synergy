import { getLocale } from './i18n.ts';
import type { TaskSummary } from './api';

export type TaskTimeOrder = 'newest' | 'oldest';

export interface TaskBoardFilters {
  keyword: string;
  featureCode: string;
  assigneeCode: string;
  source: string;
  timeOrder: TaskTimeOrder;
}

export const DEFAULT_TASK_BOARD_FILTERS: TaskBoardFilters = {
  keyword: '',
  featureCode: '',
  assigneeCode: '',
  source: '',
  timeOrder: 'newest',
};

function comparableTime(value?: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/** 已完成列以实际关闭时间排序；历史数据缺少关闭审计时回退到创建时间。 */
export function taskBoardTime(task: TaskSummary, columnId: string): number {
  if (columnId === 'done') return comparableTime(task.completed_at ?? task.created_at);
  if (columnId === 'cancelled') return comparableTime(task.cancelled_at ?? task.created_at);
  return comparableTime(task.created_at);
}

export function filterBoardTasks(tasks: TaskSummary[], filters: TaskBoardFilters): TaskSummary[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase(getLocale());
  return tasks.filter((task) => {
    if (filters.featureCode && task.feature_code !== filters.featureCode) return false;
    if (filters.assigneeCode && task.assignee_code !== filters.assigneeCode) return false;
    if (filters.source && task.source !== filters.source) return false;
    if (!keyword) return true;
    return [task.title, task.brief, task.code]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase(getLocale()).includes(keyword));
  });
}

export function sortBoardTasks(tasks: TaskSummary[], columnId: string, order: TaskTimeOrder): TaskSummary[] {
  const direction = order === 'newest' ? -1 : 1;
  return [...tasks].sort((left, right) => {
    const timeDifference = taskBoardTime(left, columnId) - taskBoardTime(right, columnId);
    if (timeDifference !== 0) return timeDifference * direction;
    return left.code.localeCompare(right.code);
  });
}
