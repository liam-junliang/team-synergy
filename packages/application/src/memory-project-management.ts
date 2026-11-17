import { and, eq, isNull, sql } from 'drizzle-orm';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import type { ProjectMemoryManagementView, ProjectMemoryProjectionStatus } from '@team-synergy/contracts';
import { lockAggregate } from './aggregate-lock.js';
import { assertProjectAccess, isProjectManager } from './project-access.js';
import { codeCondition, createPublicCode } from './public-code.js';
import { insertAudit, now } from './task-service.js';
import { listCurrentProjectMaterialCandidates } from './project-material-catalog.js';
import { reconcileProjectMaterialIndexes } from './project-material-index.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Actor = { projectCode: string; principalCode: string };
export type MemoryManagementOptions = { serviceConfigured?: boolean; legacyConfigured?: boolean };
export type MemoryEnableGuard = { expectedGeneration: number | null; onlyIfEnabled: true };
export type ProjectMemoryResource = { wikiId: string; teamId: string; userId: string; semanticAgentId?: string };
const { projectMemoryBindings: bindings, memoryProjectionJobs: jobs, projectMaterialIndexVersions: indexes } = schema;
const errorCodes = new Set(['provision_failed', 'engine_unavailable', 'identity_mismatch', 'resource_conflict', 'mapping_missing',
  'delivery_not_verified', 'wiki_ingesting', 'wiki_ingest_failed', 'wiki_index_pending', 'remote_content_changed',
  'readback_mismatch', 'source_unavailable', 'lease_changed', 'project_memory_changed', 'resource_unavailable']);
const safeError = (value: string | null | undefined, fallback = 'delivery_not_verified') => value ? errorCodes.has(value) ? value : fallback : undefined;
const leaseMs = 2 * 60 * 1000;

async function authorize(tx: Tx, cmd: Actor, manage = false) {
  const [identity] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(codeCondition(schema.projects, cmd.projectCode.trim())).limit(1);
  if (!identity) throw new DomainError('project_forbidden', '当前项目权限不足');
  await lockAggregate(tx, 'project', identity.id, !manage);
  const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, identity.id)).limit(1);
  const [principal] = await tx.select().from(schema.users).where(and(codeCondition(schema.users, cmd.principalCode.trim()),
    eq(schema.users.status, 'active'), eq(schema.users.pending_deletion, false), isNull(schema.users.deleted_at))).limit(1).for('share');
  if (!project || !principal) throw new DomainError('project_forbidden', '当前项目权限不足');
  const access = await assertProjectAccess(tx, project.id, principal.id, manage ? 'manage' : 'read');
  return { project, principal, canManage: project.status === 'active' && isProjectManager(access.role) };
}

type Context = Awaited<ReturnType<typeof authorize>>;
const find = (tx: Tx, projectId: bigint) => tx.select().from(bindings).where(eq(bindings.project_id, projectId)).limit(1).then(rows => rows[0]);
function shortTitle(value: string) {
  const text = value.slice(0, 240);
  return /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
}

