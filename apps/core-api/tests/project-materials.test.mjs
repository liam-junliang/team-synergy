import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser } from './test-db.mjs';

const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.app.close(); await closeTestDb(f.db); } });
async function fixture() {
  const db = await openTestDb(), app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-11-12T00:00:00Z';
  const team = await insertTeam(db, { name: 'Materials', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Materials', created_at });
  const users = [];
  for (const role of ['viewer', 'outsider']) {
    const user = await insertUser(db, { account: 'material.' + role, display_name: role, status: 'active', created_at });
    const token = 'material-' + role;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role === 'viewer') await insertProjectMember(db, { principal_id: user.id, project_id: project.id, role, display_name: role, created_at });
    users.push({ ...user, headers: { authorization: 'Bearer ' + token } });
  }
  const [document] = await db.insert(schema.projectDocuments).values({ project_id: project.id, kind: 'doc', title: '退款约定', content: '退款超过七天人工审核\n尚未落实', created_by: users[0].id, updated_by: users[0].id, created_at, updated_at: created_at }).returning();
  const [revision] = await db.insert(schema.projectDocumentRevisions).values({ document_id: document.id, revision: 1, title: document.title, content: document.content, change_summary: '初稿', created_by: users[0].id, created_at }).returning();
  const query = (action, payload, who = users[0]) => app.inject({ method: 'POST', url: `/projects/${project.code}/materials/${action}`, headers: who?.headers ?? {}, payload });
  return { db, app, query, document, revision, users, project };
}
test('explicit material API supports metadata, glob, line grep and source-bound reads for viewers', async () => {
  const f = await fixture();
  for (const [action, input] of [['list', {}], ['glob', { pattern: 'project/*.md' }], ['grep', { pattern: '退款' }], ['read', { sourceCitation: f.revision.code, startLine: 2 }]]) {
    const response = await f.query(action, input);
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().ok, true);
    assert.equal(response.headers['cache-control'], 'no-store');
    const data = response.json().data;
    if (action === 'list' || action === 'glob') { assert.equal(data.items[0].sourceCitation, f.revision.code); assert.equal('body' in data.items[0], false); }
    if (action === 'grep') assert.equal(data.matches[0].line, 1);
    if (action === 'read') { assert.equal(data.body, '尚未落实'); assert.equal(data.state, 'documented'); assert.equal(data.current, true); }
  }
});
test('material API rejects unauthenticated, foreign-project, unsafe and malformed queries', async () => {
  const f = await fixture();
  assert.equal((await f.query('list', {}, {})).statusCode, 401);
  assert.equal((await f.query('list', {}, f.users[1])).statusCode, 403);
  assert.equal((await f.query('glob', { pattern: '../**' })).statusCode, 400);
  assert.equal((await f.query('grep', { pattern: '[', mode: 'regex' })).json().error.code, 'material_invalid_regex');
  assert.equal((await f.query('read', { sourceCitation: f.project.code })).statusCode, 404);
  assert.equal((await f.query('list', { principalCode: f.users[1].code })).statusCode, 400);
});
