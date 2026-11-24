import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb,
  insertFeature,
  insertProjectMilestone,
  insertProjectModule,
  insertProjectPhase,
  insertProject,
  insertProjectMember,
  insertTeam,
  insertTeamMember,
  insertUser,
  openTestDb,
  publicCode,
} from './test-db.mjs';

const fixtures = [];
let fixtureSequence = 0;

async function createFixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  const createdAt = '2026-08-13T00:00:00.000Z';
  const codeOffset = fixtureSequence * 1000;
  fixtureSequence += 1;

  const owner = await insertUser(db, {
    code: publicCode(codeOffset + 1),
    account: `owner.${codeOffset}`,
    display_name: 'Owner',
    status: 'active',
    created_at: createdAt,
  });
  const builder = await insertUser(db, {
    code: publicCode(codeOffset + 2),
    account: `builder.${codeOffset}`,
    display_name: 'Builder',
    status: 'active',
    created_at: createdAt,
  });
  const other = await insertUser(db, {
    code: publicCode(codeOffset + 3),
    account: `other.${codeOffset}`,
    display_name: 'Other',
    status: 'active',
    created_at: createdAt,
  });
  const team = await insertTeam(db, {
    code: publicCode(codeOffset + 11),
    name: `Core API Team ${codeOffset}`,
    created_at: createdAt,
  });
  for (const [principal, role] of [[owner, 'owner'], [builder, 'member'], [other, 'member']]) {
    await insertTeamMember(db, {
      team_id: team.id,
      principal_id: principal.id,
      role,
      display_name: principal.display_name,
      created_at: createdAt,
    });
  }
  const project = await insertProject(db, {
    code: publicCode(codeOffset + 21),
    team_id: team.id,
    name: `Core API tests ${codeOffset}`,
    current_snapshot: 1,
    created_at: createdAt,
  });
  for (const [principal, role] of [[owner, 'owner'], [builder, 'member'], [other, 'member']]) {
    await insertProjectMember(db, {
      principal_id: principal.id,
      project_id: project.id,
      role,
      display_name: principal.display_name,
      created_at: createdAt,
    });
  }
  const feature = await insertFeature(db, {
    code: publicCode(codeOffset + 31),
    project_id: project.id,
    title: 'HTTP routes',
    status: 'active',
  });

  const fixture = { app, db, owner, builder, other, feature };
  fixtures.push(fixture);
  return fixture;
}

async function seedTask(db, feature, builder, overrides = {}) {
  const [task] = await db.insert(schema.tasks).values({
    code: publicCode(41),
    feature_id: feature.id,
    title: 'Expose task routes',
    profile: 'builder',
    source: 'requirement',
    status: 'assigned',
    assignee_principal_id: builder.id,
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Route works' }]),
    base_snapshot: 7,
    created_at: '2026-08-13T00:00:00.000Z',
    ...overrides,
  }).returning();
  return task;
}

function claimPayload(overrides = {}) {
  return {
    run_code: publicCode(51),
    workspace_code: publicCode(61),
    profile: 'builder',
    base_snapshot: 7,
    workspace_path: 'C:/tmp/acp-task-test',
    git_base: 'abc123',
    ...overrides,
  };
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture.app.close();
    await closeTestDb(fixture.db);
  }
});

test('GET /tasks returns public-code task fields from the migrated PostgreSQL database', async () => {
  const { app, db, builder, feature } = await createFixture();
  const task = await seedTask(db, feature, builder);

  const response = await app.inject({ method: 'GET', url: '/tasks', headers: { 'x-principal-code': builder.code } });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    page: 1, total: 1, has_more: false,
    data: [{
      task_code: task.code,
      title: 'Expose task routes',
      brief: '',
      status: 'assigned',
      profile: 'builder',
      source: 'requirement',
        feature_code: feature.code,
        defect_code: null,
      assignee_principal_code: builder.code,
      acceptance: [{ id: 'AC-1', text: 'Route works' }],
      base_snapshot: 7,
      created_at: '2026-08-13T00:00:00.000Z',
      completed_at: null,
      cancelled_at: null,
    }],
  });
  assert.equal(Object.hasOwn(response.json().data[0], 'task_id'), false);
});

