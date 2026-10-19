import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertTeamMember, insertUser, openTestDb, publicCode } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-14T00:00:00Z';
  const team = await insertTeam(db, { code: publicCode(10), name: 'Baseline team', created_at });
  const project = await insertProject(db, { code: publicCode(20), team_id: team.id, name: 'Baseline project', current_snapshot: 1, created_at });
  const users = [];
  for (const [index, role] of ['owner', 'member', 'outsider'].entries()) {
    const user = await insertUser(db, { code: publicCode(index + 1), account: `baseline.${role}`, display_name: role, status: 'active', created_at });
    const token = `baseline-${role}-token`;
    await db.insert(schema.devices).values({ code: publicCode(index + 101), principal_id: user.id, device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    if (role !== 'outsider') {
      await insertTeamMember(db, { team_id: team.id, principal_id: user.id, role, display_name: role, created_at });
      await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: role, created_at });
    }
    users.push({ ...user, headers: { authorization: `Bearer ${token}` } });
  }
  const [owner, member, outsider] = users;
  const feature = await insertFeature(db, { code: publicCode(30), project_id: project.id, title: 'Handover', status: 'active' });
  const [requirement] = await db.insert(schema.requirements).values({ code: publicCode(40), feature_id: feature.id, title: 'Portable handover', current_revision: 1, state: 'confirmed', owner_principal_id: owner.id }).returning();
  await db.insert(schema.requirementRevisions).values({ code: publicCode(41), requirement_id: requirement.id, revision: 1, summary: 'Original body', acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'Original acceptance' }]), open_questions: '[]', created_at });
  return { db, app, owner, member, outsider, project, feature, requirement, root: `/projects/${project.code}/requirement-baselines` };
}
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
const payload = (requirement, extra = {}) => ({ name: 'Handover V1', scope: 'Release 1', reason: 'Approved initial scope', parent_baseline_code: null, requirements: [{ requirement_code: requirement.code, revision: 1 }], ...extra });

test('baseline HTTP freezes revisions, exposes content differences and preserves parent history', async () => {
  const { db, app, owner, member, root, requirement } = await fixture();
  const create = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement) });
  assert.equal(create.statusCode, 200, create.body);
  const first = create.json().data;
  assert.equal(first.version, 1);
  assert.equal(first.requirements[0].body, 'Original body');
  await db.insert(schema.requirementRevisions).values({ code: publicCode(42), requirement_id: requirement.id, revision: 2, summary: 'Updated body', acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'Updated acceptance' }]), open_questions: JSON.stringify(['New question']), created_at: '2026-10-14T01:00:00Z' });
  await db.update(schema.requirements).set({ title: 'Updated title', current_revision: 2 }).where(eq(schema.requirements.id, requirement.id));
  const detail = await app.inject({ method: 'GET', url: `${root}/${first.baseline_code}`, headers: member.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.requirements[0].body, 'Original body');
  assert.equal(detail.json().data.requirements[0].title, 'Portable handover');
  const diff = await app.inject({ method: 'GET', url: `${root}/${first.baseline_code}/diff?compare_to=current`, headers: member.headers });
  assert.equal(diff.statusCode, 200, diff.body);
  const change = diff.json().data.changes[0];
  assert.equal(change.kind, 'modified'); assert.equal(change.before.body, 'Original body'); assert.equal(change.after.body, 'Updated body');
  assert.equal(change.after.acceptance_criteria[0].text, 'Updated acceptance'); assert.deepEqual(change.after.open_questions, ['New question']);
  const stale = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement) });
  assert.equal(stale.statusCode, 409, stale.body);
  const second = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement, { name: 'Handover V2', parent_baseline_code: first.baseline_code, requirements: [{ requirement_code: requirement.code, revision: 2 }] }) });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().data.parent_baseline_code, first.baseline_code);
  const list = await app.inject({ method: 'GET', url: root, headers: member.headers });
  assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().data.can_create, false);
  assert.equal(list.json().data.baselines.length, 2);
  const between = await app.inject({ method: 'GET', url: `${root}/${first.baseline_code}/diff?compare_to=${second.json().data.baseline_code}`, headers: member.headers });
  assert.equal(between.statusCode, 200, between.body); assert.equal(between.json().data.counts.modified, 1);
});

test('baseline HTTP requires bearer identity, Owner creation, project access and strict input', async () => {
  const { app, db, owner, member, outsider, root, requirement, project } = await fixture();
  for (const headers of [undefined, { 'x-principal-code': owner.code }]) {
    const response = await app.inject({ method: 'GET', url: root, headers });
    assert.equal(response.statusCode, 401, response.body);
  }
  const forbidden = await app.inject({ method: 'POST', url: root, headers: member.headers, payload: payload(requirement) });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  const denied = await app.inject({ method: 'GET', url: root, headers: outsider.headers });
  assert.equal(denied.statusCode, 403, denied.body);
  for (const override of [{ principal_code: owner.code }, { requirements: [{ requirement_code: requirement.code, revision: '1' }] }, { requirements: [] }, { parent_baseline_code: 'bad-code' }, { name: ' ' }]) {
    const response = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement, override) });
    assert.equal(response.statusCode, 422, response.body);
  }
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement) });
  assert.equal(created.statusCode, 200, created.body);
  const malformed = await app.inject({ method: 'GET', url: `${root}/${created.json().data.baseline_code}/diff?compare_to=bad-code`, headers: owner.headers });
  assert.equal(malformed.statusCode, 422, malformed.body);
  const other = await insertProject(db, { code: publicCode(200), team_id: project.team_id, name: 'Other project', current_snapshot: 1, created_at: project.created_at });
  await insertProjectMember(db, { project_id: other.id, principal_id: owner.id, role: 'owner', display_name: 'owner', created_at: project.created_at });
  const cross = await app.inject({ method: 'GET', url: `/projects/${other.code}/requirement-baselines/${created.json().data.baseline_code}`, headers: owner.headers });
  assert.equal(cross.statusCode, 404, cross.body);
});

