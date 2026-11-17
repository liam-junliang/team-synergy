import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createHostedCodeAnalysisUseCases, createCodeUnderstandingUseCases } from '../dist/index.js';
import { seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ok = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.data; };
const bad = (value, code) => { assert.equal(value.ok, false, JSON.stringify(value)); if (code) assert.equal(value.error.code, code); };
const plugins = ['ua', 'codegraph'].map(plugin_id => ({ plugin_id, engine_version: '1', adapter_version: '1', protocol_version: 1, engine_digest: 'f'.repeat(64) }));

function snapshot(commit = 'a'.repeat(40)) {
  const files = [{ path: 'src/auth.ts', sha256: 'c'.repeat(64), line_count: 100, byte_count: 1000 }];
  const identity = { kind: 'commit', commit, tree: 'b'.repeat(40), manifest_sha256: hash(files), scope: ['.'], exclusions: [] };
  return { snapshot_id: hash(identity), ...identity, captured_at: '2026-11-12T00:00:00.000Z', files };
}
function artifact(snap) {
  return { schema_version: 1, snapshot_id: snap.snapshot_id,
    nodes: [{ id: 'ua:auth', native_id: 'auth', provider: 'ua', kind: 'module', label: 'Authentication', summary: 'Login capability', layer: 'Services', path: 'src/auth.ts', line_start: 2, line_end: 5, evidence_ids: ['e'], verification: 'inferred' },
      { id: 'cg:auth', native_id: 'auth', provider: 'codegraph', kind: 'function', label: 'authenticate', path: 'src/auth.ts', line_start: 2, line_end: 5, evidence_ids: ['e'], verification: 'observed' }],
    edges: [{ id: 'bridge', source: 'ua:auth', target: 'cg:auth', type: 'implemented_by', provider: 'bridge', provenance: 'inferred', evidence_ids: ['e'], verification: 'inferred' }],
    evidence: [{ id: 'e', path: 'src/auth.ts', sha256: 'c'.repeat(64), line_start: 2, line_end: 5, snippet: 'function authenticate() {}' }],
    tour: [{ title: 'Auth', description: 'Authentication flow', node_ids: ['ua:auth'] }],
    coverage: ['ua', 'codegraph'].map(provider => ({ provider, analyzed_files: 1, total_files: 1, limitations: ['Static analysis'] })),
    semantic_author: { kind: 'agent', model: 'workbuddy/deepseek-v4.1-flash', prompt_version: 'hosted-1' },
    ua_graph: { version: '1.0.0', kind: 'codebase', project: { name: 'Example', languages: ['TypeScript'], frameworks: [], description: 'Authentication system', analyzedAt: snap.captured_at, gitCommitHash: snap.commit },
      nodes: [{ id: 'auth', type: 'module', name: 'Authentication', summary: 'Login capability', tags: ['auth'], complexity: 'moderate', filePath: 'src/auth.ts', lineRange: [2, 5] }], edges: [],
      layers: [{ id: 'services', name: 'Services', description: 'Module responsibilities', nodeIds: ['auth'] }],
      tour: [{ order: 0, title: 'Auth', description: 'Authentication flow', nodeIds: ['auth'] }] },
  };
}
async function setup(count = 2) {
  const db = fixture.db, ctx = await seedWorkspaceProject(db, { users: [{ key: 'owner', account: 'owner', displayName: 'Owner', projectRole: 'owner' }, { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' }] });
  const repos = [];
  for (let index = 0; index < count; index++) repos.push((await db.insert(schema.projectRepositories).values({ project_id: ctx.project.id, name: `Repository ${index}`, remote_url: `https://example.invalid/repo-${index}.git`, default_branch: 'main', created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning())[0]);
  return { ...ctx, db, repos, store: createHostedCodeAnalysisUseCases(db), uc: createCodeUnderstandingUseCases(db), actor: { projectCode: ctx.project.code, principalCode: ctx.users.owner.code } };
}
async function claim(f, executorId = 'worker') {
  const execution = ok(await f.store.claimNextJob({ executorId })); assert(execution);
  return { execution, capability: { jobCode: execution.jobCode, executorId, executionToken: execution.executionToken } };
}
async function prepare(f, capability, snap = snapshot()) {
  const run = ok(await f.store.attachRun({ ...capability, plugins }));
  assert.equal(run.runner, 'server_git');
  const attached = ok(await f.store.attachRun({ ...capability, plugins })); assert.equal(attached.code, run.code);
  ok(await f.store.progressJob({ ...capability, status: 'indexing', snapshot: snap }));
  return { run, snap, content: artifact(snap) };
}
async function publishOne(f, key, repo = f.repos[0], snap = snapshot()) {
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: key, repository_codes: [repo.code] } }));
  const { capability } = await claim(f), prepared = await prepare(f, capability, snap);
  const job = ok(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content }));
  return { ...prepared, capability, job };
}

