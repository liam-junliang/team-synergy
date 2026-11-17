import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { schema } from '@team-synergy/persistence';
import { createSystemAgentUseCases } from '@team-synergy/application';
import { registerAuthMiddleware } from '../dist/auth.js';
import { registerSystemAgentRoutes } from '../dist/routes/system-agent.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
async function fixture(configured = true) {
  const db = await openTestDb();
  const app = Fastify({ logger: false });
  fixtures.push({ app, db });
  registerAuthMiddleware(app, db);
  registerSystemAgentRoutes(app, db, { isConfigured: () => configured });
  const timestamp = '2026-10-21T00:00:00.000Z';
  const users = {};
  for (const role of ['owner', 'viewer']) {
    const user = await insertUser(db, { account: `agent.routes.${role}`, display_name: role, status: 'active', created_at: timestamp });
    const token = `system-agent-test-${role}`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: 'test', credential_hash: createHash('sha256').update(token).digest('hex'), created_at: timestamp });
    users[role] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Agent routes', owner_principal_id: users.owner.id, created_at: timestamp });
  const project = await insertProject(db, { team_id: team.id, owner_principal_id: users.owner.id, name: 'Agent routes', created_at: timestamp });
  for (const role of ['owner', 'viewer']) await insertProjectMember(db, { project_id: project.id, principal_id: users[role].id, role, display_name: role, created_at: timestamp });
  const [document] = await db.insert(schema.projectDocuments).values({ project_id: project.id, title: 'Private title', content: '# Private original', created_by: users.owner.id, updated_by: users.owner.id, created_at: timestamp, updated_at: timestamp }).returning();
  const payload = { document_code: document.code, base_revision: 1, instruction: 'Clarify purpose', request_key: 'request' };
  const url = `/projects/${project.code}/system-agent/jobs`;
  const inject = (method, endpoint = url, body, actor = users.owner) => app.inject({ method, url: endpoint, ...(actor ? { headers: actor.headers } : {}), ...(body === undefined ? {} : { payload: body }) });
  return { app, db, users, project, document, payload, url, inject };
}

test('HTTP requires authentication and ignores body-supplied actor identity', async () => {
  const ctx = await fixture();
  assert.equal((await ctx.inject('GET', ctx.url, undefined, null)).statusCode, 401);
  const spoof = await ctx.inject('POST', ctx.url, { ...ctx.payload, principal_code: ctx.users.owner.code }, ctx.users.viewer);
  assert.equal(spoof.json().ok, false);
  assert.equal(spoof.json().error.code, 'project_forbidden');
  const jobs = await ctx.db.select().from(schema.systemAgentJobs);
  assert.equal(jobs.length, 0);
});

test('unconfigured engine rejects creation immediately instead of leaving queued work', async () => {
  const ctx = await fixture(false);
  const response = await ctx.inject('POST', ctx.url, ctx.payload);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'system_agent_unavailable');
  assert.equal((await ctx.db.select().from(schema.systemAgentJobs)).length, 0);
});

test('HTTP contract persists instruction/history but hides worker token and rejects altered confirmation', async () => {
  const ctx = await fixture();
  const response = await ctx.inject('POST', ctx.url, { ...ctx.payload, execution_metadata: { engine: 'spoof' } });
  assert.equal(response.json().ok, true, response.body);
  const job = response.json().data;
  assert.equal(job.status, 'queued');
  assert.equal(job.execution_metadata, null);
  const uc = createSystemAgentUseCases(ctx.db);
  const claimed = await uc.claimNextJob({ executorId: 'test-worker' });
  assert.equal(claimed.ok, true);
  const execution = { jobCode: job.job_code, executorId: 'test-worker', executionToken: claimed.data.execution_token };
  const running = await ctx.inject('GET', `/system-agent/jobs/${job.job_code}`);
  assert.equal('execution_token' in running.json().data, false);
  assert.doesNotMatch(running.body, new RegExp(execution.executionToken));
  const completion = await uc.completeJob({ ...execution, proposal: { title: 'Proposed', summary: '', content: '# Proposed', rationale: 'Clarify source', evidence: ['Current revision'], warnings: [] } });
  assert.equal(completion.ok, true);
  const modified = await ctx.inject('POST', `/system-agent/jobs/${job.job_code}/apply`, { base_revision: 1, proposal_hash: 'changed' });
  assert.equal(modified.json().error.code, 'system_agent_confirmation_mismatch');
  const approved = await ctx.inject('POST', `/system-agent/jobs/${job.job_code}/apply`, { base_revision: 1, proposal_hash: completion.data.proposal_hash });
  assert.equal(approved.json().data.status, 'applied');
  assert.equal(approved.json().data.applied_revision, 2);
  const listed = await ctx.inject('GET');
  assert.equal(listed.json().data.length, 1);
  const stranger = await ctx.inject('GET', `/system-agent/jobs/${job.job_code}`, undefined, ctx.users.viewer);
  assert.equal(stranger.json().error.code, 'system_agent_job_not_found');
  assert.doesNotMatch(stranger.body, /Private original/);
});
