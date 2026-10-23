import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createProjectDocumentUseCases, createSystemAgentUseCases, normalizeSystemAgentProposal } from '../dist/index.js';
import { insertProject, seedWorkspaceProject, useTestDb } from './test-db.mjs';

// This suite deliberately exercises real transactions, but never a service database.
const testUrl = process.env.TSP_TEST_DATABASE_URL;
if (testUrl && new URL(testUrl).pathname !== '/team_synergy_test') throw new Error('System Agent tests require isolated team_synergy_test');
const fixture = useTestDb(import.meta.url);
const proposal = { title: 'Revised guide', summary: 'Draft summary', content: '# Revised guide\n\n## Purpose\n\nClarified scope.\n\n## Source\n\nOriginal guide.', rationale: 'Clarify the existing scope.', evidence: ['Current document revision 1'], warnings: ['Business intent requires confirmation.'] };
const unwrap = value => { assert.equal(value.ok, true, JSON.stringify(value)); return value.data; };

async function setup() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { teamName: 'System Agent Team', projectName: 'System Agent', users: [
    { key: 'owner', account: 'agent.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'author', account: 'agent.author', displayName: 'Author', projectRole: 'member' },
    { key: 'other', account: 'agent.other', displayName: 'Other', projectRole: 'member' },
    { key: 'viewer', account: 'agent.viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  const documents = createProjectDocumentUseCases(db);
  const document = unwrap(await documents.createDocument({ projectCode: seeded.project.code, principalCode: seeded.users.author.code, kind: 'doc', title: 'Original guide', content: '# Original guide\n\n## Purpose\n\nOriginal scope.' }));
  const uc = createSystemAgentUseCases(db);
  const command = { projectCode: seeded.project.code, principalCode: seeded.users.author.code, documentCode: document.document_code, baseRevision: 1, instruction: 'Clarify scope', quote: 'Original scope.', requestKey: 'request-1' };
  const create = async extra => unwrap(await uc.createJob({ ...command, ...extra }));
  const claim = async () => {
    const job = unwrap(await uc.claimNextJob({ executorId: 'worker-1' }));
    assert.ok(job);
    return { jobCode: job.job_code, executorId: 'worker-1', executionToken: job.execution_token };
  };
  const draft = async () => { const job = await create(); const execution = await claim(); const drafted = unwrap(await uc.completeJob({ ...execution, proposal })); return { job, execution, drafted }; };
  const actor = job => ({ jobCode: job.job_code, principalCode: seeded.users.author.code });
  return { db, ...seeded, documents, document, uc, command, create, claim, draft, actor };
}

test('draft is durable and exact confirmation creates one immutable revision with linked audit', async () => {
  const ctx = await setup();
  const { job, drafted } = await ctx.draft();
  assert.equal(drafted.status, 'awaiting_review');
  assert.equal(drafted.can_apply, true);
  assert.equal(drafted.proposal_hash.length, 64);
  assert.equal(drafted.quality.source_kind, 'system_agent_draft');
  assert.equal(unwrap(await ctx.documents.getDocument(ctx.document.document_code, ctx.users.author.code)).current_revision, 1);
  // A newly constructed use-case instance can resume the durable review.
  const reloaded = unwrap(await createSystemAgentUseCases(ctx.db).getJob(ctx.actor(job)));
  assert.deepEqual(reloaded.proposal, proposal);
  assert.equal('execution_token' in reloaded, false);
  assert.equal('executor_id' in reloaded, false);
  const command = { ...ctx.actor(job), proposalHash: drafted.proposal_hash, baseRevision: 1 };
  const [a, b] = await Promise.all([ctx.uc.applyJob(command), ctx.uc.applyJob(command)]);
  assert.equal(unwrap(a).applied_revision, 2);
  assert.equal(unwrap(b).applied_revision, 2);
  const stored = unwrap(await ctx.documents.getDocument(ctx.document.document_code, ctx.users.author.code));
  assert.equal(stored.current_revision, 2);
  assert.equal(stored.revisions.length, 2);
  assert.equal(stored.revisions[1].content, job.base_content);
  assert.equal(stored.revisions[0].content, proposal.content);
  const audits = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'system_agent.applied'));
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].payload).proposal_hash, drafted.proposal_hash);
});

