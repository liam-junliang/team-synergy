import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import type { TestAssetContent, TestAssetDetail, TestAssetInput, TestAssetRevisionInput, TestAssetSummary,
  TestCaseContent, TestCaseDetail, TestCaseInput, TestCaseRevision, TestCaseRevisionInput, TestCaseSummary,
  TestDocumentMetadata, TestRevisionMetadata, TestExecutionInput, TestExecutionDetail, TestExecutionSummary, TestExecutionAsset,
  TestExecutionResult, TestResultDefectInput } from '@team-synergy/contracts';
import { assertProjectAccess, isProjectManager, type AccessDb } from './project-access.js';
import { createPublicCode, findProjectByCode, findUserByCode } from './public-code.js';
import { assertRequirementInProject } from './project-use-cases.js';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import { invalid, normalizeTestAsset, normalizeTestCase, testChoice, testCommit, testRevision, testStrings, testText, testUrl, withoutTestFileBytes } from './testing-content.js';

type Scope = { projectCode: string; principalCode: string };
type Filter = Scope & { query?: string; requirement_code?: string; module_code?: string; suite?: string; method?: string; purpose?: string; storage_kind?: string };
type Content = TestCaseContent | TestAssetContent;
type Revision<C> = C & TestRevisionMetadata;
type Detail<C> = C & TestDocumentMetadata & { revisions: Revision<C>[] };
type DefinitionRow = typeof schema.testCases.$inferSelect;
type RevisionRow = typeof schema.testCaseRevisions.$inferSelect;
type ExecutionRow = typeof schema.testExecutions.$inferSelect;

