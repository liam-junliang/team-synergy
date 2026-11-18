import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { CODE_UNDERSTANDING_MAX_BYTES, CodeArtifactSchema, CodeGraphQuerySchema, CodeRunProgressSchema, CodeRunPublishSchema, CodeRunRegisterSchema, CodeViewComposeSchema, CodeViewSelectSchema, validateCodeArtifact, hasCodePublicationSensitiveText,
  type CodeArtifact, type CodeGraphResult, type CodeProjectView, type CodeRunRegister, type CodeRunSummary, type CodeSnapshot, type CodeUnderstandingContext, type CodeUaMapResult } from '@team-synergy/contracts';
import { assertProjectAccess, type AccessDb } from './project-access.js';
import { type TaskResult } from './task-service.js';

type Command = { principalCode: string; projectCode: string };
type RunCommand = Command & { code: string };
type Run = typeof schema.codeUnderstandingRuns.$inferSelect;
type View = typeof schema.codeUnderstandingViews.$inferSelect;
const runs = schema.codeUnderstandingRuns, views = schema.codeUnderstandingViews, selections = schema.codeUnderstandingSelections;
const runSummaryColumns = {
  code: runs.code,
  request_key: runs.request_key,
  request_json: runs.request_json,
  status: runs.status,
  revision: runs.revision,
  snapshot_json: runs.snapshot_json,
  message: runs.message,
  artifact_sha256: runs.artifact_sha256,
  created_at: runs.created_at,
  updated_at: runs.updated_at,
};
type RunSummaryRow = Pick<Run, keyof typeof runSummaryColumns>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string) => new DomainError('code_understanding_invalid', message);
const conflict = (message: string) => new DomainError('code_understanding_conflict', message);
const missing = () => new DomainError('code_understanding_not_found', 'Code understanding result not found');
function required<T>(value: T | undefined): T { if (value === undefined) throw missing(); return value; }
const terminal = (run: Run) => ['succeeded', 'failed', 'cancelled'].includes(run.status);
function assertRunCreator(run: Run, principalId: bigint) {
  if (run.created_by !== principalId) throw new DomainError('code_understanding_forbidden', 'Only the analysis creator may update or publish this run');
}
async function result<T>(work: () => Promise<T>): Promise<TaskResult<T>> {
  try { return { ok: true, data: await work() }; }
  catch (error) { return { ok: false, error: error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'internal_error', message: 'Code understanding operation failed' } }; }
}
function parse<T>(validator: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > CODE_UNDERSTANDING_MAX_BYTES) throw invalid(`Request exceeds ${CODE_UNDERSTANDING_MAX_BYTES / (1024 * 1024)} MiB`);
  if (hasCodePublicationSensitiveText(value)) throw invalid('Request contains a local absolute path or known credential pattern');
  const parsed = validator.safeParse(value); if (!parsed.success) throw invalid('Invalid code understanding request'); return parsed.data;
}
async function access(db: AccessDb, cmd: Command, write = false) {
  const [principal] = await db.select().from(schema.users).where(eq(schema.users.code, cmd.principalCode)).limit(1);
  const projectQuery = db.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode));
  const [project] = await (write ? projectQuery.for('update') : projectQuery).limit(1);
  if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || !project) throw new DomainError('project_forbidden', 'Project access denied');
  const role = await assertProjectAccess(db, project.id, principal.id, write ? 'write' : 'read');
  if (role.role === 'viewer') throw new DomainError('code_understanding_forbidden', 'Source-bearing knowledge is not available to viewers');
  return { project, principal };
}
async function runOf(db: AccessDb, projectId: bigint, code: string) {
  const [run] = await db.select().from(runs).where(and(eq(runs.project_id, projectId), eq(runs.code, code))).limit(1);
  if (!run) throw missing(); return run;
}
async function runSummaryOf(db: AccessDb, projectId: bigint, code: string) {
  const [run] = await db.select(runSummaryColumns).from(runs).where(and(eq(runs.project_id, projectId), eq(runs.code, code))).limit(1);
  return required(run);
}
async function viewOf(db: AccessDb, projectId: bigint, code: string) {
  const [view] = await db.select().from(views).where(and(eq(views.project_id, projectId), eq(views.code, code))).limit(1);
  if (!view) throw missing(); return view;
}
export function codeUnderstandingRunSummary(run: RunSummaryRow): CodeRunSummary {
  const request: CodeRunRegister = JSON.parse(run.request_json);
  let snapshot: CodeRunSummary['snapshot'] = null;
  if (run.snapshot_json) { const { files, ...identity }: CodeSnapshot = JSON.parse(run.snapshot_json); snapshot = { ...identity, file_count: files.length }; }
  return { code: run.code, repository_code: request.repository_code, requested_ref: request.requested_ref, kind: request.kind, runner: run.request_key.startsWith('hosted:') ? 'server_git' : 'member_cli', status: run.status as CodeRunSummary['status'], revision: run.revision,
    plugins: request.plugins, snapshot, message: run.message, artifact_sha256: run.artifact_sha256, created_at: run.created_at, updated_at: run.updated_at };
}
const summary = codeUnderstandingRunSummary;
function viewSummary(view: View): CodeProjectView { return { code: view.code, kind: view.kind, selections: JSON.parse(view.selections_json), created_at: view.created_at }; }
async function current(db: AccessDb, projectId: bigint, kind: 'commit' | 'draft') {
  const [row] = await db.select().from(selections).where(and(eq(selections.project_id, projectId), eq(selections.kind, kind))).orderBy(desc(selections.id)).limit(1);
  return row?.view_code ?? null;
}
function validateSnapshot(snapshot: CodeSnapshot, run: Run) {
  const request: CodeRunRegister = JSON.parse(run.request_json);
  const files = [...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => ({ path: file.path, sha256: file.sha256, line_count: file.line_count, byte_count: file.byte_count }));
  if (snapshot.kind !== request.kind || hash(files) !== snapshot.manifest_sha256 || hash({ kind: snapshot.kind, commit: snapshot.commit, tree: snapshot.tree, manifest_sha256: snapshot.manifest_sha256, scope: snapshot.scope, exclusions: snapshot.exclusions }) !== snapshot.snapshot_id) throw invalid('Snapshot content identity does not match');
  if (run.snapshot_json && hash(JSON.parse(run.snapshot_json)) !== hash(snapshot)) throw conflict('Run is already bound to another snapshot');
}

