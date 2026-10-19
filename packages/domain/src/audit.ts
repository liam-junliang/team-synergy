import { z } from 'zod';
import { PUBLIC_CODE_PATTERN } from '@team-synergy/contracts';
import { DomainError } from './errors.js';

/**
 * 架构不变量 1：所有正式状态变更都包含
 * principal_id、run_id（如适用）、base_snapshot 和审计记录。
 */

export const AuditEventSchema = z.object({
  code: z.string().regex(PUBLIC_CODE_PATTERN),
  timestamp: z.string(),
  principal_id: z.bigint(),
  run_id: z.bigint().optional(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.bigint(),
  legacy_entity_code: z.string().optional(),
  base_snapshot: z.number().int().nonnegative(),
  from: z.string().optional(),
  to: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** 带审计的状态变更命令：正式变更的唯一起点 */
export interface StateChangeCommand {
  entity_type: string;
  entity_id: bigint;
  legacy_entity_code?: string;
  from?: string;
  to?: string;
  principal_id: bigint;
  run_id?: bigint;
  base_snapshot: number;
  action: string;
  payload?: Record<string, unknown>;
}

/** 校验变更命令携带了不变量 1 要求的全部字段 */
export function assertAuditedChange(cmd: StateChangeCommand): void {
  if (!cmd.principal_id || cmd.principal_id <= 0n) {
    throw new DomainError('principal_required', '正式状态变更必须包含 principal_id（不变量 1）');
  }
  if (!cmd.entity_type) {
    throw new DomainError('entity_type_required', '正式状态变更必须包含 entity_type');
  }
  if (!cmd.entity_id || cmd.entity_id <= 0n) {
    throw new DomainError('entity_id_required', '正式状态变更必须包含数字 entity_id');
  }
  if (cmd.base_snapshot === undefined || cmd.base_snapshot === null) {
    throw new DomainError('base_snapshot_required', '正式状态变更必须包含 base_snapshot（不变量 1）');
  }
}

/** 由命令生成审计事件（不可变记录） */
export function toAuditEvent(cmd: StateChangeCommand, eventCode: string, timestamp: string): AuditEvent {
  assertAuditedChange(cmd);
  return {
    code: eventCode,
    timestamp,
    principal_id: cmd.principal_id,
    ...(cmd.run_id ? { run_id: cmd.run_id } : {}),
    action: cmd.action,
    entity_type: cmd.entity_type,
    entity_id: cmd.entity_id,
    ...(cmd.legacy_entity_code ? { legacy_entity_code: cmd.legacy_entity_code } : {}),
    base_snapshot: cmd.base_snapshot,
    ...(cmd.from ? { from: cmd.from } : {}),
    ...(cmd.to ? { to: cmd.to } : {}),
    ...(cmd.payload ? { payload: cmd.payload } : {}),
  };
}