async function view(tx: Tx, context: Context, options: MemoryManagementOptions = {}): Promise<ProjectMemoryManagementView> {
  const row = await find(tx, context.project.id);
  const candidates = await listCurrentProjectMaterialCandidates(tx, { projectId: context.project.id });
  const projections = await tx.select({ source: indexes.source_citation, metadataHash: indexes.metadata_hash,
    status: jobs.status, operation: jobs.operation, lastError: jobs.last_error }).from(indexes)
    .leftJoin(jobs, eq(jobs.material_index_id, indexes.id)).where(and(eq(indexes.project_id, context.project.id), eq(indexes.active, true)));
  const counts = { total: candidates.length, pending: 0, processing: 0, synced: 0, needsReconcile: 0, notQueued: 0 };
  const rows = candidates.map(candidate => {
    const projection = projections.find(item => item.source === candidate.sourceCitation && item.metadataHash === candidate.metadataHash && item.operation === 'upsert');
    const projectionStatus: ProjectMemoryProjectionStatus = projection?.status ?? 'not_queued';
    const countKey = projectionStatus === 'not_queued' ? 'notQueued' : projectionStatus === 'needs_reconcile' ? 'needsReconcile' : projectionStatus;
    counts[countKey]++;
    return { documentCode: candidate.objectCode, sourceKind: candidate.sourceKind, path: candidate.path,
      title: shortTitle(candidate.title), currentRevision: candidate.revision, source: candidate.sourceCitation, projectionStatus,
      ...(safeError(projection?.lastError) ? { lastError: safeError(projection?.lastError) } : {}) };
  });
  const legacy = await tx.execute(sql`select count(*)::int as count from memory_projection_jobs j
    join project_document_revisions r on r.id=j.project_document_revision_id join project_documents d on d.id=r.document_id
    where d.project_id=${context.project.id} and (j.operation='upsert' or j.status<>'synced')`);
  const enabled = row?.enabled ?? options.legacyConfigured === true;
  const bindingState = row?.state ?? (options.legacyConfigured ? 'ready' : 'not_enabled');
  const serviceConfigured = options.serviceConfigured !== false;
  const lastError = safeError(row?.last_error, 'provision_failed');
  return { projectCode: context.project.code, serviceConfigured, enabled, bindingState, canManage: context.canManage,
    storage: 'native_pg', retrievalEnabled: context.project.status === 'active' && serviceConfigured && enabled && bindingState === 'ready',
    counts, documents: rows.slice(0, 100), documentsTruncated: rows.length > 100,
    legacyCleanupPending: Number((legacy.rows[0] as { count?: number })?.count ?? 0),
    ...(row ? { updatedAt: row.updated_at.toISOString() } : {}), ...(lastError ? { lastError } : {}) };
}

async function audit(tx: Tx, context: Context, action: string, payload: Record<string, unknown>) {
  await insertAudit(tx, toAuditEvent({ entity_type: 'project', entity_id: context.project.id, principal_id: context.principal.id,
    base_snapshot: context.project.current_snapshot, action, payload }, createPublicCode(), now()));
}

async function queueCurrent(tx: Tx, projectId: bigint) {
  return (await reconcileProjectMaterialIndexes(tx, projectId)).queued;
}