function assertNoCompleteSourceInMetadata(value: unknown, snapshot: CodeSnapshot) {
  const fileHashes = new Set(snapshot.files.filter(file => file.byte_count >= 16).map(file => file.sha256));
  function inspect(part: unknown): void {
    if (typeof part === 'string') {
      if (Buffer.byteLength(part, 'utf8') >= 16 && fileHashes.has(createHash('sha256').update(part).digest('hex'))) throw invalid('UA metadata contains complete source bytes');
    } else if (Array.isArray(part)) part.forEach(inspect);
    else if (part && typeof part === 'object') Object.values(part).forEach(inspect);
  }
  inspect(value);
}

async function reserveExcerptBudget(db: AccessDb, projectId: bigint, artifact: CodeArtifact, snapshot: CodeSnapshot) {
  type Claim = { digest: string; line_start: number; line_end: number; characters: number };
  const excerpts = new Map<string, typeof artifact.evidence>();
  for (const item of artifact.evidence) if (item.snippet !== undefined) {
    const items = excerpts.get(item.sha256) ?? []; items.push(item); excerpts.set(item.sha256, items);
  }
  for (const [sha, items] of excerpts) {
    const [saved] = await db.select().from(schema.codeUnderstandingExcerptBudgets).where(and(eq(schema.codeUnderstandingExcerptBudgets.project_id, projectId), eq(schema.codeUnderstandingExcerptBudgets.file_sha256, sha))).limit(1);
    const claims: Claim[] = saved ? JSON.parse(saved.claims_json) : [];
    for (const item of items) {
      const digest = hash({ start: item.line_start, end: item.line_end, snippet: item.snippet });
      if (!claims.some(claim => claim.digest === digest)) claims.push({ digest, line_start: item.line_start, line_end: item.line_end, characters: item.snippet?.length ?? 0 });
    }
    const lines = new Set<number>();
    for (const claim of claims) for (let line = claim.line_start; line <= claim.line_end; line++) lines.add(line);
    const lineCount = Math.min(...snapshot.files.filter(file => file.sha256 === sha).map(file => file.line_count));
    if (claims.reduce((total, claim) => total + claim.characters, 0) > 2400 || lines.size > 60 || lines.size >= lineCount) throw invalid('Cumulative excerpts for these source bytes exceed the publication budget');
    await db.insert(schema.codeUnderstandingExcerptBudgets).values({ project_id: projectId, file_sha256: sha, claims_json: JSON.stringify(claims) })
      .onConflictDoUpdate({ target: [schema.codeUnderstandingExcerptBudgets.project_id, schema.codeUnderstandingExcerptBudgets.file_sha256], set: { claims_json: JSON.stringify(claims) } });
  }
}

