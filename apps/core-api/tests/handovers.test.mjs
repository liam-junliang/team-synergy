import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam,
  insertTeamMember, insertUser, openTestDb, publicCode,
} from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const created_at = '2026-10-13T00:00:00.000Z';
  const team = await insertTeam(db, { code: publicCode(10), name: 'Handover team', created_at });
  const project = await insertProject(db, { code: publicCode(20), team_id: team.id, name: 'Handover project', current_snapshot: 1, created_at });
  const users = [];
  for (const [index, name] of ['owner', 'builder', 'target', 'outsider'].entries()) {
    const user = await insertUser(db, { code: publicCode(index + 1), account: `handover.${name}`, display_name: name, status: 'active', created_at });
    const token = `handover-${name}-credential`;
    const [device] = await db.insert(schema.devices).values({
      code: publicCode(index + 101), principal_id: user.id, device_name: `${name}-computer`,
      credential_hash: createHash('sha256').update(token).digest('hex'), created_at,
    }).returning();
    if (name !== 'outsider') {
      const role = name === 'owner' ? 'owner' : 'member';
      await insertTeamMember(db, { team_id: team.id, principal_id: user.id, role, display_name: name, created_at });
      await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: name, created_at });
    }
    users.push({ ...user, device, headers: { authorization: `Bearer ${token}` } });
  }
  const [owner, builder, target, outsider] = users;
  const feature = await insertFeature(db, { code: publicCode(30), project_id: project.id, title: 'Handover feature', status: 'active' });
  const [repository] = await db.insert(schema.projectRepositories).values({
    code: publicCode(35), project_id: project.id, name: 'Source repository', remote_url: 'https://example.com/team/project.git',
    default_branch: 'main', created_by: owner.id, created_at, updated_at: created_at,
  }).returning();
  const [task] = await db.insert(schema.tasks).values({
    code: publicCode(40), feature_id: feature.id, title: 'Continue on another computer', profile: 'builder',
    source: 'ad-hoc', status: 'assigned', assignee_principal_id: builder.id,
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Portable handover' }]), base_snapshot: 1, created_at,
  }).returning();
  const claim = await app.inject({ method: 'POST', url: `/tasks/${task.code}/claim`, headers: builder.headers,
    payload: { run_code: publicCode(60), workspace_code: publicCode(50), profile: 'builder',
      base_snapshot: 1, workspace_path: 'C:/source/worktree', git_base: 'a'.repeat(40) },
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.code, publicCode(60)));
  const [currentTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  return { app, db, owner, builder, target, outsider, repository, task: currentTask, run };
}

afterEach(async () => {
  for (const { app, db } of fixtures.splice(0)) {
    await app.close();
    await closeTestDb(db);
  }
});

