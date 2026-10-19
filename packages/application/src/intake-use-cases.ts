import { and, asc, desc, eq } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { IntakeBundleSchema, IntakeReviewSchema, IntakeApplySchema, INTAKE_MAX_BYTES, INTAKE_SKILL_VERSION, intakeManifestText,
  type IntakeBundle, type IntakeItem, type IntakeKind, type IntakeDecision, type IntakeReviewInput, type IntakeApplyInput,
  type IntakeContext, type IntakeList, type IntakeBatchSummary, type IntakeBatchDetail } from '@team-synergy/contracts';
import { assertProjectAccess, isProjectManager, type AccessDb } from './project-access.js';
import { createPublicCode } from './public-code.js';
import { fail, now, type TaskResult } from './task-service.js';
import { ensureProjectSystemFolders, tryLockProjectSystemFolders } from './project-document-folders.js';
import { intakeHash, intakeTargets, lockIntakeTarget, type TargetRecord } from './intake-targets.js';
import { intakeAudit, writeProjectModule, writeFeature, writeRequirementDocument, writeRequirement, writeArchitecture } from './intake-entity-writers.js';
import { architectureText, normalizeArchitectureContent } from './architecture-document-content.js';

type Command = { principalCode: string; projectCode: string };
type BatchCommand = Command & { code: string };
type Batch = typeof schema.intakeBatches.$inferSelect;
type ItemRow = typeof schema.intakeItems.$inferSelect;
type Access = Awaited<ReturnType<typeof accessProject>>;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
const completed = (row: ItemRow) => row.status === 'applied' || row.status === 'bound';
const itemOf = (row: ItemRow): IntakeItem => JSON.parse(row.item_json);
const decisionOf = (row: ItemRow): IntakeDecision | null => row.decision_json ? JSON.parse(row.decision_json) : null;
const dependencies = (item: IntakeItem) => [item.module_key, item.feature_key, item.document_key].filter((key): key is string => Boolean(key));
const kindOrder: Record<IntakeKind, number> = { module: 0, feature: 1, requirement_document: 2, architecture: 3, requirement: 4 };
const conflict = (message: string) => new DomainError('intake_conflict', message);
const invalid = (message: string) => new DomainError('intake_invalid', message);
function present<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw conflict('候选关联不完整，请重新审阅'); return value; }
class IntakeMaterialBusy extends Error {}
function retryableTransactionError(error: unknown): boolean {
  if (error instanceof IntakeMaterialBusy) return true;
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const record = current as { code?: string; cause?: unknown };
    if (record.code === '40P01' || record.code === '40001') return true;
    current = record.cause;
  }
  return false;
}
function requestKey(key: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key)) throw invalid('请求幂等键不合法'); }
function parseBundle(raw: unknown): IntakeBundle {
  let json: string;
  try { json = JSON.stringify(raw); } catch { throw invalid('候选包必须为 JSON'); }
  if (!json || Buffer.byteLength(json, 'utf8') > INTAKE_MAX_BYTES) throw invalid('候选包不能超过 10 MiB');
  const result = IntakeBundleSchema.safeParse(raw);
  if (!result.success) throw invalid(result.error.issues.map(issue => issue.message).slice(0, 12).join('; '));
  if (intakeHash(intakeManifestText(result.data.source.files)) !== result.data.source.manifest_sha256) throw invalid('代码文件清单摘要不匹配');
  for (const item of result.data.items) if (item.kind === 'architecture') {
    architectureText(item.title, '标题', 512, true);
    architectureText(item.summary, '摘要', 4096);
    normalizeArchitectureContent({ contentKind: 'mermaid', sourceContent: item.diagram_source, notesMarkdown: item.content_markdown });
  }
  return result.data;
}

