import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { MemoryCenterView, MemoryCaptureState } from '@team-synergy/contracts';
import { memoryCaptureStates } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { assertProjectAccess, visibleProjectIds } from './project-access.js';
import { codeCondition } from './public-code.js';
import { createMemoryProjectManagementUseCases, type MemoryManagementOptions } from './memory-project-management.js';
import { createMemorySliceUseCases } from './memory-slice-use-cases.js';

const { memoryCaptureJobs: captures, memoryCaptureReceipts: receipts, memoryFragments: fragments,
  projectMaterialIndexVersions: indexes, memoryProjectionJobs: projections, projects, users } = schema;
const count = sql<number>`count(*)::int`;
const safeErrors = new Set(['memory_needs_clarification', 'memory_ambiguous', 'memory_source_changed', 'memory_model_unavailable',
  'memory_no_material', 'memory_capture_failed', 'memory_revision_conflict', 'memory_head_conflict', 'memory_scope_mismatch',
  'memory_proposal_changed', 'memory_forbidden', 'project_forbidden']);

/** Account identity is supplied by authentication, never by a query owner field.
 * Capture metadata remains private even for project managers/system admins. */
export function createMemoryCenterUseCases(db: Db) {
  async function read(cmd: { principalCode: string; projectCode?: string }, options: (projectCode: string) => MemoryManagementOptions = () => ({})) {
    return db.transaction(async tx => {
      const [principal] = await tx.select({ id: users.id, code: users.code, admin: users.is_system_admin }).from(users).where(and(
        codeCondition(users, cmd.principalCode), eq(users.status, 'active'), eq(users.pending_deletion, false), isNull(users.deleted_at))).limit(1).for('share');
      if (!principal) throw new DomainError('memory_forbidden', '当前账号无权读取记忆中心。');
      const visible = await visibleProjectIds(tx, principal.id);
      const directory = visible.length ? await tx.select({ id: projects.id, code: projects.code, name: projects.name, status: projects.status })
        .from(projects).where(inArray(projects.id, visible)).orderBy(projects.name, projects.code) : [];
      const selected = cmd.projectCode === undefined ? undefined : directory.find(project => project.code === cmd.projectCode);
      if (cmd.projectCode !== undefined && !selected) throw new DomainError('project_forbidden', '当前项目权限不足。');
      if (selected) await assertProjectAccess(tx, selected.id, principal.id);
      const projectIds = selected ? [selected.id] : visible;
      const captureFilter = and(eq(captures.principal_id, principal.id), projectIds.length ? inArray(captures.project_id, projectIds) : sql`false`);
      const grouped = await tx.select({ status: captures.status, count, received: sql<Date | null>`max(${captures.created_at})`,
        processed: sql<Date | null>`max(case when ${captures.status} in ('completed','skipped','needs_clarification','failed') then ${captures.updated_at} end)` })
        .from(captures).where(captureFilter).groupBy(captures.status);
      const counts = Object.fromEntries(memoryCaptureStates.map(status => [status, 0])) as Record<MemoryCaptureState, number>;
      for (const row of grouped) counts[row.status] = Number(row.count);
      const latest = (rows: Array<Date | null>) => rows.filter((value): value is Date => value !== null)
        .map(value => new Date(value).toISOString()).sort().at(-1);
      const recent = await tx.select({ code: captures.code, projectCode: projects.code, projectName: projects.name,
        sessionId: captures.session_key, eventId: captures.event_key, status: captures.status, attempts: captures.attempts,
        receivedAt: captures.created_at, updatedAt: captures.updated_at, errorCode: captures.last_error_code, receiptCode: receipts.code })
        .from(captures).innerJoin(projects, eq(projects.id, captures.project_id))
        .leftJoin(receipts, and(eq(receipts.project_id, captures.project_id), eq(receipts.principal_id, captures.principal_id),
          eq(receipts.session_key, captures.session_key), eq(receipts.event_key, captures.event_key)))
        .where(captureFilter).orderBy(desc(captures.id)).limit(41);
      const privateRows = await tx.select({ withdrawn: sql<boolean>`${fragments.withdrawn_at} is not null`, count }).from(fragments)
        .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).where(and(eq(receipts.principal_id, principal.id),
          eq(fragments.state, 'preference'), sql`not exists(select 1 from memory_fragments next where next.supersedes_id=${fragments.id})`))
        .groupBy(sql`${fragments.withdrawn_at} is not null`);
      const active = Number(privateRows.find(row => !row.withdrawn)?.count ?? 0), withdrawn = Number(privateRows.find(row => row.withdrawn)?.count ?? 0);
      // Count each immutable index once, regardless of Wiki/Core copies. These
      // are registered indexes; selected details revalidate current native sources.
      const indexed = visible.length ? await tx.select({ projectId: indexes.project_id, total: sql<number>`count(distinct ${indexes.id})::int`,
        synced: sql<number>`count(distinct case when ${projections.status}='synced' and ${projections.operation}='upsert' then ${indexes.id} end)::int` })
        .from(indexes).leftJoin(projections, eq(projections.material_index_id, indexes.id)).where(and(inArray(indexes.project_id, visible), eq(indexes.active, true)))
        .groupBy(indexes.project_id) : [];
      let selectedProject: MemoryCenterView['selectedProject'];
      if (selected) {
        const actor = { principalCode: principal.code, projectCode: selected.code };
        const nestedDb = tx as unknown as Db;
        const materials = await createMemoryProjectManagementUseCases(nestedDb).status(actor, options(selected.code));
        const candidates = await tx.select({ source: sql<string>`coalesce(${schema.requirementTopicEntries.code},${fragments.code})` })
          .from(fragments).innerJoin(receipts, eq(receipts.id, fragments.receipt_id))
          .leftJoin(schema.requirementTopicEntries, eq(schema.requirementTopicEntries.id, fragments.entry_id))
          .where(and(eq(receipts.project_id, selected.id), ne(fragments.state, 'preference'), isNull(fragments.withdrawn_at),
            sql`not exists(select 1 from memory_fragments next where next.supersedes_id=${fragments.id})`))
          .orderBy(desc(fragments.id)).limit(201);
        const shared: NonNullable<MemoryCenterView['selectedProject']>['shared'] = [];
        const sourceReader = createMemorySliceUseCases(nestedDb);
        for (let offset = 0; offset < Math.min(candidates.length, 200); offset += 40) {
          const sources = candidates.slice(offset, Math.min(offset + 40, 200)).map(row => row.source);
          for (const row of await sourceReader.readSources({ ...actor, sources })) {
            if (row.scope === 'project' && (row.state === 'discussed' || row.state === 'confirmed')) {
              shared.push({ source: row.source, state: row.state, text: row.text,
                ...('topicCode' in row && row.topicCode ? { topicCode: row.topicCode } : {}),
                ...('requirementCode' in row && row.requirementCode ? { requirementCode: row.requirementCode } : {}),
                ...('sourceRevision' in row && row.sourceRevision !== null ? { sourceRevision: row.sourceRevision } : {}) });
            }
          }
        }
        selectedProject = { materials, shared, sharedTruncated: candidates.length > 200 };
      }
      return { ownerCode: principal.code, canViewServiceObservations: principal.admin,
        projects: directory.map(project => { const index = indexed.find(row => row.projectId === project.id);
          return { code: project.code, name: project.name, status: project.status, indexes: Number(index?.total ?? 0), syncedIndexes: Number(index?.synced ?? 0) }; }),
        personal: { active, withdrawn, total: active + withdrawn },
        captures: { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0),
          lastReceivedAt: latest(grouped.map(row => row.received)), lastProcessedAt: latest(grouped.map(row => row.processed)),
          installation: 'unknown' as const, localQueue: 'unknown' as const, truncated: recent.length > 40,
          recent: recent.slice(0, 40).map(row => ({ code: row.code, projectCode: row.projectCode, projectName: row.projectName,
            sessionId: row.sessionId, eventId: row.eventId, status: row.status, attempts: row.attempts,
            receivedAt: row.receivedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
            ...(row.receiptCode ? { receiptCode: row.receiptCode } : {}),
            ...(row.errorCode ? { errorCode: safeErrors.has(row.errorCode) ? row.errorCode : 'memory_capture_failed' } : {}) })) },
        ...(selectedProject ? { selectedProject } : {}), observedAt: new Date().toISOString() };
    });
  }
  return { read };
}