test('hosted requests accept repository IDs only, enforce project ACL and persist exact idempotent selections', async () => {
  const f = await setup();
  bad(await f.store.enqueue({ ...f.actor, principalCode: f.users.viewer.code, input: { idempotency_key: 'denied' } }), 'project_forbidden');
  bad(await f.store.listJobs({ ...f.actor, principalCode: f.users.viewer.code }), 'code_understanding_forbidden');
  for (const extra of [{ path: '/tmp/repo' }, { branch: 'dev' }, { remote_url: 'https://other.invalid/repo' }]) bad(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'invalid', ...extra } }), 'code_understanding_invalid');
  const input = { idempotency_key: 'all' }, initial = ok(await f.store.enqueue({ ...f.actor, input }));
  assert.equal(initial.length, 2); assert(initial.every(job => job.status === 'queued' && job.branch === 'main'));
  assert.deepEqual(ok(await createHostedCodeAnalysisUseCases(f.db).enqueue({ ...f.actor, input })), initial);
  bad(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'all', repository_codes: [f.repos[0].code] } }), 'code_understanding_conflict');
  bad(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'duplicate' } }), 'code_understanding_conflict');
  assert.equal(ok(await f.store.listJobs(f.actor)).length, 2);
  const [other] = await f.db.insert(schema.projects).values({ team_id: f.project.team_id, owner_principal_id: f.users.owner.id, name: 'Other' }).returning();
  bad(await f.store.enqueue({ ...f.actor, projectCode: other.code, input: { idempotency_key: 'foreign', repository_codes: [f.repos[0].code] } }), 'code_understanding_invalid');
  bad(await f.store.getJob({ ...f.actor, projectCode: other.code, jobCode: initial[0].job_code }), 'code_understanding_not_found');
  const serialized = JSON.stringify(initial); assert(!serialized.includes('source_remote_url')); assert(!serialized.includes('execution_token'));
});

test('two worker completions merge the latest project mainline without losing another repository', async () => {
  const f = await setup(); ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'both' } }));
  const concurrent = await Promise.all(['worker-a', 'worker-b'].map(async executorId => ({ execution: ok(await f.store.claimNextJob({ executorId })), executorId })));
  const claimed = concurrent.filter(item => item.execution).map(({ execution, executorId }) => ({ execution, capability: { jobCode: execution.jobCode, executorId, executionToken: execution.executionToken } }));
  // A project lock may cause the other worker to yield until its next poll.
  while (claimed.length < 2) claimed.push(await claim(f, 'worker-c'));
  const [first, second] = claimed;
  assert.notEqual(first.execution.repository.code, second.execution.repository.code);
  assert.equal(ok(await f.store.claimNextJob({ executorId: 'extra' })), null);
  assert.equal(first.execution.repository.remote_url.startsWith('https://'), true);
  const prepared = await Promise.all([first, second].map(value => prepare(f, value.capability)));
  await Promise.all([first, second].map(async (value, index) => ok(await f.store.completeJob({ ...value.capability, runCode: prepared[index].run.code, artifact: prepared[index].content, executionMetadata: { runner: 'server', model: 'workbuddy/deepseek-v4.1-flash' } }))));
  const context = ok(await f.uc.context(f.actor)), view = context.views.find(item => item.code === context.current_view);
  assert.equal(view.selections.length, 2); assert.equal(new Set(view.selections.map(item => item.repository_code)).size, 2);
  const graph = ok(await f.uc.graph({ ...f.actor, input: {} })); assert.equal(graph.runs.length, 2); assert.equal(graph.nodes.length, 4);
  const jobs = ok(await f.store.listJobs(f.actor)); assert(jobs.every(job => job.status === 'succeeded' && job.run_code));
});

test('UA reader profile follows a validated hosted full-source report while historical graphs retain legacy behavior', async () => {
  const f = await setup(1), previous = await publishOne(f, 'reader-legacy');
  assert.equal(ok(await f.uc.uaMap({ ...f.actor, code: previous.run.code })).reader_profile, undefined);
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'reader-full' } }));
  const { capability } = await claim(f), prepared = await prepare(f, capability), snap = prepared.snap;
  prepared.content.semantic_analysis = {
    protocol_version: 2, mode: 'full', snapshot_id: snap.snapshot_id, manifest_sha256: snap.manifest_sha256, prompt_version: 'full-reader-test',
    file_coverage: [{ path: 'src/auth.ts', sha256: 'c'.repeat(64), total_bytes: 1000, covered_bytes: 1000, segments: [{ id: `segment:${'1'.repeat(32)}`, input_sha256: '1'.repeat(64), byte_start: 0, byte_end: 1000, line_start: 1, line_end: 100, completed: true }] }],
    node_evidence: [{ node_id: 'ua:auth', evidence_ids: ['e'] }], relation_evidence: [],
    counts: { total_files: 1, total_bytes: 1000, covered_bytes: 1000, total_segments: 1, completed_segments: 1, supported_nodes: 1, supported_relations: 0, native_dependency_relations: 0, semantic_inference_relations: 0, unresolved_items: 0 },
    uncertainty: { semantic_correctness: 'requires_independent_evaluation', unresolved_items: 0, limitations: ['Coverage does not establish semantic correctness'] },
  };
  ok(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content }));
  assert.equal(ok(await f.uc.uaMap({ ...f.actor, code: prepared.run.code })).reader_profile, 'full_system');
  assert.equal(ok(await f.uc.uaMap({ ...f.actor, code: previous.run.code })).reader_profile, undefined);
});