test('create request idempotency detects changed instruction and validates quote/version', async () => {
  const ctx = await setup();
  const [first, second] = await Promise.all([ctx.uc.createJob(ctx.command), ctx.uc.createJob(ctx.command)]);
  assert.equal(unwrap(first).job_code, unwrap(second).job_code);
  assert.equal((await ctx.uc.createJob({ ...ctx.command, instruction: 'Different change' })).error.code, 'system_agent_request_conflict');
  assert.equal((await ctx.uc.createJob({ ...ctx.command, requestKey: 'other', quote: 'Not in source' })).error.code, 'system_agent_quote_mismatch');
  assert.equal((await ctx.uc.createJob({ ...ctx.command, requestKey: 'other', baseRevision: 2 })).error.code, 'system_agent_revision_conflict');
});

test('only active authorized document editors create jobs; project and requester boundaries hold', async () => {
  const ctx = await setup();
  for (const user of ['viewer', 'other']) assert.equal((await ctx.uc.createJob({ ...ctx.command, principalCode: ctx.users[user].code })).ok, false);
  const foreign = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Foreign project' });
  const foreignDocument = await ctx.db.insert(schema.projectDocuments).values({ project_id: foreign.id, title: 'Foreign secret', content: 'Secret', created_by: ctx.users.author.id, updated_by: ctx.users.author.id, created_at: 't0', updated_at: 't0' }).returning();
  assert.equal((await ctx.uc.createJob({ ...ctx.command, documentCode: foreignDocument[0].code })).error.code, 'system_agent_document_unsupported');
  const job = await ctx.create();
  assert.equal((await ctx.uc.getJob({ jobCode: job.job_code, principalCode: ctx.users.owner.code })).error.code, 'system_agent_job_not_found');
  assert.equal(unwrap(await ctx.uc.listJobs({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code })).length, 0);
  await ctx.db.delete(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  assert.equal((await ctx.uc.getJob(ctx.actor(job))).error.code, 'project_forbidden');
  assert.equal((await ctx.uc.listJobs({ projectCode: ctx.project.code, principalCode: ctx.users.author.code })).error.code, 'project_forbidden');
});

test('changed confirmation hash/base is rejected without adopting', async () => {
  const ctx = await setup();
  const { job, drafted } = await ctx.draft();
  for (const change of [{ proposalHash: 'wrong', baseRevision: 1 }, { proposalHash: drafted.proposal_hash, baseRevision: 2 }]) {
    assert.equal((await ctx.uc.applyJob({ ...ctx.actor(job), ...change })).error.code, 'system_agent_confirmation_mismatch');
  }
  assert.equal(unwrap(await ctx.documents.getDocument(ctx.document.document_code, ctx.users.author.code)).current_revision, 1);
});

test('manual revision between proposal and adoption blocks stale write', async () => {
  const ctx = await setup();
  const { job, drafted } = await ctx.draft();
  unwrap(await ctx.documents.reviseDocument({ documentCode: ctx.document.document_code, principalCode: ctx.users.author.code, baseRevision: 1,
    title: 'Manual edit', content: '# Manual edit', changeSummary: 'Keep newer content' }));
  const fetched = unwrap(await ctx.uc.getJob(ctx.actor(job)));
  assert.equal(fetched.can_apply, false);
  assert.equal((await ctx.uc.applyJob({ ...ctx.actor(job), proposalHash: drafted.proposal_hash, baseRevision: 1 })).error.code, 'system_agent_revision_conflict');
  assert.equal(unwrap(await ctx.documents.getDocument(ctx.document.document_code, ctx.users.author.code)).content, '# Manual edit');
});

test('concurrent regular revisions use latest locked counter and optional base rejects conflicts', async () => {
  const ctx = await setup();
  const cmd = { documentCode: ctx.document.document_code, principalCode: ctx.users.author.code, title: 'Manual', content: '# Manual', changeSummary: 'Revision' };
  const concurrent = await Promise.all([ctx.documents.reviseDocument(cmd), ctx.documents.reviseDocument(cmd)]);
  concurrent.forEach(unwrap);
  const document = unwrap(await ctx.documents.getDocument(ctx.document.document_code, ctx.users.author.code));
  assert.equal(document.current_revision, 3);
  assert.deepEqual(document.revisions.map(row => row.revision), [3, 2, 1]);
  assert.equal((await ctx.documents.reviseDocument({ ...cmd, baseRevision: 1 })).error.code, 'project_document_revision_conflict');
  assert.equal((await ctx.documents.reviseDocument({ ...cmd, baseRevision: NaN })).error.code, 'project_document_base_revision_invalid');
});

test('cancel and reject are durable and prevent late result/adoption', async () => {
  const ctx = await setup();
  const job = await ctx.create();
  const execution = await ctx.claim();
  assert.equal(unwrap(await ctx.uc.cancelJob(ctx.actor(job))).status, 'cancelled');
  assert.equal(unwrap(await ctx.uc.cancelJob(ctx.actor(job))).status, 'cancelled');
  assert.equal((await ctx.uc.completeJob({ ...execution, proposal })).error.code, 'system_agent_execution_expired');
  assert.equal((await ctx.uc.heartbeatJob(execution)).error.code, 'system_agent_execution_expired');
  const second = await ctx.create({ requestKey: 'second' });
  const secondExecution = await ctx.claim();
  const drafted = unwrap(await ctx.uc.completeJob({ ...secondExecution, proposal }));
  assert.equal(unwrap(await ctx.uc.rejectJob(ctx.actor(second))).status, 'rejected');
  assert.equal((await ctx.uc.applyJob({ ...ctx.actor(second), proposalHash: drafted.proposal_hash, baseRevision: 1 })).error.code, 'system_agent_state_conflict');
});

test('worker claims are exclusive and execution token prevents another worker completion', async () => {
  const ctx = await setup();
  await ctx.create();
  const claims = await Promise.all([ctx.uc.claimNextJob({ executorId: 'worker-1' }), ctx.uc.claimNextJob({ executorId: 'worker-2' })]);
  assert.equal(claims.map(unwrap).filter(Boolean).length, 1);
  const index = claims.findIndex(value => value.data);
  const claimed = claims[index].data;
  assert.equal((await ctx.uc.completeJob({ jobCode: claimed.job_code, executorId: `worker-${index + 1}`, executionToken: 'invalid', proposal })).error.code, 'system_agent_execution_expired');
});

test('expired lease fails visibly on recovery and late completion stays rejected', async () => {
  const ctx = await setup();
  const job = await ctx.create();
  const execution = await ctx.claim();
  await ctx.db.update(schema.systemAgentJobs).set({ lease_expires_at: '2000-01-01T00:00:00.000Z' }).where(eq(schema.systemAgentJobs.code, job.job_code));
  assert.equal((await ctx.uc.completeJob({ ...execution, proposal })).error.code, 'system_agent_execution_expired');
  assert.equal(unwrap(await ctx.uc.recoverExpiredJobs()).recovered, 1);
  assert.equal(unwrap(await ctx.uc.recoverExpiredJobs()).recovered, 0);
  assert.equal(unwrap(await ctx.uc.getJob(ctx.actor(job))).status, 'failed');
});

test('revoked write authority is rechecked before claim and completion', async () => {
  const ctx = await setup();
  const job = await ctx.create();
  const execution = await ctx.claim();
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  assert.equal((await ctx.uc.completeJob({ ...execution, proposal })).error.code, 'project_forbidden');
  assert.equal(unwrap(await ctx.uc.getJob(ctx.actor(job))).status, 'failed');
  await ctx.db.update(schema.members).set({ role: 'member' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  const queued = await ctx.create({ requestKey: 'queued' });
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.author.id));
  assert.equal(unwrap(await ctx.uc.claimNextJob({ executorId: 'worker' })), null);
  const [stored] = await ctx.db.select().from(schema.systemAgentJobs).where(eq(schema.systemAgentJobs.code, queued.job_code));
  assert.equal(stored.status, 'failed');
});

test('adoption rechecks current permissions even after a valid draft', async () => {
  const ctx = await setup();
  const { job, drafted } = await ctx.draft();
  await ctx.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.author.id)));
  assert.equal(unwrap(await ctx.uc.getJob(ctx.actor(job))).can_apply, false);
  assert.equal((await ctx.uc.applyJob({ ...ctx.actor(job), proposalHash: drafted.proposal_hash, baseRevision: 1 })).error.code, 'project_forbidden');
});