export function createTestingUseCases(db: Db) {
  async function user(principalCode: string) {
    const principal = await findUserByCode(db, principalCode);
    if (!principal || principal.status !== 'active' || principal.deleted_at) throw new DomainError('project_forbidden', '当前身份无法访问项目');
    return principal;
  }
  async function scope(cmd: Scope) {
    const project = await findProjectByCode(db, cmd.projectCode);
    if (!project) throw new DomainError('project_not_found', '项目不存在');
    const principal = await user(cmd.principalCode);
    await assertProjectAccess(db, project.id, principal.id);
    return { project, principal };
  }
  async function writeScope(tx: AccessDb, projectId: bigint, principalId: bigint) {
    await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, principalId)).for('share');
    const [project] = await tx.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (!project) throw new DomainError('project_not_found', '项目不存在');
    await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
    await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId)).for('share');
    return assertProjectAccess(tx, projectId, principalId, 'write');
  }
  async function audit(tx: AccessDb, type: string, id: bigint, principalId: bigint, action: string, revision: number, payload: Record<string, unknown>) {
    await insertAudit(tx, toAuditEvent({ entity_type: type, entity_id: id, principal_id: principalId,
      base_snapshot: revision, action, payload }, createPublicCode(), now()));
  }
  async function references(tx: AccessDb, projectId: bigint, content: Content) {
    if (content.module_code) {
      const [module] = await tx.select().from(schema.projectModules).where(eq(schema.projectModules.code, content.module_code)).limit(1);
      if (!module || module.project_id !== projectId) invalid('模块必须属于当前项目');
    }
    for (const code of content.requirement_codes) {
      const [requirement] = await tx.select().from(schema.requirements).where(eq(schema.requirements.code, code)).limit(1);
      if (!requirement) invalid('关联需求不存在');
      await assertRequirementInProject(tx, requirement, projectId);
    }
    if ('asset_codes' in content) for (const code of content.asset_codes) {
      const [asset] = await tx.select().from(schema.testAssets).where(eq(schema.testAssets.code, code)).limit(1);
      if (!asset || asset.project_id !== projectId) invalid('测试资料必须属于当前项目');
    }
    if ('git' in content && content.git) {
      const [repository] = await tx.select().from(schema.projectRepositories).where(eq(schema.projectRepositories.code, content.git.repository_code)).limit(1);
      if (!repository || repository.project_id !== projectId) invalid('Git 仓库必须属于当前项目');
    }
  }
  async function metadata(document: DefinitionRow, principalId: bigint): Promise<TestDocumentMetadata> {
    const access = await assertProjectAccess(db, document.project_id, principalId);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, document.project_id)).limit(1);
    const [owner] = await db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, document.owner_principal_id)).limit(1);
    return { code: document.code, project_code: project?.code ?? '', current_revision: document.current_revision,
      owner_user_code: owner?.code ?? '', updated_at: document.updated_at,
      can_edit: project?.status === 'active' && access.role !== 'viewer' && (isProjectManager(access.role) || principalId === document.owner_principal_id) };
  }
  async function revision<C extends Content>(row: RevisionRow, tx: AccessDb = db): Promise<Revision<C>> {
    const [author] = await tx.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, row.created_by)).limit(1);
    return { ...JSON.parse(row.content_json) as C, revision_code: row.code, revision: row.revision,
      change_summary: row.change_summary, created_by_user_code: author?.code ?? '', created_at: row.created_at };
  }
  // Both definition tables intentionally share identical columns; this keeps concurrency and author rules identical.
  function definitions<C extends Content>(table: typeof schema.testCases, revisions: typeof schema.testCaseRevisions, kind: string, normalize: (input: Record<string, unknown>) => C) {
    async function rowOf(code: string, tx: AccessDb = db) {
      const [row] = await tx.select().from(table).where(eq(table.code, code)).limit(1);
      if (!row) throw new DomainError(`${kind}_not_found`, '测试资料或用例不存在');
      return row;
    }
    async function exact(code: string, version: number, projectId: bigint, tx: AccessDb): Promise<Revision<C>> {
      const row = await rowOf(code, tx);
      if (row.project_id !== projectId) invalid('测试资料或用例必须属于当前项目');
      const [rev] = await tx.select().from(revisions).where(and(eq(revisions.document_id, row.id), eq(revisions.revision, testRevision(version)))).limit(1);
      if (!rev) throw new DomainError('testing_revision_not_found', '指定的历史版本不存在');
      return revision<C>(rev, tx);
    }
    async function get(code: string, principalCode: string): Promise<TaskResult<Detail<C>>> {
      try {
        const row = await rowOf(code); const principal = await user(principalCode);
        const meta = await metadata(row, principal.id);
        const rows = await db.select().from(revisions).where(eq(revisions.document_id, row.id)).orderBy(desc(revisions.revision));
        const versions = await Promise.all(rows.map(item => revision<C>(item)));
        const current = versions.find(item => item.revision === row.current_revision);
        if (!current) throw new DomainError('internal_error', '测试资料当前版本缺失');
        const data: Detail<C> = Object.assign({}, current, meta, { revisions: versions });
        return { ok: true, data };
      } catch (error) { return fail(error); }
    }
    async function list(cmd: Filter): Promise<TaskResult<Array<C & TestDocumentMetadata>>> {
      try {
        const { project, principal } = await scope(cmd);
        const rows = await db.select({ document: table, revision: revisions }).from(table).innerJoin(revisions,
          and(eq(revisions.document_id, table.id), eq(revisions.revision, table.current_revision)))
          .where(eq(table.project_id, project.id)).orderBy(desc(table.updated_at), desc(table.id));
        const data: Array<C & TestDocumentMetadata> = [];
        for (const row of rows) {
          const content = JSON.parse(row.revision.content_json) as C;
          const searchable = 'file' in content ? withoutTestFileBytes(content) : content;
          if (cmd.query && !`${row.document.code} ${JSON.stringify(searchable)}`.toLowerCase().includes(cmd.query.trim().toLowerCase())) continue;
          if (cmd.module_code && content.module_code !== cmd.module_code) continue;
          if (cmd.requirement_code && !content.requirement_codes.includes(cmd.requirement_code)) continue;
          if ('suite' in content && ((cmd.suite && content.suite !== cmd.suite) || (cmd.method && content.method !== cmd.method))) continue;
          if ('purpose' in content && ((cmd.purpose && content.purpose !== cmd.purpose) || (cmd.storage_kind && content.storage_kind !== cmd.storage_kind))) continue;
          data.push({ ...content, ...await metadata(row.document, principal.id) });
        }
        return { ok: true, data };
      } catch (error) { return fail(error); }
    }
    async function create(cmd: Scope & { input: Partial<C> & { title: string } }): Promise<TaskResult<Detail<C>>> {
      try {
        const { project, principal } = await scope(cmd); const content = normalize(cmd.input);
        const code = await db.transaction(async tx => {
          await writeScope(tx, project.id, principal.id); await references(tx, project.id, content);
          const timestamp = now(); const code = createPublicCode();
          const [created] = await tx.insert(table).values({ code, project_id: project.id, title: content.title, summary: content.summary,
            current_revision: 1, owner_principal_id: principal.id, created_at: timestamp, updated_at: timestamp }).returning();
          if (!created) throw new DomainError('internal_error', '创建失败');
          await tx.insert(revisions).values({ code: createPublicCode(), document_id: created.id, revision: 1,
            content_json: JSON.stringify(content), change_summary: '初始版本', created_by: principal.id, created_at: timestamp });
          await audit(tx, kind, created.id, principal.id, `${kind}.created`, 0, { code, revision: 1 });
          return code;
        });
        return get(code, principal.code);
      } catch (error) { return fail(error); }
    }
    async function revise(cmd: { code: string; principalCode: string; input: Partial<C> & { base_revision: number; change_summary: string } }): Promise<TaskResult<Detail<C>>> {
      try {
        const row = await rowOf(cmd.code); const principal = await user(cmd.principalCode);
        testRevision(cmd.input.base_revision); const change = testText(cmd.input.change_summary, '变更说明', 4096, true);
        await db.transaction(async tx => {
          const access = await writeScope(tx, row.project_id, principal.id);
          if (!isProjectManager(access.role) && row.owner_principal_id !== principal.id) throw new DomainError('testing_forbidden', '只有作者或项目管理员可以修订');
          const [locked] = await tx.select().from(table).where(eq(table.id, row.id)).for('update');
          if (!locked || locked.current_revision !== cmd.input.base_revision) throw new DomainError('testing_revision_conflict', '内容已更新，请重新加载后合并修改');
          const [current] = await tx.select().from(revisions).where(and(eq(revisions.document_id, row.id), eq(revisions.revision, locked.current_revision))).limit(1);
          if (!current) throw new DomainError('internal_error', '测试资料当前版本缺失');
          const content = normalize({ ...JSON.parse(current.content_json), ...cmd.input });
          await references(tx, row.project_id, content);
          const version = locked.current_revision + 1; const timestamp = now();
          await tx.insert(revisions).values({ code: createPublicCode(), document_id: row.id, revision: version,
            content_json: JSON.stringify(content), change_summary: change, created_by: principal.id, created_at: timestamp });
          await tx.update(table).set({ title: content.title, summary: content.summary, current_revision: version, updated_at: timestamp }).where(eq(table.id, row.id));
          await audit(tx, kind, row.id, principal.id, `${kind}.revised`, locked.current_revision, { revision: version, change_summary: change });
        });
        return get(row.code, principal.code);
      } catch (error) { return fail(error); }
    }
    return { get, list, create, revise, exact };
  }
  const cases = definitions(schema.testCases, schema.testCaseRevisions, 'test_case', normalizeTestCase);
  const assets = definitions(schema.testAssets as unknown as typeof schema.testCases,
    schema.testAssetRevisions as unknown as typeof schema.testCaseRevisions, 'test_asset', normalizeTestAsset);

  async function executionOf(code: string) {
    const [row] = await db.select().from(schema.testExecutions).where(eq(schema.testExecutions.code, code)).limit(1);
    if (!row) throw new DomainError('test_execution_not_found', '测试执行记录不存在');
    return row;
  }
  async function executionSummary(row: ExecutionRow): Promise<TestExecutionSummary> {
    const [project] = await db.select({ code: schema.projects.code }).from(schema.projects).where(eq(schema.projects.id, row.project_id)).limit(1);
    const [executor] = await db.select({ code: schema.users.code }).from(schema.users).where(eq(schema.users.id, row.executor_principal_id)).limit(1);
    const results = await db.select({ result: schema.testExecutionResults.result }).from(schema.testExecutionResults).where(eq(schema.testExecutionResults.execution_id, row.id));
    const counts = { not_run: 0, pass: 0, fail: 0, blocked: 0, skipped: 0 };
    for (const result of results) counts[result.result] += 1;
    return { code: row.code, project_code: project?.code ?? '', title: row.title, environment: row.environment,
      tested_version: row.tested_version, commit_sha: row.commit_sha, source: row.source, task_code: row.task_code,
      notes_markdown: row.notes_markdown, executor_user_code: executor?.code ?? '', created_at: row.created_at, counts };
  }
  async function getExecution(code: string, principalCode: string): Promise<TaskResult<TestExecutionDetail>> {
    try {
      const row = await executionOf(code); const principal = await user(principalCode);
      await assertProjectAccess(db, row.project_id, principal.id);
      const rows = await db.select().from(schema.testExecutionResults).where(eq(schema.testExecutionResults.execution_id, row.id)).orderBy(schema.testExecutionResults.id);
      const results: TestExecutionResult[] = [];
      for (const result of rows) {
        const [current] = await db.select({ revision: schema.testCases.current_revision }).from(schema.testCases).where(eq(schema.testCases.code, result.case_code)).limit(1);
        results.push({ result_code: result.code, case_code: result.case_code, case_revision: result.case_revision, result: result.result,
          actual_result: result.actual_result, notes: result.notes, report_urls: JSON.parse(result.report_urls_json),
          snapshot: JSON.parse(result.snapshot_json) as TestCaseRevision, defect_code: result.defect_code, is_outdated: current?.revision !== result.case_revision });
      }
      return { ok: true, data: { ...await executionSummary(row), results, assets: JSON.parse(row.assets_json) as TestExecutionAsset[] } };
    } catch (error) { return fail(error); }
  }
  async function listExecutions(cmd: Scope & { query?: string }): Promise<TaskResult<TestExecutionSummary[]>> {
    try {
      const { project } = await scope(cmd);
      const rows = await db.select().from(schema.testExecutions).where(eq(schema.testExecutions.project_id, project.id)).orderBy(desc(schema.testExecutions.created_at), desc(schema.testExecutions.id));
      const selected = rows.filter(row => !cmd.query || [row.title, row.environment, row.tested_version, row.notes_markdown].join(' ').toLowerCase().includes(cmd.query.trim().toLowerCase()));
      return { ok: true, data: await Promise.all(selected.map(executionSummary)) };
    } catch (error) { return fail(error); }
  }
  async function createExecution(cmd: Scope & { input: TestExecutionInput }): Promise<TaskResult<TestExecutionDetail>> {
    try {
      const { project, principal } = await scope(cmd); const input = cmd.input;
      const title = testText(input.title, '标题', 512, true); const environment = testText(input.environment, '测试环境', 4096, true);
      const tested_version = testText(input.tested_version, '测试版本', 512, true); const commit_sha = testCommit(input.commit_sha ?? '');
      const source = testChoice(input.source ?? 'manual', ['manual', 'agent', 'ci'], '来源');
      const notes_markdown = testText(input.notes_markdown ?? '', '执行说明');
      if (!Array.isArray(input.results) || !input.results.length || input.results.length > 500) invalid('执行记录需要 1 到 500 条用例结果');
      if (new Set(input.results.map(item => item.case_code)).size !== input.results.length) invalid('同一执行不能重复记录同一用例');
      const assetRefs = input.asset_refs ?? [];
      if (!Array.isArray(assetRefs) || assetRefs.length > 100 || new Set(assetRefs.map(item => item.asset_code)).size !== assetRefs.length) invalid('资料引用格式不正确或重复');
      const code = await db.transaction(async tx => {
        await writeScope(tx, project.id, principal.id);
        if (input.task_code) {
          const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.code, input.task_code)).limit(1);
          if (!task) invalid('关联任务不存在');
          const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, task.feature_id)).limit(1);
          if (feature?.project_id !== project.id) invalid('关联任务必须属于当前项目');
        }
        const resolvedAssets: TestExecutionAsset[] = [];
        for (const ref of assetRefs) {
          const content = withoutTestFileBytes(await assets.exact(ref.asset_code, ref.revision, project.id, tx));
          let git: TestExecutionAsset['snapshot']['git'] = null;
          if (content.git) {
            const [repository] = await tx.select().from(schema.projectRepositories).where(eq(schema.projectRepositories.code, content.git.repository_code)).limit(1);
            if (!repository || repository.project_id !== project.id) invalid('Git 仓库必须属于当前项目');
            git = { ...content.git, remote_url: repository.remote_url };
          }
          resolvedAssets.push({ ...ref, snapshot: { ...content, git } });
        }
        const repositories = new Set(resolvedAssets.flatMap(asset => asset.snapshot.git ? [asset.snapshot.git.repository_code] : []));
        for (const asset of resolvedAssets) if (asset.snapshot.git && !asset.snapshot.git.commit) {
          if (!commit_sha || repositories.size !== 1) invalid('Git 资料必须固定 commit；多仓库执行需分别在资料版本中指定 commit');
          asset.snapshot.git = { ...asset.snapshot.git, commit: commit_sha };
        }
        const resolvedResults = [];
        for (const item of input.results) {
          const snapshot = await cases.exact(item.case_code, item.case_revision, project.id, tx);
          for (const assetCode of snapshot.asset_codes) if (!resolvedAssets.some(asset => asset.asset_code === assetCode)) invalid('请为用例关联资料指定确切版本');
          const result = testChoice(item.result, ['not_run', 'pass', 'fail', 'blocked', 'skipped'], '测试结果');
          const actual_result = testText(item.actual_result ?? '', '实际结果'); const notes = testText(item.notes ?? '', '结果备注');
          const report_urls = testStrings(item.report_urls ?? [], '报告链接', 30).map(testUrl);
          resolvedResults.push({ code: createPublicCode(), case_code: item.case_code, case_revision: item.case_revision, result,
            actual_result, notes, report_urls_json: JSON.stringify(report_urls), snapshot_json: JSON.stringify(snapshot), defect_code: null });
        }
        const [execution] = await tx.insert(schema.testExecutions).values({ code: createPublicCode(), project_id: project.id, title, environment,
          tested_version, commit_sha, source, task_code: input.task_code || null, notes_markdown, assets_json: JSON.stringify(resolvedAssets),
          executor_principal_id: principal.id, created_at: now() }).returning();
        if (!execution) throw new DomainError('internal_error', '执行记录保存失败');
        await tx.insert(schema.testExecutionResults).values(resolvedResults.map(result => ({ ...result, execution_id: execution.id })));
        await audit(tx, 'test_execution', execution.id, principal.id, 'test_execution.recorded', 0,
          { code: execution.code, result_count: resolvedResults.length, source, tested_version });
        return execution.code;
      });
      return getExecution(code, principal.code);
    } catch (error) { return fail(error); }
  }
  async function linkResultDefect(cmd: { code: string; resultCode: string; principalCode: string; input: TestResultDefectInput }): Promise<TaskResult<TestExecutionDetail>> {
    try {
      const execution = await executionOf(cmd.code); const principal = await user(cmd.principalCode);
      await db.transaction(async tx => {
        await writeScope(tx, execution.project_id, principal.id);
        const [result] = await tx.select().from(schema.testExecutionResults).where(and(eq(schema.testExecutionResults.code, cmd.resultCode), eq(schema.testExecutionResults.execution_id, execution.id))).for('update');
        if (!result) throw new DomainError('test_result_not_found', '测试结果不存在');
        if (result.result !== 'fail') invalid('只有失败的测试结果可以关联缺陷');
        if (result.defect_code) {
          if (result.defect_code === cmd.input.defect_code) return;
          throw new DomainError('testing_defect_conflict', '测试结果已经关联缺陷');
        }
        let defectCode = cmd.input.defect_code;
        if (defectCode) {
          const [defect] = await tx.select().from(schema.defects).where(eq(schema.defects.code, defectCode)).limit(1);
          if (!defect) throw new DomainError('defect_not_found', '缺陷不存在');
          const [feature] = await tx.select().from(schema.features).where(eq(schema.features.id, defect.feature_id)).limit(1);
          if (feature?.project_id !== execution.project_id) invalid('缺陷必须属于当前项目');
        } else {
          const [feature] = await tx.select().from(schema.features).where(eq(schema.features.code, cmd.input.feature_code ?? '')).limit(1);
          if (!feature || feature.project_id !== execution.project_id) invalid('请选择当前项目的 Feature');
          const snapshot = JSON.parse(result.snapshot_json) as TestCaseRevision;
          const title = testText(cmd.input.title ?? snapshot.title, '缺陷标题', 512, true);
          const severity = testChoice(cmd.input.severity ?? 'medium', ['critical', 'high', 'medium', 'low'], '严重度');
          let relatedRequirementId: bigint | null = null;
          if (snapshot.requirement_codes.length === 1) {
            const [requirement] = await tx.select().from(schema.requirements).where(eq(schema.requirements.code, snapshot.requirement_codes[0] ?? '')).limit(1);
            if (requirement) { await assertRequirementInProject(tx, requirement, execution.project_id); relatedRequirementId = requirement.id; }
          }
          const description = [`测试执行：${execution.code}`, `用例：${result.case_code} r${result.case_revision}`, `环境：${execution.environment}`,
            `版本：${execution.tested_version}`, `Commit：${execution.commit_sha || '—'}`, '', '## 前置条件', snapshot.preconditions,
            '## 复现步骤', ...snapshot.steps.map((step, index) => `${index + 1}. ${step.action}\n预期：${step.expected}`),
            '## 关联需求', ...snapshot.requirement_codes, '## 实际结果', result.actual_result, result.notes, '## 证据', ...(JSON.parse(result.report_urls_json) as string[])].join('\n');
          const [defect] = await tx.insert(schema.defects).values({ code: createPublicCode(), feature_id: feature.id, title, severity,
            reported_by: principal.id, found_in: execution.tested_version, description, status: 'reported', related_requirement: relatedRequirementId }).returning();
          if (!defect) throw new DomainError('internal_error', '缺陷创建失败');
          defectCode = defect.code;
          await audit(tx, 'defect', defect.id, principal.id, 'defect.reported', 0, { test_execution_code: execution.code, test_result_code: result.code, severity });
        }
        await tx.update(schema.testExecutionResults).set({ defect_code: defectCode }).where(eq(schema.testExecutionResults.id, result.id));
        await audit(tx, 'test_execution', execution.id, principal.id, 'test_execution.defect_linked', 0, { result_code: result.code, defect_code: defectCode });
      });
      return getExecution(execution.code, principal.code);
    } catch (error) { return fail(error); }
  }
  return {
    listCases: (cmd: Filter): Promise<TaskResult<TestCaseSummary[]>> => cases.list(cmd),
    getCase: (code: string, principalCode: string): Promise<TaskResult<TestCaseDetail>> => cases.get(code, principalCode),
    createCase: (cmd: Scope & { input: TestCaseInput }): Promise<TaskResult<TestCaseDetail>> => cases.create(cmd),
    reviseCase: (cmd: { code: string; principalCode: string; input: TestCaseRevisionInput }): Promise<TaskResult<TestCaseDetail>> => cases.revise(cmd),
    async listAssets(cmd: Filter): Promise<TaskResult<TestAssetSummary[]>> { const result = await assets.list(cmd); return result.ok ? { ok: true, data: result.data.map(withoutTestFileBytes) } : result; },
    getAsset: (code: string, principalCode: string): Promise<TaskResult<TestAssetDetail>> => assets.get(code, principalCode),
    createAsset: (cmd: Scope & { input: TestAssetInput }): Promise<TaskResult<TestAssetDetail>> => assets.create(cmd),
    reviseAsset: (cmd: { code: string; principalCode: string; input: TestAssetRevisionInput }): Promise<TaskResult<TestAssetDetail>> => assets.revise(cmd),
    listExecutions, getExecution, createExecution, linkResultDefect,
  };
}
export type TestingUseCases = ReturnType<typeof createTestingUseCases>;
