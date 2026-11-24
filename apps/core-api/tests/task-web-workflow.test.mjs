import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam,
  insertTeamMember, insertUser, openTestDb, publicCode,
} from './test-db.mjs';

test('web task recovery, human delivery, reassigned review, and close work through authenticated API', async (t) => {
  const db = await openTestDb();
  t.after(() => closeTestDb(db));
  const created_at = new Date().toISOString();
  const team = await insertTeam(db, { name: 'Workflow test team', created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Workflow test project', member_policy: 'private', created_at });
  const actors = {};
  for (const [account, role] of [['owner', 'owner'], ['original', 'member'], ['next', 'member'], ['viewer', 'viewer']]) {
    const user = await insertUser(db, { account, display_name: account, status: 'active', created_at });
    await insertTeamMember(db, { team_id: team.id, principal_id: user.id, role: role === 'owner' ? 'owner' : 'member', display_name: account, created_at });
    await insertProjectMember(db, { project_id: project.id, principal_id: user.id, role, display_name: account, created_at });
    const token = 'isolated-web-workflow-' + account;
    await db.insert(schema.devices).values({
      principal_id: user.id, credential_hash: createHash('sha256').update(token).digest('hex'), created_at,
    });
    actors[account] = { ...user, token };
  }
  const feature = await insertFeature(db, { project_id: project.id, title: 'Workflow feature', status: 'active' });
  const [task] = await db.insert(schema.tasks).values({
    feature_id: feature.id, title: 'Work left by an original runner', profile: 'builder', source: 'ad-hoc', status: 'assigned',
    assignee_principal_id: actors.original.id, base_snapshot: 7,
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Check output' }, { id: 'AC-2', text: 'Check regression' }]), created_at,
  }).returning();
  const app = await buildServer({ db, logger: false });
  t.after(() => app.close());
  const taskUrl = '/tasks/' + task.code;
  const workflow = taskUrl + '/web-workflow';
  const board = '/projects/' + project.code + '/task-workflow';
  const call = (actor, url, payload) => app.inject({
    method: payload ? 'POST' : 'GET', url,
    ...(actor ? { headers: { authorization: 'Bearer ' + actors[actor].token } } : {}),
    ...(payload ? { payload } : {}),
  }).then(response => response.json());
  const success = async (request) => {
    const result = await request;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const inspect = (actor = 'owner') => success(call(actor, workflow));
  const current = () => success(call('owner', taskUrl));
  const apply = async (actor, data) => call(actor, workflow, { base_snapshot: (await current()).base_snapshot, ...data });
  assert.equal((await call(null, workflow)).ok, false);

  const run_code = publicCode(401);
  await success(call('original', taskUrl + '/claim', {
    run_code, workspace_code: publicCode(402), profile: 'builder', workspace_path: '/test-only/workspace',
    base_snapshot: 7, git_base: 'a'.repeat(40),
  }));
  const before = await inspect();
  assert.equal(before.execution.run_code, run_code);
  assert.equal(before.execution.execution_health, 'unknown');
  assert.equal(before.execution.recovery_requires_confirmation, true);
  assert.equal((await inspect('viewer')).execution.can_recover, false);
  assert.equal((await success(call('owner', board))).find(row => row.task_code === task.code).execution_health, 'unknown');
  const recovery = { action: 'recover_execution', assignee_principal_code: actors.next.code, reason: 'Original executor became unavailable' };
  assert.equal((await apply('viewer', { ...recovery, confirm_active: true })).ok, false);
  assert.equal((await apply('owner', recovery)).ok, false);
  assert.equal((await success(apply('owner', { ...recovery, confirm_active: true }))).status, 'assigned');
  const [ended] = await db.select().from(schema.runs).where(eq(schema.runs.code, run_code));
  assert.equal(ended.status, 'cancelled');
  assert.ok(ended.finished_at);
  assert.equal((await current()).assignee_principal_code, actors.next.code);

  const submitted = await success(apply('next', {
    action: 'record_delivery', artifact_uri: 'https://forge.example/test/project/commit/' + 'b'.repeat(40),
    content_hash: 'b'.repeat(40), summary: 'Reproduced on the fixed revision and ran regression tests',
    acceptance_refs: ['AC-1', 'AC-2'],
  }));
  assert.equal(submitted.status, 'submitted');
  assert.equal((await inspect('next')).delivery.can_start_review, false);
  assert.equal((await success(call('owner', board))).find(row => row.task_code === task.code).review_status, 'waiting');
  const assignment = { action: 'assign_review', reviewer_principal_code: actors.original.code };
  await success(apply('owner', assignment));
  await success(apply('original', { action: 'start_review' }));
  const inReview = (await success(call('owner', board))).find(row => row.task_code === task.code);
  assert.equal(inReview.review_status, 'in_progress');
  assert.equal(inReview.reviewer_code, actors.original.code);
  const replacement = { action: 'assign_review', reviewer_principal_code: actors.owner.code };
  assert.equal((await apply('owner', replacement)).ok, false);
  await success(apply('owner', { ...replacement, confirm_active: true, reason: 'Reviewer is unavailable' }));
  await success(apply('owner', { action: 'start_review' }));
  const verify = { action: 'finish_review', submission_code: (await inspect()).delivery.submission_code,
    result: 'pass', summary: 'Reviewed the pinned commit and both acceptance criteria' };
  assert.equal((await apply('original', { ...verify, acceptance_refs: ['AC-1', 'AC-2'] })).ok, false);
  assert.equal((await apply('owner', { ...verify, acceptance_refs: ['AC-1'] })).ok, false);
  assert.equal((await apply('owner', { ...verify, submission_code: publicCode(900), acceptance_refs: ['AC-1', 'AC-2'] })).ok, false);
  assert.equal((await success(apply('owner', { ...verify, acceptance_refs: ['AC-1', 'AC-2'] }))).status, 'verified');
  const evidence = await success(call('owner', taskUrl + '/evidences'));
  assert.ok(evidence.some(item => item.type === 'verifier_review' && item.result === 'pass'));
  assert.equal((await success(call('owner', taskUrl + '/close', { base_snapshot: (await current()).base_snapshot }))).status, 'closed');
});