test('malformed or partial model output never becomes a reviewable draft', async () => {
  const ctx = await setup();
  const job = await ctx.create();
  const execution = await ctx.claim();
  assert.equal((await ctx.uc.completeJob({ ...execution, proposal: { ...proposal, content: '' } })).ok, false);
  assert.equal(unwrap(await ctx.uc.getJob(ctx.actor(job))).status, 'running');
  unwrap(await ctx.uc.failJob({ ...execution, message: 'Structured output validation failed' }));
  assert.equal(unwrap(await ctx.uc.getJob(ctx.actor(job))).status, 'failed');
  assert.throws(() => normalizeSystemAgentProposal({ ...proposal, evidence: ['a', 42] }));
});

test('execution metadata is pinned privately by worker and durable in result/audit', async () => {
  const ctx = await setup();
  const job = await ctx.create();
  const metadata = { engine: 'dsh', engine_version: 'test-pinned-version', model: 'test-model', skill_version: '1.0.0', skill_sha256: 'a'.repeat(64) };
  const claimed = unwrap(await ctx.uc.claimNextJob({ executorId: 'worker', executionMetadata: { ...metadata, unexpected_token: 'never-persist' } }));
  assert.deepEqual(claimed.execution_metadata, metadata);
  const drafted = unwrap(await ctx.uc.completeJob({ jobCode: job.job_code, executorId: 'worker', executionToken: claimed.execution_token, proposal }));
  assert.deepEqual(drafted.execution_metadata, metadata);
  assert.deepEqual(unwrap(await ctx.uc.getJob(ctx.actor(job))).execution_metadata, metadata);
  const [audit] = await ctx.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'system_agent.started'));
  assert.deepEqual(JSON.parse(audit.payload).execution_metadata, metadata);
});