test('baseline binding pins task revision and does not expose frozen project requirements to outsiders', async () => {
  const { app, db, owner, member, outsider, root, feature, requirement } = await fixture();
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement) });
  assert.equal(created.statusCode, 200, created.body);
  const baseline = created.json().data;
  const [task] = await db.insert(schema.tasks).values({ code: publicCode(60), feature_id: feature.id, requirement_id: requirement.id,
    title: 'Continue handover', profile: 'builder', source: 'requirement', status: 'draft', base_snapshot: 1,
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Original acceptance' }]), created_at: '2026-10-14T00:00:00Z' }).returning();
  const bind = await app.inject({ method: 'POST', url: `/tasks/${task.code}/baseline`, headers: owner.headers,
    payload: { baseline_code: baseline.baseline_code, base_snapshot: 1 } });
  assert.equal(bind.statusCode, 200, bind.body);
  assert.equal(bind.json().data.requirement_baseline_code, baseline.baseline_code);
  const detail = await app.inject({ method: 'GET', url: `/tasks/${task.code}`, headers: member.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().data.source_requirement_revision, 1);
  assert.equal(detail.json().data.requirement_baseline.requirements[0].body, 'Original body');
  for (const headers of [outsider.headers]) {
    const denied = await app.inject({ method: 'GET', url: `/tasks/${task.code}`, headers });
    assert.equal(denied.statusCode, 403, denied.body);
    // Task access is checked before reading the frozen baseline or revealing its presence.
    assert.equal(denied.json().error.code, 'project_forbidden');
    assert.equal(denied.json().data, undefined);
  }
  for (const headers of [undefined, { 'x-principal-code': owner.code }]) {
    const denied = await app.inject({ method: 'GET', url: `/tasks/${task.code}`, headers });
    assert.equal(denied.statusCode, 401, denied.body);
  }
});

test('baseline task creation requires authenticated identity even when the body claims an Owner', async () => {
  const { app, db, owner, member, root, feature, requirement } = await fixture();
  const created = await app.inject({ method: 'POST', url: root, headers: owner.headers, payload: payload(requirement) });
  assert.equal(created.statusCode, 200, created.body);
  const body = { feature_code: feature.code, requirement_code: requirement.code, baseline_code: created.json().data.baseline_code,
    title: 'Frozen task', profile: 'builder', source: 'requirement', acceptance: [{ id: 'AC-1', text: 'Original acceptance' }], principal_code: owner.code };
  for (const headers of [undefined, { 'x-principal-code': owner.code }]) {
    const denied = await app.inject({ method: 'POST', url: '/tasks', headers, payload: body });
    assert.equal(denied.statusCode, 401, denied.body);
  }
  const forged = await app.inject({ method: 'POST', url: '/tasks', headers: member.headers, payload: body });
  assert.equal(forged.statusCode, 403, forged.body);
  assert.equal((await db.select().from(schema.tasks)).length, 0);
  const valid = await app.inject({ method: 'POST', url: '/tasks', headers: owner.headers, payload: body });
  assert.equal(valid.statusCode, 200, valid.body);
});

test('baseline graph bindings route is static, bearer-only and project-scoped, with unbound tasks retained', async () => {
  const { app, db, owner, member, outsider, root, feature, project } = await fixture();
  const url = `${root}/bindings`;
  for (const headers of [undefined, { 'x-principal-code': owner.code }]) {
    const denied = await app.inject({ method: 'GET', url, headers });
    assert.equal(denied.statusCode, 401, denied.body);
  }
  const denied = await app.inject({ method: 'GET', url, headers: outsider.headers });
  assert.equal(denied.statusCode, 403, denied.body);
  const [task] = await db.insert(schema.tasks).values({ code: publicCode(61), feature_id: feature.id, title: 'Unbound task', profile: 'builder',
    source: 'requirement', status: 'draft', base_snapshot: 1, acceptance: '[]', created_at: project.created_at }).returning();
  const other = await insertProject(db, { code: publicCode(201), team_id: project.team_id, name: 'Other', current_snapshot: 1, created_at: project.created_at });
  const otherFeature = await insertFeature(db, { code: publicCode(202), project_id: other.id, title: 'Other', status: 'active' });
  await db.insert(schema.tasks).values({ code: publicCode(203), feature_id: otherFeature.id, title: 'Other task', profile: 'builder',
    source: 'requirement', status: 'draft', base_snapshot: 1, acceptance: '[]', created_at: project.created_at });
  const view = await app.inject({ method: 'GET', url, headers: member.headers });
  assert.equal(view.statusCode, 200, view.body);
  assert.deepEqual(view.json().data, { tasks: [{ task_code: task.code, title: task.title, status: 'draft', baseline_code: null, baseline_version: null }], handovers: [] });
  await db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, member.id));
  const inactive = await app.inject({ method: 'GET', url, headers: member.headers });
  assert.equal(inactive.statusCode, 401, inactive.body);
});
