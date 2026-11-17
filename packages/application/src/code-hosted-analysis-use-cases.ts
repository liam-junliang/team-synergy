import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import {
  CODE_UNDERSTANDING_MAX_BYTES, CodeArtifactSchema, CodeHostedAnalysisRequestSchema, CodeRunProgressSchema, CodeRunPublishSchema, CodeRunRegisterSchema,
  hasCodePublicationSensitiveText, type CodeHostedAnalysisJobView, type CodePlugin, type CodeRunSummary, type CodeSnapshot,
} from '@team-synergy/contracts';
import { assertProjectAccess, type AccessDb } from './project-access.js';
import { type TaskResult } from './task-service.js';
import { codeUnderstandingRunSummary, progressCodeUnderstandingRun, publishCodeUnderstandingRun } from './code-understanding-use-cases.js';

type Actor = { principalCode: string; projectCode: string };
type Capability = { jobCode: string; executorId: string; executionToken: string };
type Job = typeof schema.codeHostedAnalysisJobs.$inferSelect;
const jobs = schema.codeHostedAnalysisJobs, runs = schema.codeUnderstandingRuns;
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string) => new DomainError('code_understanding_invalid', message);
const conflict = (message: string) => new DomainError('code_understanding_conflict', message);
const expired = () => new DomainError('code_understanding_execution_expired', 'Hosted analysis execution has expired or changed');
const missing = () => new DomainError('code_understanding_not_found', 'Hosted analysis job not found');
const leaseExpiry = (seconds = 120) => new Date(Date.now() + Math.max(30, Math.min(600, seconds)) * 1000).toISOString();
async function result<T>(work: () => Promise<T>): Promise<TaskResult<T>> {
  try { return { ok: true, data: await work() }; }
  catch (cause) { return { ok: false, error: cause instanceof DomainError ? { code: cause.code, message: cause.message } : { code: 'internal_error', message: 'Hosted analysis operation failed' } }; }
}
function parse<T>(validator: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > CODE_UNDERSTANDING_MAX_BYTES || hasCodePublicationSensitiveText(value)) throw invalid('Invalid or sensitive hosted analysis input');
  const parsed = validator.safeParse(value); if (!parsed.success) throw invalid('Invalid hosted analysis input'); return parsed.data;
}
function validSource(remote: string, branch: string | null): branch is string {
  if (!branch || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) return false;
  if (remote.length > 2000 || /\s/.test(remote) || Array.from(remote).some(character => character.charCodeAt(0) < 32) || hasCodePublicationSensitiveText(remote)) return false;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(remote)) return !remote.includes('/../');
  try {
    const url = new URL(remote);
    return ['https:', 'ssh:'].includes(url.protocol) && !url.password && (url.protocol === 'ssh:' || !url.username) && !url.search && !url.hash && Boolean(url.hostname) && url.pathname.length > 1;
  } catch { return false; }
}

export interface HostedCodeAnalysisExecution {
  jobCode: string; executionToken: string; projectCode: string; principalCode: string;
  repository: { code: string; name: string; remote_url: string; default_branch: string };
  run: CodeRunSummary | null;
}

