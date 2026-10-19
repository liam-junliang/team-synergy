import { createHmac } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { createPublicCode, findRunByCode } from './public-code.js';
import { hashToken } from './user-use-cases.js';
import { assertExecutionWrite } from './execution-guard.js';
import { assertProjectAccess } from './project-access.js';
import { resolveRunSkillManifest } from './skills-run.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export interface ExecutionIdentity { principalId: bigint; deviceId: bigint }
export const RUN_LEASE_TTL_MS = 30_000;

async function requireOwnedRun(tx: Tx, runId: bigint, identity: ExecutionIdentity) {
  let [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
  if (!run) throw new DomainError('run_not_found', 'Run 不存在');
  await tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, run.task_id)).for('update');
  [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
  if (!run) throw new DomainError('run_not_found', 'Run 不存在');
  const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, run.task_id)).limit(1);
  const [feature] = task ? await tx.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1) : [];
  const [device] = await tx.select().from(schema.devices).where(and(eq(schema.devices.id, identity.deviceId), eq(schema.devices.principal_id, identity.principalId))).limit(1);
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, identity.principalId)).limit(1);
  if (!task || !feature || run.principal_id !== identity.principalId || !device || device.revoked_at || user?.status !== 'active') throw new DomainError('forbidden', '需要 Run 本人、有效设备和项目成员权限');
  await assertProjectAccess(tx, feature.project_id, identity.principalId, 'read');
  return { run, task, device, projectId: feature.project_id };
}

/** Mint only inside the caller's task transaction; token never appears in portable context. */
export async function issueRunLease(tx: Tx, input: ExecutionIdentity & { runId: bigint; epoch?: number; ttlMs?: number }) {
  const { run, task, device, projectId } = await requireOwnedRun(tx, input.runId, input);
  await assertProjectAccess(tx, projectId, input.principalId, 'write');
  if (run.status !== 'active') throw new DomainError('run_not_active', 'Run 当前不可执行');
  if (input.epoch !== undefined && input.epoch !== run.execution_epoch || task.execution_epoch !== run.execution_epoch) throw new DomainError('execution_epoch_conflict', '执行代数已变化');
  const [bound] = await tx.select().from(schema.runLeases).where(and(eq(schema.runLeases.run_id, run.id), eq(schema.runLeases.epoch, run.execution_epoch), isNull(schema.runLeases.revoked_at))).limit(1);
  const deriveToken = (leaseCode: string) => createHmac('sha256', device.credential_hash).update(`acp-run-lease:v1:${run.code}:${run.execution_epoch}:${leaseCode}`).digest('hex');
  if (bound && Date.parse(bound.expires_at) > Date.now()) {
    if (bound.device_id !== input.deviceId) throw new DomainError('execution_device_mismatch', 'Run 已绑定另一台设备');
    const token = deriveToken(bound.code);
    if (bound.token_hash === hashToken(token)) return { lease_token: token, execution_epoch: run.execution_epoch, expires_at: bound.expires_at };
    throw new DomainError('execution_lease_invalid', '现有租约不能恢复，请等待租约过期');
  }
  const timestamp = new Date().toISOString();
  await tx.update(schema.runLeases).set({ revoked_at: timestamp }).where(and(eq(schema.runLeases.run_id, run.id), isNull(schema.runLeases.revoked_at)));
  const leaseCode = createPublicCode();
  const token = deriveToken(leaseCode);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? RUN_LEASE_TTL_MS)).toISOString();
  await tx.insert(schema.runLeases).values({ code: leaseCode, run_id: run.id, device_id: input.deviceId, epoch: run.execution_epoch, token_hash: hashToken(token), expires_at: expiresAt, created_at: timestamp });
  return { lease_token: token, execution_epoch: run.execution_epoch, expires_at: expiresAt };
}

async function assertSessionLease(tx: Tx, runId: bigint, identity: ExecutionIdentity, token: string, epoch: number): Promise<void> {
  const [lease] = await tx.select().from(schema.runLeases).where(and(eq(schema.runLeases.run_id, runId), eq(schema.runLeases.device_id, identity.deviceId), eq(schema.runLeases.epoch, epoch), eq(schema.runLeases.token_hash, hashToken(token)), isNull(schema.runLeases.revoked_at))).limit(1);
  if (!lease || Date.parse(lease.expires_at) <= Date.now()) throw new DomainError('execution_lease_invalid', '租约过期、设备不符或已撤销');
}

