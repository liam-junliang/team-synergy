import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';

export const code = PublicCodeSchema;
export const inputText = (max: number) => z.string().trim().min(1).max(max);

export const agentToolModules = {
  projects: { title: '账号与项目', description: '核对身份、角色和目标项目。每次调用使用目标项目编码。', keywords: 'account project permission identity 账号 权限 项目' },
  materials: { title: '项目资料', description: '按目录、路径和正文找资料，按修订读原文；长期资料进入文档库。', keywords: 'documents files documentation 文档 资料 全文' },
  memory: { title: '项目与个人记忆', description: '查讨论、已确认决定和个人偏好，核对出处及状态。', keywords: 'memory decisions consensus preference 记忆 共识 决定 偏好' },
  code: { title: '代码规格', description: '查仓库主线、分析版本、符号与代码证据。', keywords: 'code source symbols analysis 代码 规格 源码 依赖 分析' },
  tasks: { title: '任务协作', description: '查任务、状态、验收项和快照，按真实证据推进。', keywords: 'task workflow delivery 任务 协作 工单 状态 交付' },
  testing: { title: '测试与证据', description: '查阅用例、资料和执行记录，登记实际测试结果。', keywords: 'test testing execution 验证 测试 用例 回归' },
  teams: { title: '团队管理', description: '查找或创建团队，管理成员和角色。', keywords: 'team organization membership 管理 团队 成员 组织' },
  repositories: { title: '仓库管理', description: '登记和维护项目的 Git 仓库与主线分支。', keywords: 'git repo repositories repository branch 仓库 分支 主线' },
  planning: { title: '项目计划', description: '管理功能模块、阶段和里程碑。', keywords: 'module phase milestone planning 模块 计划 阶段 里程碑 排序' },
  requirements: { title: '需求与议题', description: '管理想法、议题、需求文档和基线，区分提案与决策。', keywords: 'requirements topic idea baseline proposal 需求 议题 想法 基线' },
  design: { title: '设计与架构', description: '查看和修订交互原型及架构图。', keywords: 'design architecture prototype diagram 设计 架构 原型' },
  defects: { title: '缺陷管理', description: '记录操作、预期、实际和证据，依照状态机处理缺陷。', keywords: 'bug defect incident 缺陷 报错 修复' },
  skills: { title: '技能库', description: '查找技能、读取固定版本，核对项目采用状态。', keywords: 'skills version revision 技能 固定版本' },
  handovers: { title: '交接记录', description: '核对项目交接涉及的任务、执行与接收情况。', keywords: 'handoff handover 交接 接手' },
} as const;

export type AgentToolModule = keyof typeof agentToolModules;
export const AgentToolModuleSchema = z.enum(Object.keys(agentToolModules) as AgentToolModule[]);
export type AgentProjectRole = 'owner' | 'admin' | 'member' | 'viewer';
export type AgentProjectObject = 'repository' | 'defect' | 'feature' | 'requirement' | 'projectDocument' | 'architecture' |
  'designPrototype' | 'testCase' | 'testAsset' | 'module' | 'phase' | 'milestone' | 'topic' | 'idea' | 'baseline' | 'requirementDocument' | 'testExecution';

export interface AgentActionDefinition {
  name: string;
  module: AgentToolModule;
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  schema: z.ZodObject;
  scope: 'account' | 'project';
  roles?: readonly AgentProjectRole[];
  requiresWorkspacePermission?: boolean;
  destructive?: boolean;
  projectArgument?: string;
  projectObject?: { kind: AgentProjectObject; key: string };
  bodyPathKeys?: readonly string[];
}