async function accessProject(db: AccessDb, cmd: Command, mutation: false | 'write' | 'manage' = false, lock = false) {
  const userQuery = db.select().from(schema.users).where(eq(schema.users.code, cmd.principalCode));
  const [principal] = await (lock ? userQuery.for('update') : userQuery).limit(1);
  const [initialProject] = await db.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
  if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || !initialProject) throw new DomainError('project_forbidden', '当前项目权限不足');
  if (lock) await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, initialProject.team_id)).for('update');
  const projectQuery = db.select().from(schema.projects).where(eq(schema.projects.id, initialProject.id));
  const [project] = await (lock ? projectQuery.for('update') : projectQuery).limit(1);
  if (!project) throw new DomainError('project_forbidden', '当前项目权限不足');
  const role = await assertProjectAccess(db, project.id, principal.id, mutation || 'read');
  if (role.role === 'viewer') throw new DomainError('intake_forbidden', '观看者不能访问代码规格候选');
  return { project, principal, role, projectId: project.id, projectCode: project.code, principalId: principal.id };
}
async function batchOf(db: AccessDb, access: Access, code: string, lock = false): Promise<Batch> {
  const query = db.select().from(schema.intakeBatches).where(and(eq(schema.intakeBatches.code, code), eq(schema.intakeBatches.project_id, access.project.id)));
  const [batch] = await (lock ? query.for('update') : query).limit(1);
  if (!batch) throw new DomainError('intake_not_found', '接入批次不存在');
  return batch;
}
async function itemsOf(db: AccessDb, batch: Batch) { return db.select().from(schema.intakeItems).where(eq(schema.intakeItems.batch_id, batch.id)).orderBy(asc(schema.intakeItems.id)); }
async function repositoryOf(db: AccessDb, access: Access, code: string) {
  const [repository] = await db.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.project_id, access.project.id), eq(schema.projectRepositories.code, code))).limit(1);
  if (!repository || repository.status !== 'active') throw invalid('必须选择当前项目已登记的有效仓库');
  return repository;
}
async function bindingRows(db: AccessDb, batch: Batch) { return db.select().from(schema.intakeBindings).where(and(eq(schema.intakeBindings.project_id, batch.project_id), eq(schema.intakeBindings.repository_id, batch.repository_id), eq(schema.intakeBindings.namespace, batch.namespace))); }
function checkRevision(batch: Batch, revision: number) { if (!Number.isInteger(revision) || batch.revision !== revision) throw conflict('批次已变化，请重新加载'); }
function assertNotRunning(batch: Batch) { if (batch.status === 'applying') throw conflict('发布正在执行，请先停止再修改候选'); }
async function summary(db: AccessDb, access: Access, batch: Batch, items: ItemRow[]): Promise<IntakeBatchSummary> {
  const [author] = await db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, batch.created_by)).limit(1);
  const [repo] = await db.select({ code: schema.projectRepositories.code }).from(schema.projectRepositories).where(eq(schema.projectRepositories.id, batch.repository_id)).limit(1);
  return { code: batch.code, project_code: access.project.code, repository_code: repo?.code ?? '', namespace: batch.namespace,
    status: batch.status, revision: batch.revision, created_by: author?.code ?? '', created_at: batch.created_at, updated_at: batch.updated_at,
    item_count: items.length, applied_count: items.filter(completed).length, plan_hash: batch.plan_hash };
}
async function detailView(db: AccessDb, access: Access, batch: Batch): Promise<IntakeBatchDetail> {
  const items = await itemsOf(db, batch), targets = await intakeTargets(db, batch.project_id), bindings = await bindingRows(db, batch);
  const active = access.project.status === 'active', manager = isProjectManager(access.role.role);
  return { ...await summary(db, access, batch, items), source: JSON.parse(batch.source_json), stop_requested: batch.stop_requested,
    can_review: active && manager,
    can_edit: active && batch.status !== 'applying' && batch.status !== 'applied' && (manager || (batch.created_by === access.principal.id && !batch.plan_hash)),
    targets: targets.map(row => row.target), items: items.map(row => {
      const binding = bindings.find(binding => binding.kind === row.kind && binding.source_key === row.item_key);
      return { item: itemOf(row), decision: decisionOf(row), status: row.status, target_code: row.target_code, error: row.error,
        existing_binding: binding ? targets.find(target => target.target.kind === row.kind && target.target.code === binding.target_code)?.target ?? null : null };
    }) };
}