function publicSession(session: typeof schema.agentSessions.$inferSelect, runCode: string) {
  return { session_code: session.code, run_code: runCode, agent_command: session.agent_command, launch_kind: session.launch_kind, prompt_path: session.prompt_path, process_id: session.process_id, status: session.status, started_at: session.started_at, finished_at: session.finished_at, exit_code: session.exit_code, last_error: session.last_error, last_output: session.last_output, execution_epoch: session.execution_epoch };
}

export function createExecutionUseCases(db: Db) {
  async function withRun<T>(runCode: string, identity: ExecutionIdentity, action: (tx: Tx, context: Awaited<ReturnType<typeof requireOwnedRun>>) => Promise<T>) {
    return db.transaction(async tx => {
      const run = await findRunByCode(tx as unknown as Db, runCode);
      if (!run) throw new DomainError('run_not_found', 'Run 不存在');
      const context = await requireOwnedRun(tx, run.id, identity);
      return action(tx, context);
    });
  }
  return {
    context: (code: string, identity: ExecutionIdentity) => withRun(code, identity, async (tx, { run, task }) => {
      const [workspace] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, run.workspace_id)).limit(1);
      if (!workspace) throw new DomainError('workspace_not_found', 'Workspace 不存在');
      return { run_code: run.code, task_code: task.code, status: run.status, execution_epoch: run.execution_epoch, workspace_path: workspace.path };
    }),
    lease: (code: string, identity: ExecutionIdentity, epoch?: number) => withRun(code, identity, (tx, { run }) => issueRunLease(tx, { ...identity, runId: run.id, epoch })),
    renew: (code: string, identity: ExecutionIdentity, token: string, epoch: number) => withRun(code, identity, async (tx, { run, task }) => {
      await assertExecutionWrite(tx, { taskId: task.id, runId: run.id, ...identity, epoch, leaseToken: token });
      const [lease] = await tx.select().from(schema.runLeases).where(and(eq(schema.runLeases.run_id, run.id), eq(schema.runLeases.device_id, identity.deviceId), eq(schema.runLeases.epoch, epoch), eq(schema.runLeases.token_hash, hashToken(token)), isNull(schema.runLeases.revoked_at))).limit(1);
      if (!lease || Date.parse(lease.expires_at) <= Date.now()) throw new DomainError('execution_lease_invalid', '租约过期或已撤销');
      const expiresAt = new Date(Date.now() + RUN_LEASE_TTL_MS).toISOString();
      await tx.update(schema.runLeases).set({ expires_at: expiresAt }).where(eq(schema.runLeases.id, lease.id));
      return { lease_token: token, execution_epoch: epoch, expires_at: expiresAt };
    }),
    sessions: (code: string, identity: ExecutionIdentity) => withRun(code, identity, async (tx, { run }) => ({ run_code: run.code, sessions: (await tx.select().from(schema.agentSessions).where(eq(schema.agentSessions.run_id, run.id)).orderBy(desc(schema.agentSessions.id))).map(s => publicSession(s, run.code)) })),
    start: (code: string, identity: ExecutionIdentity, input: { start_key: string; agent_command: string; launch_kind?: 'default' | 'custom'; prompt_path?: string; resumed_from_session_code?: string; lease_token: string; execution_epoch: number }) => withRun(code, identity, async (tx, { run, task }) => {
      await assertExecutionWrite(tx, { taskId: task.id, runId: run.id, ...identity, epoch: input.execution_epoch, leaseToken: input.lease_token });
      await assertSessionLease(tx, run.id, identity, input.lease_token, input.execution_epoch);
      await resolveRunSkillManifest(tx, { runId: run.id, principalId: identity.principalId });
      if (!input.start_key || input.start_key.length > 128 || !input.agent_command || input.agent_command.length > 100_000) throw new DomainError('validation_failed', '缺少有效启动 key 或命令');
      const [existing] = await tx.select().from(schema.agentSessions).where(and(eq(schema.agentSessions.run_id, run.id), eq(schema.agentSessions.device_id, identity.deviceId), eq(schema.agentSessions.execution_epoch, input.execution_epoch), eq(schema.agentSessions.start_key, input.start_key))).limit(1);
      if (existing) {
        if (existing.agent_command !== input.agent_command || existing.prompt_path !== (input.prompt_path ?? null)) throw new DomainError('conflict', '启动 key 已用于不同请求');
        return { ...publicSession(existing, run.code), created: false };
      }
      const [active] = await tx.select().from(schema.agentSessions).where(and(eq(schema.agentSessions.run_id, run.id), eq(schema.agentSessions.execution_epoch, input.execution_epoch))).orderBy(desc(schema.agentSessions.id)).limit(1);
      if (active && ['starting','running'].includes(active.status)) throw new DomainError('conflict', 'Run 已有活跃 Agent Session');
      let resumedId: bigint | null = null;
      if (input.resumed_from_session_code) {
        const [previous] = await tx.select().from(schema.agentSessions).where(and(eq(schema.agentSessions.code, input.resumed_from_session_code), eq(schema.agentSessions.run_id, run.id))).limit(1);
        if (!previous) throw new DomainError('session_not_found', '恢复来源会话不存在');
        resumedId = previous.id;
      }
      const [session] = await tx.insert(schema.agentSessions).values({ code: createPublicCode(), run_id: run.id, device_id: identity.deviceId, execution_epoch: input.execution_epoch, start_key: input.start_key, agent_command: input.agent_command, launch_kind: input.launch_kind ?? 'custom', prompt_path: input.prompt_path ?? null, resumed_from_session_id: resumedId, status: 'starting', started_at: new Date().toISOString() }).returning();
      if (!session) throw new DomainError('internal_error', 'Session 写入失败');
      await tx.insert(schema.auditEvents).values({ code: createPublicCode(), timestamp: new Date().toISOString(), principal_id: identity.principalId, run_id: run.id, action: input.resumed_from_session_code ? 'agent_session.resume' : 'agent_session.start', entity_type: 'agent_session', entity_id: session.id, base_snapshot: run.base_snapshot, from_state: null, to_state: 'starting', payload: JSON.stringify({ session_code: session.code }) });
      return { ...publicSession(session, run.code), resumed_from_session_code: input.resumed_from_session_code ?? null, created: true };
    }),
    async state(code: string, identity: ExecutionIdentity, input: { status: 'running'|'finished'|'failed'|'cancelled'; process_id?: number; exit_code?: number|null; last_error?: string|null; last_output?: string|null; lease_token: string; execution_epoch: number }) {
      return db.transaction(async tx => {
        const [session] = await tx.select().from(schema.agentSessions).where(eq(schema.agentSessions.code, code)).limit(1);
        if (!session) throw new DomainError('session_not_found', 'Session 不存在');
        const { run, task } = await requireOwnedRun(tx, session.run_id, identity);
        await assertExecutionWrite(tx, { taskId: task.id, runId: run.id, ...identity, epoch: input.execution_epoch, leaseToken: input.lease_token });
        await assertSessionLease(tx, run.id, identity, input.lease_token, input.execution_epoch);
        if (session.device_id !== identity.deviceId || session.execution_epoch !== input.execution_epoch) throw new DomainError('forbidden', 'Session 不属于当前设备和执行代数');
        if (!['starting','running'].includes(session.status)) return publicSession(session, run.code);
        const terminal = input.status !== 'running';
        const [updated] = await tx.update(schema.agentSessions).set({ status: input.status, process_id: input.process_id ?? session.process_id, finished_at: terminal ? new Date().toISOString() : null, exit_code: input.exit_code ?? null, last_error: input.last_error?.slice(0, 4000) ?? null, last_output: input.last_output?.slice(-32_000) ?? null }).where(eq(schema.agentSessions.id, session.id)).returning();
        await tx.insert(schema.auditEvents).values({ code: createPublicCode(), timestamp: new Date().toISOString(), principal_id: identity.principalId, run_id: run.id, action: input.status === 'cancelled' ? 'agent_session.stop' : 'agent_session.status', entity_type: 'agent_session', entity_id: session.id, base_snapshot: run.base_snapshot, from_state: session.status, to_state: input.status, payload: JSON.stringify({ session_code: session.code, exit_code: input.exit_code, error: input.last_error }) });
        if (!updated) throw new DomainError('internal_error', 'Session 状态写入失败');
        return publicSession(updated, run.code);
      });
    },
  };
}
