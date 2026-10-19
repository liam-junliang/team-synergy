import { createHash } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import type { RequirementBaseline, RequirementBaselineItem, RequirementBaselineComparison, RequirementBaselineBindings } from '@team-synergy/contracts';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Store = Db | Tx;
interface AccessArgs { projectCode: string; principalCode: string }
interface BaselineArgs extends AccessArgs { baselineCode: string }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function contentHash(items: RequirementBaselineItem[]) {
  return createHash('sha256').update(canonicalJson(items)).digest('hex');
}
export interface CreateRequirementBaselineCommand extends AccessArgs {
  name: string;
  scope: string;
  reason: string;
  /** Expected latest baseline. Omission chooses the latest under the transaction lock. */
  parentBaselineCode?: string | null;
  requirements: Array<{ requirement_code: string; revision: number }>;
}

async function access(tx: Tx, args: AccessArgs, mutation = false) {
  const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, args.projectCode)).for('share').limit(1);
  if (!project) throw new DomainError('project_not_found', '项目不存在');
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.code, args.principalCode)).for('share').limit(1);
  if (!user) throw new DomainError('user_not_found', '用户不存在');
  const member = await effectiveProjectMember(tx, project.id, user.id);
  if (!member || user.status !== 'active') throw new DomainError('baseline_access_denied', '需要有效项目成员身份');
  if (mutation && project.status !== 'active') throw new DomainError('project_archived', '归档项目不可创建基线');
  if (mutation && !isProjectManager(member.role)) throw new DomainError('baseline_owner_required', '只有项目负责人或管理员可以确认需求基线');
  await assertProjectAccess(tx, project.id, user.id, mutation ? 'manage' : 'read');
  return { project, user, member };
}

export async function loadRequirementBaseline(db: Store, projectId: bigint, baselineCode: string) {
  const [row] = await db.select().from(schema.requirementBaselines).where(and(
    eq(schema.requirementBaselines.project_id, projectId), eq(schema.requirementBaselines.code, baselineCode),
  )).limit(1);
  if (!row) return undefined;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, row.project_id)).limit(1);
  const [creator] = await db.select().from(schema.users).where(eq(schema.users.id, row.created_by)).limit(1);
  const [parent] = row.parent_baseline_id === null ? [] : await db.select().from(schema.requirementBaselines).where(eq(schema.requirementBaselines.id, row.parent_baseline_id)).limit(1);
  const items = await db.select().from(schema.requirementBaselineItems).where(eq(schema.requirementBaselineItems.baseline_id, row.id));
  const requirements = items.map(item => JSON.parse(item.snapshot) as RequirementBaselineItem).sort((a, b) => a.requirement_code.localeCompare(b.requirement_code));
  if (contentHash(requirements) !== row.content_hash) throw new DomainError('baseline_integrity_error', '需求基线内容校验失败');
  const baseline: RequirementBaseline = {
    baseline_code: row.code, project_code: project?.code ?? '', version: row.version,
    name: row.name, scope: row.scope, reason: row.reason, parent_baseline_code: parent?.code ?? null,
    created_by: creator?.code ?? '', created_at: row.created_at, content_hash: row.content_hash, requirements,
  };
  return { row, baseline };
}

async function snapshotRequirement(db: Store, requirement: typeof schema.requirements.$inferSelect, revisionNumber: number) {
  const [feature] = requirement.feature_id === null ? [] : await db.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1);
  const [module] = requirement.module_id === null ? [] : await db.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1);
  const [document] = requirement.document_id === null ? [] : await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1);
  const projectIds = [...new Set([feature?.project_id, module?.project_id, document?.project_id].filter((id): id is bigint => id !== undefined))];
  const [revision] = await db.select().from(schema.requirementRevisions).where(and(eq(schema.requirementRevisions.requirement_id, requirement.id), eq(schema.requirementRevisions.revision, revisionNumber))).limit(1);
  if (!revision) throw new DomainError('baseline_revision_not_found', `需求 ${requirement.code} 的 R${revisionNumber} 不存在`);
  // Existing revision content is already normalized by requirement use cases; preserve it exactly.
  const item: RequirementBaselineItem = {
    requirement_code: requirement.code, revision: revision.revision, revision_code: revision.code,
    title: requirement.title, status: requirement.state,
    feature_code: feature?.code ?? null, module_code: module?.code ?? null, document_code: document?.code ?? null,
    body: revision.summary ?? '', acceptance_criteria: (JSON.parse(revision.acceptance_criteria) as Array<{ id: string; text: string } | string>).map((criterion, index) => typeof criterion === 'string' ? { id: `AC-${index + 1}`, text: criterion } : criterion),
    open_questions: JSON.parse(revision.open_questions ?? '[]'),
  };
  return { item, requirementId: requirement.id, revisionId: revision.id, projectIds };
}