/** All mutation paths acquire project before job locks, including recovery and publication. */
export function createHostedCodeAnalysisUseCases(db: Db) {
  async function actor(conn: AccessDb, cmd: Actor, write = false) {
    const [principal] = await conn.select().from(schema.users).where(eq(schema.users.code, cmd.principalCode)).limit(1);
    const query = conn.select().from(schema.projects).where(eq(schema.projects.code, cmd.projectCode)).limit(1);
    const [project] = await (write ? query.for('update') : query);
    if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || !project) throw new DomainError('project_forbidden', 'Project access denied');
    const access = await assertProjectAccess(conn, project.id, principal.id, write ? 'write' : 'read');
    if (access.role === 'viewer') throw new DomainError('code_understanding_forbidden', 'Source-bearing knowledge is not available to viewers');
    return { project, principal };
  }
  async function jobView(conn: AccessDb, job: Job): Promise<CodeHostedAnalysisJobView> {
    const [project] = await conn.select({ code: schema.projects.code }).from(schema.projects).where(eq(schema.projects.id, job.project_id)).limit(1);
    const [repo] = await conn.select({ code: schema.projectRepositories.code, name: schema.projectRepositories.name }).from(schema.projectRepositories).where(eq(schema.projectRepositories.id, job.repository_id)).limit(1);
    if (!project || !repo) throw missing();
    return { job_code: job.code, project_code: project.code, repository_code: repo.code, repository_name: repo.name, branch: job.source_branch, status: job.status,
      run_code: job.run_code, error: job.error, created_at: job.created_at, updated_at: job.updated_at, execution_metadata: job.execution_metadata_json ? JSON.parse(job.execution_metadata_json) : null };
  }
  async function executionJob(conn: AccessDb, cmd: Capability) {
    const [before] = await conn.select().from(jobs).where(eq(jobs.code, cmd.jobCode)).limit(1);
    if (!before) throw expired();
    await conn.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, before.project_id)).limit(1).for('update');
    const [job] = await conn.select().from(jobs).where(eq(jobs.id, before.id)).limit(1).for('update');
    if (!job || job.status !== 'running' || job.executor_id !== cmd.executorId || job.execution_token !== cmd.executionToken || !job.lease_expires_at || job.lease_expires_at <= now()) throw expired();
    return job;
  }
  async function source(conn: AccessDb, job: Job) {
    const [principal] = await conn.select().from(schema.users).where(eq(schema.users.id, job.requester_id)).limit(1);
    const [project] = await conn.select().from(schema.projects).where(eq(schema.projects.id, job.project_id)).limit(1);
    if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || !project) throw new DomainError('project_forbidden', 'Analysis requester is no longer active');
    await assertProjectAccess(conn, project.id, principal.id, 'write');
    const [repo] = await conn.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.id, job.repository_id), eq(schema.projectRepositories.project_id, project.id))).limit(1).for('update');
    if (!repo || repo.status !== 'active' || repo.remote_url !== job.source_remote_url || repo.default_branch !== job.source_branch || !validSource(repo.remote_url, repo.default_branch)) throw conflict('Registered repository or its main branch changed; request a new analysis');
    return { principal, project, repo };
  }
  async function jobRun(conn: AccessDb, job: Job) {
    if (!job.run_code) throw conflict('Analysis has no attached run');
    const [run] = await conn.select().from(runs).where(and(eq(runs.code, job.run_code), eq(runs.project_id, job.project_id), eq(runs.repository_id, job.repository_id), eq(runs.created_by, job.requester_id))).limit(1);
    if (!run) throw conflict('Hosted analysis run binding is invalid');
    return run;
  }
  async function finishFailed(conn: AccessDb, job: Job, message: string) {
    await conn.update(jobs).set({ status: 'failed', error: message, execution_token: null, lease_expires_at: null, updated_at: now() }).where(eq(jobs.id, job.id));
    if (job.run_code) await conn.update(runs).set({ status: 'failed', message, revision: (await jobRun(conn, job)).revision + 1, updated_at: now() }).where(and(eq(runs.code, job.run_code), inArray(runs.status, ['preparing', 'indexing', 'awaiting_agent', 'validating', 'uploading'])));
  }
  async function executionSource(conn: AccessDb, job: Job) {
    try { return { ok: true as const, data: await source(conn, job) }; }
    catch (cause) {
      await finishFailed(conn, job, 'Project access or registered repository changed; request a new analysis');
      return { ok: false as const, error: cause instanceof DomainError ? cause : conflict('Analysis source changed') };
    }
  }

  return {
    enqueue: (cmd: Actor & { input: unknown }) => result(() => db.transaction(async tx => {
      const { project, principal } = await actor(tx, cmd, true), input = parse(CodeHostedAnalysisRequestSchema, cmd.input);
      const requestHash = hash({ repository_codes: input.repository_codes ? [...input.repository_codes].sort() : null });
      const existing = await tx.select().from(jobs).where(and(eq(jobs.project_id, project.id), eq(jobs.requester_id, principal.id), eq(jobs.request_key, input.idempotency_key))).orderBy(asc(jobs.id));
      if (existing.length) {
        if (existing.some(job => job.request_hash !== requestHash)) throw conflict('Idempotency key has different repository selections');
        return Promise.all(existing.map(job => jobView(tx, job)));
      }
      const repositories = await tx.select().from(schema.projectRepositories).where(and(eq(schema.projectRepositories.project_id, project.id), eq(schema.projectRepositories.status, 'active'))).orderBy(asc(schema.projectRepositories.id)).for('update');
      const selected = input.repository_codes ? repositories.filter(repo => input.repository_codes?.includes(repo.code)) : repositories;
      if (!selected.length || selected.length > 50 || (input.repository_codes && selected.length !== input.repository_codes.length)) throw invalid('Select active repositories belonging to this project');
      for (const repo of selected) {
        if (!validSource(repo.remote_url, repo.default_branch)) throw invalid('Each repository needs a remote Git URL without embedded credentials and one configured main branch');
        const [active] = await tx.select({ code: jobs.code }).from(jobs).where(and(eq(jobs.repository_id, repo.id), inArray(jobs.status, ['queued', 'running']))).limit(1);
        if (active) throw conflict('A selected repository already has an active mainline analysis');
      }
      const timestamp = now(), created: CodeHostedAnalysisJobView[] = [];
      for (const repo of selected) {
        const branch = repo.default_branch;
        if (!branch) throw invalid('Repository main branch is required');
        const [job] = await tx.insert(jobs).values({ project_id: project.id, repository_id: repo.id, requester_id: principal.id, request_key: input.idempotency_key, request_hash: requestHash,
          source_remote_url: repo.remote_url, source_branch: branch, created_at: timestamp, updated_at: timestamp }).returning();
        if (!job) throw missing(); created.push(await jobView(tx, job));
      }
      return created;
    })),
    listJobs: (cmd: Actor) => result(async () => {
      const { project } = await actor(db, cmd);
      const found = await db.select().from(jobs).where(eq(jobs.project_id, project.id)).orderBy(desc(jobs.id)).limit(100);
      return Promise.all(found.map(job => jobView(db, job)));
    }),
    getJob: (cmd: Actor & { jobCode: string }) => result(async () => {
      const { project } = await actor(db, cmd);
      const [job] = await db.select().from(jobs).where(and(eq(jobs.project_id, project.id), eq(jobs.code, cmd.jobCode))).limit(1);
      if (!job) throw missing(); return jobView(db, job);
    }),
    claimNextJob: (cmd: { executorId: string; leaseSeconds?: number }) => result<HostedCodeAnalysisExecution | null>(() => db.transaction(async tx => {
      if (!cmd.executorId || cmd.executorId.length > 200) throw invalid('Invalid analysis executor');
      const candidates = await tx.select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.id)).limit(20);
      for (const candidate of candidates) {
        const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, candidate.project_id)).limit(1).for('update', { skipLocked: true });
        if (!project) continue;
        const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'queued'))).limit(1).for('update', { skipLocked: true });
        if (!job) continue;
        const checked = await executionSource(tx, job);
        if (!checked.ok) continue;
        const token = randomUUID();
        await tx.update(jobs).set({ status: 'running', executor_id: cmd.executorId, execution_token: token, lease_expires_at: leaseExpiry(cmd.leaseSeconds), updated_at: now() }).where(eq(jobs.id, job.id));
        const { principal, project: target, repo } = checked.data;
        return { jobCode: job.code, executionToken: token, projectCode: target.code, principalCode: principal.code,
          repository: { code: repo.code, name: repo.name, remote_url: job.source_remote_url, default_branch: job.source_branch }, run: job.run_code ? codeUnderstandingRunSummary(await jobRun(tx, job)) : null };
      }
      return null;
    })),
    heartbeatJob: (cmd: Capability & { leaseSeconds?: number }) => result(() => db.transaction(async tx => {
      const job = await executionJob(tx, cmd), checked = await executionSource(tx, job);
      if (!checked.ok) return { active: false as const };
      await tx.update(jobs).set({ lease_expires_at: leaseExpiry(cmd.leaseSeconds), updated_at: now() }).where(eq(jobs.id, job.id));
      return { active: true as const };
    })),
    attachRun: (cmd: Capability & { plugins: CodePlugin[] }) => result(() => db.transaction(async tx => {
      const job = await executionJob(tx, cmd), { repo } = await source(tx, job);
      if (job.run_code) return codeUnderstandingRunSummary(await jobRun(tx, job));
      const request = parse(CodeRunRegisterSchema, { idempotency_key: `hosted:${job.code}`, repository_code: repo.code, requested_ref: job.source_branch, kind: 'commit', plugins: cmd.plugins });
      const timestamp = now();
      const [run] = await tx.insert(runs).values({ project_id: job.project_id, repository_id: job.repository_id, created_by: job.requester_id, request_key: request.idempotency_key,
        request_hash: hash(request), request_json: JSON.stringify(request), status: 'preparing', created_at: timestamp, updated_at: timestamp }).returning();
      if (!run) throw missing();
      await tx.update(jobs).set({ run_code: run.code, updated_at: timestamp }).where(eq(jobs.id, job.id));
      return codeUnderstandingRunSummary(run);
    })),
    progressJob: (cmd: Capability & { status: Exclude<CodeRunSummary['status'], 'succeeded'>; snapshot?: CodeSnapshot; message?: string }) => result(() => db.transaction(async tx => {
      const job = await executionJob(tx, cmd); await source(tx, job);
      const run = await jobRun(tx, job), input = parse(CodeRunProgressSchema, { expected_revision: run.revision, status: cmd.status, ...(cmd.snapshot ? { snapshot: cmd.snapshot } : {}), ...(cmd.message ? { message: cmd.message } : {}) });
      return codeUnderstandingRunSummary(await progressCodeUnderstandingRun(tx, run, input));
    })),
    completeJob: (cmd: Capability & { runCode: string; artifact: unknown; executionMetadata?: Record<string, unknown> }) => result(() => db.transaction(async tx => {
      const artifact = parse(CodeArtifactSchema, cmd.artifact);
      const [retry] = await tx.select().from(jobs).where(eq(jobs.code, cmd.jobCode)).limit(1);
      if (retry?.status === 'succeeded' && retry.executor_id === cmd.executorId && retry.completion_token_hash === hash(cmd.executionToken) && retry.run_code === cmd.runCode) {
        const run = await jobRun(tx, retry);
        if (run.artifact_sha256 === hash(artifact)) return jobView(tx, retry);
        throw conflict('Completed analysis has a different artifact');
      }
      const job = await executionJob(tx, cmd); await source(tx, job);
      const run = await jobRun(tx, job);
      if (run.code !== cmd.runCode || CodeRunRegisterSchema.parse(JSON.parse(run.request_json)).kind !== 'commit') throw conflict('Analysis run does not match the execution');
      const input = parse(CodeRunPublishSchema, { expected_revision: run.revision, artifact });
      if (!input.artifact.ua_graph || !input.artifact.ua_graph.layers.length || !input.artifact.ua_graph.tour.length || !input.artifact.ua_graph.nodes.some(node => ['module', 'concept', 'service', 'domain', 'flow'].includes(node.type))) throw invalid('Hosted analysis requires a complete native UA semantic graph');
      const published = await publishCodeUnderstandingRun(tx, run, input), snap = codeUnderstandingRunSummary(published).snapshot;
      if (!snap) throw conflict('Published analysis has no source identity');
      const [current] = await tx.select().from(schema.codeUnderstandingSelections).where(and(eq(schema.codeUnderstandingSelections.project_id, job.project_id), eq(schema.codeUnderstandingSelections.kind, 'commit'))).orderBy(desc(schema.codeUnderstandingSelections.id)).limit(1);
      const [base] = current ? await tx.select().from(schema.codeUnderstandingViews).where(and(eq(schema.codeUnderstandingViews.code, current.view_code), eq(schema.codeUnderstandingViews.project_id, job.project_id))).limit(1) : [];
      const merged = new Map<string, { repository_code: string; run_code: string; snapshot_id: string }>((base ? JSON.parse(base.selections_json) : []).map((item: { repository_code: string; run_code: string; snapshot_id: string }) => [item.repository_code, item]));
      const request = CodeRunRegisterSchema.parse(JSON.parse(published.request_json));
      merged.set(request.repository_code, { repository_code: request.repository_code, run_code: published.code, snapshot_id: snap.snapshot_id });
      const selections = [...merged.values()].sort((a, b) => a.repository_code.localeCompare(b.repository_code));
      if (selections.length > 50) throw invalid('Too many repositories in the project mainline');
      const contentHash = hash(selections);
      const [existing] = await tx.select().from(schema.codeUnderstandingViews).where(and(eq(schema.codeUnderstandingViews.project_id, job.project_id), eq(schema.codeUnderstandingViews.content_hash, contentHash))).limit(1);
      const view = existing ?? (await tx.insert(schema.codeUnderstandingViews).values({ project_id: job.project_id, kind: 'commit', selections_json: JSON.stringify(selections), content_hash: contentHash, created_by: job.requester_id, created_at: now() }).returning())[0];
      if (!view) throw missing();
      if (current?.view_code !== view.code) await tx.insert(schema.codeUnderstandingSelections).values({ project_id: job.project_id, kind: 'commit', view_code: view.code, selected_by: job.requester_id, selected_at: now() });
      if (cmd.executionMetadata && (Buffer.byteLength(JSON.stringify(cmd.executionMetadata)) > 20000 || hasCodePublicationSensitiveText(cmd.executionMetadata))) throw invalid('Execution metadata contains invalid or sensitive content');
      const [updated] = await tx.update(jobs).set({ status: 'succeeded', error: null, execution_token: null, lease_expires_at: null,
        completion_token_hash: hash(cmd.executionToken), execution_metadata_json: cmd.executionMetadata ? JSON.stringify(cmd.executionMetadata) : null, updated_at: now() }).where(eq(jobs.id, job.id)).returning();
      if (!updated) throw missing(); return jobView(tx, updated);
    })),
    failJob: (cmd: Capability & { message: string }) => result(() => db.transaction(async tx => {
      const job = await executionJob(tx, cmd);
      const message = typeof cmd.message === 'string' && cmd.message.length <= 2000 && !hasCodePublicationSensitiveText(cmd.message) ? cmd.message : 'Analysis execution failed; request a new analysis';
      await finishFailed(tx, job, message); return { failed: true as const };
    })),
    recoverExpiredJobs: () => result(() => db.transaction(async tx => {
      const candidates = await tx.select().from(jobs).where(and(eq(jobs.status, 'running'), lt(jobs.lease_expires_at, now()))).orderBy(asc(jobs.id)).limit(100);
      let recovered = 0;
      for (const candidate of candidates) {
        const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, candidate.project_id)).limit(1).for('update', { skipLocked: true });
        if (!project) continue;
        const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'running'), lt(jobs.lease_expires_at, now()))).limit(1).for('update', { skipLocked: true });
        if (!job) continue;
        await finishFailed(tx, job, 'Analysis worker disconnected or timed out; the previous mainline remains available'); recovered++;
      }
      return { recovered };
    })),
  };
}
