import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { schema } from '@team-synergy/persistence';
import { hashToken } from '@team-synergy/application';
import { seedWorkspaceProject, useTestDb } from '../../../packages/application/tests/test-db.mjs';
import { registerAuthMiddleware } from '../dist/auth.js';
import { httpStatusForError } from '../dist/error-status.js';
import { registerCodeUnderstandingRoutes } from '../dist/routes/code-understanding.js';

const fixture = useTestDb(new URL('../../../packages/application/tests/code-hosted-analysis.test.mjs', import.meta.url).href);
async function setup(configured = true) {
  const db = fixture.db, ctx = await seedWorkspaceProject(db, { users: [{ key: 'owner', account: 'owner', displayName: 'Owner', projectRole: 'owner' }, { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' }] });
  for (const role of ['owner', 'viewer']) await db.insert(schema.devices).values({ principal_id: ctx.users[role].id, device_name: role, credential_hash: hashToken(`hosted-http-${role}`), created_at: 't0' });
  const repositories = await db.insert(schema.projectRepositories).values(['api', 'web'].map(name => ({ project_id: ctx.project.id, name, remote_url: `https://example.invalid/${name}.git`, default_branch: 'main', created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }))).returning();
  const app = Fastify({ logger: false });
  registerAuthMiddleware(app, db);
  registerCodeUnderstandingRoutes(app, db, { isConfigured: () => configured, status: () => ({ configured, model: 'workbuddy/deepseek-v4.1-flash', message: configured ? 'Ready' : 'Not configured', workspace_root: 'PRIVATE-RUNNER-PATH', plugins: ['PRIVATE-RUNTIME-PATH'] }) });
  app.addHook('preSerialization', async (_request, reply, payload) => {
    if (reply.statusCode === 200 && payload?.ok === false) reply.code(httpStatusForError(payload.error.code));
    return payload;
  });
  const base = `/projects/${ctx.project.code}/code-understanding`;
  const request = (method, route, payload, role = 'owner') => app.inject({ method, url: base + route, headers: { authorization: `Bearer hosted-http-${role}` }, ...(payload ? { payload } : {}) });
  return { ...ctx, db, repositories, app, base, request };
}

test('hosted analysis HTTP authenticates, keeps runtime configuration private and queues only registered mainlines', async () => {
  const f = await setup();
  try {
    for (const route of ['/runtime', '/analyses', '/analyses/00000000000000000001']) assert.equal((await f.app.inject({ method: 'GET', url: f.base + route })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: f.base + '/runtime', headers: { 'x-principal-code': f.users.owner.code } })).statusCode, 401);
    assert.equal((await f.request('GET', '/runtime', undefined, 'viewer')).statusCode, 403);
    assert.equal((await f.request('POST', '/analyses', { idempotency_key: 'denied' }, 'viewer')).statusCode, 403);
    const runtime = await f.request('GET', '/runtime');
    assert.equal(runtime.statusCode, 200); assert.deepEqual(runtime.json().data, { configured: true, model: 'workbuddy/deepseek-v4.1-flash', message: 'Ready' });
    assert(!runtime.body.includes('PRIVATE-'));
    for (const extra of [{ branch: 'dev' }, { path: 'F:/member/worktree' }, { remote_url: 'https://other.invalid/repo.git' }]) {
      const response = await f.request('POST', '/analyses', { idempotency_key: 'invalid', ...extra }); assert.equal(response.statusCode, 422, response.body);
    }
    const response = await f.request('POST', '/analyses', { idempotency_key: 'all-mainlines' });
    assert.equal(response.statusCode, 200, response.body); const jobs = response.json().data;
    assert.equal(jobs.length, 2); assert(jobs.every(job => job.branch === 'main' && job.status === 'queued'));
    assert(!response.body.includes('execution_token')); assert(!response.body.includes('remote_url'));
    const retry = await f.request('POST', '/analyses', { idempotency_key: 'all-mainlines' }); assert.deepEqual(retry.json().data, jobs);
    assert.equal((await f.request('POST', '/analyses', { idempotency_key: 'overlap' })).statusCode, 409);
    const listed = await f.request('GET', '/analyses'); assert.equal(listed.json().data.length, 2);
    const detail = await f.request('GET', `/analyses/${jobs[0].job_code}`); assert.equal(detail.json().data.repository_code, jobs[0].repository_code);
    assert.equal((await f.request('GET', `/analyses/${jobs[0].job_code}`, undefined, 'viewer')).statusCode, 403);
    assert.equal((await f.request('GET', '/analyses/00000000000000000001')).statusCode, 404);
  } finally { await f.app.close(); }
});

test('unconfigured hosted analysis is explicitly unavailable and does not leave unexecutable jobs', async () => {
  const f = await setup(false);
  try {
    const response = await f.request('POST', '/analyses', { idempotency_key: 'no-worker' });
    assert.equal(response.statusCode, 503, response.body); assert.equal(response.json().error.code, 'code_understanding_unavailable');
    assert.deepEqual((await f.request('GET', '/analyses')).json().data, []);
    assert.equal((await f.request('GET', '/runtime')).json().data.configured, false);
  } finally { await f.app.close(); }
});
