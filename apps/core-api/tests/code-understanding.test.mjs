import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schema } from '@team-synergy/persistence';
import { hashToken } from '@team-synergy/application';
import { seedWorkspaceProject, useTestDb } from '../../../packages/application/tests/test-db.mjs';
import { buildServer } from '../dist/server.js';

const fixture = useTestDb(new URL('../../../packages/application/tests/code-understanding.test.mjs', import.meta.url).href);
test('HTTP code understanding authenticates, validates, persists progress and maps errors', async () => {
  const db = fixture.db, ctx = await seedWorkspaceProject(db, { users: [{ key: 'owner', account: 'owner', displayName: 'Owner', projectRole: 'owner' }, { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' }] });
  for (const name of ['owner', 'viewer']) await db.insert(schema.devices).values({ principal_id: ctx.users[name].id, device_name: name, credential_hash: hashToken(`understanding-${name}`), created_at: 't0' });
  const [repo] = await db.insert(schema.projectRepositories).values({ project_id: ctx.project.id, name: 'repo', remote_url: 'https://example.invalid/repo.git', created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const app = await buildServer({ db, logger: false }), base = `/projects/${ctx.project.code}/code-understanding`;
  const request = (method, suffix, payload, actor = 'owner') => app.inject({ method, url: base + suffix, headers: { authorization: `Bearer understanding-${actor}` }, ...(payload ? { payload } : {}) });
  try {
    assert.equal((await app.inject({ method: 'GET', url: base + '/context' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: base + '/runs/00000000000000000001/ua-map' })).statusCode, 401);
    assert.equal((await request('GET', '/context', undefined, 'viewer')).statusCode, 403);
    assert.equal((await request('GET', '/graph?limit=999')).statusCode, 422);
    const plugins = ['ua', 'codegraph'].map(plugin_id => ({ plugin_id, engine_version: '1', adapter_version: '1', protocol_version: 1 }));
    const response = await request('POST', '/runs', { repository_code: repo.code, idempotency_key: 'http', requested_ref: 'HEAD', kind: 'commit', plugins });
    assert.equal(response.statusCode, 200, response.body); const run = response.json().data;
    assert.equal((await request('GET', `/runs/${run.code}/ua-map`, undefined, 'viewer')).statusCode, 403);
    assert.equal((await request('GET', `/runs/${run.code}/ua-map`)).statusCode, 409);
    const context = await request('GET', '/context'); assert.equal(context.json().data.runs[0].code, run.code);
    const cancelled = await request('POST', `/runs/${run.code}/progress`, { expected_revision: 0, status: 'cancelled' });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const late = await request('POST', `/runs/${run.code}/progress`, { expected_revision: 1, status: 'preparing' });
    assert.equal(late.statusCode, 409, late.body);
    assert.equal((await request('GET', `/runs/${run.code}`, undefined, 'viewer')).statusCode, 403);
    assert.equal((await request('POST', '/runs', { raw: 'invalid' })).statusCode, 422);
  } finally { await app.close(); }
});
