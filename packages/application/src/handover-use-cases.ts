import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { ContextManifestSchema, HandoverSummarySchema, WorkspaceManifestSchema, type HandoverSummary, type WorkspaceManifest, type RequirementBaseline } from '@team-synergy/contracts';
import { loadRequirementBaseline } from './baseline-use-cases.js';
import { createPublicCode } from './public-code.js';
import { fail, now, parseAcceptance } from './task-service.js';
import { UNRESOLVED_HANDOVER_STATUSES } from './execution-guard.js';
import { issueRunLease } from './execution-use-cases.js';
import { designPrototypeContentMetadata, designPrototypeRevisionColumns } from './design-prototype-content.js';
import { collectProjectStandardsDocuments } from './project-standards.js';
import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { copyRunSkills, resolveRunSkillManifest } from './skills-run.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Task = typeof schema.tasks.$inferSelect;
type Handover = typeof schema.taskHandovers.$inferSelect;
type Snapshot = typeof schema.contextSnapshots.$inferSelect;
export interface HandoverIdentity { principalCode: string; deviceCode?: string; authKind?: string }
interface Command {
  identity: HandoverIdentity;
  idempotencyKey?: string;
  task_code?: string;
  handover_code?: string;
  snapshot_code?: string;
  context_snapshot_code?: string;
  run_code?: string;
  version?: number;
}
type Actor = Awaited<ReturnType<typeof actorFor>>;
type Access = Awaited<ReturnType<typeof accessTask>>;
type Versions = Record<string, string>;

export function canonicalContextJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalContextJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalContextJson(record[key])}`).join(',')}}`;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(canonicalContextJson(value));
const preparationToken = (credentialHash: string, code: string, epoch: number) => createHmac('sha256', credentialHash).update(`acp-handover-grant:v1:${code}:${epoch}`).digest('hex');
const parse = <T>(value: string): T => JSON.parse(value) as T;
const required = <T>(value: T | null | undefined, code: string, message: string): T => {
  if (value === null || value === undefined) throw new DomainError(code, message);
  return value;
};

async function actorFor(tx: Tx, identity: HandoverIdentity, mutation: boolean) {
  const [principal] = await tx.select().from(schema.users).where(eq(schema.users.code, identity.principalCode)).for('share').limit(1);
  if (!principal || principal.status !== 'active') throw new DomainError('handover_forbidden', '需要有效项目用户');
  const [device] = identity.deviceCode ? await tx.select().from(schema.devices).where(and(
    eq(schema.devices.code, identity.deviceCode), eq(schema.devices.principal_id, principal.id),
  )).for('share').limit(1) : [];
  if (identity.authKind !== 'bearer' || !device || device.revoked_at) throw new DomainError('handover_forbidden', mutation ? '交接操作需要当前用户的设备登录凭据' : '共享上下文读取需要当前用户的设备登录凭据');
  return { principal, device };
}

async function accessTask(tx: Tx, taskCode: string, actor: Actor, lock = false, mutation = false) {
  const query = tx.select().from(schema.tasks).where(eq(schema.tasks.code, taskCode));
  const [task] = lock ? await query.for('update').limit(1) : await query.limit(1);
  if (!task) throw new DomainError('task_not_found', '任务不存在');
  const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
  const [project] = feature ? await tx.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id)).for('share').limit(1) : [];
  const member = project ? await effectiveProjectMember(tx, project.id, actor.principal.id) : undefined;
  if (!project || !member) throw new DomainError('handover_forbidden', '当前用户没有此项目的访问权限');
  await assertProjectAccess(tx, project.id, actor.principal.id, mutation ? 'write' : 'read');
  return { task, feature: required(feature, 'feature_not_found', '功能不存在'), project, member };
}

function contractOf(task: Task) {
  return {
    task_code: task.code, title: task.title, brief: task.brief, profile: task.profile, source: task.source,
    acceptance: parseAcceptance(task.acceptance), scope: task.scope ? parse<unknown>(task.scope) : undefined,
    validation_seams: task.validation_seams ? parse<unknown>(task.validation_seams) : [],
    requirement_baseline_id: task.requirement_baseline_id?.toString() ?? null,
  };
}