/** Caller holds the project lock; hosted workers additionally fence their execution lease. */
export async function progressCodeUnderstandingRun(db: AccessDb, run: Run, input: { expected_revision: number; status: CodeRunSummary['status']; snapshot?: CodeSnapshot; message?: string }) {
  if (input.snapshot) validateSnapshot(input.snapshot, run);
  if (run.revision === input.expected_revision + 1 && run.status === input.status && run.message === (input.message ?? null) && (!input.snapshot || hash(JSON.parse(run.snapshot_json ?? 'null')) === hash(input.snapshot))) return run;
  if (run.revision !== input.expected_revision || terminal(run)) throw conflict('Run revision or lifecycle changed');
  if (input.status !== 'preparing' && input.status !== 'failed' && input.status !== 'cancelled' && !input.snapshot && !run.snapshot_json) throw invalid('Capture a snapshot before analysis');
  const order = ['preparing', 'indexing', 'awaiting_agent', 'validating', 'uploading'];
  if (order.includes(input.status) && order.indexOf(input.status) < order.indexOf(run.status)) throw conflict('Run cannot move backwards');
  const [updated] = await db.update(runs).set({ status: input.status, revision: run.revision + 1, snapshot_json: input.snapshot ? JSON.stringify(input.snapshot) : run.snapshot_json, message: input.message ?? null, updated_at: new Date().toISOString() }).where(eq(runs.id, run.id)).returning();
  return required(updated);
}

/** Shared publication validation. The caller must hold the project lock and establish run authority. */
export async function publishCodeUnderstandingRun(db: AccessDb, run: Run, input: { expected_revision: number; artifact: CodeArtifact }) {
  const artifactHash = hash(input.artifact);
  if (run.status === 'succeeded' && run.artifact_sha256 === artifactHash) return run;
  if (terminal(run) || run.revision !== input.expected_revision || !run.snapshot_json) throw conflict('Run is not publishable');
  const snapshot: CodeSnapshot = JSON.parse(run.snapshot_json), issues = validateCodeArtifact(input.artifact, snapshot);
  if (issues.length) throw invalid(issues.join('; '));
  if (input.artifact.ua_graph) assertNoCompleteSourceInMetadata(input.artifact.ua_graph, snapshot);
  await reserveExcerptBudget(db, run.project_id, input.artifact, snapshot);
  const [updated] = await db.update(runs).set({ status: 'succeeded', revision: run.revision + 1, artifact_json: JSON.stringify(input.artifact), artifact_sha256: artifactHash, message: null, updated_at: new Date().toISOString() }).where(eq(runs.id, run.id)).returning();
  return required(updated);
}

async function assertMemberRun(db: AccessDb, run: Run) {
  const [hosted] = await db.select({ id: schema.codeHostedAnalysisJobs.id }).from(schema.codeHostedAnalysisJobs).where(eq(schema.codeHostedAnalysisJobs.run_code, run.code)).limit(1);
  if (hosted) throw new DomainError('code_understanding_forbidden', 'Hosted runs can only be changed by their active analysis worker');
}

