import { writeRequirement } from './intake-entity-writers.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import {
  createPublicCode,
  findFeatureByCode,
  findProjectByCode,
  findProjectModuleByCode,
  findRequirementByCode,
  findRequirementDocumentByCode,
  findUserByCode,
} from './public-code.js';

export const REQUIREMENT_STATUSES = [
  'draft',
  'clarifying',
  'confirmed',
  'implementing',
  'delivered',
  'change_proposed',
  'deprecated',
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const REQUIREMENT_TRANSITIONS: Readonly<Record<RequirementStatus, readonly RequirementStatus[]>> = {
  draft: ['clarifying', 'confirmed', 'deprecated'],
  clarifying: ['draft', 'confirmed', 'deprecated'],
  confirmed: ['implementing', 'change_proposed', 'deprecated'],
  implementing: ['delivered', 'change_proposed', 'deprecated'],
  delivered: ['change_proposed', 'deprecated'],
  change_proposed: ['clarifying', 'confirmed', 'deprecated'],
  deprecated: [],
};

const EDITABLE_STATUSES = new Set<RequirementStatus>(['draft', 'clarifying', 'change_proposed']);

export interface RequirementAcceptanceCriterion {
  id: string;
  text: string;
}

export interface RequirementRevision {
  revision: number;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
  created_at: string;
}

export interface RequirementSummary {
  requirement_code: string;
  feature_code: string | null;
  document_code: string | null;
  module_code: string | null;
  module_name: string | null;
  module_key: string | null;
  title: string;
  current_revision: number;
  owner_principal_code: string;
  status: RequirementStatus;
  state: RequirementStatus;
  body: string;
  acceptance_criteria: RequirementAcceptanceCriterion[];
  open_questions: string[];
  revision_created_at: string | null;
  task_count?: number;
}

export interface RequirementTask {
  task_code: string;
  title: string;
  status: string;
  profile: string;
  assignee_principal_code: string | null;
}

export interface RequirementDetail extends RequirementSummary {
  tasks: RequirementTask[];
  revisions: RequirementRevision[];
  can_edit: boolean;
  available_transitions: RequirementStatus[];
}

type RequirementRow = typeof schema.requirements.$inferSelect;
type RequirementRevisionRow = typeof schema.requirementRevisions.$inferSelect;
type FeatureRow = typeof schema.features.$inferSelect;
type ModuleRow = typeof schema.projectModules.$inferSelect;
type DocumentRow = typeof schema.requirementDocuments.$inferSelect;

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseAcceptanceCriteria(raw: string | null): RequirementAcceptanceCriterion[] {
  return parseJsonArray(raw).flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return [{ id: `AC-${index + 1}`, text: item.trim() }];
    }
    if (!item || typeof item !== 'object') return [];
    const candidate = item as { id?: unknown; text?: unknown };
    if (typeof candidate.text !== 'string' || !candidate.text.trim()) return [];
    return [{
      id: typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id.trim() : `AC-${index + 1}`,
      text: candidate.text.trim(),
    }];
  });
}