/** Explicit binding respects the candidate's hierarchy without modifying existing content. */
function checkBindingParents(item: IntakeItem, target: TargetRecord, rows: ItemRow[], targets: TargetRecord[]) {
  for (const [key, field, kind] of [[item.module_key, 'moduleId', 'module'], [item.feature_key, 'featureId', 'feature'], [item.document_key, 'documentId', 'requirement_document']] as const) {
    if (!key) continue;
    const parent = rows.find(row => row.item_key === key), decision = parent && decisionOf(parent);
    const parentCode = parent && completed(parent) ? parent.target_code : decision?.action === 'bind' ? decision.target_code : null;
    const resolved = targets.find(row => row.target.kind === kind && row.target.code === parentCode);
    if (!resolved || target[field] !== resolved.id) throw conflict(`关联目标的归属与候选依赖不一致：${item.key}`);
  }
}

export function createIntakeUseCases(db: Db) {
  async function materialTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5000;
    for (let attempt = 0; ; attempt++) {
      try { return await db.transaction(work); }
      catch (error) {
        if (!retryableTransactionError(error) || Date.now() >= deadline) throw error;
        // No governance row locks survive this wait. Existing material writers may finish first.
        await delay(Math.min(20 + attempt * 10, 100));
      }
    }
  }
  async function context(cmd: Command): Promise<TaskResult<IntakeContext>> {
    try {
      const access = await accessProject(db, cmd);
      const repositories = await db.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.project_id, access.project.id), eq(schema.projectRepositories.status, 'active')));
      const bindings = await db.select().from(schema.intakeBindings).where(eq(schema.intakeBindings.project_id, access.project.id));
      const repoCodes = new Map(repositories.map(row => [row.id, row.code]));
      return { ok: true, data: { project_code: access.project.code, repositories: repositories.map(row => ({ code: row.code, name: row.name })),
        targets: (await intakeTargets(db, access.project.id)).map(row => row.target), skill_version: INTAKE_SKILL_VERSION,
        bindings: bindings.filter(row => repoCodes.has(row.repository_id)).map(row => ({ repository_code: present(repoCodes.get(row.repository_id)), namespace: row.namespace,
          key: row.source_key, kind: row.kind as IntakeKind, target_code: row.target_code })) } };
    } catch (error) { return fail(error); }
  }
  async function list(cmd: Command): Promise<TaskResult<IntakeList>> {
    try {
      const access = await accessProject(db, cmd);
      const batches = await db.select().from(schema.intakeBatches).where(eq(schema.intakeBatches.project_id, access.project.id)).orderBy(desc(schema.intakeBatches.id));
      return { ok: true, data: { can_submit: access.project.status === 'active', can_review: access.project.status === 'active' && isProjectManager(access.role.role),
        batches: await Promise.all(batches.map(async batch => summary(db, access, batch, await itemsOf(db, batch)))) } };
    } catch (error) { return fail(error); }
  }
  async function detail(cmd: BatchCommand): Promise<TaskResult<IntakeBatchDetail>> {
    try { const access = await accessProject(db, cmd); return { ok: true, data: await detailView(db, access, await batchOf(db, access, cmd.code)) }; }
    catch (error) { return fail(error); }
  }
  async function submit(cmd: Command & { bundle: unknown; idempotencyKey: string }): Promise<TaskResult<IntakeBatchDetail>> {
    try {
      const bundle = parseBundle(cmd.bundle); requestKey(cmd.idempotencyKey);
      if (bundle.project_code !== cmd.projectCode) throw invalid('候选包项目与当前项目不一致');
      const hash = intakeHash(bundle);
      const code = await db.transaction(async tx => {
        const access = await accessProject(tx, cmd, 'write', true), repository = await repositoryOf(tx, access, bundle.repository_code);
        const [prior] = await tx.select().from(schema.intakeBatches).where(and(eq(schema.intakeBatches.project_id, access.project.id), eq(schema.intakeBatches.created_by, access.principal.id), eq(schema.intakeBatches.submit_key, cmd.idempotencyKey))).for('update');
        if (prior) { if (prior.submit_hash !== hash) throw conflict('幂等键已用于不同的候选包'); return prior.code; }
        const timestamp = now();
        const [batch] = await tx.insert(schema.intakeBatches).values({ code: createPublicCode(), project_id: access.project.id, repository_id: repository.id,
          namespace: bundle.namespace, created_by: access.principal.id, source_json: JSON.stringify(bundle.source), payload_hash: hash,
          submit_key: cmd.idempotencyKey, submit_hash: hash, status: 'draft', revision: 1, created_at: timestamp, updated_at: timestamp }).returning();
        if (!batch) throw new DomainError('internal_error', '无法保存接入批次');
        await tx.insert(schema.intakeItems).values(bundle.items.map(item => ({ batch_id: batch.id, item_key: item.key, kind: item.kind, item_json: JSON.stringify(item), status: 'pending' as const })));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.submitted', { batch_code: batch.code, payload_hash: hash, repository_code: repository.code });
        return batch.code;
      });
      return detail({ ...cmd, code });
    } catch (error) { return fail(error); }
  }
  async function replace(cmd: BatchCommand & { baseRevision: number; bundle: unknown }): Promise<TaskResult<IntakeBatchDetail>> {
    try {
      const bundle = parseBundle(cmd.bundle);
      await db.transaction(async tx => {
        const access = await accessProject(tx, cmd, 'write', true), batch = await batchOf(tx, access, cmd.code, true);
        checkRevision(batch, cmd.baseRevision); assertNotRunning(batch);
        if (!isProjectManager(access.role.role) && (batch.created_by !== access.principal.id || batch.plan_hash !== null)) throw new DomainError('intake_forbidden', '只能修改本人未冻结的候选');
        if (batch.status === 'applied') throw conflict('已发布批次不可修改');
        const repository = await repositoryOf(tx, access, bundle.repository_code);
        if (bundle.project_code !== cmd.projectCode || repository.id !== batch.repository_id || bundle.namespace !== batch.namespace) throw invalid('批次项目、仓库和命名空间不能修改');
        const rows = await itemsOf(tx, batch), sourceChanged = intakeHash(bundle.source) !== intakeHash(JSON.parse(batch.source_json));
        for (const row of rows.filter(completed)) {
          const next = bundle.items.find(item => item.key === row.item_key);
          if (!next || intakeHash(next) !== intakeHash(itemOf(row)) || sourceChanged) throw conflict('已发布项及其来源快照不能修改；请提交新批次');
        }
        for (const row of rows.filter(row => !completed(row))) await tx.delete(schema.intakeItems).where(eq(schema.intakeItems.id, row.id));
        const pending = bundle.items.filter(item => !rows.some(row => completed(row) && row.item_key === item.key));
        if (pending.length) await tx.insert(schema.intakeItems).values(pending.map(item => ({ batch_id: batch.id, item_key: item.key, kind: item.kind, item_json: JSON.stringify(item), status: 'pending' as const })));
        await tx.update(schema.intakeBatches).set({ source_json: JSON.stringify(bundle.source), payload_hash: intakeHash(bundle), revision: batch.revision + 1,
          plan_hash: null, status: 'draft', stop_requested: false, updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.replaced', { revision: batch.revision + 1, payload_hash: intakeHash(bundle) });
      });
      return detail(cmd);
    } catch (error) { return fail(error); }
  }
  async function review(cmd: BatchCommand & { input: IntakeReviewInput }): Promise<TaskResult<IntakeBatchDetail>> {
    try {
      const parsed = IntakeReviewSchema.safeParse(cmd.input); if (!parsed.success) throw invalid('审阅决策格式不正确');
      const input = parsed.data;
      await db.transaction(async tx => {
        const access = await accessProject(tx, cmd, 'manage', true), batch = await batchOf(tx, access, cmd.code, true);
        checkRevision(batch, input.base_revision); assertNotRunning(batch);
        if (batch.status === 'applied' || batch.status === 'cancelled') throw conflict('已完成或取消批次不能重新审阅');
        const rows = await itemsOf(tx, batch), targets = await intakeTargets(tx, access.project.id), bindings = await bindingRows(tx, batch);
        if (input.decisions.length !== rows.length || input.decisions.some(decision => !rows.some(row => row.item_key === decision.key))) throw invalid('必须逐项明确新增、关联或跳过');
        const reviewed = rows.map(row => ({ ...row, decision_json: JSON.stringify(present(input.decisions.find(decision => decision.key === row.item_key))) }));
        for (const row of reviewed) {
          const old = present(rows.find(old => old.id === row.id)), decision = present(decisionOf(row)), item = itemOf(row);
          if (completed(old)) { if (row.decision_json !== old.decision_json) throw conflict('已发布项的决策不能修改'); continue; }
          if (decision.action === 'skip') continue;
          for (const key of dependencies(item)) if (decisionOf(present(reviewed.find(row => row.item_key === key)))?.action === 'skip') throw conflict(`候选 ${item.key} 依赖已跳过的 ${key}`);
          const binding = bindings.find(binding => binding.kind === item.kind && binding.source_key === item.key);
          if (binding && (decision.action !== 'bind' || binding.target_code !== decision.target_code)) throw conflict(`来源 ${item.key} 已有关联，必须显式关联同一目标`);
          if (decision.action === 'bind') {
            const target = targets.find(target => target.target.code === decision.target_code && target.target.kind === item.kind);
            if (!target || target.target.fingerprint !== decision.target_fingerprint) throw conflict(`关联目标已变化或不属于本项目：${item.key}`);
            checkBindingParents(item, target, reviewed, targets);
          }
        }
        for (const row of reviewed.filter(row => !completed(row))) await tx.update(schema.intakeItems).set({ decision_json: row.decision_json,
          status: present(decisionOf(row)).action === 'skip' ? 'skipped' : 'pending', error: null }).where(eq(schema.intakeItems.id, row.id));
        const revision = batch.revision + 1;
        const planHash = intakeHash({ batch: batch.code, revision, payload: batch.payload_hash, decisions: reviewed.map(row => present(decisionOf(row))).sort((a, b) => a.key < b.key ? -1 : 1) });
        await tx.update(schema.intakeBatches).set({ revision, plan_hash: planHash, status: 'ready', updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.reviewed', { revision, plan_hash: planHash, decisions: input.decisions });
      });
      return detail(cmd);
    } catch (error) { return fail(error); }
  }

  async function stop(cmd: BatchCommand & { baseRevision: number }): Promise<TaskResult<IntakeBatchDetail>> {
    try {
      await db.transaction(async tx => {
        const access = await accessProject(tx, cmd, 'write', true), batch = await batchOf(tx, access, cmd.code, true);
        checkRevision(batch, cmd.baseRevision);
        if (!isProjectManager(access.role.role) && (batch.created_by !== access.principal.id || batch.plan_hash)) throw new DomainError('intake_forbidden', '只有项目管理员可以停止已审阅发布计划');
        if (batch.status === 'applied') return;
        const rows = await itemsOf(tx, batch), count = rows.filter(completed).length;
        await tx.update(schema.intakeBatches).set({ stop_requested: true, status: count ? 'partial' : batch.status === 'draft' || batch.status === 'ready' ? 'cancelled' : 'stopped',
          revision: batch.revision + 1, updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
        await tx.update(schema.intakeAttempts).set({ status: 'stopped', finished_at: now() }).where(and(eq(schema.intakeAttempts.batch_id, batch.id), eq(schema.intakeAttempts.status, 'running')));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.stopped', { applied_count: count });
      });
      return detail(cmd);
    } catch (error) { return fail(error); }
  }

  async function apply(cmd: BatchCommand & { input: IntakeApplyInput }): Promise<TaskResult<IntakeBatchDetail>> {
    let attemptId: bigint | undefined;
    try {
      const parsed = IntakeApplySchema.safeParse(cmd.input); if (!parsed.success) throw invalid('发布请求格式不正确');
      const input = parsed.data;
      const attempt = await db.transaction(async tx => {
        const access = await accessProject(tx, cmd, 'manage', true), batch = await batchOf(tx, access, cmd.code, true);
        const [prior] = await tx.select().from(schema.intakeAttempts).where(and(eq(schema.intakeAttempts.batch_id, batch.id), eq(schema.intakeAttempts.idempotency_key, input.idempotency_key))).for('update');
        if (prior) { if (prior.plan_hash !== input.plan_hash || prior.principal_id !== access.principal.id) throw conflict('幂等键已用于不同的计划或操作者'); return prior; }
        if (!batch.plan_hash || input.plan_hash !== batch.plan_hash) throw conflict('请先审阅并冻结当前发布计划');
        if (!['ready', 'partial', 'stopped'].includes(batch.status)) throw conflict('当前批次不允许开始新的发布尝试');
        const [running] = await tx.select().from(schema.intakeAttempts).where(and(eq(schema.intakeAttempts.batch_id, batch.id), eq(schema.intakeAttempts.status, 'running')));
        if (running) throw conflict('已有发布正在执行');
        const rows = await itemsOf(tx, batch);
        if (rows.some(row => !decisionOf(row))) throw conflict('存在未审阅候选');
        const targets = await intakeTargets(tx, access.project.id), bindings = await bindingRows(tx, batch);
        for (const row of rows.filter(row => !completed(row))) {
          const decision = present(decisionOf(row)), item = itemOf(row);
          if (decision.action === 'skip') continue;
          if (dependencies(item).some(key => decisionOf(present(rows.find(parent => parent.item_key === key)))?.action === 'skip')) throw conflict('发布计划包含已跳过的依赖');
          const binding = bindings.find(binding => binding.kind === item.kind && binding.source_key === item.key);
          if (binding && (decision.action !== 'bind' || decision.target_code !== binding.target_code)) throw conflict('来源已由其他批次关联，请重新审阅');
          if (decision.action === 'bind') {
            const target = targets.find(target => target.target.kind === item.kind && target.target.code === decision.target_code);
            if (!target || target.target.fingerprint !== decision.target_fingerprint) throw conflict('关联目标已变化，请重新审阅');
            checkBindingParents(item, target, rows, targets);
          }
        }
        await tx.update(schema.intakeItems).set({ status: 'pending', error: null }).where(and(eq(schema.intakeItems.batch_id, batch.id), eq(schema.intakeItems.status, 'failed')));
        await tx.update(schema.intakeItems).set({ status: 'pending', error: null }).where(and(eq(schema.intakeItems.batch_id, batch.id), eq(schema.intakeItems.status, 'blocked')));
        const [created] = await tx.insert(schema.intakeAttempts).values({ batch_id: batch.id, idempotency_key: input.idempotency_key, plan_hash: input.plan_hash,
          principal_id: access.principal.id, status: 'running', created_at: now() }).returning();
        if (!created) throw new DomainError('internal_error', '无法创建发布尝试');
        await tx.update(schema.intakeBatches).set({ status: 'applying', stop_requested: false, updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.apply_started', { attempt_id: String(created.id), plan_hash: input.plan_hash });
        return created;
      });
      attemptId = attempt.id;
      if (attempt.status !== 'running') return detail(cmd);
      // Material-table triggers also acquire this fence. Never block on it while holding governance row locks.
      await materialTransaction(async tx => {
        const access = await accessProject(tx, cmd, 'manage', true), batch = await batchOf(tx, access, cmd.code, true);
        if (!batch.stop_requested && batch.status === 'applying') {
          if (!await tryLockProjectSystemFolders(tx)) throw new IntakeMaterialBusy();
          await ensureProjectSystemFolders(tx, access.project.id);
        }
      });
      while (await applyNext(cmd, attempt.id)) { /* Each item rechecks current authority and durable stop state. */ }
      return detail(cmd);
    } catch (error) {
      if (retryableTransactionError(error)) return fail(conflict('资料正在被其他操作使用；已提交结果保留，请使用相同请求键重试'));
      if (attemptId) await db.transaction(async tx => {
        const [attempt] = await tx.select().from(schema.intakeAttempts).where(eq(schema.intakeAttempts.id, present(attemptId))).limit(1);
        if (!attempt) return;
        const [batch] = await tx.select().from(schema.intakeBatches).where(eq(schema.intakeBatches.id, attempt.batch_id)).for('update');
        if (!batch) return;
        const [current] = await tx.select().from(schema.intakeAttempts).where(eq(schema.intakeAttempts.id, attempt.id)).for('update');
        if (current?.status !== 'running') return;
        const rows = await itemsOf(tx, batch);
        await tx.update(schema.intakeAttempts).set({ status: 'stopped', finished_at: now() }).where(eq(schema.intakeAttempts.id, attempt.id));
        await tx.update(schema.intakeBatches).set({ stop_requested: true, status: rows.some(completed) ? 'partial' : 'stopped', updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
      });
      return fail(error);
    }
  }

  async function applyNext(cmd: BatchCommand, attemptId: bigint): Promise<boolean> {
    return materialTransaction(async tx => {
      const access = await accessProject(tx, cmd, 'manage', true), batch = await batchOf(tx, access, cmd.code, true);
      const [attempt] = await tx.select().from(schema.intakeAttempts).where(eq(schema.intakeAttempts.id, attemptId)).for('update');
      if (!attempt || attempt.status !== 'running' || batch.stop_requested || batch.status !== 'applying') return false;
      if (attempt.plan_hash !== batch.plan_hash) throw conflict('发布计划已变化');
      if (!await tryLockProjectSystemFolders(tx)) throw new IntakeMaterialBusy();
      const rows = await itemsOf(tx, batch);
      const row = rows.filter(row => row.status === 'pending').sort((a, b) => kindOrder[a.kind as IntakeKind] - kindOrder[b.kind as IntakeKind] || (a.id < b.id ? -1 : 1))[0];
      if (!row) {
        await tx.update(schema.intakeBatches).set({ status: rows.some(row => row.status === 'failed' || row.status === 'blocked') ? 'partial' : 'applied', updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
        await tx.update(schema.intakeAttempts).set({ status: 'completed', finished_at: now() }).where(eq(schema.intakeAttempts.id, attempt.id));
        await intakeAudit(tx, access, 'intake_batch', batch.id, 'intake.apply_finished', { attempt_id: String(attempt.id), applied_count: rows.filter(completed).length });
        return false;
      }
      await tx.select({ id: schema.intakeItems.id }).from(schema.intakeItems).where(eq(schema.intakeItems.id, row.id)).for('update');
      let result: { status: ItemRow['status']; target_code: string | null; error: string | null };
      const item = itemOf(row), decision = decisionOf(row);
      if (!decision || decision.action === 'skip') throw conflict('发布计划缺少明确审阅');
      if (dependencies(item).some(key => !rows.some(parent => parent.item_key === key && completed(parent)))) {
        result = { status: 'blocked', target_code: null, error: '依赖候选未成功发布或关联' };
      } else {
        try {
          // A savepoint rolls back every business write, mapping and audit together on an item failure.
          result = await tx.transaction(async itemTx => {
            for (const key of dependencies(item)) {
              const parent = present(rows.find(row => row.item_key === key));
              await lockIntakeTarget(itemTx, parent.kind as IntakeKind, present(parent.target_code));
            }
            if (decision.action === 'bind') await lockIntakeTarget(itemTx, item.kind, present(decision.target_code));
            const targets = await intakeTargets(itemTx, access.project.id), bindings = await bindingRows(itemTx, batch);
            const existing = bindings.find(binding => binding.kind === item.kind && binding.source_key === item.key);
            if (existing && (decision.action !== 'bind' || existing.target_code !== decision.target_code)) throw conflict('此来源已被其他批次关联，请重新审阅');
            let target: TargetRecord;
            if (decision.action === 'bind') {
              const found = targets.find(target => target.target.code === decision.target_code && target.target.kind === item.kind);
              if (!found || found.target.fingerprint !== decision.target_fingerprint) throw conflict('关联目标已变化，请重新审阅');
              checkBindingParents(item, found, rows, targets); target = found;
            } else {
              const parent = (key?: string) => key ? targets.find(target => target.target.code === rows.find(row => row.item_key === key)?.target_code) : undefined;
              const module = parent(item.module_key), feature = parent(item.feature_key), document = parent(item.document_key);
              if (item.module_key && !module) throw conflict('关联模块已归档或移出项目');
              if (item.feature_key && (!feature || feature.moduleId !== module?.id)) throw conflict('关联 Feature 的模块已变化');
              if (item.document_key && (!document || document.moduleId !== module?.id)) throw conflict('关联文档的模块已变化');
              let code: string;
              switch (item.kind) {
                case 'module': code = (await writeProjectModule(itemTx, access, { name: item.title, description: item.content_markdown || item.summary })).code; break;
                case 'feature': code = (await writeFeature(itemTx, access, { title: item.title, goal: item.content_markdown || item.summary, moduleId: present(module).id })).code; break;
                case 'requirement_document': {
                  const [moduleRow] = await itemTx.select().from(schema.projectModules).where(eq(schema.projectModules.id, present(module).id));
                  code = (await writeRequirementDocument(itemTx, access, { moduleId: present(module).id, moduleKey: present(moduleRow).name,
                    title: item.title, summary: item.summary || item.title, content: item.content_markdown, keywords: [] })).document.code; break;
                }
                case 'requirement': code = (await writeRequirement(itemTx, access, { moduleId: present(module).id, featureId: feature?.id ?? null, documentId: document?.id ?? null,
                  title: item.title, body: item.content_markdown, acceptanceCriteria: [], openQuestions: item.gaps })).requirement.code; break;
                case 'architecture': code = (await writeArchitecture(itemTx, access, { title: item.title, summary: item.summary,
                  content: { content_kind: 'mermaid', source_content: present(item.diagram_source), notes_markdown: item.content_markdown, preview_svg: null } })).code; break;
              }
              target = present((await intakeTargets(itemTx, access.project.id)).find(target => target.target.kind === item.kind && target.target.code === code));
              if (!target) throw new DomainError('internal_error', '发布目标投影失败');
            }
            if (!existing) await itemTx.insert(schema.intakeBindings).values({ project_id: access.project.id, repository_id: batch.repository_id, namespace: batch.namespace,
              kind: item.kind, source_key: item.key, target_code: target.target.code, target_fingerprint: target.target.fingerprint, batch_id: batch.id, created_at: now() });
            const value = { status: decision.action === 'bind' ? 'bound' as const : 'applied' as const, target_code: target.target.code, error: null };
            await itemTx.update(schema.intakeItems).set(value).where(eq(schema.intakeItems.id, row.id));
            await intakeAudit(itemTx, access, 'intake_batch', batch.id, 'intake.item_published', { key: item.key, kind: item.kind,
              action: decision.action, target_code: target.target.code, attempt_id: String(attempt.id), plan_hash: batch.plan_hash });
            const receipts = JSON.parse(attempt.results_json) as unknown[];
            await itemTx.update(schema.intakeAttempts).set({ results_json: JSON.stringify([...receipts, { key: item.key, ...value }]) }).where(eq(schema.intakeAttempts.id, attempt.id));
            return value;
          });
        } catch (error) {
          if (retryableTransactionError(error)) throw error;
          result = { status: 'failed', target_code: null, error: error instanceof DomainError ? `${error.code}: ${error.message}` : '发布失败；本条写入已回滚，请重试或联系管理员' };
        }
      }
      if (result.status === 'failed' || result.status === 'blocked') {
        await tx.update(schema.intakeItems).set(result).where(eq(schema.intakeItems.id, row.id));
        await tx.update(schema.intakeAttempts).set({ results_json: JSON.stringify([...(JSON.parse(attempt.results_json) as unknown[]), { key: item.key, ...result }]) }).where(eq(schema.intakeAttempts.id, attempt.id));
      }
      await tx.update(schema.intakeBatches).set({ updated_at: now() }).where(eq(schema.intakeBatches.id, batch.id));
      return true;
    });
  }
  return { context, list, submit, detail, review, apply, stop, replace };
}