test('GET /tasks/:task_code returns structure names and public codes without bigint ids', async () => {
  const { app, db, builder, feature } = await createFixture();
  const [project] = await db.select().from(schema.projects).limit(1);
  const module = await insertProjectModule(db, {
    code: publicCode(71),
    project_id: project.id,
    name: 'AUTH',
    description: 'Identity module',
    sort_order: 1,
    status: 'active',
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  });
  const phase = await insertProjectPhase(db, {
    code: publicCode(72),
    project_id: project.id,
    name: 'Foundation',
    goal: 'Lay groundwork',
    sort_order: 1,
    start_date: null,
    end_date: null,
    status: 'active',
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  });
  const milestone = await insertProjectMilestone(db, {
    code: publicCode(73),
    project_id: project.id,
    phase_id: phase.id,
    name: 'Password Gate',
    goal: 'Expose task structure names',
    target_date: null,
    sort_order: 1,
    status: 'active',
    owner_principal_id: null,
    created_at: '2026-08-13T00:00:00.000Z',
    updated_at: '2026-08-13T00:00:00.000Z',
  });
  await db.update(schema.features).set({
    module_id: module.id,
    milestone_id: milestone.id,
  }).where(eq(schema.features.id, feature.id));
  const task = await seedTask(db, feature, builder);

  const response = await app.inject({ method: 'GET', url: `/tasks/${task.code}`, headers: { 'x-principal-code': builder.code } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true, response.body);
  assert.equal(response.json().data.feature_code, feature.code);
  assert.equal(response.json().data.feature_name, 'HTTP routes');
  assert.equal(response.json().data.module_code, module.code);
  assert.equal(response.json().data.module_name, 'AUTH');
  assert.equal(response.json().data.milestone_code, milestone.code);
  assert.equal(response.json().data.milestone_name, 'Password Gate');
  assert.equal(response.json().data.phase_code, phase.code);
  assert.equal(response.json().data.phase_name, 'Foundation');
  assert.equal(Object.hasOwn(response.json().data, 'feature_id'), false);
  assert.equal(Object.hasOwn(response.json().data, 'module_id'), false);
  assert.equal(Object.hasOwn(response.json().data, 'milestone_id'), false);
  assert.equal(Object.hasOwn(response.json().data, 'phase_id'), false);
});

test('POST /tasks/:task_code/claim returns generated run and workspace public codes', async () => {
  const { app, db, builder, feature } = await createFixture();
  const task = await seedTask(db, feature, builder);

  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${task.code}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: claimPayload(),
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.task_code, task.code);
  assert.equal(body.data.status, 'running');
  assert.equal(body.data.run_code, publicCode(51));
  assert.equal(body.data.workspace_code, publicCode(61));

  const [run] = await db.select().from(schema.runs);
  const [workspace] = await db.select().from(schema.workspaces);
  assert.equal(run.task_id, task.id);
  assert.equal(run.principal_id, builder.id);
  assert.equal(run.workspace_id, workspace.id);
});

test('claim keeps business-state rejection in a structured envelope with conflict status', async () => {
  const { app, db, builder, feature } = await createFixture();
  const task = await seedTask(db, feature, builder, { status: 'ready' });

  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${task.code}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: claimPayload(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().ok, false);
  assert.equal(response.json().error.code, 'claim_not_assigned');
});