test('project handover list aggregates tasks, isolates projects and keeps unpublished handovers private', async () => {
  const { app, db, owner, builder, target, outsider, task, run } = await fixture();
  const [feature] = await db.select().from(schema.features).where(eq(schema.features.id, task.feature_id));
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, feature.project_id));
  async function prepare(taskRow, runRow) {
    const response = await app.inject({ method: 'POST', url: `/tasks/${taskRow.code}/handovers/prepare`, headers: builder.headers,
      payload: { source_run_code: runRow.code, target_user_code: target.code, base_snapshot: taskRow.base_snapshot } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.handover_code;
  }
  async function extraTask(projectId, seed) {
    const extraFeature = await insertFeature(db, { code: publicCode(seed), project_id: projectId, title: 'Extra feature', status: 'active' });
    const [extra] = await db.insert(schema.tasks).values({ code: publicCode(seed + 1), feature_id: extraFeature.id,
      title: `Extra task ${seed}`, profile: 'builder', source: 'ad-hoc', status: 'assigned', assignee_principal_id: builder.id,
      acceptance: JSON.stringify([{ id: 'AC-1', text: 'Continue work' }]), base_snapshot: 1, created_at: '2026-10-13T00:00:00.000Z' }).returning();
    const response = await app.inject({ method: 'POST', url: `/tasks/${extra.code}/claim`, headers: builder.headers,
      payload: { run_code: publicCode(seed + 2), workspace_code: publicCode(seed + 3), profile: 'builder', base_snapshot: 1,
        workspace_path: `C:/worktree-${seed}`, git_base: 'a'.repeat(40) } });
    assert.equal(response.statusCode, 200, response.body);
    const [current] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, extra.id));
    const [extraRun] = await db.select().from(schema.runs).where(eq(schema.runs.code, publicCode(seed + 2)));
    return prepare(current, extraRun);
  }
  const first = await prepare(task, run);
  const second = await extraTask(project.id, 200);
  const other = await insertProject(db, { code: publicCode(300), team_id: project.team_id, name: 'Other project', current_snapshot: 1, created_at: project.created_at });
  await insertProjectMember(db, { project_id: other.id, principal_id: builder.id, role: 'owner', display_name: 'builder', created_at: project.created_at });
  await insertProjectMember(db, { project_id: other.id, principal_id: target.id, role: 'member', display_name: 'target', created_at: project.created_at });
  const unrelated = await extraTask(other.id, 310);
  await db.update(schema.taskHandovers).set({ updated_at: '2026-10-13T01:00:00.000Z' }).where(eq(schema.taskHandovers.code, first));
  await db.update(schema.taskHandovers).set({ updated_at: '2026-10-13T02:00:00.000Z' }).where(eq(schema.taskHandovers.code, second));
  async function list(user, projectCode = project.code) {
    return app.inject({ method: 'GET', url: `/projects/${projectCode}/handovers`, headers: user.headers });
  }
  for (const user of [owner, builder]) {
    const response = await list(user);
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json().data;
    assert.deepEqual(data.map(row => row.handover_code), [second, first]);
    assert.equal(data[1].task_title, task.title);
    assert.equal(data[1].source_user_name, 'builder');
    assert.equal(data[1].target_user_name, 'target');
    assert.ok(data.every(row => row.handover_code !== unrelated));
  }
  assert.deepEqual((await list(target)).json().data, []);
  // Publication visibility depends on published_by, including terminal records.
  await db.update(schema.taskHandovers).set({ published_by: owner.id, status: 'cancelled' }).where(eq(schema.taskHandovers.code, first));
  assert.deepEqual((await list(target)).json().data.map(row => row.handover_code), [first]);
  for (const response of [await list(outsider), await list(owner, other.code)]) {
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, 'handover_forbidden');
  }
  const malformed = await list(builder, 'bad-code');
  assert.equal(malformed.statusCode, 422, malformed.body);
  const legacy = await app.inject({ method: 'GET', url: `/projects/${project.code}/handovers`, headers: { 'x-principal-code': builder.code } });
  assert.ok([401, 403].includes(legacy.statusCode), legacy.body);
  const anonymous = await app.inject({ method: 'GET', url: `/projects/${project.code}/handovers` });
  assert.ok([401, 403].includes(anonymous.statusCode), anonymous.body);
  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, project.id));
  const archived = await list(owner);
  assert.equal(archived.statusCode, 200, archived.body);
  assert.deepEqual(archived.json().data.map(row => row.handover_code), [second, first]);
  const archivedWrite = await app.inject({ method: 'POST', url: `/handovers/${second}/publish`, headers: owner.headers, payload: {} });
  assert.equal(archivedWrite.statusCode, 403, archivedWrite.body);
  assert.equal(archivedWrite.json().error.code, 'project_archived');
});

