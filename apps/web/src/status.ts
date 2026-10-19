/** 状态展示映射（docs/02 十态 + 派生） */
export const STATUS_META: Record<string, { label: string; color: string; group: string }> = {
  draft: { label: '草稿', color: 'bg-slate-200 text-slate-700', group: 'backlog' },
  ready: { label: '就绪', color: 'bg-sky-100 text-sky-700', group: 'backlog' },
  assigned: { label: '已分派', color: 'bg-indigo-100 text-indigo-700', group: 'todo' },
  running: { label: '进行中', color: 'bg-blue-100 text-blue-700', group: 'doing' },
  self_tested: { label: '自测完成', color: 'bg-teal-100 text-teal-700', group: 'doing' },
  submitted: { label: '待验收', color: 'bg-amber-100 text-amber-700', group: 'review' },
  verified: { label: '已验收', color: 'bg-emerald-100 text-emerald-700', group: 'review' },
  closed: { label: '已关闭', color: 'bg-green-600 text-white', group: 'done' },
  blocked: { label: '阻塞', color: 'bg-red-100 text-red-700', group: 'doing' },
  failed: { label: '失败', color: 'bg-rose-600 text-white', group: 'doing' },
  cancelled: { label: '已取消', color: 'bg-slate-500 text-white', group: 'cancelled' },
};

export const BOARD_COLUMNS: Array<{ id: string; title: string; statuses: string[] }> = [
  { id: 'backlog', title: '待处理', statuses: ['draft', 'ready'] },
  { id: 'todo', title: '已分派', statuses: ['assigned'] },
  { id: 'doing', title: '执行中', statuses: ['running', 'self_tested', 'blocked', 'failed'] },
  { id: 'review', title: '验收', statuses: ['submitted', 'verified'] },
  { id: 'done', title: '已完成', statuses: ['closed'] },
  { id: 'cancelled', title: '已取消', statuses: ['cancelled'] },
];

export const PROFILE_META: Record<string, string> = {
  planner: '规划',
  builder: '构建',
  verifier: '验证',
};

export const SOURCE_META: Record<string, string> = {
  requirement: '需求',
  'defect-fix': '缺陷修复',
  'ad-hoc': '临时',
  integration: '集成',
};

/** stale 判定（docs/16）：最后活动超过 24h 的任务需要显眼提示 */
export function isStale(lastActivityAt: string | undefined, now = Date.now()): boolean {
  if (!lastActivityAt) return false;
  const diff = now - new Date(lastActivityAt).getTime();
  return diff > 24 * 60 * 60 * 1000;
}