test('lease fencing, recovery and public run endpoints cannot publish a late hosted worker result', async () => {
  const f = await setup(1), previous = await publishOne(f, 'initial'), current = ok(await f.uc.context(f.actor)).current_view;
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'next' } }));
  const { capability } = await claim(f), prepared = await prepare(f, capability);
  const cmd = { ...f.actor, code: prepared.run.code };
  bad(await f.uc.progress({ ...cmd, input: { expected_revision: 1, status: 'cancelled' } }), 'code_understanding_forbidden');
  bad(await f.uc.publish({ ...cmd, input: { expected_revision: 1, artifact: prepared.content } }), 'code_understanding_forbidden');
  bad(await f.store.completeJob({ ...capability, executionToken: 'wrong', runCode: prepared.run.code, artifact: prepared.content }), 'code_understanding_execution_expired');
  await f.db.update(schema.codeHostedAnalysisJobs).set({ lease_expires_at: '2000-01-01T00:00:00.000Z' }).where(eq(schema.codeHostedAnalysisJobs.code, capability.jobCode));
  assert.equal(ok(await f.store.recoverExpiredJobs()).recovered, 1);
  bad(await f.store.heartbeatJob(capability), 'code_understanding_execution_expired');
  bad(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content }), 'code_understanding_execution_expired');
  assert.equal(ok(await f.uc.context(f.actor)).current_view, current);
  assert.equal(ok(await f.uc.detail(cmd)).status, 'failed');
  assert.equal(ok(await f.uc.uaMap({ ...f.actor, code: previous.run.code })).graph.project.gitCommitHash, previous.snap.commit);
});

test('source or requester changes stop an executing job and keep the prior readable mainline', async () => {
  const f = await setup(1); await publishOne(f, 'initial'); const current = ok(await f.uc.context(f.actor)).current_view;
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'branch' } }));
  const { capability } = await claim(f); await prepare(f, capability);
  await f.db.update(schema.projectRepositories).set({ default_branch: 'next' }).where(eq(schema.projectRepositories.id, f.repos[0].id));
  assert.deepEqual(ok(await f.store.heartbeatJob(capability)), { active: false });
  assert.equal(ok(await f.store.getJob({ ...f.actor, jobCode: capability.jobCode })).status, 'failed');
  assert.equal(ok(await f.uc.context(f.actor)).current_view, current);
  await f.db.update(schema.projectRepositories).set({ default_branch: 'main' }).where(eq(schema.projectRepositories.id, f.repos[0].id));
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'revoked' } }));
  const queued = ok(await f.store.listJobs(f.actor))[0];
  await f.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, f.project.id));
  assert.equal(ok(await f.store.claimNextJob({ executorId: 'worker' })), null);
  assert.equal(ok(await f.store.getJob({ ...f.actor, jobCode: queued.job_code })).status, 'failed');
  assert.equal(ok(await f.uc.context(f.actor)).current_view, current);
});

test('publication is atomic, semantic artifacts are required, and completion retries never re-promote old mainlines', async () => {
  const f = await setup(1), initial = await publishOne(f, 'initial'), current = ok(await f.uc.context(f.actor)).current_view;
  ok(await f.store.enqueue({ ...f.actor, input: { idempotency_key: 'invalid' } }));
  const { capability } = await claim(f), prepared = await prepare(f, capability);
  const invalid = structuredClone(prepared.content); delete invalid.ua_graph;
  bad(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: invalid }), 'code_understanding_invalid');
  const mismatch = structuredClone(prepared.content); mismatch.ua_graph.project.gitCommitHash = 'f'.repeat(40);
  bad(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: mismatch }), 'code_understanding_invalid');
  bad(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content, executionMetadata: { workspace: 'F:/member/checkout' } }), 'code_understanding_invalid');
  assert.equal(ok(await f.uc.detail({ ...f.actor, code: prepared.run.code })).status, 'indexing');
  assert.equal(ok(await f.uc.context(f.actor)).current_view, current);
  const done = ok(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content }));
  assert.equal(done.status, 'succeeded');
  const later = await publishOne(f, 'later', f.repos[0], snapshot('d'.repeat(40))), latest = ok(await f.uc.context(f.actor)).current_view;
  assert.equal(ok(await f.store.completeJob({ ...capability, runCode: prepared.run.code, artifact: prepared.content })).job_code, done.job_code);
  assert.equal(ok(await f.uc.context(f.actor)).current_view, latest);
  assert.notEqual(later.run.code, initial.run.code);
});