test('handover mutations require bearer credentials even when legacy identity is enabled', async () => {
  const { app, builder, task, run } = await fixture();
  const response = await app.inject({ method: 'POST', url: `/tasks/${task.code}/handovers/prepare`,
    headers: { 'x-principal-code': builder.code },
    payload: { source_run_code: run.code, target_user_code: publicCode(3), base_snapshot: 1 },
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(response.json().error.code, 'unauthorized');
  for (const action of ['draft', 'stop-ack', 'source-stop-ack', 'publish', 'accept', 'restore', 'ready', 'activate', 'cancel', 'approve-drift']) {
    const result = await app.inject({ method: 'POST', url: `/handovers/${publicCode(70)}/${action}`, payload: {} });
    assert.equal(result.statusCode, 401, `${action}: ${result.body}`);
  }
});

test('handover request bodies cannot override authenticated principal or device', async () => {
  const { app, builder, target, task, run } = await fixture();
  for (const spoof of [{ principal_code: target.code }, { device_code: target.device.code }, { identity: { principalCode: target.code } }]) {
    const response = await app.inject({ method: 'POST', url: `/tasks/${task.code}/handovers/prepare`, headers: builder.headers,
      payload: { source_run_code: run.code, target_user_code: target.code, base_snapshot: 1, ...spoof },
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'validation_failed');
  }
  const rows = await app.inject({ method: 'GET', url: `/tasks/${task.code}/handovers`, headers: builder.headers });
  assert.equal(rows.statusCode, 200, rows.body);
  assert.deepEqual(rows.json().data, []);
});

test('task handover lists enforce project membership and validate public codes', async () => {
  const { app, outsider, builder, task } = await fixture();
  const denied = await app.inject({ method: 'GET', url: `/tasks/${task.code}/handovers`, headers: outsider.headers });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().ok, false);
  const malformed = await app.inject({ method: 'GET', url: '/context-snapshots/not-a-code', headers: builder.headers });
  assert.equal(malformed.statusCode, 422, malformed.body);
  const anonymous = await app.inject({ method: 'GET', url: `/tasks/${task.code}/handovers` });
  assert.ok([401, 403].includes(anonymous.statusCode), anonymous.body);
});

test('HTTP preparation binds the authenticated source device and keeps drafts private', async () => {
  const { app, db, owner, builder, target, task, run } = await fixture();
  const request = { method: 'POST', url: `/tasks/${task.code}/handovers/prepare`,
    headers: { ...builder.headers, 'idempotency-key': 'http-prepare-1' },
    payload: { source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot },
  };
  const prepared = await app.inject(request);
  assert.equal(prepared.statusCode, 200, prepared.body);
  const code = prepared.json().data.handover_code;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  const [row] = await db.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.code, code));
  assert.equal(row.source_device_id, builder.device.id);
  const repeated = await app.inject(request);
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().data.handover_code, code);
  const targetRead = await app.inject({ method: 'GET', url: `/handovers/${code}`, headers: target.headers });
  assert.equal(targetRead.statusCode, 403, targetRead.body);
  const ownerRead = await app.inject({ method: 'GET', url: `/handovers/${code}`, headers: owner.headers });
  assert.equal(ownerRead.statusCode, 200, ownerRead.body);
  assert.equal(ownerRead.json().data.source_user_code, builder.code);
  assert.equal(ownerRead.json().data.target_user_code, target.code);
});

