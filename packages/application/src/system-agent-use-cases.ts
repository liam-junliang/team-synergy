import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import {
  evaluateDocumentQuality, inferDocumentQualityPurpose,
  type DocumentQualityReport, type SystemAgentExecution, type SystemAgentExecutionMetadata, type SystemAgentJobView, type SystemAgentProposal,
} from '@team-synergy/contracts';
import { assertProjectAccess, isProjectManager, type AccessDb } from './project-access.js';
import { createPublicCode } from './public-code.js';
import { insertAudit, now, type TaskResult } from './task-service.js';
import { enqueueProjectDocumentMemory } from './project-document-memory.js';

type Job = typeof schema.systemAgentJobs.$inferSelect;
type Document = typeof schema.projectDocuments.$inferSelect;
type ActorCommand = { jobCode: string; principalCode: string };
type ExecutionCommand = { jobCode: string; executorId: string; executionToken: string };

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const result = <T>(data: T): TaskResult<T> => ({ ok: true, data });
const error = (code: string, message: string) => new DomainError(code, message);
const leaseExpiry = (seconds = 120) => new Date(Date.now() + Math.max(30, Math.min(600, seconds)) * 1000).toISOString();

/** SQL/driver errors can contain credentials or source content. Never publish their messages. */
function fail<T>(cause: unknown): TaskResult<T> {
  if (cause instanceof DomainError) return { ok: false, error: { code: cause.code, message: cause.message } };
  return { ok: false, error: { code: 'internal_error', message: '系统 Agent 暂时无法完成操作，请稍后重试' } };
}

function text(value: unknown, name: string, limit: number, required = true): string {
  if (typeof value !== 'string') throw error('system_agent_input_invalid', `${name}必须是文本`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if ((required && !normalized) || normalized.length > limit) throw error('system_agent_input_invalid', `${name}为空或超过长度限制 ${limit}`);
  return normalized;
}

/** Validate all engine output at the business boundary; never trust a model's completion flag. */
export function normalizeSystemAgentProposal(input: unknown): SystemAgentProposal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('system_agent_proposal_invalid', 'Agent 未返回结构化修改稿');
  const proposal = input as Record<string, unknown>;
  const list = (key: string, limit: number) => {
    const value = proposal[key];
    if (!Array.isArray(value) || value.length > 20) throw error('system_agent_proposal_invalid', `${key}必须是最多 20 条文本`);
    return value.map(item => text(item, key, limit));
  };
  return {
    title: text(proposal.title, '标题', 200),
    summary: text(proposal.summary, '摘要', 2000, false),
    content: text(proposal.content, '正文', 200_000),
    rationale: text(proposal.rationale, '修改依据', 6000),
    evidence: list('evidence', 200), warnings: list('warnings', 1000),
  };
}