test('existing system-folder editing restrictions also apply to agent jobs', async () => {
  const ctx = await setup();
  unwrap(await ctx.documents.listLibrary({ projectCode: ctx.project.code, principalCode: ctx.users.author.code }));
  const [linkedFolder] = await ctx.db.select().from(schema.projectDocumentFolders).where(and(eq(schema.projectDocumentFolders.project_id, ctx.project.id), eq(schema.projectDocumentFolders.system_role, 'requirements')));
  assert.ok(linkedFolder);
  await ctx.db.update(schema.projectDocuments).set({ folder_id: linkedFolder.id }).where(eq(schema.projectDocuments.code, ctx.document.document_code));
  assert.equal((await ctx.uc.createJob(ctx.command)).error.code, 'project_document_source_read_only');
});

test('input budgets reject oversized instructions, quotes and UTF-8 snapshots before enqueue', async () => {
  const ctx = await setup();
  assert.equal((await ctx.uc.createJob({ ...ctx.command, instruction: 'x'.repeat(8001) })).error.code, 'system_agent_input_invalid');
  assert.equal((await ctx.uc.createJob({ ...ctx.command, quote: 'x'.repeat(20001) })).error.code, 'system_agent_input_invalid');
  await ctx.db.update(schema.projectDocuments).set({ content: 'a'.repeat(100001) }).where(eq(schema.projectDocuments.code, ctx.document.document_code));
  assert.equal((await ctx.uc.createJob({ ...ctx.command, quote: undefined })).error.code, 'system_agent_document_too_large');
  await ctx.db.update(schema.projectDocuments).set({ content: '文'.repeat(99990) }).where(eq(schema.projectDocuments.code, ctx.document.document_code));
  assert.equal((await ctx.uc.createJob({ ...ctx.command, quote: undefined })).error.code, 'system_agent_document_too_large');
  assert.equal((await ctx.db.select().from(schema.systemAgentJobs)).length, 0);
  for (const value of [{ title: 'x'.repeat(201) }, { summary: 'x'.repeat(2001) }, { content: 'x'.repeat(200001) }, { rationale: 'x'.repeat(6001) }, { evidence: ['x'.repeat(201)] }, { warnings: ['x'.repeat(1001)] }, { evidence: Array(21).fill('ref') }]) {
    assert.throws(() => normalizeSystemAgentProposal({ ...proposal, ...value }));
  }
});