test('HTTP handover restores immutable context on the target device and atomically activates a new Run', async () => {
  const { app, db, owner, builder, target, repository, task, run } = await fixture();
  async function request(user, method, url, payload, key) {
    const response = await app.inject({ method, url, headers: { ...user.headers, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 200, `${method} ${url}: ${response.body}`);
    assert.equal(response.json().ok, true, response.body);
    return response.json().data;
  }
  const prepared = await request(builder, 'POST', `/tasks/${task.code}/handovers/prepare`, {
    source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot,
  }, 'route-flow-prepare');
  const url = `/handovers/${prepared.handover_code}`;
  const workspaceManifest = {
    repository_code: repository.code, remote_url: repository.remote_url, base_commit: 'a'.repeat(40),
    snapshot_commit: 'b'.repeat(40), snapshot_tree: 'c'.repeat(40), snapshot_ref: 'refs/heads/acp-handover-route-test',
    files: [{ path: 'src/example.ts', hash: 'd'.repeat(64) }],
  };
  const draft = await request(builder, 'PUT', `${url}/draft`, {
    preparation_grant: prepared.preparation_grant, version: prepared.version,
    summary: { goal: 'Continue on another computer', completed: ['Implementation drafted'], remaining: ['Run target tests'], next_actions: ['Read the frozen requirement'] },
    workspace_manifest: workspaceManifest,
  }, 'route-flow-draft');
  const stop = await request(builder, 'POST', `${url}/source-stop-ack`, {
    preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation',
  }, 'route-flow-stop');
  assert.equal(stop.status, 'preparing');
  const published = await request(owner, 'POST', `${url}/publish`, { version: stop.version }, 'route-flow-publish');
  assert.equal(published.status, 'published');
  const context = await request(target, 'GET', `/context-snapshots/${published.context_snapshot_code}`);
  assert.equal(context.context_snapshot_hash, draft.context_snapshot_hash);
  assert.equal(context.summary.goal, 'Continue on another computer');
  const drift = await request(target, 'GET', `/context-snapshots/${published.context_snapshot_code}/diff`);
  assert.equal(drift.source_changed, false);
  const accepted = await request(target, 'POST', `${url}/accept`, { version: published.version }, 'route-flow-accept');
  const restored = await request(target, 'POST', `${url}/restore`, {
    version: accepted.version, workspace_path: 'D:/target/independent-worktree', git_base: workspaceManifest.snapshot_commit,
  }, 'route-flow-restore');
  const receipt = { version: restored.version, attempt_code: restored.attempt_code, workspace_digest: 'e'.repeat(64),
    snapshot_commit: workspaceManifest.snapshot_commit, context_snapshot_hash: published.context_snapshot_hash, assurance: 'client_reported' };
  const spoofed = await app.inject({ method: 'POST', url: `${url}/ready`, headers: target.headers,
    payload: { ...receipt, device_code: builder.device.code },
  });
  assert.equal(spoofed.statusCode, 422, spoofed.body);
  const ready = await request(target, 'POST', `${url}/ready`, receipt, 'route-flow-ready');
  const activationBody = {
    version: ready.version, attempt_code: restored.attempt_code, context_snapshot_hash: published.context_snapshot_hash,
  };
  const activated = await request(target, 'POST', `${url}/activate`, activationBody, 'route-flow-activate');
  const replayed = await request(target, 'POST', `${url}/activate`, activationBody, 'route-flow-activate');
  assert.equal(replayed.run_code, activated.run_code);
  assert.equal(replayed.lease.lease_token, activated.lease.lease_token);
  assert.equal(activated.run_code, restored.target_run_code);
  assert.ok(activated.execution_epoch > 0);
  assert.ok(activated.lease.lease_token);
  const [sourceRun] = await db.select().from(schema.runs).where(eq(schema.runs.id, run.id));
  const [targetRun] = await db.select().from(schema.runs).where(eq(schema.runs.code, activated.run_code));
  const [currentTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  assert.equal(sourceRun.status, 'transferred');
  assert.equal(sourceRun.principal_id, builder.id);
  assert.equal(targetRun.status, 'active');
  assert.equal(targetRun.principal_id, target.id);
  assert.equal(targetRun.continued_from_run_id, sourceRun.id);
  assert.notEqual(targetRun.workspace_id, sourceRun.workspace_id);
  assert.equal(currentTask.assignee_principal_id, target.id);
  assert.equal((await request(target, 'GET', url)).status, 'completed');
});

test('invalid idempotency keys are rejected instead of silently disabling replay protection', async () => {
  const { app, db, builder, target, task, run } = await fixture();
  for (const key of ['', ' ', 'x'.repeat(129), 'x'.repeat(201)]) {
    for (const [url, payload] of [
      [`/tasks/${task.code}/handovers/prepare`, { source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot }],
      [`/handovers/${publicCode(70)}/publish`, {}],
      [`/runs/${run.code}/resume`, {}],
    ]) {
      const response = await app.inject({ method: 'POST', url, headers: { ...builder.headers, 'idempotency-key': key }, payload });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().error.code, 'validation_failed');
    }
  }
  assert.equal((await db.select().from(schema.taskHandovers)).length, 0);
  const response = await app.inject({ method: 'POST', url: `/tasks/${task.code}/handovers/prepare`,
    headers: { ...builder.headers, 'idempotency-key': 'x'.repeat(128) },
    payload: { source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot },
  });
  assert.equal(response.statusCode, 200, response.body);
});

test('a task pinned to r1 requires Owner approval when the requirement was already r2 before preparing', async () => {
  const { app, db, owner, builder, target, repository, task, run } = await fixture();
  const [requirement] = await db.insert(schema.requirements).values({
    code: publicCode(75), feature_id: task.feature_id, title: 'Requirement already changed',
    current_revision: 2, state: 'confirmed', owner_principal_id: owner.id,
  }).returning();
  const [r1] = await db.insert(schema.requirementRevisions).values([1, 2].map((revision) => ({
    code: publicCode(75 + revision), requirement_id: requirement.id, revision,
    summary: `Requirement r${revision}`, acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'Portable handover' }]),
    created_at: '2026-10-13T00:00:00.000Z',
  }))).returning();
  await db.update(schema.tasks).set({ requirement_id: requirement.id, source_requirement_revision_id: r1.id, source: 'requirement' }).where(eq(schema.tasks.id, task.id));
  const preparedResponse = await app.inject({ method: 'POST', url: `/tasks/${task.code}/handovers/prepare`, headers: builder.headers,
    payload: { source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot },
  });
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
  const prepared = preparedResponse.json().data;
  const url = `/handovers/${prepared.handover_code}`;
  const draftResponse = await app.inject({ method: 'PUT', url: `${url}/draft`, headers: builder.headers,
    payload: { preparation_grant: prepared.preparation_grant, version: prepared.version,
      summary: { goal: 'Continue with the reviewed r1 baseline' },
      workspace_manifest: { repository_code: repository.code, remote_url: repository.remote_url,
        base_commit: 'a'.repeat(40), snapshot_commit: 'b'.repeat(40), snapshot_tree: 'c'.repeat(40), snapshot_ref: 'refs/heads/acp-handover-baseline-test' },
    },
  });
  assert.equal(draftResponse.statusCode, 200, draftResponse.body);
  const stop = await app.inject({ method: 'POST', url: `${url}/source-stop-ack`, headers: builder.headers,
    payload: { preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation' },
  });
  assert.equal(stop.statusCode, 200, stop.body);
  const denied = await app.inject({ method: 'POST', url: `${url}/publish`, headers: owner.headers,
    payload: { version: stop.json().data.version },
  });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(denied.json().error.code, 'context_source_changed');
  const approval = await app.inject({ method: 'POST', url: `${url}/approve-drift`, headers: owner.headers,
    payload: { reason: 'r2 belongs to a later release; finish the explicitly reviewed r1 scope first.' },
  });
  assert.equal(approval.statusCode, 200, approval.body);
  const published = await app.inject({ method: 'POST', url: `${url}/publish`, headers: owner.headers,
    payload: { version: approval.json().data.version },
  });
  assert.equal(published.statusCode, 200, published.body);
  const context = await app.inject({ method: 'GET', url: `/context-snapshots/${published.json().data.context_snapshot_code}`, headers: target.headers });
  assert.equal(context.statusCode, 200, context.body);
  const source = context.json().data.manifest.sources.find((item) => item.kind === 'requirement');
  assert.equal(source.revision, 1);
  assert.equal(source.content, 'Requirement r1');
});

test('preparing rejects a missing fixed document revision without suspending the source Run', async () => {
  const { app, db, builder, target, task, run } = await fixture();
  await db.update(schema.tasks).set({ source_document_revision_id: 999999n }).where(eq(schema.tasks.id, task.id));
  const response = await app.inject({ method: 'POST', url: `/tasks/${task.code}/handovers/prepare`, headers: builder.headers,
    payload: { source_run_code: run.code, target_user_code: target.code, base_snapshot: task.base_snapshot },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'context_source_missing');
  assert.equal((await db.select().from(schema.taskHandovers)).length, 0);
  assert.equal((await db.select().from(schema.runs).where(eq(schema.runs.id, run.id)))[0].status, 'active');
});