function compareItems(from: RequirementBaselineItem[], to: RequirementBaselineItem[], fromCode: string, toCode: string | null): RequirementBaselineComparison {
  const before = new Map(from.map(item => [item.requirement_code, item]));
  const after = new Map(to.map(item => [item.requirement_code, item]));
  const changes: RequirementBaselineComparison['changes'] = [];
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const code of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(code) ?? null;
    const right = after.get(code) ?? null;
    const fields = Object.keys(right ?? left ?? {}) as Array<keyof RequirementBaselineItem>;
    const changed = fields.filter(field => JSON.stringify(left?.[field]) !== JSON.stringify(right?.[field]));
    if (!changed.length) continue;
    const kind = left === null ? 'added' : right === null ? 'removed' : 'modified';
    counts[kind]++;
    changes.push({ requirement_code: code, kind, before: left, after: right, changed_fields: changed });
  }
  return { from_baseline_code: fromCode, to_baseline_code: toCode, changes, counts };
}

export function createRequirementBaselineUseCases(db: Db) {
  return {
    async bindings(args: AccessArgs): Promise<TaskResult<RequirementBaselineBindings>> {
      try {
        return await db.transaction(async tx => {
          const { project, user, member } = await access(tx, args);
          const tasks = await tx.select({ task_code: schema.tasks.code, title: schema.tasks.title, status: schema.tasks.status,
            baseline_code: schema.requirementBaselines.code, baseline_version: schema.requirementBaselines.version })
            .from(schema.tasks)
            .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
            .leftJoin(schema.requirementBaselines, and(eq(schema.requirementBaselines.id, schema.tasks.requirement_baseline_id), eq(schema.requirementBaselines.project_id, project.id)))
            .where(eq(schema.features.project_id, project.id)).orderBy(asc(schema.tasks.id));
          const rows = await tx.select({ handover: schema.taskHandovers, task: schema.tasks, source_principal_id: schema.runs.principal_id,
            manifest: schema.contextSnapshots.manifest })
            .from(schema.taskHandovers)
            .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskHandovers.task_id))
            .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
            .innerJoin(schema.runs, and(eq(schema.runs.id, schema.taskHandovers.source_run_id), eq(schema.runs.task_id, schema.tasks.id)))
            .leftJoin(schema.contextSnapshots, and(eq(schema.contextSnapshots.id, schema.taskHandovers.context_snapshot_id),
              eq(schema.contextSnapshots.project_id, project.id), eq(schema.contextSnapshots.task_id, schema.tasks.id),
              eq(schema.contextSnapshots.source_run_id, schema.taskHandovers.source_run_id)))
            .where(eq(schema.features.project_id, project.id)).orderBy(asc(schema.taskHandovers.id));
          const baselines = await tx.select({ code: schema.requirementBaselines.code, version: schema.requirementBaselines.version })
            .from(schema.requirementBaselines).where(eq(schema.requirementBaselines.project_id, project.id));
          const baselineVersions = new Map(baselines.map(baseline => [baseline.code, baseline.version]));
          const handovers: RequirementBaselineBindings['handovers'] = [];
          for (const { handover, task, source_principal_id, manifest } of rows) {
            if (!handover.published_by && !isProjectManager(member.role) && source_principal_id !== user.id) continue;
            const frozen = manifest === null ? null : (JSON.parse(manifest) as { requirement_baseline?: RequirementBaseline | null }).requirement_baseline;
            const baseline = frozen?.project_code === project.code && baselineVersions.get(frozen.baseline_code) === frozen.version ? frozen : null;
            handovers.push({ handover_code: handover.code, task_code: task.code, task_title: task.title, status: handover.status,
              baseline_code: baseline?.baseline_code ?? null, baseline_version: baseline?.version ?? null });
          }
          return { ok: true, data: { tasks, handovers } };
        });
      } catch (error) { return fail(error); }
    },

    async list(args: AccessArgs): Promise<TaskResult<{ baselines: RequirementBaseline[]; can_create: boolean }>> {
      try {
        return await db.transaction(async tx => {
          const { project, member } = await access(tx, args);
          const rows = await tx.select().from(schema.requirementBaselines).where(eq(schema.requirementBaselines.project_id, project.id)).orderBy(desc(schema.requirementBaselines.version));
          const baselines: RequirementBaseline[] = [];
          for (const row of rows) {
            const loaded = await loadRequirementBaseline(tx, project.id, row.code);
            if (!loaded) throw new DomainError('baseline_not_found', '需求基线不存在');
            baselines.push(loaded.baseline);
          }
          return { ok: true, data: { baselines, can_create: isProjectManager(member.role) && project.status === 'active' } };
        });
      } catch (error) { return fail(error); }
    },

    async get(args: BaselineArgs): Promise<TaskResult<RequirementBaseline>> {
      try {
        return await db.transaction(async tx => {
          const { project } = await access(tx, args);
          const loaded = await loadRequirementBaseline(tx, project.id, args.baselineCode);
          if (!loaded) throw new DomainError('baseline_not_found', '此项目中不存在该基线');
          return { ok: true, data: loaded.baseline };
        });
      } catch (error) { return fail(error); }
    },

    async create(args: CreateRequirementBaselineCommand): Promise<TaskResult<RequirementBaseline>> {
      try {
        if (![args.name, args.scope, args.reason].every(value => typeof value === 'string' && value.trim())) throw new DomainError('baseline_invalid_metadata', '基线名称、范围和变更原因必填');
        if (!Array.isArray(args.requirements) || !args.requirements.length || args.requirements.some(item => !item || typeof item.requirement_code !== 'string' || !Number.isInteger(item.revision) || item.revision < 1) || new Set(args.requirements.map(item => item.requirement_code)).size !== args.requirements.length) throw new DomainError('baseline_invalid_selection', '请选择不重复的需求及有效修订版本');
        return await db.transaction(async tx => {
          // Same lock as requirement/material writers, acquired before any reads to avoid upgrades.
          await tx.execute(sql`select pg_advisory_xact_lock(1094930512)`);
          const { project, user } = await access(tx, args, true);
          const [parent] = await tx.select().from(schema.requirementBaselines).where(eq(schema.requirementBaselines.project_id, project.id)).orderBy(desc(schema.requirementBaselines.version)).limit(1);
          if (args.parentBaselineCode !== undefined && args.parentBaselineCode !== (parent?.code ?? null)) throw new DomainError('baseline_parent_conflict', '基线已更新，请基于最新基线重新确认');
          const captured: Awaited<ReturnType<typeof snapshotRequirement>>[] = [];
          for (const choice of [...args.requirements].sort((a, b) => a.requirement_code.localeCompare(b.requirement_code))) {
            const [requirement] = await tx.select().from(schema.requirements).where(eq(schema.requirements.code, choice.requirement_code)).limit(1);
            if (!requirement) throw new DomainError('baseline_invalid_selection', '所选需求不存在');
            const snapshot = await snapshotRequirement(tx, requirement, choice.revision);
            if (snapshot.projectIds.length !== 1 || snapshot.projectIds[0] !== project.id) throw new DomainError('baseline_requirement_project_mismatch', '所选需求必须属于此项目');
            if (!['confirmed', 'implementing', 'delivered'].includes(requirement.state)) throw new DomainError('baseline_requirement_not_approved', '仅已确认、实现中或已交付需求可进入基线');
            captured.push(snapshot);
          }
          const hash = contentHash(captured.map(value => value.item));
          const createdAt = now();
          const [row] = await tx.insert(schema.requirementBaselines).values({ code: createPublicCode(), project_id: project.id, version: (parent?.version ?? 0) + 1, name: args.name.trim(), scope: args.scope.trim(), reason: args.reason.trim(), parent_baseline_id: parent?.id ?? null, created_by: user.id, created_at: createdAt, content_hash: hash }).returning();
          if (!row) throw new DomainError('internal_error', '需求基线创建失败');
          await tx.insert(schema.requirementBaselineItems).values(captured.map(value => ({ baseline_id: row.id, requirement_id: value.requirementId, requirement_revision_id: value.revisionId, snapshot: JSON.stringify(value.item) })));
          const audit = { entity_type: 'requirement_baseline', entity_id: row.id, principal_id: user.id, base_snapshot: 0, to: 'frozen', action: 'requirement_baseline.created', payload: { version: row.version, reason: row.reason, parent_baseline_code: parent?.code ?? null, content_hash: hash } };
          assertAuditedChange(audit);
          await insertAudit(tx, toAuditEvent(audit, createPublicCode(), createdAt));
          const loaded = await loadRequirementBaseline(tx, project.id, row.code);
          if (!loaded) throw new DomainError('internal_error', '需求基线创建后读取失败');
          return { ok: true, data: loaded.baseline };
        });
      } catch (error) { return fail(error); }
    },

    async compare(args: BaselineArgs & { compareTo: string }): Promise<TaskResult<RequirementBaselineComparison>> {
      try {
        return await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
          const { project } = await access(tx, args);
          const from = await loadRequirementBaseline(tx, project.id, args.baselineCode);
          if (!from) throw new DomainError('baseline_not_found', '此项目中不存在该基线');
          if (args.compareTo !== 'current') {
            const to = await loadRequirementBaseline(tx, project.id, args.compareTo);
            if (!to) throw new DomainError('baseline_not_found', '此项目中不存在目标基线');
            return { ok: true, data: compareItems(from.baseline.requirements, to.baseline.requirements, from.row.code, to.row.code) };
          }
          const current: RequirementBaselineItem[] = [];
          const heads = await tx.select().from(schema.requirements).orderBy(asc(schema.requirements.code));
          for (const head of heads) {
            const [feature] = head.feature_id === null ? [] : await tx.select().from(schema.features).where(eq(schema.features.id, head.feature_id)).limit(1);
            const [module] = head.module_id === null ? [] : await tx.select().from(schema.projectModules).where(eq(schema.projectModules.id, head.module_id)).limit(1);
            const [document] = head.document_id === null ? [] : await tx.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, head.document_id)).limit(1);
            if (![feature?.project_id, module?.project_id, document?.project_id].includes(project.id)) continue;
            const snapshot = await snapshotRequirement(tx, head, head.current_revision);
            if (snapshot.projectIds.length === 1 && snapshot.projectIds[0] === project.id) current.push(snapshot.item);
          }
          return { ok: true, data: compareItems(from.baseline.requirements, current, from.row.code, null) };
        });
      } catch (error) { return fail(error); }
    },
  };
}
