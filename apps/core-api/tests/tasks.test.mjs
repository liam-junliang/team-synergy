import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
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