function parseOpenQuestions(raw: string | null): string[] {
  return parseJsonArray(raw)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAcceptanceCriteria(items: RequirementAcceptanceCriterion[]): RequirementAcceptanceCriterion[] {
  const normalized = items.flatMap((item, index) => {
    const text = item.text.trim();
    if (!text) return [];
    return [{ id: item.id.trim() || `AC-${index + 1}`, text }];
  });
  const ids = new Set<string>();
  for (const item of normalized) {
    if (ids.has(item.id)) {
      throw new DomainError('requirement_acceptance_id_duplicate', `验收标准 ID 重复：${item.id}`);
    }
    ids.add(item.id);
  }
  return normalized;
}

function normalizeOpenQuestions(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

function toRevision(row: RequirementRevisionRow): RequirementRevision {
  return {
    revision: row.revision,
    body: row.summary ?? '',
    acceptance_criteria: parseAcceptanceCriteria(row.acceptance_criteria),
    open_questions: parseOpenQuestions(row.open_questions),
    created_at: row.created_at,
  };
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function modulesByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, ModuleRow>();
  const rows = await db.select().from(schema.projectModules).where(inArray(schema.projectModules.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function projectMember(db: Db, projectId: bigint, principalId: bigint) {
  const member = await effectiveProjectMember(db, projectId, principalId);
  return member;
}

function moduleKeyOf(module: ModuleRow | undefined, document: DocumentRow | undefined) {
  return document?.module_key ?? module?.name ?? null;
}

async function loadRequirementRelations(db: Db, requirement: RequirementRow) {
  const [feature, module, document] = await Promise.all([
    requirement.feature_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1).then((rows) => rows[0]),
    requirement.module_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1).then((rows) => rows[0]),
    requirement.document_id === null
      ? Promise.resolve(undefined)
      : db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1).then((rows) => rows[0]),
  ]);
  const projectIds = [...new Set([
    feature?.project_id,
    module?.project_id,
    document?.project_id,
  ].filter((value): value is bigint => value !== undefined))];
  const project = projectIds.length === 1
    ? await db.select().from(schema.projects).where(eq(schema.projects.id, projectIds[0]!)).limit(1).then((rows) => rows[0])
    : undefined;
  return { feature, module, document, project };
}

async function toSummary(
  db: Db,
  requirement: RequirementRow,
  revision: RequirementRevisionRow | null,
  resolved?: {
    feature?: FeatureRow;
    module?: ModuleRow;
    document?: DocumentRow;
    ownerCode?: string;
  },
): Promise<RequirementSummary> {
  const feature = resolved?.feature ?? (
    requirement.feature_id === null
      ? undefined
      : await db.select().from(schema.features).where(eq(schema.features.id, requirement.feature_id)).limit(1).then((rows) => rows[0])
  );
  const module = resolved?.module ?? (
    requirement.module_id === null
      ? undefined
      : await db.select().from(schema.projectModules).where(eq(schema.projectModules.id, requirement.module_id)).limit(1).then((rows) => rows[0])
  );
  const document = resolved?.document ?? (
    requirement.document_id === null
      ? undefined
      : await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, requirement.document_id)).limit(1).then((rows) => rows[0])
  );
  const ownerCode = resolved?.ownerCode ?? (
    await db.select().from(schema.users).where(eq(schema.users.id, requirement.owner_principal_id)).limit(1).then((rows) => rows[0]?.code ?? '')
  );

  return {
    requirement_code: requirement.code,
    feature_code: feature?.code ?? null,
    document_code: document?.code ?? null,
    module_code: module?.code ?? null,
    module_name: module?.name ?? null,
    module_key: moduleKeyOf(module, document),
    title: requirement.title,
    current_revision: requirement.current_revision,
    owner_principal_code: ownerCode ?? '',
    status: requirement.state,
    state: requirement.state,
    body: revision?.summary ?? '',
    acceptance_criteria: parseAcceptanceCriteria(revision?.acceptance_criteria ?? null),
    open_questions: parseOpenQuestions(revision?.open_questions ?? null),
    revision_created_at: revision?.created_at ?? null,
  };
}

async function resolveBindingContext(
  db: Db,
  args: {
    feature?: FeatureRow | null;
    module?: ModuleRow | null;
    document?: DocumentRow | null;
    fallbackModuleId?: bigint | null;
  },
) {
  const projectIds = [...new Set([
    args.feature?.project_id,
    args.module?.project_id,
    args.document?.project_id,
  ].filter((value): value is bigint => value !== undefined))];
  if (projectIds.length > 1) {
    throw new DomainError('requirement_project_mismatch', '需求关联的 Feature / 模块 / 文档必须属于同一项目');
  }
  const projectId = projectIds[0];
  if (projectId === undefined) {
    return { project: undefined, moduleId: args.fallbackModuleId ?? null };
  }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!project) throw new DomainError('project_not_found', `项目不存在：${String(projectId)}`);

  const documentModuleId = args.document?.module_id ?? null;
  const featureModuleId = args.feature?.module_id ?? null;

  if (args.module && documentModuleId !== null && documentModuleId !== args.module.id) {
    throw new DomainError('requirement_document_module_mismatch', '需求文档与指定模块不一致');
  }
  if (args.module && featureModuleId !== null && featureModuleId !== args.module.id) {
    throw new DomainError('requirement_feature_module_mismatch', 'Feature 与指定模块不一致');
  }

  const moduleId = args.module?.id
    ?? documentModuleId
    ?? featureModuleId
    ?? args.fallbackModuleId
    ?? null;
  return { project, moduleId };
}

