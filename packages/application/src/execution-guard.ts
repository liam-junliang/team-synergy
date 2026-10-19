import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { assertProjectAccess } from './project-access.js';

export type ExecutionDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
export const UNRESOLVED_HANDOVER_STATUSES = ['preparing', 'published', 'accepted', 'restoring', 'ready'] as const;

export async function assertNoPendingHandover(db: ExecutionDb, taskId: bigint): Promise<void> {
  const [pending] = await db.select({ id: schema.taskHandovers.id }).from(schema.taskHandovers).where(and(
    eq(schema.taskHandovers.task_id, taskId),
    inArray(schema.taskHandovers.status, [...UNRESOLVED_HANDOVER_STATUSES]),
  )).limit(1);
  if (pending) throw new DomainError('task_handover_pending', '任务正在交接，请先完成或取消交接');
}

export async function assertExecutionWrite(db: ExecutionDb, input: {
  taskId: bigint;
  runId: bigint;
  principalId: bigint;
  deviceId?: bigint;
  epoch?: number;
  leaseToken?: string;
}): Promise<void> {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, input.runId)).limit(1);
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, input.taskId)).limit(1);
  if (!run || !task || run.task_id !== task.id || run.principal_id !== input.principalId) {
    throw new DomainError('execution_forbidden', '执行身份与 Run 不匹配');
  }
  if (run.status !== 'active') throw new DomainError('run_inactive', 'Run 已暂停、转交或结束，不能继续写入');
  const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
  if (!feature) throw new DomainError('execution_forbidden', '任务项目不存在');
  // Role revocation applies to every Run, including pre-lease legacy Runs.
  await assertProjectAccess(db, feature.project_id, input.principalId, 'write');
  await assertNoPendingHandover(db, task.id);
  // Untouched pre-handover tasks retain the existing development CLI contract.
  // Once an epoch is advanced, every execution write must carry a device lease.
  if (task.execution_epoch === 0 && run.execution_epoch === 0) return;
  if (!input.deviceId || !input.leaseToken || input.epoch !== task.execution_epoch || run.execution_epoch !== task.execution_epoch) {
    throw new DomainError('execution_lease_invalid', '执行租约或代数已失效，请重新登录并领取当前 Run 租约');
  }
  const [device] = await db.select().from(schema.devices).where(and(
    eq(schema.devices.id, input.deviceId), eq(schema.devices.principal_id, input.principalId),
  )).limit(1);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, input.principalId)).limit(1);
  if (!device || device.revoked_at || user?.status !== 'active') throw new DomainError('execution_forbidden', '执行设备或项目成员权限已失效');
  const [lease] = await db.select().from(schema.runLeases).where(and(
    eq(schema.runLeases.run_id, run.id), eq(schema.runLeases.device_id, device.id),
    eq(schema.runLeases.epoch, input.epoch), isNull(schema.runLeases.revoked_at),
    eq(schema.runLeases.token_hash, createHash('sha256').update(input.leaseToken).digest('hex')),
  )).limit(1);
  if (!lease || Date.parse(lease.expires_at) <= Date.now()) throw new DomainError('execution_lease_invalid', '执行租约已过期或被撤销');
}

export async function executionDeviceId(db: ExecutionDb, principalId: bigint, deviceCode?: string): Promise<bigint | undefined> {
  if (!deviceCode) return undefined;
  const [device] = await db.select().from(schema.devices).where(and(
    eq(schema.devices.code, deviceCode), eq(schema.devices.principal_id, principalId),
  )).limit(1);
  if (!device || device.revoked_at) throw new DomainError('execution_forbidden', '执行设备不属于当前用户或已吊销');
  return device.id;
}