// Shared locks on mutable heads serialize revision changes with activation.
// Immutable bodies are copied; a later read never follows a head to newer text.
async function compileContext(tx: Tx, access: Access) {
  const { task, project, feature } = access;
  const sources: Array<Record<string, unknown>> = [];
  const baselineConflicts: Array<{ source: string; pinned_revision: number; current_revision: number }> = [];
  const versions: Versions = { task: digest(contractOf(task)), project: digest({ name: project.name, description: project.description, status: project.status,
    overview_document_id: project.overview_document_id?.toString() ?? null,
    guide_document_id: project.guide_document_id?.toString() ?? null,
  }) };
  sources.push({ kind: 'project', code: project.code, name: project.name, description: project.description });
  let requirementBaseline: RequirementBaseline | null = null;
  if (task.requirement_baseline_id !== null) {
    const [row] = await tx.select().from(schema.requirementBaselines).where(and(
      eq(schema.requirementBaselines.id, task.requirement_baseline_id), eq(schema.requirementBaselines.project_id, project.id),
    )).limit(1);
    const loaded = row ? await loadRequirementBaseline(tx, project.id, row.code) : undefined;
    if (!loaded) throw new DomainError('context_source_missing', '任务绑定的需求基线不可用');
    requirementBaseline = loaded.baseline;
    versions[`requirement_baseline:${requirementBaseline.baseline_code}`] = requirementBaseline.content_hash;
    sources.push({ kind: 'requirement_baseline', code: requirementBaseline.baseline_code, title: requirementBaseline.name,
      revision: requirementBaseline.version, content: canonicalContextJson(requirementBaseline) });
    for (const item of requirementBaseline.requirements) {
      const [head] = await tx.select().from(schema.requirements).where(eq(schema.requirements.code, item.requirement_code)).for('share').limit(1);
      versions[`baseline_requirement:${item.requirement_code}`] = head ? digest({ revision: head.current_revision, state: head.state, title: head.title }) : 'missing';
      if (head?.current_revision !== item.revision) baselineConflicts.push({ source: `baseline_requirement:${item.requirement_code}`,
        pinned_revision: item.revision, current_revision: head?.current_revision ?? -1 });
    }
  }
  if (task.requirement_id) {
    const [head] = await tx.select().from(schema.requirements).where(eq(schema.requirements.id, task.requirement_id)).for('share').limit(1);
    if (!head) throw new DomainError('context_source_missing', '任务需求已不可用');
    const [revision] = await tx.select().from(schema.requirementRevisions).where(task.source_requirement_revision_id
      ? and(eq(schema.requirementRevisions.id, task.source_requirement_revision_id), eq(schema.requirementRevisions.requirement_id, head.id))
      : and(eq(schema.requirementRevisions.requirement_id, head.id), eq(schema.requirementRevisions.revision, head.current_revision))).limit(1);
    if (!revision) throw new DomainError('context_source_missing', '任务固定需求版本不存在');
    if (revision.revision !== head.current_revision) baselineConflicts.push({ source: `requirement:${head.code}`, pinned_revision: revision.revision, current_revision: head.current_revision });
    versions[`requirement:${head.code}`] = digest({ revision: head.current_revision, state: head.state, title: head.title });
    const frozen = requirementBaseline?.requirements.find(item => item.requirement_code === head.code);
    if (requirementBaseline && (!frozen || frozen.revision_code !== revision.code)) throw new DomainError('baseline_revision_mismatch', '任务需求修订与绑定基线不一致');
    sources.push({ kind: 'requirement', code: head.code, revision_code: revision.code, revision: revision.revision, title: frozen?.title ?? head.title,
      content: frozen?.body ?? revision.summary, acceptance: frozen?.acceptance_criteria ?? parse<unknown>(revision.acceptance_criteria),
      open_questions: frozen ? canonicalContextJson(frozen.open_questions) : revision.open_questions });
  }
  const [requiredRevision] = task.source_document_revision_id ? await tx.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, task.source_document_revision_id)).limit(1) : [];
  if (task.source_document_revision_id && !requiredRevision) throw new DomainError('context_source_missing', '任务固定需求文档版本不存在');
  const documents = await tx.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.project_id, project.id)).orderBy(asc(schema.requirementDocuments.id)).for('share');
  if (requiredRevision && !documents.some(document => document.id === requiredRevision.document_id && document.state === 'active')) throw new DomainError('context_source_missing', '任务必需需求文档已归档或不属于此项目');
  for (const document of documents) {
    versions[`requirement_document:${document.code}`] = `${document.current_revision}:${document.state}`;
    if (document.state !== 'active') continue;
    const pinned = requiredRevision?.document_id === document.id ? requiredRevision : undefined;
    if (pinned && pinned.revision !== document.current_revision) baselineConflicts.push({ source: `requirement_document:${document.code}`, pinned_revision: pinned.revision, current_revision: document.current_revision });
    const [latest] = pinned ? [] : await tx.select().from(schema.requirementDocumentRevisions).where(and(
      eq(schema.requirementDocumentRevisions.document_id, document.id), eq(schema.requirementDocumentRevisions.revision, document.current_revision),
    )).limit(1);
    const body = pinned ?? latest;
    if (!body) throw new DomainError('context_source_missing', '需求文档版本不可用');
    sources.push({ kind: 'requirement_document', code: document.code, revision_code: body.code, revision: body.revision, title: document.title, content: body.content });
  }
  const handoffFolders = await tx.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, project.id))
    .orderBy(asc(schema.projectDocumentFolders.id)).for('share');
  const handoffDocs = await tx.select().from(schema.projectDocuments).where(eq(schema.projectDocuments.project_id, project.id)).orderBy(asc(schema.projectDocuments.id)).for('share');
  const standards = collectProjectStandardsDocuments(project.id, handoffFolders, handoffDocs);
  const standardsIds = new Set(standards.map(document => document.id));
  // Only effective membership affects mandatory reading. Creating an empty
  // system folder or moving an empty branch must not invalidate a handover.
  versions.project_standards = digest(standards.map(document => document.code).sort());
  for (const document of handoffDocs) {
    versions[`project_document:${document.code}`] = digest({ revision: document.revision, status: document.status,
      folder_id: document.folder_id?.toString() ?? null });
    if (document.status === 'active') sources.push({ kind: 'project_document', code: document.code, revision: document.revision, title: document.title, content: document.content,
      home_roles: [project.overview_document_id === document.id ? 'overview' : null, project.guide_document_id === document.id ? 'guide' : null,
        standardsIds.has(document.id) ? 'standards' : null].filter((role): role is string => role !== null),
    });
  }
  const prototypes = await tx.select().from(schema.designPrototypes).where(eq(schema.designPrototypes.project_id, project.id)).orderBy(asc(schema.designPrototypes.id)).for('share');
  for (const prototype of prototypes) {
    versions[`prototype:${prototype.code}`] = `${prototype.current_revision}:${prototype.status}`;
    if (prototype.status === 'archived') continue;
    const [body] = await tx.select(designPrototypeRevisionColumns).from(schema.designPrototypeRevisions).where(and(eq(schema.designPrototypeRevisions.prototype_id, prototype.id), eq(schema.designPrototypeRevisions.revision, prototype.current_revision))).limit(1);
    if (body) sources.push({ kind: 'prototype', code: prototype.code, revision_code: body.code, revision: body.revision, title: prototype.title,
      html_content: body.html_content, content: body.notes_markdown, ...designPrototypeContentMetadata(prototype.code, body) });
  }
  const topics = await tx.select().from(schema.requirementTopics).where(eq(schema.requirementTopics.project_id, project.id)).orderBy(asc(schema.requirementTopics.id)).for('share');
  for (const topic of topics) {
    const decisions = await tx.select().from(schema.requirementTopicEntries).where(and(eq(schema.requirementTopicEntries.topic_id, topic.id), eq(schema.requirementTopicEntries.entry_type, 'decision'))).orderBy(asc(schema.requirementTopicEntries.id));
    versions[`topic:${topic.code}`] = digest({ status: topic.status, decisions: decisions.map(row => ({ code: row.code, content: row.content, rationale: row.rationale, withdrawn_at: row.withdrawn_at })) });
    for (const decision of decisions) if (!decision.withdrawn_at) sources.push({ kind: 'decision', code: decision.code, topic_code: topic.code, content: decision.content, rationale: decision.rationale, supersedes_code: decisions.find(row => row.id === decision.supersedes_entry_id)?.code ?? null });
  }
  const repositories = await tx.select().from(schema.projectRepositories).where(eq(schema.projectRepositories.project_id, project.id)).orderBy(asc(schema.projectRepositories.id)).for('share');
  for (const repository of repositories) versions[`repository:${repository.code}`] = digest({ remote: repository.remote_url, status: repository.status });
  const manifest = ContextManifestSchema.parse({ schema_version: 1, task_contract: { ...contractOf(task), feature_code: feature.code,
    ...(requirementBaseline ? { requirement_baseline_code: requirementBaseline.baseline_code } : {}) },
    project_code: project.code, sources, baseline_conflicts: baselineConflicts, requirement_baseline: requirementBaseline });
  if (Buffer.byteLength(canonicalContextJson(manifest), 'utf8') > 4 * 1024 * 1024) throw new DomainError('context_too_large', '上下文超过首版大小上限，请缩小项目材料范围');
  return { manifest, versions };
}