test('POST /tasks/:task_code/cancel cancels an unstarted task and keeps an audit trail', async () => {
  const { app, db, owner, builder, feature } = await createFixture();
  const task = await seedTask(db, feature, builder, { status: 'assigned' });

  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${task.code}/cancel`,
    headers: { 'x-principal-code': owner.code },
    payload: { base_snapshot: 7, reason: '排期调整' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true, response.body);
  assert.equal(response.json().data.status, 'cancelled');
  assert.equal(response.json().data.base_snapshot, 8);
  const [audit] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.cancelled'));
  assert.equal(audit.entity_id, task.id);
  assert.match(audit.payload, /排期调整/);
});

test('manual ready checks the version, project role and state before recording the change', async () => {
  const { app, db, owner, builder, feature } = await createFixture();
  const task = await seedTask(db, feature, builder, { status: 'failed' });
  const ready = (principal, payload) => app.inject({
    method: 'POST', url: `/tasks/${task.code}/ready`, headers: { 'x-principal-code': principal.code }, payload,
  });

  assert.equal((await ready(owner, {})).statusCode, 422);
  assert.equal((await ready(owner, { base_snapshot: 7.5 })).statusCode, 422);
  assert.equal((await ready(builder, { base_snapshot: 7 })).statusCode, 403);
  const stale = await ready(owner, { base_snapshot: 6 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'base_snapshot_mismatch');

  const response = await ready(owner, { base_snapshot: 7 });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data, {
    task_code: task.code, status: 'ready', assignee_principal_code: null, base_snapshot: 8,
  });
  const [saved] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  assert.equal(saved.status, 'ready');
  assert.equal(saved.assignee_principal_id, null);
  const [audit] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.readied'));
  assert.deepEqual([audit.entity_id, audit.principal_id, audit.from_state, audit.to_state, audit.base_snapshot],
    [task.id, owner.id, 'failed', 'ready', 7]);
  assert.equal((await ready(owner, { base_snapshot: 8 })).json().error.code, 'invalid_transition');

  const [noAcceptance] = await db.update(schema.tasks).set({ status: 'draft', acceptance: '[]' })
    .where(eq(schema.tasks.id, task.id)).returning();
  assert.equal((await ready(owner, { base_snapshot: noAcceptance.base_snapshot })).json().error.code, 'acceptance_required');
});

test('pre-claim reassignment requires an explicit version and records the previous assignee', async () => {
  const { app, db, owner, builder, other, feature } = await createFixture();
  const task = await seedTask(db, feature, builder);
  const assign = (assignee, fields) => app.inject({
    method: 'POST', url: `/tasks/${task.code}/assign`, headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: assignee.code, ...fields },
  });

  assert.equal((await assign(other, {})).statusCode, 422);
  const unchanged = await assign(builder, { base_snapshot: 7 });
  assert.equal(unchanged.statusCode, 409);
  assert.equal(unchanged.json().error.code, 'task_assignee_unchanged');

  const results = await Promise.all([assign(other, { base_snapshot: 7 }), assign(owner, { base_snapshot: 7 })]);
  const winner = results.findIndex((response) => response.statusCode === 200);
  assert.ok(winner >= 0, results.map((response) => response.body).join('\n'));
  const loser = results[1 - winner];
  assert.equal(loser.statusCode, 409);
  assert.equal(loser.json().error.code, 'base_snapshot_mismatch');
  const assignee = [other, owner][winner];
  assert.deepEqual(results[winner].json().data, {
    task_code: task.code, status: 'assigned', assignee_principal_code: assignee.code, base_snapshot: 8,
  });
  const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'task.reassigned'));
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].payload), { assignee_code: assignee.code, previous_assignee_code: builder.code });
  const fromFormerAssignee = await app.inject({
    method: 'POST', url: `/tasks/${task.code}/claim`, headers: { 'x-principal-code': builder.code },
    payload: claimPayload({ base_snapshot: 8 }),
  });
  assert.equal(fromFormerAssignee.json().error.code, 'claim_assignee_mismatch');
});

test('manual state and assignment changes preserve existing Runs and wait for unfinished work', async () => {
  const { app, db, owner, builder, other, feature } = await createFixture();
  const task = await seedTask(db, feature, builder);
  const claim = await app.inject({
    method: 'POST', url: `/tasks/${task.code}/claim`, headers: { 'x-principal-code': builder.code }, payload: claimPayload(),
  });
  assert.equal(claim.statusCode, 200, claim.body);

  // Represent a persisted blocked task (including a previously paused Run).
  await db.update(schema.tasks).set({ status: 'blocked' }).where(eq(schema.tasks.id, task.id));
  const ready = () => app.inject({
    method: 'POST', url: `/tasks/${task.code}/ready`, headers: { 'x-principal-code': owner.code }, payload: { base_snapshot: 8 },
  });
  for (const status of ['active', 'suspended', 'preparing']) {
    await db.update(schema.runs).set({ status }).where(eq(schema.runs.task_id, task.id));
    const response = await ready();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, 'task_run_active');
  }

  await db.update(schema.tasks).set({ status: 'assigned' }).where(eq(schema.tasks.id, task.id));
  const assign = await app.inject({
    method: 'POST', url: `/tasks/${task.code}/assign`, headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: other.code, base_snapshot: 8 },
  });
  assert.equal(assign.statusCode, 409);
  assert.equal(assign.json().error.code, 'task_run_active');

  await db.update(schema.tasks).set({ status: 'blocked' }).where(eq(schema.tasks.id, task.id));
  await db.update(schema.runs).set({ status: 'failed', finished_at: '2026-08-13T00:00:01.000Z' })
    .where(eq(schema.runs.task_id, task.id));
  const recovered = await ready();
  assert.equal(recovered.statusCode, 200, recovered.body);
  const runs = await db.select().from(schema.runs).where(eq(schema.runs.task_id, task.id));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].principal_id, builder.id);
});

test('claim reuses identity checks and returns claim_assignee_mismatch for another principal code', async () => {
  const { app, db, builder, other, feature } = await createFixture();
  const task = await seedTask(db, feature, builder);

  const response = await app.inject({
    method: 'POST',
    url: `/tasks/${task.code}/claim`,
    headers: { 'x-principal-code': other.code },
    payload: claimPayload(),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().ok, false);
  assert.equal(response.json().error.code, 'claim_assignee_mismatch');
});

test('bounded task HTTP reads meet 40-project / 5000-task query and payload budgets and use ordering index', async () => {
  const { app, db, builder, feature } = await createFixture();
  const [baseProject] = await db.select().from(schema.projects).limit(1);
  const projects = [baseProject, ...await db.insert(schema.projects).values(Array.from({ length: 39 }, (_, i) => ({
    team_id: baseProject.team_id, owner_principal_id: builder.id, name: `budget-${i}`, created_at: '2026-10-23T00:00:00Z',
  }))).returning()];
  const features = [feature, ...await db.insert(schema.features).values(projects.slice(1).map(project => ({
    project_id: project.id, title: 'budget feature', status: 'active',
  }))).returning()];
  for (const f of features) {
    await db.insert(schema.tasks).values(Array.from({ length: 125 }, (_, i) => ({ feature_id: f.id, title: `Task ${i}`, profile: 'builder',
      source: 'requirement', status: 'draft', base_snapshot: 0, acceptance: '[]', created_at: '2026-10-23T00:00:00Z' })));
  }
  const [device] = await db.insert(schema.devices).values({ principal_id: builder.id, device_name: 'budget client',
    credential_hash: createHash('sha256').update('execution-budget').digest('hex'), legacy_session_initialized: true,
    created_at: '2026-10-23T00:00:00Z' }).returning();
  await db.insert(schema.deviceSessions).values({ device_id: device.id, token_hash: createHash('sha256').update('budget-session').digest('hex'),
    created_at: '2026-10-23T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
  await db.$client.query('ANALYZE tasks');
  await db.$client.query('ANALYZE features');
  const query = db.$client.query.bind(db.$client);
  const calls = [];
  db.$client.query = (...args) => { calls.push(args); return query(...args); };
  let response;
  try {
    response = await app.inject({ method: 'GET', url: '/tasks?limit=50', headers: { authorization: 'Bearer budget-session' } });
  } finally { db.$client.query = query; }
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().total, 5000);
  assert.equal(response.json().data.length, 50);
  assert.equal(response.json().has_more, true);
  assert.ok(calls.length <= 8, `DB calls ${calls.length}`);
  assert.ok(Buffer.byteLength(response.body) <= 200 * 1024);
  const ordered = calls.find(args => (args[0].text ?? args[0]).includes('order by "tasks"."created_at"'));
  assert.ok(ordered);
  const plan = await query(`EXPLAIN ${ordered[0].text}`, ordered[1]);
  const planText = plan.rows.map(row => row['QUERY PLAN']).join('\n');
  assert.match(planText, /Index Scan.*idx_tasks_created_id/);
  console.log(`A-01 benchmark: ${calls.length} DB calls, ${Buffer.byteLength(response.body)} bytes, index idx_tasks_created_id`);

  const graph = await app.inject({ method: 'GET', url: `/tasks/graph?project_code=${baseProject.code}`, headers: { 'x-principal-code': builder.code } });
  assert.equal(graph.json().data.nodes.length, 125, 'graph must not truncate at default task page size');
  for (const value of ['0', '-1', '1.5', '501', 'abc', '', 'Infinity']) {
    const invalid = await app.inject({ method: 'GET', url: `/tasks?limit=${value}`, headers: { 'x-principal-code': builder.code } });
    assert.equal(invalid.statusCode, 422, invalid.body);
    assert.equal(invalid.json().error.code, 'validation_failed');
  }
  const beyond = await app.inject({ method: 'GET', url: '/tasks?limit=50&offset=5000', headers: { 'x-principal-code': builder.code } });
  assert.deepEqual({ ...beyond.json(), total: 5000 }, { ok: true, data: [], total: 5000, page: 101, has_more: false });
  const scoped = await app.inject({ method: 'GET', url: `/tasks?limit=50&project_code=${baseProject.code}`, headers: { 'x-principal-code': builder.code } });
  assert.equal(scoped.json().total, 125);
});
