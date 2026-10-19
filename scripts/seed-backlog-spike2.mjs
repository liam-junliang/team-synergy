// 把本项目剩余开发工作批量录入平台（dogfooding：看板反映真实 backlog）。
// 用法：node scripts/seed-backlog-spike2.mjs（需 core-api 运行在 ACP_API_URL）
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../apps/cli/dist/index.js');
const apiUrl = process.env.ACP_API_URL ?? 'http://127.0.0.1:8080';
const projectCode = process.env.ACP_PROJECT_CODE;
if (!projectCode) throw new Error('请设置 ACP_PROJECT_CODE（公开项目编码）');

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ACP_API_URL: apiUrl },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(r.stdout.trim());
  if (!parsed.ok) {
    throw new Error(`failed: ${args.join(' ')} -> ${r.stdout}`);
  }
  return parsed;
}

function createFeature(title) {
  const r = run(['feature', 'create', '--project', projectCode, '--title', title]);
  return r.data.feature_code;
}

function createTask(t, featureCode) {
  const r = run(['task', 'create', '--feature', featureCode, '--title', `[${t.taskId}] ${t.title}`, '--profile', t.profile, '--source', 'requirement', '--acceptance', JSON.stringify(t.acceptance)]);
  return r.data.task_code;
}

// ---- Spike 2：Agent Client Protocol 接入 ----
const spike2FeatureCode = createFeature('Spike 2: Agent Client Protocol');

const spike2 = [
  { taskId: 'TASK-201', title: 'agentd：Run 生命周期内 Session 创建与恢复（Codex 优先）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'agentd 能创建/恢复 Codex Session 并绑定 Run' }, { id: 'AC-2', text: 'Session 状态与 Run 事实同步落库' }] },
  { taskId: 'TASK-202', title: '三 Harness 验证：Codex / Claude Code / OpenCode 的 Session 创建与恢复', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '三种 Agent 至少各跑通一次 session 创建/恢复' }, { id: 'AC-2', text: '差异与适配点记录回流 docs' }] },
  { taskId: 'TASK-203', title: '流式事件、权限请求、取消与异常退出的协议验证', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '流式事件/权限请求/取消/异常退出四条路径各有测试' }, { id: 'AC-2', text: '异常退出能正确结束 Run 并记录审计' }] },
  { taskId: 'TASK-204', title: '三个并行 Run 的 CWD、进程与日志隔离验证', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '3 个并行 Run 互不干扰（CWD/进程/日志）' }, { id: 'AC-2', text: '隔离失败场景有明确报错' }] },
  { taskId: 'TASK-205', title: '统一 CLI Adapter：为不支持协议的 Agent 提供执行接口', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'CLI Adapter 接口定义并实现（claim→执行→submit 模式复用 tsp run）' }, { id: 'AC-2', text: '适配器测试通过' }] },
];

// ---- Spike 1 遗留 ----
const leftoverFeatureCode = createFeature('Spike 1 leftovers');

const leftover = [
  { taskId: 'TASK-206', title: '局域网多机实测（阻塞：需第二台设备）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '两台设备经 core-api 共享状态跑通一个任务闭环' }, { id: 'AC-2', text: '问题清单回流 docs/15' }] },
  { taskId: 'TASK-207', title: '邀请码与设备凭据（docs/15 完整形态）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'team join 邀请码流程落地' }, { id: 'AC-2', text: '设备凭据绑定与过期拒绝测试' }] },
  { taskId: 'TASK-208', title: 'Context Pack 完整形态：pack.yaml、diff-since-base、已知坑', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'claim 渲染 pack.yaml + diff-since-base' }, { id: 'AC-2', text: '已知坑（环境/约定）进 Pack 供 Agent 读取' }] },
  { taskId: 'TASK-209', title: '列表视图规范落地：筛选/分页/看板折叠与默认视图（docs/19 第 4 节）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '需求工作台等列表支持分页与筛选' }, { id: 'AC-2', text: '大数据场景折叠策略与默认视图按 docs/19 落地' }] },
  { taskId: 'TASK-210', title: 'Agent 准确率对比测量：完整文档 vs Task 子图', profile: 'planner',
    acceptance: [{ id: 'AC-1', text: '设计测量方案（同任务双组对照）' }, { id: 'AC-2', text: '完成一轮测量并记录耗时/Token/准确率数据' }] },
];

// ---- Spike 3：薄 MCP ----
const spike3FeatureCode = createFeature('Spike 3: thin MCP');

const spike3 = [
  { taskId: 'TASK-211', title: 'MCP：task_get_current + feature_get_context（含 stale 与差异摘要，docs/16）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '两个 MCP 工具可用且返回 stale 状态与差异摘要' }, { id: 'AC-2', text: '在 Agent Harness 中验证相同 Schema' }] },
  { taskId: 'TASK-212', title: 'MCP：feature_get_context_graph + 权限过滤', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '上下文图查询可用' }, { id: 'AC-2', text: '越权节点被过滤（权限过滤测试）' }] },
  { taskId: 'TASK-213', title: 'MCP：artifact_publish + evidence_submit', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '两工具对接 application 用例（不绕过校验）' }, { id: 'AC-2', text: '独立 stdio 进程绑定 Run Credential' }] },
  { taskId: 'TASK-214', title: 'MCP 安全：跨 Run 身份伪装与过期 Credential 拒绝测试', profile: 'verifier',
    acceptance: [{ id: 'AC-1', text: '跨 Run 伪装被拒绝' }, { id: 'AC-2', text: '过期 Credential 被拒绝' }] },
];

// ---- P1 首批 ----
const p1FeatureCode = createFeature('P1 first batch');

const p1 = [
  { taskId: 'TASK-215', title: 'Proposal → Review → Decision 流程与 Snapshot 变更摘要（docs/16）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '提案/审议/决策三阶段入库与状态流转' }, { id: 'AC-2', text: '变更摘要按 docs/16 生成并展示' }] },
  { taskId: 'TASK-216', title: 'SSE 状态通知与冲突提示（看板实时化）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '看板经 SSE 收到状态变更通知（替代 10s 轮询）' }, { id: 'AC-2', text: '乐观并发冲突有 UI 提示' }] },
  { taskId: 'TASK-217', title: 'PostgreSQL Persistence Adapter 与数据迁移验证', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '同一 Schema 在 PostgreSQL 迁移通过' }, { id: 'AC-2', text: 'core-api 可切换 PG 运行（接口不变）' }] },
  { taskId: 'TASK-218', title: '编排对话条接真实后端（当前为本地渲染占位）', profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '对话消息持久化与多成员可见' }, { id: 'AC-2', text: '对话条与任务/决策联动（docs/14 最小闭环）' }] },
];

const groups = [
  [spike2FeatureCode, spike2],
  [leftoverFeatureCode, leftover],
  [spike3FeatureCode, spike3],
  [p1FeatureCode, p1],
];
let created = 0;
for (const [feature, tasks] of groups) {
  for (const t of tasks) {
    const code = createTask(t, feature);
    created++;
    console.log(`${t.taskId} -> ${code}`);
  }
}
const total = spike2.length + leftover.length + spike3.length + p1.length;
console.log(`done: ${created}/${total} created`);