export function createCodeUnderstandingUseCases(db: Db) {
  return {
    context: (cmd: Command) => result<CodeUnderstandingContext>(async () => {
      const { project } = await access(db, cmd);
      const repositories = await db.select({ code: schema.projectRepositories.code, name: schema.projectRepositories.name, default_branch: schema.projectRepositories.default_branch, status: schema.projectRepositories.status }).from(schema.projectRepositories).where(eq(schema.projectRepositories.project_id, project.id));
      const runRows = await db.select(runSummaryColumns).from(runs).where(eq(runs.project_id, project.id)).orderBy(desc(runs.id)).limit(101);
      const viewRows = await db.select().from(views).where(eq(views.project_id, project.id)).orderBy(desc(views.id)).limit(101);
      return { repositories, runs: runRows.slice(0, 100).map(summary), views: viewRows.slice(0, 100).map(viewSummary), current_view: await current(db, project.id, 'commit'), current_draft_view: await current(db, project.id, 'draft'), can_write: project.status === 'active', truncated: runRows.length > 100 || viewRows.length > 100 };
    }),
    register: (cmd: Command & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await access(tx, cmd, true), input = parse(CodeRunRegisterSchema, cmd.input);
      if (input.idempotency_key.startsWith('hosted:')) throw invalid('The hosted request namespace is reserved for server analysis');
      const [repo] = await tx.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.project_id, project.id), eq(schema.projectRepositories.code, input.repository_code))).limit(1);
      if (!repo || repo.status !== 'active') throw invalid('Repository must belong to this project and be active');
      if (input.workspace_code) {
        const [workspace] = await tx.select().from(schema.projectWorkspaces).where(and(eq(schema.projectWorkspaces.project_id, project.id), eq(schema.projectWorkspaces.code, input.workspace_code), eq(schema.projectWorkspaces.principal_id, principal.id), eq(schema.projectWorkspaces.status, 'active'))).limit(1);
        if (!workspace) throw invalid('Workspace must belong to this principal and project');
      }
      const [existing] = await tx.select().from(runs).where(and(eq(runs.project_id, project.id), eq(runs.created_by, principal.id), eq(runs.request_key, input.idempotency_key))).limit(1);
      if (existing) { if (existing.request_hash !== hash(input)) throw conflict('Idempotency key has different content'); return summary(existing); }
      const now = new Date().toISOString();
      const [run] = await tx.insert(runs).values({ project_id: project.id, repository_id: repo.id, created_by: principal.id, request_key: input.idempotency_key, request_hash: hash(input), request_json: JSON.stringify(input), status: 'preparing', created_at: now, updated_at: now }).returning();
      return summary(required(run));
    })),
    detail: (cmd: RunCommand) => result(async () => { const { project } = await access(db, cmd); return summary(await runSummaryOf(db, project.id, cmd.code)); }),
    progress: (cmd: RunCommand & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await access(tx, cmd, true), input = parse(CodeRunProgressSchema, cmd.input), run = await runOf(tx, project.id, cmd.code);
      assertRunCreator(run, principal.id);
      await assertMemberRun(tx, run);
      return summary(await progressCodeUnderstandingRun(tx, run, input));
    })),
    publish: (cmd: RunCommand & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await access(tx, cmd, true), input = parse(CodeRunPublishSchema, cmd.input), run = await runOf(tx, project.id, cmd.code);
      assertRunCreator(run, principal.id);
      await assertMemberRun(tx, run);
      if (input.artifact.semantic_analysis) throw new DomainError('code_understanding_forbidden', 'Full semantic reports must be generated through the server hosted analysis workflow');
      return summary(await publishCodeUnderstandingRun(tx, run, input));
    })),
    compose: (cmd: Command & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await access(tx, cmd, true), input = parse(CodeViewComposeSchema, cmd.input);
      const base = input.base_view_code ? viewSummary(await viewOf(tx, project.id, input.base_view_code)).selections : [];
      const merged = new Map(base.map(selection => [selection.repository_code, selection]));
      for (const selection of input.selections) {
        const item = summary(await runSummaryOf(tx, project.id, selection.run_code));
        if (item.status !== 'succeeded' || !item.snapshot || item.repository_code !== selection.repository_code) throw invalid('View requires published runs belonging to the specified repositories');
        merged.set(item.repository_code, { repository_code: item.repository_code, run_code: item.code, snapshot_id: item.snapshot.snapshot_id });
      }
      const selected = [...merged.values()].sort((a, b) => a.repository_code.localeCompare(b.repository_code));
      if (selected.length > 50) throw invalid('Too many repositories');
      let kind: 'commit' | 'draft' = 'commit';
      for (const selection of selected) if (summary(await runSummaryOf(tx, project.id, selection.run_code)).kind === 'draft') kind = 'draft';
      const contentHash = hash(selected);
      const [old] = await tx.select().from(views).where(and(eq(views.project_id, project.id), eq(views.content_hash, contentHash))).limit(1);
      if (old) return viewSummary(old);
      const [view] = await tx.insert(views).values({ project_id: project.id, kind, selections_json: JSON.stringify(selected), content_hash: contentHash, created_by: principal.id, created_at: new Date().toISOString() }).returning();
      return viewSummary(required(view));
    })),
    select: (cmd: RunCommand & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await access(tx, cmd, true), input = parse(CodeViewSelectSchema, cmd.input), view = await viewOf(tx, project.id, cmd.code);
      const currentCode = await current(tx, project.id, view.kind);
      if (currentCode === view.code) return viewSummary(view);
      if (currentCode !== input.expected_current) throw conflict('Current view changed; reload before selecting');
      await tx.insert(selections).values({ project_id: project.id, kind: view.kind, view_code: view.code, selected_by: principal.id, selected_at: new Date().toISOString() });
      return viewSummary(view);
    })),
    uaMap: (cmd: RunCommand) => result<CodeUaMapResult>(async () => {
      const { project } = await access(db, cmd), row = await runOf(db, project.id, cmd.code), run = summary(row);
      if (row.status !== 'succeeded' || !row.artifact_json || !run.snapshot) throw conflict('Run has no published projection');
      const artifact = CodeArtifactSchema.parse(JSON.parse(row.artifact_json));
      const scope = { run_code: run.code, repository_code: run.repository_code, snapshot_id: run.snapshot.snapshot_id };
      const nodes = artifact.nodes.filter(node => node.provider === 'ua'), ids = new Set(nodes.map(node => node.id));
      const edges = artifact.edges.filter(edge => edge.provider === 'ua' && ids.has(edge.source) && ids.has(edge.target));
      return { run, graph: artifact.ua_graph ?? null, metadata_complete: Boolean(artifact.ua_graph), ...(artifact.semantic_analysis ? { reader_profile: 'full_system' as const } : {}), projection: {
        source: 'published_projection', runs: [run], view: null, nodes: nodes.map(node => ({ ...node, ...scope })), edges: edges.map(edge => ({ ...edge, ...scope })), evidence: [],
        tour: artifact.tour.map(step => ({ ...step, node_ids: step.node_ids.filter(id => ids.has(id)), ...scope })), coverage: artifact.coverage.filter(item => item.provider === 'ua').map(item => ({ ...item, ...scope })),
        total_nodes: nodes.length, offset: 0, limit: nodes.length, truncated: false, capabilities: ['ua_map'],
      } };
    }),
    graph: (cmd: Command & { input: unknown }) => result<CodeGraphResult>(async () => {
      const { project } = await access(db, cmd), query = parse(CodeGraphQuerySchema, cmd.input);
      const viewCode = query.view_code ?? (!query.run_code ? await current(db, project.id, 'commit') : null);
      const view = viewCode ? viewSummary(await viewOf(db, project.id, viewCode)) : null;
      const runCodes = query.run_code ? [query.run_code] : view?.selections.map(item => item.run_code) ?? [];
      const nodes: CodeGraphResult['nodes'] = [], edges: CodeGraphResult['edges'] = [], evidence: CodeGraphResult['evidence'] = [], selectedRuns: CodeRunSummary[] = [], tour: CodeGraphResult['tour'] = [], coverage: CodeGraphResult['coverage'] = [];
      let totalNodes = 0, budgetTruncated = false;
      for (const code of runCodes) {
        const run = await runOf(db, project.id, code), item = summary(run);
        if (run.status !== 'succeeded' || !run.artifact_json || !item.snapshot) throw conflict('Run has no published projection');
        const artifact = CodeArtifactSchema.parse(JSON.parse(run.artifact_json));
        const qualified = { run_code: run.code, repository_code: item.repository_code, snapshot_id: item.snapshot.snapshot_id };
        selectedRuns.push(item); coverage.push(...artifact.coverage.map(row => ({ ...row, ...qualified })));
        const remainingTour = Math.max(0, 100 - tour.length);
        tour.push(...artifact.tour.slice(0, remainingTour).map(row => ({ ...row, ...qualified })));
        if (artifact.tour.length > remainingTour) budgetTruncated = true;
        let relevant = artifact.nodes;
        if (query.node_id) {
          if (!artifact.nodes.some(node => node.id === query.node_id)) throw missing();
          const ids = new Set([query.node_id]);
          for (const edge of artifact.edges) if ((query.direction !== 'in' && edge.source === query.node_id) || (query.direction !== 'out' && edge.target === query.node_id)) { ids.add(edge.source); ids.add(edge.target); }
          relevant = relevant.filter(node => ids.has(node.id));
        }
        const needle = query.query?.toLocaleLowerCase();
        const metadataText = (meta: CodeArtifact['nodes'][number]['domain_meta']) => [
          ...(meta?.businessRules ?? []), ...(meta?.entities ?? []), ...(meta?.userPurposes ?? []), ...(meta?.unknowns ?? []), ...(meta?.crossDomainInteractions ?? []),
        ].join(' ');
        const domainText = new Map(artifact.ua_graph?.nodes.map(node => [node.id, metadataText(node.domainMeta)]));
        relevant = relevant.filter(node => (!query.provider || node.provider === query.provider) && (!needle || `${node.label} ${node.summary ?? ''} ${node.path ?? ''} ${node.provider === 'ua' ? metadataText(node.domain_meta) || domainText.get(node.native_id) || '' : ''}`.toLocaleLowerCase().includes(needle)));
        if (query.node_id) relevant.sort((a, b) => Number(b.id === query.node_id) - Number(a.id === query.node_id));
        else if (query.provider === 'ua') {
          const overviewKinds = new Set(['domain', 'module', 'capability', 'concept', 'service', 'component', 'flow', 'layer']);
          relevant.sort((a, b) => Number(overviewKinds.has(b.kind.toLowerCase())) - Number(overviewKinds.has(a.kind.toLowerCase())));
        }
        const start = Math.max(0, query.offset - totalNodes), available = Math.max(0, query.limit - nodes.length);
        const page = relevant.slice(start, start + available);
        totalNodes += relevant.length;
        const ids = new Set(page.map(node => node.id));
        const relatedEdges = artifact.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target) && (!query.node_id || (query.direction !== 'in' && edge.source === query.node_id) || (query.direction !== 'out' && edge.target === query.node_id)));
        const edgePage = relatedEdges.slice(0, Math.max(0, 1000 - edges.length));
        const evidenceIds = new Set([...page.flatMap(node => node.evidence_ids), ...edgePage.flatMap(edge => edge.evidence_ids)]);
        const relatedEvidence = artifact.evidence.filter(item => evidenceIds.has(item.id));
        const evidencePage = relatedEvidence.slice(0, Math.max(0, 1000 - evidence.length));
        if (edgePage.length < relatedEdges.length || evidencePage.length < relatedEvidence.length) budgetTruncated = true;
        nodes.push(...page.map(node => ({ ...node, ...qualified })));
        edges.push(...edgePage.map(edge => ({ ...edge, ...qualified })));
        evidence.push(...evidencePage.map(item => ({ ...item, ...qualified })));
      }
      return { source: 'published_projection', runs: selectedRuns, view, nodes, edges, evidence, tour, coverage, total_nodes: totalNodes, offset: query.offset, limit: query.limit,
        truncated: query.offset + nodes.length < totalNodes || budgetTruncated, capabilities: ['overview', 'search', 'node', 'relations'] };
    }),
  };
}