function changes(before: Versions, after: Versions) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(key => before[key] !== after[key]).map(key => ({ source: key, before: before[key] ?? null, after: after[key] ?? null }));
}

export function createHandoverUseCases(db: Db) {
  async function audit(tx: Tx, action: string, actor: Actor, access: Access, handover?: Handover, payload?: unknown) {
    await tx.insert(schema.auditEvents).values({ code: createPublicCode(), timestamp: now(), principal_id: actor.principal.id,
      run_id: handover?.source_run_id, action, entity_type: 'task', entity_id: access.task.id, base_snapshot: access.task.base_snapshot,
      payload: JSON.stringify({ handover_code: handover?.code, ...((payload ?? {}) as object) }) });
  }
  async function snapshot(tx: Tx, handover: Handover): Promise<Snapshot> {
    const [row] = handover.context_snapshot_id ? await tx.select().from(schema.contextSnapshots).where(eq(schema.contextSnapshots.id, handover.context_snapshot_id)).limit(1) : [];
    return required(row, 'context_not_ready', '交接上下文尚未准备好');
  }
  async function storeSnapshot(tx: Tx, access: Access, actor: Actor, sourceRunId: bigint, summary: HandoverSummary, workspace: WorkspaceManifest | null, frozen?: Snapshot) {
    const compiled = frozen ? { manifest: parse<Record<string, unknown>>(frozen.manifest), versions: parse<Versions>(frozen.material_versions) } : await compileContext(tx, access);
    const payload = { ...compiled.manifest, material_revision_vector: compiled.versions, summary, workspace_manifest: workspace };
    if (Buffer.byteLength(canonicalContextJson(payload), 'utf8') > 4 * 1024 * 1024) throw new DomainError('context_too_large', '上下文与交接材料超过首版大小上限');
    const [row] = await tx.insert(schema.contextSnapshots).values({ code: createPublicCode(), project_id: access.project.id,
      task_id: access.task.id, source_run_id: sourceRunId, created_by: actor.principal.id, manifest: canonicalContextJson(payload),
      summary: canonicalContextJson(summary), material_versions: canonicalContextJson(compiled.versions), content_hash: digest(payload), created_at: now() }).returning();
    return required(row, 'internal_error', '无法保存上下文快照');
  }
  async function checkDrift(tx: Tx, access: Access, handover: Handover) {
    const original = await snapshot(tx, handover);
    const approved = handover.drift_approval ? parse<{ versions: Versions }>(handover.drift_approval).versions : null;
    const baseline = parse<Versions>(original.material_versions);
    const current = (await compileContext(tx, access)).versions;
    const conflicts = parse<{ baseline_conflicts?: unknown[] }>(original.manifest).baseline_conflicts ?? [];
    if (baseline.task !== current.task || changes(approved ?? baseline, current).length || (!approved && conflicts.length)) throw new DomainError('context_source_changed', '交接来源已变化，请由 Owner 确认原基线或重新发布', { changes: changes(approved ?? baseline, current), baseline_conflicts: conflicts });
  }
  function owner(access: Access) { if (!isProjectManager(access.member.role)) throw new DomainError('handover_forbidden', '只有项目负责人或管理员可以发布或批准交接'); }
  function target(handover: Handover, actor: Actor) { if (handover.target_principal_id !== actor.principal.id) throw new DomainError('handover_forbidden', '只有目标成员可以接收和恢复此交接'); }
  function source(handover: Handover, actor: Actor, sourceRun: typeof schema.runs.$inferSelect) {
    if (sourceRun.principal_id !== actor.principal.id || handover.source_device_id !== actor.device?.id) throw new DomainError('handover_forbidden', '需要源执行者及其准备设备');
  }
  function grant(handover: Handover, token?: string) {
    const received = hash(token ?? '');
    if (!token || !timingSafeEqual(Buffer.from(received), Buffer.from(handover.preparation_grant_hash)) || Date.parse(handover.preparation_expires_at) <= Date.now()) throw new DomainError('handover_grant_invalid', '停止确认授权已失效，请重新准备');
  }
  function status(handover: Handover, allowed: Handover['status'][]) {
    if (!allowed.includes(handover.status)) throw new DomainError('handover_state_conflict', '交接状态不允许此操作', { status: handover.status });
  }
  async function receipt(tx: Tx, actor: Actor, command: Command, operation: string, body: unknown) {
    if (!command.idempotencyKey) return null;
    if (command.idempotencyKey.length > 128) throw new DomainError('invalid_request', '幂等键过长');
    const [row] = await tx.select().from(schema.commandReceipts).where(and(eq(schema.commandReceipts.principal_id, actor.principal.id), eq(schema.commandReceipts.operation, operation), eq(schema.commandReceipts.key, command.idempotencyKey))).limit(1);
    if (row && (row.request_hash !== digest(body) || row.device_id !== (actor.device?.id ?? null))) throw new DomainError('idempotency_conflict', '同一幂等键不能用于其他请求或设备');
    return row ? parse<Record<string, unknown>>(row.result) : null;
  }
  async function saveReceipt(tx: Tx, actor: Actor, command: Command, operation: string, body: unknown, result: object) {
    if (!command.idempotencyKey) return;
    await tx.insert(schema.commandReceipts).values({ code: createPublicCode(), principal_id: actor.principal.id, device_id: actor.device?.id,
      operation, key: command.idempotencyKey, request_hash: digest(body), result: canonicalContextJson(result), created_at: now() });
  }
  async function view(tx: Tx, access: Access, actor: Actor, handover: Handover) {
    const [run, targetUser, context] = await Promise.all([
      tx.select().from(schema.runs).where(eq(schema.runs.id, handover.source_run_id)).limit(1).then(rows => rows[0]),
      tx.select().from(schema.users).where(eq(schema.users.id, handover.target_principal_id)).limit(1).then(rows => rows[0]),
      snapshot(tx, handover),
    ]);
    if (!handover.published_by && run?.principal_id !== actor.principal.id && !isProjectManager(access.member.role)) throw new DomainError('handover_forbidden', '未发布交接仅源执行者和管理者可读');
    const [sourceUser, targetRun] = await Promise.all([
      run ? tx.select().from(schema.users).where(eq(schema.users.id, run.principal_id)).limit(1).then(rows => rows[0]) : undefined,
      handover.target_run_id ? tx.select().from(schema.runs).where(eq(schema.runs.id, handover.target_run_id)).limit(1).then(rows => rows[0]) : undefined,
    ]);
    const frozenBaseline = parse<{ requirement_baseline?: RequirementBaseline | null }>(context.manifest).requirement_baseline;
    const writable = access.project.status === 'active' && access.member.role !== 'viewer';
    return { handover_code: handover.code, task_code: access.task.code, status: handover.status, version: handover.version,
      requirement_baseline_code: frozenBaseline?.baseline_code ?? null, requirement_baseline_name: frozenBaseline?.name ?? null,
      requirement_baseline_version: frozenBaseline?.version ?? null,
      source_run_code: run?.code, source_user_code: sourceUser?.code, target_user_code: targetUser?.code,
      target_run_code: targetRun?.code ?? null, context_snapshot_code: context.code, context_snapshot_hash: context.content_hash,
      workspace_manifest: handover.workspace_manifest ? parse<WorkspaceManifest>(handover.workspace_manifest) : null,
      summary: parse<HandoverSummary>(context.summary), attempt_code: handover.attempt_code, source_epoch: handover.source_epoch,
      expires_at: handover.expires_at, last_error: handover.last_error, stop_ack: handover.stop_ack ? parse<unknown>(handover.stop_ack) : null,
      can_publish: writable && handover.status === 'preparing' && isProjectManager(access.member.role), can_accept: writable && handover.status === 'published' && handover.target_principal_id === actor.principal.id,
      can_approve_drift: writable && isProjectManager(access.member.role) && [...UNRESOLVED_HANDOVER_STATUSES].includes(handover.status as typeof UNRESOLVED_HANDOVER_STATUSES[number]),
      can_cancel: writable && [...UNRESOLVED_HANDOVER_STATUSES].includes(handover.status as typeof UNRESOLVED_HANDOVER_STATUSES[number]) && (isProjectManager(access.member.role) || run?.principal_id === actor.principal.id || handover.target_principal_id === actor.principal.id),
      drift_approval: handover.drift_approval ? parse<unknown>(handover.drift_approval) : null };
  }
  async function withHandover<T>(command: Command, mutation: boolean, action: (tx: Tx, actor: Actor, access: Access, handover: Handover) => Promise<T>, allowExpiredMutation = false, receiptOperation?: string) {
    try {
      const result = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
        const actor = await actorFor(tx, command.identity, mutation);
        const snapshotCode = command.snapshot_code ?? command.context_snapshot_code;
        const [lookup] = !command.handover_code && snapshotCode ? await tx.select().from(schema.contextSnapshots).where(eq(schema.contextSnapshots.code, snapshotCode)).limit(1) : [];
        const [initial] = await tx.select().from(schema.taskHandovers).where(command.handover_code
          ? eq(schema.taskHandovers.code, command.handover_code)
          : eq(schema.taskHandovers.context_snapshot_id, lookup?.id ?? -1n)).limit(1);
        if (!initial) throw new DomainError('handover_not_found', '交接不存在');
        const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, initial.task_id)).limit(1);
        const access = await accessTask(tx, required(task, 'task_not_found', '任务不存在').code, actor, true, mutation);
        const [current] = await tx.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.id, initial.id)).limit(1);
        let handover = required(current, 'handover_not_found', '交接不存在');
        const [replay] = command.idempotencyKey && receiptOperation ? await tx.select().from(schema.commandReceipts).where(and(
          eq(schema.commandReceipts.principal_id, actor.principal.id), eq(schema.commandReceipts.operation, receiptOperation), eq(schema.commandReceipts.key, command.idempotencyKey),
        )).limit(1) : [];
        if (!replay && command.version !== undefined && command.version !== handover.version) throw new DomainError('handover_version_conflict', '交接已变化，请刷新');
        if (mutation && ['published', 'accepted', 'restoring', 'ready'].includes(handover.status) && Date.parse(handover.expires_at) <= Date.now()) {
          if (handover.target_run_id) await tx.update(schema.runs).set({ status: 'cancelled', finished_at: now() }).where(and(eq(schema.runs.id, handover.target_run_id), eq(schema.runs.status, 'preparing')));
          handover = await update(tx, handover, { status: 'expired', preparation_expires_at: now() });
          await audit(tx, 'handover.expired', actor, access, handover);
          if (mutation && !allowExpiredMutation) return { expired: true as const };
        }
        return { expired: false as const, data: await action(tx, actor, access, handover) };
      });
      if (result.expired) return fail<T>(new DomainError('handover_expired', '交接已过期，源 Run 保持暂停，请明确恢复或重新准备'));
      return { ok: true as const, data: result.data };
    } catch (error) { return fail<T>(error); }
  }
  async function update(tx: Tx, handover: Handover, values: Partial<typeof schema.taskHandovers.$inferInsert>) {
    const [row] = await tx.update(schema.taskHandovers).set({ ...values, updated_at: now(), version: handover.version + 1 }).where(eq(schema.taskHandovers.id, handover.id)).returning();
    return required(row, 'handover_not_found', '交接不存在');
  }

  return {
    async prepare(command: Command & { task_code: string; source_run_code: string; target_user_code: string; base_snapshot: number }) {
      try {
        const data = await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
          const actor = await actorFor(tx, command.identity, true);
          const access = await accessTask(tx, command.task_code, actor, true, true);
          const requestBody = { task_code: command.task_code, source_run_code: command.source_run_code, target_user_code: command.target_user_code, base_snapshot: command.base_snapshot };
          const previous = await receipt(tx, actor, command, 'handover.prepare', requestBody);
          if (previous) {
            const [existing] = await tx.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.code, String(previous.handover_code))).limit(1);
            const handover = required(existing, 'handover_not_found', '交接不存在');
            status(handover, ['preparing']);
            const token = preparationToken(required(actor.device, 'handover_forbidden', '缺少设备').credential_hash, handover.code, handover.source_epoch);
            await tx.update(schema.taskHandovers).set({ preparation_grant_hash: hash(token), preparation_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }).where(eq(schema.taskHandovers.id, handover.id));
            return { ...await view(tx, access, actor, handover), preparation_grant: token };
          }
          if (access.task.base_snapshot !== command.base_snapshot) throw new DomainError('base_snapshot_mismatch', '任务已变化，请刷新');
          if (!['running', 'self_tested'].includes(access.task.status) || access.task.profile !== 'builder') throw new DomainError('handover_task_state', '首版只支持正在执行的 builder 任务');
          const [sourceRun] = await tx.select().from(schema.runs).where(and(eq(schema.runs.code, command.source_run_code), eq(schema.runs.task_id, access.task.id))).limit(1);
          if (!sourceRun || sourceRun.status !== 'active' || sourceRun.profile !== 'builder' || sourceRun.principal_id !== actor.principal.id || access.task.assignee_principal_id !== actor.principal.id) throw new DomainError('handover_forbidden', '只有当前任务执行者可以准备交接');
          const [targetUser] = await tx.select().from(schema.users).where(eq(schema.users.code, command.target_user_code)).for('share').limit(1);
          const targetMember = targetUser ? await effectiveProjectMember(tx, access.project.id, targetUser.id) : undefined;
          if (!targetUser || targetUser.status !== 'active' || !targetMember || targetMember.role === 'viewer' || targetUser.id === actor.principal.id) throw new DomainError('handover_target_invalid', '目标必须是另一位具有协作权限的项目成员');
          const [pending] = await tx.select().from(schema.taskHandovers).where(and(eq(schema.taskHandovers.task_id, access.task.id), inArray(schema.taskHandovers.status, [...UNRESOLVED_HANDOVER_STATUSES]))).limit(1);
          if (pending) throw new DomainError('task_handover_pending', '已有未完成交接');
          const epoch = access.task.execution_epoch + 1;
          await tx.update(schema.tasks).set({ execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 }).where(eq(schema.tasks.id, access.task.id));
          await tx.update(schema.runs).set({ status: 'suspended' }).where(eq(schema.runs.id, sourceRun.id));
          await tx.update(schema.runLeases).set({ revoked_at: now() }).where(and(eq(schema.runLeases.run_id, sourceRun.id), isNull(schema.runLeases.revoked_at)));
          const context = await storeSnapshot(tx, access, actor, sourceRun.id, HandoverSummarySchema.parse({ goal: access.task.brief || access.task.title }), null);
          const handoverCode = createPublicCode();
          const token = preparationToken(required(actor.device, 'handover_forbidden', '缺少设备').credential_hash, handoverCode, epoch);
          const [handover] = await tx.insert(schema.taskHandovers).values({ code: handoverCode, task_id: access.task.id, source_run_id: sourceRun.id,
            target_principal_id: targetUser.id, source_device_id: required(actor.device, 'handover_forbidden', '缺少设备').id,
            context_snapshot_id: context.id, source_epoch: epoch, preparation_grant_hash: hash(token), preparation_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), created_at: now(), updated_at: now() }).returning();
          const stored = required(handover, 'internal_error', '无法创建交接');
          await audit(tx, 'handover.prepared', actor, access, stored);
          await saveReceipt(tx, actor, command, 'handover.prepare', requestBody, { handover_code: stored.code });
          return { ...await view(tx, access, actor, stored), preparation_grant: token };
        });
        return { ok: true as const, data };
      } catch (error) { return fail(error); }
    },
    draft: (command: Command & { summary: unknown; workspace_manifest: unknown; preparation_grant: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      status(handover, ['preparing']);
      const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, handover.source_run_id)).limit(1);
      source(handover, actor, required(run, 'run_not_found', '源 Run 不存在')); grant(handover, command.preparation_grant);
      const summary = HandoverSummarySchema.parse(command.summary);
      const workspace = WorkspaceManifestSchema.parse(command.workspace_manifest);
      const [repository] = await tx.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.code, workspace.repository_code), eq(schema.projectRepositories.project_id, access.project.id))).for('share').limit(1);
      if (!repository || repository.status !== 'active' || repository.remote_url.replace(/\.git$/, '').replace(/\/$/, '') !== workspace.remote_url.replace(/\.git$/, '').replace(/\/$/, '')) throw new DomainError('handover_repository_mismatch', '快照必须属于项目登记的有效代码仓库');
      const context = await storeSnapshot(tx, access, actor, handover.source_run_id, summary, workspace, await snapshot(tx, handover));
      const changed = await update(tx, handover, { context_snapshot_id: context.id, workspace_manifest: canonicalContextJson(workspace), drift_approval: null });
      await audit(tx, 'handover.draft_updated', actor, access, changed);
      return view(tx, access, actor, changed);
    }),
    ackStop: (command: Command & { preparation_grant: string; stopped: boolean; assurance?: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      status(handover, ['preparing']);
      const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, handover.source_run_id)).limit(1);
      source(handover, actor, required(run, 'run_not_found', '源 Run 不存在')); grant(handover, command.preparation_grant);
      if (!command.stopped || !['manual_confirmation', 'managed_process', 'client_reported', 'supervised'].includes(command.assurance ?? '')) throw new DomainError('handover_stop_required', '需要明确的停止确认');
      await tx.update(schema.agentSessions).set({ status: 'cancelled', finished_at: now(), last_error: '源执行者确认交接停止' }).where(and(eq(schema.agentSessions.run_id, handover.source_run_id), inArray(schema.agentSessions.status, ['starting', 'running'])));
      const changed = await update(tx, handover, { stop_ack: canonicalContextJson({ stopped: true, assurance: command.assurance, actor_code: actor.principal.code, device_code: actor.device?.code, epoch: handover.source_epoch, at: now() }) });
      await audit(tx, 'handover.source_stopped', actor, access, changed);
      return view(tx, access, actor, changed);
    }),
    publish: (command: Command) => withHandover(command, true, async (tx, actor, access, handover) => {
      owner(access); status(handover, ['preparing']);
      if (!handover.stop_ack || !handover.workspace_manifest) throw new DomainError('handover_not_ready', '需要源停止确认和可获取的代码快照');
      await checkDrift(tx, access, handover);
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, handover.target_principal_id)).limit(1);
      const member = await effectiveProjectMember(tx, access.project.id, handover.target_principal_id);
      if (!member || member.role === 'viewer' || user?.status !== 'active') throw new DomainError('handover_target_invalid', '目标成员协作权限已失效');
      const changed = await update(tx, handover, { status: 'published', published_by: actor.principal.id });
      await audit(tx, 'handover.published', actor, access, changed);
      return view(tx, access, actor, changed);
    }),
    accept: (command: Command) => withHandover(command, true, async (tx, actor, access, handover) => {
      target(handover, actor); status(handover, ['published', 'accepted']);
      const changed = handover.status === 'accepted' ? handover : await update(tx, handover, { status: 'accepted' });
      await audit(tx, 'handover.accepted', actor, access, changed);
      return view(tx, access, actor, changed);
    }),
    restore: (command: Command & { workspace_path?: string; git_base?: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      target(handover, actor);
      const workspace = parse<WorkspaceManifest>(required(handover.workspace_manifest, 'handover_not_ready', '代码快照不存在'));
      const requestBody = { handover_code: handover.code, workspace_path: command.workspace_path, git_base: command.git_base };
      const previous = await receipt(tx, actor, command, 'handover.restore', requestBody);
      if (previous) return previous;
      status(handover, ['accepted', 'restoring', 'ready']);
      if (handover.target_device_id && handover.target_device_id !== actor.device?.id) throw new DomainError('handover_device_conflict', '恢复尝试已绑定另一台设备');
      if (handover.target_run_id) throw new DomainError('handover_state_conflict', '已有恢复尝试，请用原幂等键继续');
      if (!command.workspace_path?.trim() || command.git_base !== workspace.snapshot_commit) throw new DomainError('handover_restore_invalid', '需要独立目标目录和准确快照 Commit');
      await checkDrift(tx, access, handover);
      const [sourceWorkspace] = await tx.select().from(schema.workspaces).innerJoin(schema.runs, eq(schema.runs.workspace_id, schema.workspaces.id)).where(eq(schema.runs.id, handover.source_run_id)).limit(1);
      if (sourceWorkspace?.workspaces.path === command.workspace_path) throw new DomainError('handover_restore_invalid', '目标必须使用独立工作区');
      const [workspaceRow] = await tx.insert(schema.workspaces).values({ code: createPublicCode(), run_id: -handover.id, path: command.workspace_path, git_base: workspace.snapshot_commit, created_at: now() }).returning();
      const [run] = await tx.insert(schema.runs).values({ code: createPublicCode(), task_id: access.task.id, principal_id: actor.principal.id, profile: 'builder', workspace_id: required(workspaceRow, 'internal_error', '无法创建工作区').id,
        status: 'preparing', continued_from_run_id: handover.source_run_id, handover_id: handover.id, context_snapshot_id: handover.context_snapshot_id, execution_epoch: access.task.execution_epoch, base_snapshot: access.task.base_snapshot, started_at: now() }).returning();
      const targetRun = required(run, 'internal_error', '无法创建目标 Run');
      await copyRunSkills(tx, { sourceRunId: handover.source_run_id, targetRunId: targetRun.id, projectId: access.project.id, principalId: actor.principal.id });
      await tx.update(schema.workspaces).set({ run_id: targetRun.id }).where(eq(schema.workspaces.id, targetRun.workspace_id));
      const attempt = createPublicCode();
      const changed = await update(tx, handover, { status: 'restoring', target_run_id: targetRun.id, target_device_id: actor.device?.id, attempt_code: attempt });
      const result = { ...await view(tx, access, actor, changed), attempt_code: attempt, target_run_code: targetRun.code, workspace_code: workspaceRow?.code };
      await saveReceipt(tx, actor, command, 'handover.restore', requestBody, result);
      await audit(tx, 'handover.restoring', actor, access, changed);
      return result;
    }, false, 'handover.restore'),
    ready: (command: Command & { attempt_code: string; workspace_digest: string; snapshot_commit: string; context_snapshot_hash: string; assurance: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      target(handover, actor); status(handover, ['restoring', 'ready']);
      await resolveRunSkillManifest(tx, { runId: required(handover.target_run_id, 'run_not_found', '目标 Run 不存在'), principalId: actor.principal.id });
      const context = await snapshot(tx, handover);
      const workspace = parse<WorkspaceManifest>(required(handover.workspace_manifest, 'handover_not_ready', '代码快照不存在'));
      if (handover.target_device_id !== actor.device?.id || handover.attempt_code !== command.attempt_code || context.content_hash !== command.context_snapshot_hash || workspace.snapshot_commit !== command.snapshot_commit || !/^[a-f0-9]{64}$/.test(command.workspace_digest) || command.assurance !== 'client_reported') throw new DomainError('handover_receipt_invalid', '恢复回执与设备、尝试或快照不匹配');
      await checkDrift(tx, access, handover);
      const changed = await update(tx, handover, { status: 'ready', ready_receipt: canonicalContextJson({ attempt_code: command.attempt_code, workspace_digest: command.workspace_digest, snapshot_commit: command.snapshot_commit, context_snapshot_hash: command.context_snapshot_hash, assurance: 'client_reported', at: now() }) });
      await audit(tx, 'handover.ready', actor, access, changed);
      return view(tx, access, actor, changed);
    }),
    activate: (command: Command & { attempt_code: string; context_snapshot_hash: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      target(handover, actor);
      const requestBody = { handover_code: handover.code, attempt_code: command.attempt_code, context_snapshot_hash: command.context_snapshot_hash };
      const previous = await receipt(tx, actor, command, 'handover.activate', requestBody);
      if (handover.status === 'completed') {
        if (!previous || handover.target_device_id !== actor.device?.id) throw new DomainError('handover_state_conflict', '交接已经完成');
        const lease = await issueRunLease(tx, { runId: required(handover.target_run_id, 'run_not_found', '目标 Run 不存在'), principalId: actor.principal.id, deviceId: required(actor.device, 'handover_forbidden', '缺少设备').id, epoch: access.task.execution_epoch });
        return { ...previous, lease };
      }
      status(handover, ['ready']);
      const context = await snapshot(tx, handover);
      if (!handover.ready_receipt || handover.target_device_id !== actor.device?.id || handover.attempt_code !== command.attempt_code || context.content_hash !== command.context_snapshot_hash) throw new DomainError('handover_receipt_invalid', '当前设备尚未恢复准确上下文');
      await checkDrift(tx, access, handover);
      const [sourceRun, targetRun] = await Promise.all([
        tx.select().from(schema.runs).where(eq(schema.runs.id, handover.source_run_id)).limit(1).then(rows => rows[0]),
        tx.select().from(schema.runs).where(eq(schema.runs.id, required(handover.target_run_id, 'run_not_found', '目标 Run 不存在'))).limit(1).then(rows => rows[0]),
      ]);
      if (sourceRun?.status !== 'suspended' || targetRun?.status !== 'preparing') throw new DomainError('handover_state_conflict', '源或目标执行状态已变化');
      await resolveRunSkillManifest(tx, { runId: targetRun.id, principalId: actor.principal.id });
      const epoch = access.task.execution_epoch + 1;
      await tx.update(schema.runs).set({ status: 'transferred', finished_at: now() }).where(eq(schema.runs.id, sourceRun.id));
      await tx.update(schema.runs).set({ status: 'active', execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 }).where(eq(schema.runs.id, targetRun.id));
      await tx.update(schema.tasks).set({ status: 'running', assignee_principal_id: actor.principal.id, execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 }).where(eq(schema.tasks.id, access.task.id));
      const changed = await update(tx, handover, { status: 'completed' });
      const lease = await issueRunLease(tx, { runId: targetRun.id, principalId: actor.principal.id, deviceId: required(actor.device, 'handover_forbidden', '缺少设备').id, epoch });
      const [targetWorkspace] = await tx.select().from(schema.workspaces).where(eq(schema.workspaces.id, targetRun.workspace_id)).limit(1);
      const result = { handover_code: handover.code, task_code: access.task.code, run_code: targetRun.code, workspace_code: targetWorkspace?.code, execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 };
      await saveReceipt(tx, actor, command, 'handover.activate', requestBody, result);
      await audit(tx, 'handover.activated', actor, access, changed, { target_run_code: targetRun.code, source_run_code: sourceRun.code });
      return { ...result, lease };
    }, false, 'handover.activate'),
    cancel: (command: Command) => withHandover(command, true, async (tx, actor, access, handover) => {
      const [sourceRun] = await tx.select().from(schema.runs).where(eq(schema.runs.id, handover.source_run_id)).limit(1);
      if (!isProjectManager(access.member.role) && sourceRun?.principal_id !== actor.principal.id && handover.target_principal_id !== actor.principal.id) throw new DomainError('handover_forbidden', '无权取消此交接');
      status(handover, [...UNRESOLVED_HANDOVER_STATUSES, 'cancelled', 'expired']);
      if (['cancelled', 'expired'].includes(handover.status)) return view(tx, access, actor, handover);
      if (handover.target_run_id) await tx.update(schema.runs).set({ status: 'cancelled', finished_at: now() }).where(and(eq(schema.runs.id, handover.target_run_id), eq(schema.runs.status, 'preparing')));
      const changed = await update(tx, handover, { status: Date.parse(handover.expires_at) <= Date.now() ? 'expired' : 'cancelled', preparation_expires_at: now() });
      await audit(tx, 'handover.cancelled', actor, access, changed);
      return view(tx, access, actor, changed);
    }, true),
    approveDrift: (command: Command & { reason: string }) => withHandover(command, true, async (tx, actor, access, handover) => {
      owner(access); status(handover, [...UNRESOLVED_HANDOVER_STATUSES]);
      if (!command.reason?.trim() || command.reason.length > 4000) throw new DomainError('invalid_request', '需要继续旧基线的明确理由');
      const baseline = parse<Versions>((await snapshot(tx, handover)).material_versions);
      const current = (await compileContext(tx, access)).versions;
      if (baseline.task !== current.task) throw new DomainError('context_contract_changed', '任务合同变化不能通过继续旧基线豁免');
      const changed = await update(tx, handover, { drift_approval: canonicalContextJson({ versions: current, reason: command.reason, actor_code: actor.principal.code, at: now() }), ready_receipt: null, status: handover.status === 'ready' ? 'restoring' : handover.status });
      await audit(tx, 'handover.drift_approved', actor, access, changed, { reason: command.reason, changes: changes(baseline, current) });
      return view(tx, access, actor, changed);
    }),
    get: (command: Command) => withHandover(command, false, (tx, actor, access, handover) => view(tx, access, actor, handover)),
    async list(command: Command & { task_code: string }) {
      try { const data = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
        const actor = await actorFor(tx, command.identity, false); const access = await accessTask(tx, command.task_code, actor);
        const rows = await tx.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.task_id, access.task.id)).orderBy(asc(schema.taskHandovers.id));
        const result = [];
        for (const row of rows) {
          const [sourceRun] = await tx.select().from(schema.runs).where(eq(schema.runs.id, row.source_run_id)).limit(1);
          if (row.published_by || isProjectManager(access.member.role) || sourceRun?.principal_id === actor.principal.id) result.push(await view(tx, access, actor, row));
        }
        return result;
      }); return { ok: true as const, data }; } catch (error) { return fail(error); }
    },
    async listProject(command: { project_code: string; identity: HandoverIdentity }) {
      try { const data = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
        const actor = await actorFor(tx, command.identity, false);
        const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.code, command.project_code)).for('share').limit(1);
        const member = project ? await effectiveProjectMember(tx, project.id, actor.principal.id) : undefined;
        if (!project || !member) throw new DomainError('handover_forbidden', '当前用户没有此项目的访问权限');
        const rows = await tx.select({ handover: schema.taskHandovers, task: schema.tasks, feature: schema.features, run: schema.runs })
          .from(schema.taskHandovers)
          .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskHandovers.task_id))
          .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id))
          .innerJoin(schema.runs, eq(schema.runs.id, schema.taskHandovers.source_run_id))
          .where(eq(schema.features.project_id, project.id))
          .orderBy(desc(schema.taskHandovers.updated_at), desc(schema.taskHandovers.id));
        const visible = rows.filter(({ handover, run }) => handover.published_by || isProjectManager(member.role) || run.principal_id === actor.principal.id);
        const userIds = [...new Set(visible.flatMap(({ handover, run }) => [run.principal_id, handover.target_principal_id]))];
        const users = userIds.length ? await tx.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
        const names = new Map(users.map(user => [user.id, user.display_name]));
        const result = [];
        // Reads never mutate execution state; commands perform lazy expiry.
        for (const { handover, task, feature, run } of visible) result.push({
          ...await view(tx, { task, feature, project, member }, actor, handover),
          task_title: task.title, task_status: task.status,
          source_user_name: names.get(run.principal_id) ?? null,
          target_user_name: names.get(handover.target_principal_id) ?? null,
          created_at: handover.created_at, updated_at: handover.updated_at,
        });
        return result;
      }); return { ok: true as const, data }; } catch (error) { return fail(error); }
    },
    async getContext(command: Command) {
      try { const data = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(1094930512)`);
        const actor = await actorFor(tx, command.identity, false);
        const [context] = await tx.select().from(schema.contextSnapshots).where(eq(schema.contextSnapshots.code, command.snapshot_code ?? command.context_snapshot_code ?? '')).limit(1);
        const row = required(context, 'context_not_found', '上下文快照不存在');
        const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, row.task_id)).limit(1);
        const access = await accessTask(tx, required(task, 'task_not_found', '任务不存在').code, actor);
        const [sourceRun] = await tx.select().from(schema.runs).where(eq(schema.runs.id, row.source_run_id)).limit(1);
        const [published] = await tx.select().from(schema.taskHandovers).where(and(eq(schema.taskHandovers.context_snapshot_id, row.id), isNull(schema.taskHandovers.published_by))).limit(1);
        const [linked] = await tx.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.context_snapshot_id, row.id)).limit(1);
        if ((!linked || published) && !isProjectManager(access.member.role) && sourceRun?.principal_id !== actor.principal.id) throw new DomainError('handover_forbidden', '快照尚未发布');
        const manifest = parse<Record<string, unknown>>(row.manifest);
        if (digest(manifest) !== row.content_hash) throw new DomainError('context_hash_mismatch', '上下文快照完整性校验失败');
        return { context_snapshot_code: row.code, content_hash: row.content_hash, context_snapshot_hash: row.content_hash, manifest, summary: parse<HandoverSummary>(row.summary), material_revision_vector: parse<Versions>(row.material_versions), created_at: row.created_at };
      }); return { ok: true as const, data }; } catch (error) { return fail(error); }
    },
    diffContext: (command: Command) => withHandover(command, false, async (tx, actor, access, handover) => {
      await view(tx, access, actor, handover);
      const original = await snapshot(tx, handover);
      const current = (await compileContext(tx, access)).versions;
      const drift = changes(parse<Versions>(original.material_versions), current);
      const conflicts = parse<{ baseline_conflicts?: unknown[] }>(original.manifest).baseline_conflicts ?? [];
      return { context_snapshot_code: original.code, changes: drift, baseline_conflicts: conflicts, source_changed: drift.length > 0 || conflicts.length > 0, drift_approved: handover.drift_approval !== null };
    }),
    async resume(command: Command & { run_code: string }) {
      try { const data = await db.transaction(async tx => {
        const actor = await actorFor(tx, command.identity, true);
        const [initial] = await tx.select().from(schema.runs).where(eq(schema.runs.code, command.run_code)).limit(1);
        const run = required(initial, 'run_not_found', 'Run 不存在');
        const [taskRow] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, run.task_id)).limit(1);
        const access = await accessTask(tx, required(taskRow, 'task_not_found', '任务不存在').code, actor, true, true);
        const [current] = await tx.select().from(schema.runs).where(eq(schema.runs.id, run.id)).limit(1);
        if (current?.principal_id !== actor.principal.id || access.task.assignee_principal_id !== actor.principal.id) throw new DomainError('handover_forbidden', '只有源执行者可以恢复暂停 Run');
        const previous = await receipt(tx, actor, command, 'run.resume', { run_code: run.code });
        await resolveRunSkillManifest(tx, { runId: run.id, principalId: actor.principal.id });
        if (previous && current.status === 'active') return { ...previous, lease: await issueRunLease(tx, { runId: run.id, principalId: actor.principal.id, deviceId: required(actor.device, 'handover_forbidden', '缺少设备').id, epoch: access.task.execution_epoch }) };
        if (current.status !== 'suspended') throw new DomainError('run_inactive', '只有暂停且未转交的 Run 可以恢复');
        const [pending] = await tx.select().from(schema.taskHandovers).where(and(eq(schema.taskHandovers.task_id, run.task_id), inArray(schema.taskHandovers.status, [...UNRESOLVED_HANDOVER_STATUSES]))).limit(1);
        if (pending) throw new DomainError('task_handover_pending', '请先取消交接');
        const epoch = access.task.execution_epoch + 1;
        await tx.update(schema.tasks).set({ execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 }).where(eq(schema.tasks.id, access.task.id));
        await tx.update(schema.runs).set({ status: 'active', execution_epoch: epoch }).where(eq(schema.runs.id, run.id));
        const lease = await issueRunLease(tx, { runId: run.id, principalId: actor.principal.id, deviceId: required(actor.device, 'handover_forbidden', '缺少设备').id, epoch });
        const result = { run_code: run.code, execution_epoch: epoch, base_snapshot: access.task.base_snapshot + 1 };
        await saveReceipt(tx, actor, command, 'run.resume', { run_code: run.code }, result);
        await audit(tx, 'run.resumed', actor, access);
        return { ...result, lease };
      }); return { ok: true as const, data }; } catch (error) { return fail(error); }
    },
  };
}