export function createMemoryProjectManagementUseCases(db: Db) {
  async function status(cmd: Actor, options: MemoryManagementOptions = {}) {
    return db.transaction(async tx => view(tx, await authorize(tx, cmd), options));
  }

  async function enable(cmd: Actor, options: MemoryManagementOptions = {}, guard?: MemoryEnableGuard) {
    return db.transaction(async tx => {
      const context = await authorize(tx, cmd, true);
      if (options.serviceConfigured === false) throw new DomainError('memory_service_unavailable', '记忆服务尚未配置。');
      const previous = await find(tx, context.project.id);
      if (guard && ((previous?.generation ?? null) !== guard.expectedGeneration || !(previous?.enabled ?? options.legacyConfigured === true))) {
        return { provisionRequired: false, generation: previous?.generation ?? 0, status: await view(tx, context, options) };
      }
      if (previous?.enabled && (previous.state === 'ready' || previous.state === 'provisioning' &&
          previous.provision_lease_until && previous.provision_lease_until.getTime() > Date.now())) {
        return { provisionRequired: false, generation: previous.generation, status: await view(tx, context, options) };
      }
      const ready = previous?.state === 'ready';
      const generation = (previous?.generation ?? 0) + 1;
      const values = { enabled: true, state: ready ? 'ready' as const : 'provisioning' as const, generation,
        provision_lease_until: ready ? null : new Date(Date.now() + leaseMs), last_error: null,
        updated_by: context.principal.id, updated_source: 'member' as const, updated_at: new Date() };
      if (previous) await tx.update(bindings).set(values).where(eq(bindings.id, previous.id));
      else await tx.insert(bindings).values({ project_id: context.project.id, ...values });
      await queueCurrent(tx, context.project.id);
      await audit(tx, context, 'project_memory.enabled', { generation, provision_required: !ready });
      return { provisionRequired: !ready, generation, status: await view(tx, context, options) };
    });
  }

  async function pause(cmd: Actor, options: MemoryManagementOptions = {}) {
    return db.transaction(async tx => {
      const context = await authorize(tx, cmd, true);
      const previous = await find(tx, context.project.id);
      if (previous && !previous.enabled) return view(tx, context, options);
      const generation = (previous?.generation ?? 0) + 1;
      const values = { enabled: false, generation, provision_lease_until: null, updated_by: context.principal.id, updated_source: 'member' as const, updated_at: new Date() };
      if (previous) await tx.update(bindings).set(values).where(eq(bindings.id, previous.id));
      else await tx.insert(bindings).values({ project_id: context.project.id, state: 'provisioning', ...values });
      await audit(tx, context, 'project_memory.paused', { generation });
      return view(tx, context, options);
    });
  }

  async function retry(cmd: Actor, options: MemoryManagementOptions = {}) {
    return db.transaction(async tx => {
      const context = await authorize(tx, cmd, true);
      if (options.serviceConfigured === false) throw new DomainError('memory_service_unavailable', '记忆服务尚未配置。');
      const previous = await find(tx, context.project.id);
      if (!(previous?.enabled ?? options.legacyConfigured === true)) throw new DomainError('memory_not_enabled', '请先启用项目记忆。');
      const queued = await queueCurrent(tx, context.project.id);
      const updated = await tx.execute(sql`update memory_projection_jobs j set status='pending',lease_until=null,last_error=null
        from project_material_index_versions v where j.material_index_id=v.id and j.engine='tencent' and j.status='needs_reconcile'
          and v.project_id=${context.project.id} returning j.id`);
      const retried = queued + updated.rows.length;
      if (retried) await audit(tx, context, 'project_memory.retried', { count: retried });
      return { retried, status: await view(tx, context, options) };
    });
  }

  async function binding(projectCode: string) {
    const [row] = await db.select({ projectCode: schema.projects.code, enabled: bindings.enabled, state: bindings.state,
      generation: bindings.generation, wikiId: bindings.wiki_id, teamId: bindings.engine_team_id, userId: bindings.engine_user_id,
      semanticAgentId: bindings.semantic_agent_id, lastError: bindings.last_error, leaseUntil: bindings.provision_lease_until,
    }).from(bindings).innerJoin(schema.projects, eq(schema.projects.id, bindings.project_id))
      .where(eq(schema.projects.code, projectCode)).limit(1);
    return row ?? null;
  }

  async function prepareAutomatic(projectCode: string) {
    return db.transaction(async tx => {
      const [project] = await tx.select({ id: schema.projects.id, status: schema.projects.status }).from(schema.projects)
        .where(eq(schema.projects.code, projectCode)).limit(1);
      if (!project || project.status !== 'active') return null;
      await lockAggregate(tx, 'project', project.id);
      const previous = await find(tx, project.id);
      if (previous && (!previous.enabled || previous.state === 'ready' ||
        previous.state === 'provisioning' && previous.provision_lease_until && previous.provision_lease_until.getTime() > Date.now() ||
        previous.state === 'failed' && previous.updated_at.getTime() > Date.now() - 30000)) return null;
      const generation = (previous?.generation ?? 0) + 1;
      const values = { enabled: true, state: 'provisioning' as const, generation, updated_by: null,
        updated_source: 'system' as const, last_error: null, updated_at: new Date(), provision_lease_until: new Date(Date.now() + leaseMs) };
      if (previous) await tx.update(bindings).set(values).where(eq(bindings.id, previous.id));
      else await tx.insert(bindings).values({ project_id: project.id, ...values });
      await tx.insert(schema.projectMaterialIndexEvents).values({ project_id: project.id, action: 'binding.automatic_prepared',
        payload: JSON.stringify({ generation, firstBinding: !previous }) });
      return { projectCode, generation };
    });
  }

  async function finish(cmd: { projectCode: string; generation: number }, resource: ProjectMemoryResource | null, errorCode?: string) {
    if (!Number.isSafeInteger(cmd.generation) || cmd.generation < 1) throw new DomainError('memory_binding_invalid', '记忆资源代次无效。');
    if (resource && ![resource.wikiId, resource.teamId, resource.userId, ...(resource.semanticAgentId === undefined ? [] : [resource.semanticAgentId])]
      .every(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) && value !== '.' && value !== '..')) {
      throw new DomainError('memory_binding_invalid', '记忆资源身份无效。');
    }
    return db.transaction(async tx => {
      const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
      if (!project) return false;
      await lockAggregate(tx, 'project', project.id);
      const [active] = await tx.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, project.id)).limit(1);
      if (active?.status !== 'active') return false;
      const previous = resource ? await find(tx, project.id) : undefined;
      const rows = await tx.update(bindings).set({
        state: resource ? 'ready' : 'failed', provision_lease_until: null,
        last_error: resource ? null : safeError(errorCode || 'provision_failed', 'provision_failed'), updated_at: new Date(),
        ...(resource ? { wiki_id: resource.wikiId, engine_team_id: resource.teamId, engine_user_id: resource.userId,
          semantic_agent_id: resource.semanticAgentId ?? null } : {}),
      }).where(and(eq(bindings.project_id, project.id), eq(bindings.enabled, true), eq(bindings.state, 'provisioning'),
        eq(bindings.generation, cmd.generation))).returning({ id: bindings.id });
      if (rows.length && resource && previous?.wiki_id !== resource.wikiId) await tx.execute(sql`update memory_projection_jobs j set status='pending',lease_until=null,last_error=null
        from project_material_index_versions v
        where j.material_index_id=v.id and j.engine='tencent' and j.status='synced' and j.operation='upsert'
          and v.project_id=${project.id} and v.active`);
      return rows.length === 1;
    });
  }
  const completeProvision = (cmd: { projectCode: string; generation: number; binding: ProjectMemoryResource }) => finish(cmd, cmd.binding);
  const failProvision = (cmd: { projectCode: string; generation: number; errorCode: string }) => finish(cmd, null, cmd.errorCode);
  async function invalidateBinding(cmd: { projectCode: string; generation: number; errorCode: string }) {
    if (!Number.isSafeInteger(cmd.generation) || cmd.generation < 1) throw new DomainError('memory_binding_invalid', '记忆资源代次无效。');
    return db.transaction(async tx => {
      const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
      if (!project) return false;
      await lockAggregate(tx, 'project', project.id);
      const changed = await tx.update(bindings).set({ state: 'failed', generation: sql`${bindings.generation} + 1`,
        last_error: safeError(cmd.errorCode || 'engine_unavailable', 'provision_failed'), provision_lease_until: null, updated_at: new Date(),
      }).where(and(eq(bindings.project_id, project.id), eq(bindings.enabled, true), eq(bindings.state, 'ready'),
        eq(bindings.generation, cmd.generation))).returning({ id: bindings.id });
      if (changed.length) await tx.execute(sql`update memory_projection_jobs j set status='needs_reconcile',lease_until=null,last_error='project_memory_changed'
        from project_material_index_versions v
        where j.material_index_id=v.id and j.engine='tencent' and j.status='synced' and j.operation='upsert'
          and v.project_id=${project.id} and v.active`);
      return changed.length === 1;
    });
  }
  return { status, enable, pause, retry, binding, completeProvision, failProvision, invalidateBinding, prepareAutomatic };
}
