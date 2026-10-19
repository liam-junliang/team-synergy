import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb(); const app = await buildServer({ db, logger: false }); fixtures.push({ app, db });
  const created_at = '2026-10-18T00:00:00Z'; const users = {};
  for (const name of ['owner', 'member', 'viewer', 'outside']) {
    const user = await insertUser(db, { account: `testing.http.${name}`, display_name: name, status: 'active', created_at });
    const token = `testing-http-${name}-token`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: name, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    users[name] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Testing team', owner_principal_id: users.owner.id, created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Testing project', owner_principal_id: users.owner.id, member_policy: 'private', created_at });
  const foreign = await insertProject(db, { team_id: team.id, name: 'Foreign project', owner_principal_id: users.owner.id, member_policy: 'private', created_at });
  for (const name of ['owner', 'member', 'viewer']) await insertProjectMember(db, { project_id: project.id, principal_id: users[name].id, role: name === 'owner' ? 'admin' : name, display_name: name, created_at });
  const feature = await insertFeature(db, { project_id: project.id, title: 'Login' });
  return { db, app, users, project, foreign, feature, root: `/projects/${project.code}` };
}
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
function request(c, actor, method, url, payload) { return c.app.inject({ method, url, headers: actor?.headers ?? {}, ...(payload === undefined ? {} : { payload }) }); }
function data(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().ok, true, response.body); return response.json().data; }
function status(response, expected, code) { assert.equal(response.statusCode, expected, response.body); if (code) assert.equal(response.json().error.code, code); }

test('test HTTP routes use authenticated identity and URL project despite forged camel/snake query or body fields', async () => {
  const c = await fixture(); const { owner, member, outside, viewer } = c.users;
  const testCase = data(await request(c, member, 'POST', `${c.root}/test-cases`, { title: 'Secret case', notes_markdown: 'Private instructions', principalCode: owner.code, principal_code: owner.code }));
  const asset = data(await request(c, member, 'POST', `${c.root}/test-assets`, { title: 'Secret asset', content: 'Private evidence' }));
  assert.equal(testCase.owner_user_code, member.code);
  const foreignCase = data(await request(c, owner, 'POST', `/projects/${c.foreign.code}/test-cases`, { title: 'Other project case' }));
  for (const suffix of ['test-cases', 'test-assets', 'test-executions']) {
    status(await request(c, null, 'GET', `${c.root}/${suffix}`), 401);
    status(await request(c, outside, 'GET', `${c.root}/${suffix}?principalCode=${owner.code}&principal_code=${owner.code}&projectCode=${c.project.code}`), 403, 'project_forbidden');
    status(await request(c, member, 'GET', `/projects/${c.foreign.code}/${suffix}?principalCode=${owner.code}&projectCode=${c.project.code}`), 403);
  }
  const list = data(await request(c, member, 'GET', `${c.root}/test-cases?projectCode=${c.foreign.code}&principalCode=${owner.code}`));
  assert.equal(list.length, 1); assert.equal(list[0].code, testCase.code); assert.notEqual(list[0].code, foreignCase.code);
  status(await request(c, outside, 'GET', `/test-cases/${testCase.code}?principalCode=${owner.code}`), 403);
  status(await request(c, outside, 'GET', `/test-assets/${asset.code}`), 403);
  status(await request(c, viewer, 'POST', `${c.root}/test-cases`, { title: 'Forbidden', principal_code: owner.code }), 403);
  status(await request(c, viewer, 'PATCH', `/test-assets/${asset.code}`, { base_revision: 1, change_summary: 'Forge owner', content: 'Unauthorized', principalCode: owner.code }), 403);
});

test('test HTTP version conflicts, execution snapshots and failed-result defect workflow use stable envelopes', async () => {
  const c = await fixture(); const actor = c.users.member;
  const testCase = data(await request(c, actor, 'POST', `${c.root}/test-cases`, { title: 'Login', steps: [{ action: 'Login', expected: 'Dashboard' }] }));
  const execution = data(await request(c, actor, 'POST', `${c.root}/test-executions`, { title: 'Smoke', environment: 'Stage', tested_version: 'build-1', source: 'ci',
    executor_user_code: c.users.owner.code, results: [{ case_code: testCase.code, case_revision: 1, result: 'fail', actual_result: 'Blank page' }] }));
  assert.equal(execution.executor_user_code, actor.code);
  data(await request(c, actor, 'PATCH', `/test-cases/${testCase.code}`, { base_revision: 1, change_summary: 'Update', title: 'Login v2' }));
  status(await request(c, actor, 'PATCH', `/test-cases/${testCase.code}`, { base_revision: 1, change_summary: 'Stale' }), 409, 'testing_revision_conflict');
  const saved = data(await request(c, c.users.viewer, 'GET', `/test-executions/${execution.code}`));
  assert.equal(saved.results[0].snapshot.title, 'Login'); assert.equal(saved.results[0].is_outdated, true);
  const linked = data(await request(c, actor, 'POST', `/test-executions/${execution.code}/results/${saved.results[0].result_code}/defect`, { feature_code: c.feature.code, severity: 'high' }));
  assert.ok(linked.results[0].defect_code);
  status(await request(c, actor, 'POST', `/test-executions/${execution.code}/results/${saved.results[0].result_code}/defect`, { feature_code: c.feature.code }), 409, 'testing_defect_conflict');
  const [defect] = await c.db.select().from(schema.defects).where(eq(schema.defects.code, linked.results[0].defect_code));
  assert.match(defect.description, /Dashboard/); assert.match(defect.description, /Blank page/);
  status(await request(c, actor, 'POST', `${c.root}/test-assets`, { title: 'Unsafe URL', storage_kind: 'url', url: 'javascript:alert(1)' }), 422, 'testing_invalid');
  status(await request(c, actor, 'POST', `${c.root}/test-executions`, { title: 'Missing context', results: [] }), 400);
});
