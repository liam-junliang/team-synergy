import { z } from 'zod';
import { PUBLIC_CODE_PATTERN } from './public-code.js';

export const PublicCodeSchema = z.string().regex(PUBLIC_CODE_PATTERN, '公开编码必须为 20 位 Crockford Base32');
export type PublicCodeValue = z.infer<typeof PublicCodeSchema>;

/** Agent 职责模板（docs/02 三种早期 Profile） */
export const ProfileSchema = z.enum(['planner', 'builder', 'verifier']);
export type Profile = z.infer<typeof ProfileSchema>;

/** 团队治理与项目协作使用独立角色；Owner 只能通过所有权流程变更。 */
export const TeamRoleSchema = z.enum(['owner', 'admin', 'member']);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
export const MemberRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export const ProjectMemberPolicySchema = z.enum(['private', 'team_read', 'team_write']);
export type ProjectMemberPolicy = z.infer<typeof ProjectMemberPolicySchema>;

/**
 * Task 来源分类（docs/19）：
 * requirement（需求拆解）/ ad-hoc（临时）/ defect-fix（缺陷修复）/ integration（对接联调）
 */
export const TaskSourceSchema = z.enum(['requirement', 'ad-hoc', 'defect-fix', 'integration']);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/**
 * 任务状态机（docs/02）：
 * draft → ready → assigned → running → self_tested → submitted → verified → closed
 *                         ↘ blocked（可回到 ready）  ↘ failed
 * draft / ready / assigned → cancelled（执行前由 Owner 取消）
 */
export const TaskStatusSchema = z.enum([
  'draft',
  'ready',
  'assigned',
  'running',
  'self_tested',
  'submitted',
  'verified',
  'closed',
  'blocked',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 验收标准条目（docs/02 任务契约） */
export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * 任务契约（docs/02/11）：不是一句自然语言指令。
 * 任何来源的任务都必须有验收标准（架构不变量 2）。
 */
export const TaskContractSchema = z.object({
  task_code: PublicCodeSchema,
  feature_code: PublicCodeSchema,
  title: z.string(),
  profile: ProfileSchema,
  goal: z.string().optional(),
  source: TaskSourceSchema.default('requirement'),
  scope: z
    .object({
      writable_paths: z.array(z.string()),
    })
    .optional(),
  acceptance: z.array(AcceptanceCriterionSchema).min(1),
  outputs: z.array(z.string()).optional(),
  dependencies: z.array(PublicCodeSchema).default([]),
  assignee_principal_code: PublicCodeSchema.optional(),
  requirement_code: PublicCodeSchema.optional(),
  requirement_baseline_code: PublicCodeSchema.optional(),
  defect_code: PublicCodeSchema.optional(),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

/** Run 状态 */
export const RunStatusSchema = z.enum(['active', 'suspended', 'preparing', 'transferred', 'completed', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Evidence 类型（docs/02/16）：self_test、独立验证、部署证据等 */
export const EvidenceTypeSchema = z.enum([
  'self_test',
  'verifier_review',
  'deployment',
  'manual',
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceResultSchema = z.enum(['pass', 'fail', 'inconclusive']);
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const ArtifactKindSchema = z.enum(['commit', 'document', 'prototype', 'report', 'other']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * Evidence（docs/02）：命令、结果、时间、环境与报告引用；
 * acceptance_refs 显式声明覆盖的验收标准（docs/16 §2.1）。
 */
export const EvidenceSchema = z.object({
  evidence_code: PublicCodeSchema,
  task_code: PublicCodeSchema,
  run_code: PublicCodeSchema.optional(),
  type: EvidenceTypeSchema,
  acceptance_refs: z.array(z.string()).default([]),
  result: EvidenceResultSchema,
  command: z.string().optional(),
  summary: z.string().optional(),
  report_uri: z.string().optional(),
  recorded_at: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Artifact（docs/02）：显式发布的正式产物，保存引用与摘要，不复制托管内容 */
export const ArtifactSchema = z.object({
  artifact_code: PublicCodeSchema,
  project_code: PublicCodeSchema,
  task_code: PublicCodeSchema.optional(),
  run_code: PublicCodeSchema.optional(),
  kind: ArtifactKindSchema,
  title: z.string().optional(),
  uri: z.string(),
  content_hash: z.string(),
  summary: z.string().optional(),
  published_at: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Defect（docs/19）：reported → triaged → fixing → retest → closed，closed 必须关联复测 Evidence */
export const DefectStatusSchema = z.enum([
  'reported',
  'triaged',
  'fixing',
  'retest',
  'closed',
  'rejected',
]);
export type DefectStatus = z.infer<typeof DefectStatusSchema>;

export const DefectSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DefectSchema = z.object({
  defect_code: PublicCodeSchema,
  title: z.string(),
  feature_code: PublicCodeSchema,
  severity: DefectSeveritySchema,
  reported_by_user_code: PublicCodeSchema,
  found_in: z.string().optional(),
  description: z.string(),
  related_requirement_code: PublicCodeSchema.optional(),
  status: DefectStatusSchema,
  fix_task_code: PublicCodeSchema.optional(),
  verification_evidence_code: PublicCodeSchema.optional(),
});
export type Defect = z.infer<typeof DefectSchema>;