export function createSystemAgentUseCases(db: Db) {
  async function principalId(conn: AccessDb, code: string) {
    const [principal] = await conn.select().from(schema.users).where(eq(schema.users.code, code)).limit(1);
    if (!principal || principal.status !== 'active' || principal.deleted_at) throw error('user_not_found', '当前用户不可用');
    return principal.id;
  }

  async function documentFor(conn: AccessDb, job: Job, lock = false) {
    const query = conn.select().from(schema.projectDocuments).where(and(
      eq(schema.projectDocuments.id, job.document_id), eq(schema.projectDocuments.project_id, job.project_id),
    )).limit(1);
    const [document] = await (lock ? query.for('update') : query);
    if (!document) throw error('project_document_not_found', '目标文档不存在');
    return document;
  }

  async function writable(conn: AccessDb, document: Document, requesterId: bigint) {
    const access = await assertProjectAccess(conn, document.project_id, requesterId, 'write');
    if (!isProjectManager(access.role) && document.created_by !== requesterId) throw error('project_document_forbidden', '只有文档创建者或项目管理者可安排文档修改');
    if (document.status !== 'active') throw error('project_document_archived', '已归档文档不能修改');
    let folderId = document.folder_id;
    const seen = new Set<bigint>();
    while (folderId !== null) {
      if (seen.has(folderId)) throw error('project_document_folder_invalid', '文档目录关系异常');
      seen.add(folderId);
      const [folder] = await conn.select().from(schema.projectDocumentFolders).where(and(
        eq(schema.projectDocumentFolders.id, folderId), eq(schema.projectDocumentFolders.project_id, document.project_id),
      )).limit(1);
      if (!folder) throw error('project_document_folder_invalid', '文档目录不存在');
      if (folder.system_role) {
        if (!['standards', 'overview'].includes(folder.system_role)) throw error('project_document_source_read_only', '关联业务资料请通过原始业务页面修订；第一版仅支持可编辑的原生文档');
        break;
      }
      folderId = folder.parent_id;
    }
    return access;
  }

  async function actorJob(conn: AccessDb, cmd: ActorCommand, lock = false) {
    const id = await principalId(conn, cmd.principalCode);
    const query = conn.select().from(schema.systemAgentJobs).where(and(eq(schema.systemAgentJobs.code, cmd.jobCode), eq(schema.systemAgentJobs.requester_id, id))).limit(1);
    const [job] = await (lock ? query.for('update') : query);
    if (!job) throw error('system_agent_job_not_found', '任务不存在或当前用户不可访问');
    await assertProjectAccess(conn, job.project_id, id, 'read');
    return job;
  }

  async function view(conn: AccessDb, job: Job): Promise<SystemAgentJobView> {
    const [project] = await conn.select().from(schema.projects).where(eq(schema.projects.id, job.project_id)).limit(1);
    const document = await documentFor(conn, job);
    let canApply = false;
    if (job.status === 'awaiting_review' && document.revision === job.base_revision) {
      try { await writable(conn, document, job.requester_id); canApply = true; } catch { /* State remains inspectable to a read-only requester. */ }
    }
    return {
      job_code: job.code, project_code: project?.code ?? '', document_code: document.code, document_title: document.title,
      base_revision: job.base_revision, base_title: job.base_title, base_summary: job.base_summary, base_content: job.base_content,
      instruction: job.instruction, quote: job.quote, status: job.status,
      proposal: job.proposal_json ? JSON.parse(job.proposal_json) as SystemAgentProposal : null,
      proposal_hash: job.proposal_hash, quality: job.quality_json ? JSON.parse(job.quality_json) as DocumentQualityReport : null,
      error: job.error, created_at: job.created_at, updated_at: job.updated_at, applied_revision: job.applied_revision, can_apply: canApply,
      execution_metadata: job.execution_metadata_json ? JSON.parse(job.execution_metadata_json) as SystemAgentExecutionMetadata : null,
    };
  }

  async function audit(conn: AccessDb, job: Job, action: string, payload: Record<string, unknown> = {}) {
    await insertAudit(conn, toAuditEvent({ entity_type: 'system_agent_job', entity_id: job.id, principal_id: job.requester_id,
      base_snapshot: job.base_revision, action, payload: { job_code: job.code, ...payload } }, createPublicCode(), now()));
  }

  async function getJob(cmd: ActorCommand): Promise<TaskResult<SystemAgentJobView>> {
    try { return result(await view(db, await actorJob(db, cmd))); } catch (e) { return fail(e); }
  }

  async function listJobs(cmd: { projectCode: string; principalCode: string }): Promise<TaskResult<SystemAgentJobView[]>> {
    try {
      const id = await principalId(db, cmd.principalCode);
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
      if (!project) throw error('project_not_found', '项目不存在');
      await assertProjectAccess(db, project.id, id, 'read');
      const jobs = await db.select().from(schema.systemAgentJobs).where(and(eq(schema.systemAgentJobs.project_id, project.id), eq(schema.systemAgentJobs.requester_id, id))).orderBy(desc(schema.systemAgentJobs.created_at)).limit(50);
      return result(await Promise.all(jobs.map(job => view(db, job))));
    } catch (e) { return fail(e); }
  }

  async function createJob(cmd: { projectCode: string; principalCode: string; documentCode: string; baseRevision: number; instruction: string; quote?: string; requestKey: string }): Promise<TaskResult<SystemAgentJobView>> {
    try {
      const instruction = text(cmd.instruction, '批注指令', 8000);
      const quote = cmd.quote === undefined || cmd.quote === '' ? null : text(cmd.quote, '引用片段', 20_000);
      const requestKey = text(cmd.requestKey, '请求标识', 200);
      if (!Number.isSafeInteger(cmd.baseRevision) || cmd.baseRevision < 1) throw error('system_agent_base_revision_invalid', '必须指定文档的当前正整数版本');
      const requestHash = hash(JSON.stringify([cmd.documentCode, cmd.baseRevision, instruction, quote]));
      return await db.transaction(async tx => {
        const id = await principalId(tx, cmd.principalCode);
        const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
        if (!project) throw error('project_not_found', '项目不存在');
        await assertProjectAccess(tx, project.id, id, 'write');
        const [document] = await tx.select().from(schema.projectDocuments).where(and(eq(schema.projectDocuments.code, cmd.documentCode), eq(schema.projectDocuments.project_id, project.id))).limit(1).for('update');
        if (!document) throw error('system_agent_document_unsupported', '第一版仅支持当前项目文档库中的原生文档；关联需求、架构、测试资料请在对应页面修订');
        await writable(tx, document, id);
        const [existing] = await tx.select().from(schema.systemAgentJobs).where(and(eq(schema.systemAgentJobs.project_id, project.id), eq(schema.systemAgentJobs.requester_id, id), eq(schema.systemAgentJobs.request_key, requestKey))).limit(1);
        if (existing) {
          if (existing.request_hash !== requestHash) throw error('system_agent_request_conflict', '同一请求标识已用于不同任务');
          return result(await view(tx, existing));
        }
        if (document.revision !== cmd.baseRevision) throw error('system_agent_revision_conflict', '文档已更新，请刷新文档后重新批注');
        if (document.content.length > 100_000 || Buffer.byteLength(JSON.stringify({ title: document.title, summary: document.summary, content: document.content, instruction, quote }), 'utf8') > 300_000) {
          throw error('system_agent_document_too_large', '第一版单篇文档最多支持 100000 字符，文档与批注合计不超过 300000 字节；请拆分资料后重试');
        }
        if (quote && !document.content.includes(quote)) throw error('system_agent_quote_mismatch', '引用片段不属于指定版本的原文，请重新选择或使用全文批注');
        const timestamp = now();
        const [job] = await tx.insert(schema.systemAgentJobs).values({ code: createPublicCode(), project_id: project.id, document_id: document.id, requester_id: id,
          request_key: requestKey, request_hash: requestHash, base_revision: document.revision, base_title: document.title,
          base_summary: document.summary ?? '', base_content: document.content, instruction, quote, created_at: timestamp, updated_at: timestamp,
        }).onConflictDoNothing().returning();
        if (!job) throw error('system_agent_request_conflict', '请求已提交，请重新读取任务记录');
        await audit(tx, job, 'system_agent.queued', { document_code: document.code });
        return result(await view(tx, job));
      });
    } catch (e) { return fail(e); }
  }

  async function changeDisposition(cmd: ActorCommand, status: 'cancelled' | 'rejected'): Promise<TaskResult<SystemAgentJobView>> {
    try {
      return await db.transaction(async tx => {
        const job = await actorJob(tx, cmd, true);
        if (job.status === status) return result(await view(tx, job));
        const allowed = status === 'rejected' ? ['awaiting_review'] : ['queued', 'running', 'awaiting_review'];
        if (!allowed.includes(job.status)) throw error('system_agent_state_conflict', '当前任务状态不允许此操作');
        const [updated] = await tx.update(schema.systemAgentJobs).set({ status, execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id)).returning();
        if (!updated) throw error('system_agent_job_not_found', '任务不存在');
        await audit(tx, updated, `system_agent.${status}`);
        return result(await view(tx, updated));
      });
    } catch (e) { return fail(e); }
  }

  async function applyJob(cmd: ActorCommand & { proposalHash: string; baseRevision: number }): Promise<TaskResult<SystemAgentJobView>> {
    try {
      return await db.transaction(async tx => {
        const job = await actorJob(tx, cmd, true);
        const document = await documentFor(tx, job, true);
        await writable(tx, document, job.requester_id);
        if (!job.proposal_hash || job.proposal_hash !== cmd.proposalHash || cmd.baseRevision !== job.base_revision) throw error('system_agent_confirmation_mismatch', '确认内容与修改稿不一致，请重新查看差异');
        if (job.status === 'applied') return result(await view(tx, job));
        if (job.status !== 'awaiting_review' || !job.proposal_json) throw error('system_agent_state_conflict', '任务没有待确认的修改稿');
        if (document.revision !== job.base_revision) throw error('system_agent_revision_conflict', '文档已有新修订，不能覆盖；请按最新文档重新生成修改稿');
        const proposal = normalizeSystemAgentProposal(JSON.parse(job.proposal_json));
        const revision = document.revision + 1;
        const timestamp = now();
        const changeSummary = `采用系统 Agent 修改稿 ${job.code}：${job.instruction.slice(0, 500)}`;
        await tx.update(schema.projectDocuments).set({ title: proposal.title, summary: proposal.summary, content: proposal.content, revision, updated_by: job.requester_id, updated_at: timestamp }).where(eq(schema.projectDocuments.id, document.id));
        const [storedRevision] = await tx.insert(schema.projectDocumentRevisions).values({ code: createPublicCode(), document_id: document.id, revision, title: proposal.title, summary: proposal.summary,
          content: proposal.content, change_summary: changeSummary, created_by: job.requester_id, created_at: timestamp }).returning({ id: schema.projectDocumentRevisions.id });
        if (!storedRevision) throw error('internal_error', '文档修订创建失败');
        await enqueueProjectDocumentMemory(tx, storedRevision.id);
        const [updated] = await tx.update(schema.systemAgentJobs).set({ status: 'applied', applied_revision: revision, applied_by: job.requester_id, updated_at: timestamp }).where(eq(schema.systemAgentJobs.id, job.id)).returning();
        if (!updated) throw error('system_agent_job_not_found', '任务不存在');
        await insertAudit(tx, toAuditEvent({ entity_type: 'project_document', entity_id: document.id, principal_id: job.requester_id, base_snapshot: job.base_revision,
          action: 'project_document.revised', payload: { document_code: document.code, revision, change_summary: changeSummary, system_agent_job_code: job.code, executor_id: job.executor_id, proposal_hash: job.proposal_hash, requester_id: String(job.requester_id), adopter_id: String(job.requester_id) },
        }, createPublicCode(), timestamp));
        await audit(tx, updated, 'system_agent.applied', { revision, proposal_hash: job.proposal_hash, executor_id: job.executor_id });
        return result(await view(tx, updated));
      });
    } catch (e) { return fail(e); }
  }

  async function claimNextJob(cmd: { executorId: string; leaseSeconds?: number; executionMetadata?: SystemAgentExecutionMetadata }): Promise<TaskResult<SystemAgentExecution | null>> {
    try {
      const executorId = text(cmd.executorId, '执行器标识', 200);
      const metadata = cmd.executionMetadata ? {
        engine: text(cmd.executionMetadata.engine, 'engine', 200),
        engine_version: text(cmd.executionMetadata.engine_version, 'engine_version', 200),
        model: text(cmd.executionMetadata.model, 'model', 200),
        skill_version: text(cmd.executionMetadata.skill_version, 'skill_version', 200),
        skill_sha256: cmd.executionMetadata.skill_sha256,
      } : undefined;
      if (metadata) {
        if (!/^[0-9a-f]{64}$/.test(metadata.skill_sha256)) throw error('system_agent_execution_metadata_invalid', 'Skill 内容摘要必须为 SHA-256');
      }
      return await db.transaction(async tx => {
        const queued = await tx.select().from(schema.systemAgentJobs).where(eq(schema.systemAgentJobs.status, 'queued')).orderBy(asc(schema.systemAgentJobs.created_at)).limit(10).for('update', { skipLocked: true });
        for (const job of queued) {
          try {
            const document = await documentFor(tx, job);
            await writable(tx, document, job.requester_id);
            if (document.revision !== job.base_revision) throw error('system_agent_revision_conflict', '排队期间文档已更新，请重新批注');
          } catch (e) {
            await tx.update(schema.systemAgentJobs).set({ status: 'failed', error: e instanceof DomainError ? e.message : '任务权限或资料验证暂不可用，请重新发起', updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id));
            await audit(tx, job, 'system_agent.failed', { reason: 'authorization_or_source_changed' });
            continue;
          }
          const token = randomUUID();
          const [updated] = await tx.update(schema.systemAgentJobs).set({ status: 'running', executor_id: executorId, execution_metadata_json: metadata ? JSON.stringify(metadata) : null, execution_token: token, lease_expires_at: leaseExpiry(cmd.leaseSeconds), updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id)).returning();
          if (!updated) throw error('system_agent_job_not_found', '任务不存在');
          await audit(tx, updated, 'system_agent.started', { executor_id: executorId, execution_metadata: metadata ?? null });
          return result({ ...await view(tx, updated), execution_token: token });
        }
        return result(null);
      });
    } catch (e) { return fail(e); }
  }

  async function executionJob(conn: AccessDb, cmd: ExecutionCommand) {
    const [job] = await conn.select().from(schema.systemAgentJobs).where(eq(schema.systemAgentJobs.code, cmd.jobCode)).limit(1).for('update');
    if (!job || job.status !== 'running' || job.executor_id !== cmd.executorId || job.execution_token !== cmd.executionToken || !job.lease_expires_at || job.lease_expires_at <= now()) throw error('system_agent_execution_expired', '执行已取消、租约过期或执行器不匹配');
    return job;
  }

  async function executionAccess(conn: AccessDb, job: Job): Promise<TaskResult<null>> {
    try { await writable(conn, await documentFor(conn, job), job.requester_id); return result(null); }
    catch (e) {
      await conn.update(schema.systemAgentJobs).set({ status: 'failed', error: '任务执行期间项目或文档权限已失效', execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id));
      await audit(conn, job, 'system_agent.failed', { reason: 'authorization_revoked' });
      return fail(e);
    }
  }

  async function heartbeatJob(cmd: ExecutionCommand & { leaseSeconds?: number }): Promise<TaskResult<{ active: true }>> {
    try {
      return await db.transaction(async tx => {
        const job = await executionJob(tx, cmd);
        const access = await executionAccess(tx, job);
        if (!access.ok) return access;
        await tx.update(schema.systemAgentJobs).set({ lease_expires_at: leaseExpiry(cmd.leaseSeconds), updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id));
        return result({ active: true as const });
      });
    } catch (e) { return fail(e); }
  }

  async function completeJob(cmd: ExecutionCommand & { proposal: unknown }): Promise<TaskResult<SystemAgentJobView>> {
    try {
      const proposal = normalizeSystemAgentProposal(cmd.proposal);
      return await db.transaction(async tx => {
        const job = await executionJob(tx, cmd);
        const access = await executionAccess(tx, job);
        if (!access.ok) return access;
        const proposalHash = hash(JSON.stringify({ job_code: job.code, base_revision: job.base_revision, proposal }));
        const quality = evaluateDocumentQuality({ title: proposal.title, content: proposal.content, purpose: inferDocumentQualityPurpose({ title: proposal.title, source_kind: 'project' }),
          source_kind: 'system_agent_draft', document_code: (await documentFor(tx, job)).code, revision: job.base_revision + 1, content_sha256: hash(proposal.content), checked_at: now() });
        const [updated] = await tx.update(schema.systemAgentJobs).set({ status: 'awaiting_review', proposal_json: JSON.stringify(proposal), proposal_hash: proposalHash, quality_json: JSON.stringify(quality),
          execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id)).returning();
        if (!updated) throw error('system_agent_job_not_found', '任务不存在');
        await audit(tx, updated, 'system_agent.drafted', { proposal_hash: proposalHash, executor_id: job.executor_id });
        return result(await view(tx, updated));
      });
    } catch (e) { return fail(e); }
  }

  async function failJob(cmd: ExecutionCommand & { message: string }): Promise<TaskResult<{ failed: true }>> {
    try {
      return await db.transaction(async tx => {
        const job = await executionJob(tx, cmd);
        await tx.update(schema.systemAgentJobs).set({ status: 'failed', error: text(cmd.message, '失败说明', 2000), execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id));
        await audit(tx, job, 'system_agent.failed', { executor_id: job.executor_id });
        return result({ failed: true as const });
      });
    } catch (e) { return fail(e); }
  }

  async function recoverExpiredJobs(): Promise<TaskResult<{ recovered: number }>> {
    try {
      return await db.transaction(async tx => {
        const jobs = await tx.select().from(schema.systemAgentJobs).where(and(eq(schema.systemAgentJobs.status, 'running'), lt(schema.systemAgentJobs.lease_expires_at, now()))).for('update', { skipLocked: true });
        for (const job of jobs) {
          await tx.update(schema.systemAgentJobs).set({ status: 'failed', error: '执行器连接中断或任务超时；修改稿未采用，请重新发起', execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(schema.systemAgentJobs.id, job.id));
          await audit(tx, job, 'system_agent.failed', { reason: 'lease_expired' });
        }
        return result({ recovered: jobs.length });
      });
    } catch (e) { return fail(e); }
  }

  return { createJob, getJob, listJobs, applyJob, cancelJob: (cmd: ActorCommand) => changeDisposition(cmd, 'cancelled'), rejectJob: (cmd: ActorCommand) => changeDisposition(cmd, 'rejected'),
    claimNextJob, heartbeatJob, completeJob, failJob, recoverExpiredJobs };
}