export function createRequirementUseCases(db: Db) {
  async function createRequirement(cmd: {
    featureCode?: string;
    moduleCode?: string;
    documentCode?: string;
    title: string;
    body: string;
    acceptanceCriteria?: RequirementAcceptanceCriterion[];
    openQuestions?: string[];
    status?: RequirementStatus;
    principalCode: string;
  }): Promise<TaskResult<RequirementSummary>> {
    try {
      const [feature, module, document, principal] = await Promise.all([
        cmd.featureCode ? findFeatureByCode(db, cmd.featureCode) : Promise.resolve(undefined),
        cmd.moduleCode ? findProjectModuleByCode(db, cmd.moduleCode) : Promise.resolve(undefined),
        cmd.documentCode ? findRequirementDocumentByCode(db, cmd.documentCode) : Promise.resolve(undefined),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (cmd.featureCode && !feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (cmd.moduleCode && !module) return fail(new DomainError('module_not_found', `功能模块不存在：${cmd.moduleCode}`));
      if (cmd.documentCode && !document) return fail(new DomainError('requirement_document_not_found', `需求文档不存在：${cmd.documentCode}`));
      if (!principal || principal.status !== 'active') {
        return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }
      if (!feature && !module && !document) {
        return fail(new DomainError('requirement_scope_required', '需求至少需要关联模块或来源文档；旧版 Feature-only 调用仍可兼容'));
      }

      const title = cmd.title.trim();
      const body = cmd.body.trim();
      const status = cmd.status ?? 'draft';
      const acceptanceCriteria = normalizeAcceptanceCriteria(cmd.acceptanceCriteria ?? []);
      const openQuestions = normalizeOpenQuestions(cmd.openQuestions ?? []);
      if (!title) return fail(new DomainError('requirement_title_required', '需求标题不能为空'));
      if (!body) return fail(new DomainError('requirement_body_required', '需求背景与目标不能为空'));
      if (status !== 'draft') {
        return fail(new DomainError('requirement_initial_status_invalid', '新需求必须从草稿开始，通过生命周期动作推进'));
      }

      const context = await resolveBindingContext(db, {
        feature: feature ?? null,
        module: module ?? null,
        document: document ?? null,
      });
      if (!context.project) {
        return fail(new DomainError('project_not_found', '需求缺少有效项目上下文'));
      }

      const member = await projectMember(db, context.project.id, principal.id);
      if (!member) {
        return fail(new DomainError('requirement_forbidden', '只有当前项目成员可以录入需求', {
          principal_code: principal.code,
        }));
      }
      await assertProjectAccess(db, context.project.id, principal.id, 'write');

      const boundProject = context.project;
      const created = await db.transaction(tx => writeRequirement(tx, {
        projectId: boundProject.id, projectCode: boundProject.code, principalId: principal.id,
      }, { moduleId: context.moduleId, featureId: feature?.id ?? null, documentId: document?.id ?? null,
        title, body, acceptanceCriteria, openQuestions }));

      const resolvedModule = created.requirement.module_id
        ? (module ?? (await modulesByIds(db, [created.requirement.module_id])).get(created.requirement.module_id))
        : undefined;
      return {
        ok: true,
        data: await toSummary(db, created.requirement, created.revision, {
          feature,
          module: resolvedModule,
          document,
          ownerCode: principal.code,
        }),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function getRequirement(requirementCode: string, principalCode = ''): Promise<TaskResult<RequirementDetail>> {
    try {
      const requirement = await findRequirementByCode(db, requirementCode);
      if (!requirement) return fail(new DomainError('requirement_not_found', `需求不存在：${requirementCode}`));

      const [{ feature, module, document, project }, currentRevision, revisions, tasks, principal] = await Promise.all([
        loadRequirementRelations(db, requirement),
        db.select().from(schema.requirementRevisions).where(and(
          eq(schema.requirementRevisions.requirement_id, requirement.id),
          eq(schema.requirementRevisions.revision, requirement.current_revision),
        )).limit(1).then((rows) => rows[0] ?? null),
        db.select().from(schema.requirementRevisions)
          .where(eq(schema.requirementRevisions.requirement_id, requirement.id))
          .orderBy(desc(schema.requirementRevisions.revision)),
        db.select().from(schema.tasks)
          .where(eq(schema.tasks.requirement_id, requirement.id))
          .orderBy(desc(schema.tasks.created_at), desc(schema.tasks.id)),
        principalCode ? findUserByCode(db, principalCode) : Promise.resolve(undefined),
      ]);
      if (!project) return fail(new DomainError('project_not_found', `需求缺少项目上下文：${requirementCode}`));

      const [member, ownerMap, assigneeMap] = await Promise.all([
        principal ? projectMember(db, project.id, principal.id) : Promise.resolve(undefined),
        usersByIds(db, [requirement.owner_principal_id]),
        usersByIds(
          db,
          [...new Set(tasks.map((task) => task.assignee_principal_id).filter((value): value is bigint => value !== null))],
        ),
      ]);

      if (!member) throw new DomainError('requirement_forbidden', '当前用户不能访问此需求');
      const summary = await toSummary(db, requirement, currentRevision, {
        feature,
        module,
        document,
        ownerCode: ownerMap.get(requirement.owner_principal_id)?.code ?? '',
      });

      return {
        ok: true,
        data: {
          ...summary,
          tasks: tasks.map((task) => ({
            task_code: task.code,
            title: task.title,
            status: task.status,
            profile: task.profile,
            assignee_principal_code: task.assignee_principal_id
              ? (assigneeMap.get(task.assignee_principal_id)?.code ?? null)
              : null,
          })),
          revisions: revisions.map(toRevision),
          can_edit: Boolean(member && isProjectManager(member.role) && project.status === 'active' && EDITABLE_STATUSES.has(requirement.state)),
          available_transitions: project.status === 'active' && isProjectManager(member?.role) ? [...REQUIREMENT_TRANSITIONS[requirement.state]] : [],
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function listRequirements(projectCode?: string, query?: string, principalCode = ''): Promise<RequirementSummary[]> {
    const project = projectCode ? await findProjectByCode(db, projectCode) : undefined;
    if (projectCode && !project) return [];
    const principal = await findUserByCode(db, principalCode);
    if (!principal || principal.status !== 'active') return [];
    const pattern = query?.trim().toLocaleLowerCase() || '';

    const rows = await db
      .select({
        requirement: schema.requirements,
        revision: schema.requirementRevisions,
        feature: schema.features,
        module: schema.projectModules,
        document: schema.requirementDocuments,
      })
      .from(schema.requirements)
      .leftJoin(schema.features, eq(schema.features.id, schema.requirements.feature_id))
      .leftJoin(schema.projectModules, eq(schema.projectModules.id, schema.requirements.module_id))
      .leftJoin(schema.requirementDocuments, eq(schema.requirementDocuments.id, schema.requirements.document_id))
      .leftJoin(
        schema.requirementRevisions,
        and(
          eq(schema.requirementRevisions.requirement_id, schema.requirements.id),
          eq(schema.requirementRevisions.revision, schema.requirements.current_revision),
        ),
      );

    const visible = new Set<bigint>();
    for (const id of new Set(rows.map(row => row.feature?.project_id ?? row.module?.project_id ?? row.document?.project_id).filter((id): id is bigint => id !== undefined))) {
      if (await effectiveProjectMember(db, id, principal.id)) visible.add(id);
    }
    const filtered = rows.filter((row) => {
      const projectId = row.feature?.project_id ?? row.module?.project_id ?? row.document?.project_id ?? null;
      if (projectId === null || !visible.has(projectId) || (project && projectId !== project.id)) return false;
      if (!pattern) return true;
      const haystack = [
        row.requirement.code,
        row.requirement.legacy_code,
        row.requirement.title,
        row.feature?.code,
        row.module?.code,
        row.module?.name,
        row.document?.code,
        row.document?.title,
        row.revision?.summary,
      ]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLocaleLowerCase());
      return haystack.some((value) => value.includes(pattern));
    });

    const requirementIds = filtered.map((row) => row.requirement.id);
    const ownerIds = [...new Set(filtered.map((row) => row.requirement.owner_principal_id))];
    const [linkedTasks, owners] = await Promise.all([
      requirementIds.length
        ? db.select({ requirement_id: schema.tasks.requirement_id }).from(schema.tasks)
          .where(inArray(schema.tasks.requirement_id, requirementIds))
        : Promise.resolve([]),
      usersByIds(db, ownerIds),
    ]);
    const taskCounts = new Map<bigint, number>();
    for (const task of linkedTasks) {
      if (task.requirement_id === null) continue;
      taskCounts.set(task.requirement_id, (taskCounts.get(task.requirement_id) ?? 0) + 1);
    }

    return Promise.all(filtered.map(async (row) => ({
      ...(await toSummary(db, row.requirement, row.revision, {
        feature: row.feature ?? undefined,
        module: row.module ?? undefined,
        document: row.document ?? undefined,
        ownerCode: owners.get(row.requirement.owner_principal_id)?.code ?? '',
      })),
      task_count: taskCounts.get(row.requirement.id) ?? 0,
    })));
  }

  async function updateRequirement(cmd: {
    requirementCode: string;
    title?: string;
    body?: string;
    acceptanceCriteria?: RequirementAcceptanceCriterion[];
    openQuestions?: string[];
    featureCode?: string | null;
    moduleCode?: string | null;
    documentCode?: string | null;
    principalCode: string;
  }): Promise<TaskResult<RequirementSummary>> {
    try {
      const [requirement, principal] = await Promise.all([
        findRequirementByCode(db, cmd.requirementCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!requirement) return fail(new DomainError('requirement_not_found', `需求不存在：${cmd.requirementCode}`));
      if (!principal || principal.status !== 'active') {
        return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }

      const [currentRevision, currentRelations] = await Promise.all([
        db.select().from(schema.requirementRevisions).where(and(
          eq(schema.requirementRevisions.requirement_id, requirement.id),
          eq(schema.requirementRevisions.revision, requirement.current_revision),
        )).limit(1).then((rows) => rows[0]),
        loadRequirementRelations(db, requirement),
      ]);
      if (!currentRevision) {
        return fail(new DomainError('requirement_revision_not_found', `需求当前版本不存在：${cmd.requirementCode}`, {
          revision: requirement.current_revision,
        }));
      }
      if (!currentRelations.project) {
        return fail(new DomainError('project_not_found', `需求缺少项目上下文：${cmd.requirementCode}`));
      }

      const member = await projectMember(db, currentRelations.project.id, principal.id);
      if (!member || !isProjectManager(member.role)) {
        return fail(new DomainError('requirement_forbidden', '只有项目负责人或管理员可以更新需求', {
          principal_code: principal.code,
        }));
      }
      await assertProjectAccess(db, currentRelations.project.id, principal.id, 'manage');

      const [feature, module, document] = await Promise.all([
        cmd.featureCode === undefined
          ? Promise.resolve(currentRelations.feature ?? null)
          : (cmd.featureCode ? findFeatureByCode(db, cmd.featureCode) : Promise.resolve(null)),
        cmd.moduleCode === undefined
          ? Promise.resolve(currentRelations.module ?? null)
          : (cmd.moduleCode ? findProjectModuleByCode(db, cmd.moduleCode) : Promise.resolve(null)),
        cmd.documentCode === undefined
          ? Promise.resolve(currentRelations.document ?? null)
          : (cmd.documentCode ? findRequirementDocumentByCode(db, cmd.documentCode) : Promise.resolve(null)),
      ]);
      if (cmd.featureCode && !feature) return fail(new DomainError('feature_not_found', `Feature 不存在：${cmd.featureCode}`));
      if (cmd.moduleCode && !module) return fail(new DomainError('module_not_found', `功能模块不存在：${cmd.moduleCode}`));
      if (cmd.documentCode && !document) return fail(new DomainError('requirement_document_not_found', `需求文档不存在：${cmd.documentCode}`));

      const nextTitle = cmd.title === undefined ? requirement.title : cmd.title.trim();
      const nextBody = cmd.body === undefined ? (currentRevision.summary ?? '') : cmd.body.trim();
      if (!nextTitle) return fail(new DomainError('requirement_title_required', '需求标题不能为空'));
      if (!nextBody) return fail(new DomainError('requirement_body_required', '需求背景与目标不能为空'));

      const nextAcceptanceCriteria = normalizeAcceptanceCriteria(
        cmd.acceptanceCriteria ?? parseAcceptanceCriteria(currentRevision.acceptance_criteria),
      );
      const nextOpenQuestions = normalizeOpenQuestions(
        cmd.openQuestions ?? parseOpenQuestions(currentRevision.open_questions),
      );
      const contentChanged = nextTitle !== requirement.title
        || nextBody !== (currentRevision.summary ?? '')
        || !jsonEqual(nextAcceptanceCriteria, parseAcceptanceCriteria(currentRevision.acceptance_criteria))
        || !jsonEqual(nextOpenQuestions, parseOpenQuestions(currentRevision.open_questions));
      if (contentChanged && !EDITABLE_STATUSES.has(requirement.state)) {
        return fail(new DomainError('requirement_revision_locked', '当前状态不可直接编辑；已确认或交付的需求请先发起变更提议', {
          status: requirement.state,
        }));
      }

      const context = await resolveBindingContext(db, {
        feature,
        module,
        document,
        fallbackModuleId: cmd.moduleCode !== undefined ? null : requirement.module_id,
      });
      if (!context.project || context.project.id !== currentRelations.project.id) {
        return fail(new DomainError('requirement_project_mismatch', '需求不能跨项目重新绑定'));
      }

      const nextFeatureId = feature?.id ?? null;
      const nextDocumentId = document?.id ?? null;
      const nextModuleId = context.moduleId;
      if (nextFeatureId === null && nextDocumentId === null && nextModuleId === null) {
        return fail(new DomainError('requirement_scope_required', '需求至少需要保留模块、Feature 或来源文档之一'));
      }

      const bindingChanged = nextFeatureId !== requirement.feature_id
        || nextModuleId !== requirement.module_id
        || nextDocumentId !== requirement.document_id;
      if (!contentChanged && !bindingChanged) {
        return {
          ok: true,
          data: await toSummary(db, requirement, currentRevision, {
            feature: feature ?? undefined,
            module: nextModuleId ? (module ?? currentRelations.module ?? undefined) : undefined,
            document: document ?? undefined,
            ownerCode: principal.code,
          }),
        };
      }

      const changedAt = now();
      const result = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, currentRelations.project!.id, principal.id, 'manage');
        let nextRevisionNumber = requirement.current_revision;
        if (contentChanged) {
          nextRevisionNumber += 1;
          await tx.insert(schema.requirementRevisions).values({
            code: createPublicCode(),
            requirement_id: requirement.id,
            revision: nextRevisionNumber,
            summary: nextBody,
            acceptance_criteria: JSON.stringify(nextAcceptanceCriteria),
            open_questions: JSON.stringify(nextOpenQuestions),
            created_at: changedAt,
          });
        }

        const [updatedRequirement] = await tx.update(schema.requirements).set({
          title: nextTitle,
          current_revision: nextRevisionNumber,
          feature_id: nextFeatureId,
          module_id: nextModuleId,
          document_id: nextDocumentId,
        }).where(eq(schema.requirements.id, requirement.id)).returning();
        if (!updatedRequirement) throw new DomainError('internal_error', '需求更新失败');

        const audit = {
          entity_type: 'requirement',
          entity_id: requirement.id,
          legacy_entity_code: requirement.legacy_code ?? undefined,
          principal_id: principal.id,
          base_snapshot: requirement.current_revision,
          action: contentChanged ? 'requirement.revised' : 'requirement.bound',
          payload: {
            title: nextTitle,
            revision: nextRevisionNumber,
            feature_code: feature?.code ?? null,
            module_code: module?.code ?? null,
            document_code: document?.code ?? null,
          },
        };
        assertAuditedChange(audit);
        await insertAudit(tx, toAuditEvent(audit, createPublicCode(), changedAt));
        return updatedRequirement;
      });

      const [revision] = await db.select().from(schema.requirementRevisions).where(and(
        eq(schema.requirementRevisions.requirement_id, requirement.id),
        eq(schema.requirementRevisions.revision, result.current_revision),
      )).limit(1);
      if (!revision) return fail(new DomainError('internal_error', '需求修订版本缺失'));

      const finalModule = nextModuleId
        ? (module ?? currentRelations.module ?? (await modulesByIds(db, [nextModuleId])).get(nextModuleId))
        : undefined;
      return {
        ok: true,
        data: await toSummary(db, result, revision, {
          feature: feature ?? undefined,
          module: finalModule,
          document: document ?? undefined,
          ownerCode: requirement.owner_principal_id === principal.id ? principal.code : undefined,
        }),
      };
    } catch (error) {
      return fail(error);
    }
  }

  async function transitionRequirement(cmd: {
    requirementCode: string;
    to: RequirementStatus;
    principalCode: string;
  }): Promise<TaskResult<RequirementSummary>> {
    try {
      if (!REQUIREMENT_STATUSES.includes(cmd.to)) {
        return fail(new DomainError('requirement_status_invalid', `非法需求状态：${cmd.to}`, { valid: REQUIREMENT_STATUSES }));
      }

      const [requirement, principal] = await Promise.all([
        findRequirementByCode(db, cmd.requirementCode),
        findUserByCode(db, cmd.principalCode),
      ]);
      if (!requirement) return fail(new DomainError('requirement_not_found', `需求不存在：${cmd.requirementCode}`));
      if (!principal || principal.status !== 'active') {
        return fail(new DomainError('user_not_found', `用户不存在：${cmd.principalCode}`));
      }
      if (!REQUIREMENT_TRANSITIONS[requirement.state].includes(cmd.to)) {
        return fail(new DomainError('requirement_transition_invalid', `需求不能从 ${requirement.state} 转为 ${cmd.to}`, {
          from: requirement.state,
          to: cmd.to,
          valid: REQUIREMENT_TRANSITIONS[requirement.state],
        }));
      }

      const [relations, revision] = await Promise.all([
        loadRequirementRelations(db, requirement),
        db.select().from(schema.requirementRevisions).where(and(
          eq(schema.requirementRevisions.requirement_id, requirement.id),
          eq(schema.requirementRevisions.revision, requirement.current_revision),
        )).limit(1).then((rows) => rows[0]),
      ]);
      if (!relations.project) return fail(new DomainError('project_not_found', `需求缺少项目上下文：${cmd.requirementCode}`));
      if (!revision) return fail(new DomainError('requirement_revision_not_found', `需求当前版本不存在：${cmd.requirementCode}`));

      const member = await projectMember(db, relations.project.id, principal.id);
      if (!member || !isProjectManager(member.role)) {
        return fail(new DomainError('requirement_forbidden', '只有项目负责人或管理员可以推进需求生命周期', {
          principal_code: principal.code,
        }));
      }
      await assertProjectAccess(db, relations.project.id, principal.id, 'manage');

      const acceptanceCriteria = parseAcceptanceCriteria(revision.acceptance_criteria);
      const openQuestions = parseOpenQuestions(revision.open_questions);
      const tasks = await db.select({ status: schema.tasks.status }).from(schema.tasks)
        .where(eq(schema.tasks.requirement_id, requirement.id));

      if (cmd.to === 'confirmed') {
        if (acceptanceCriteria.length === 0) {
          return fail(new DomainError('requirement_acceptance_required', '确认需求前至少需要一条可验证的验收标准'));
        }
        if (openQuestions.length > 0) {
          return fail(new DomainError('requirement_questions_unresolved', '确认需求前必须清空所有开放问题', {
            open_questions: openQuestions,
          }));
        }
      }
      if (cmd.to === 'implementing' && tasks.length === 0) {
        return fail(new DomainError('requirement_tasks_required', '进入实施前至少需要关联一个交付任务'));
      }
      if (cmd.to === 'delivered' && (tasks.length === 0 || tasks.some((task) => task.status !== 'closed'))) {
        return fail(new DomainError('requirement_tasks_incomplete', '标记已交付前，所有关联任务必须关闭'));
      }

      const changedAt = now();
      await db.update(schema.requirements).set({ state: cmd.to }).where(eq(schema.requirements.id, requirement.id));
      const audit = {
        entity_type: 'requirement',
        entity_id: requirement.id,
        legacy_entity_code: requirement.legacy_code ?? undefined,
        principal_id: principal.id,
        base_snapshot: requirement.current_revision,
        from: requirement.state,
        to: cmd.to,
        action: 'requirement.transitioned',
        payload: { revision: requirement.current_revision },
      };
      assertAuditedChange(audit);
      await insertAudit(db, toAuditEvent(audit, createPublicCode(), changedAt));

      return {
        ok: true,
        data: await toSummary(db, { ...requirement, state: cmd.to }, revision, {
          feature: relations.feature,
          module: relations.module,
          document: relations.document,
          ownerCode: requirement.owner_principal_id === principal.id ? principal.code : undefined,
        }),
      };
    } catch (error) {
      return fail(error);
    }
  }

  return { createRequirement, getRequirement, listRequirements, updateRequirement, transitionRequirement };
}

export type RequirementUseCases = ReturnType<typeof createRequirementUseCases>;
