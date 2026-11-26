import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { schema } from '@team-synergy/persistence';
import { createHttpTestContext, insertMember, insertProject, insertTeam, insertUser, testCode } from './http-test-helpers.mjs';

async function fixture(t) {
  const ctx = await createHttpTestContext(import.meta.url);
  t.after(() => ctx.cleanup());
  const { db } = ctx;
  const created_at = new Date().toISOString();
  const team = await insertTeam(db, { code: testCode(1000) });
  const project = await insertProject(db, { code: testCode(1001), teamId: team.id });
  const actors = {};
  for (const [role, number] of [['owner', 1002], ['member', 1004]]) {
    const user = await insertUser(db, { code: testCode(number), account: 'cli.' + role, displayName: role });
    await insertMember(db, { principalId: user.id, projectId: project.id, role, displayName: role });
    const token = 'isolated-task-workflow-cli-' + role;
    await db.insert(schema.devices).values({ code: testCode(number + 1), principal_id: user.id,
      device_name: role, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    actors[role] = { user, token };
  }
  const [feature] = await db.insert(schema.features).values({
    code: testCode(1006), project_id: project.id, title: 'Workflow fixture', status: 'active',
  }).returning();
  async function createTask(number, status) {
    const [task] = await db.insert(schema.tasks).values({
      code: testCode(number), feature_id: feature.id, title: 'Workflow task', profile: 'builder', source: 'ad-hoc',
      status, base_snapshot: 7, assignee_principal_id: status === 'assigned' ? actors.member.user.id : null, created_at,
      acceptance: JSON.stringify([{ id: 'AC-1', text: 'Check output' }, { id: 'AC-2', text: 'Check regression' }]),
    }).returning();
    return task;
  }
  async function runCli(role, args) {
    const result = await ctx.runCli(['task', ...args], { ACP_TOKEN: actors[role].token, ACP_DEVICE_TOKEN: '' });
    assert.ok(result.out, result.err);
    const envelope = JSON.parse(result.out);
    assert.equal(result.status, envelope.ok ? 0 : 1, result.out);
    return envelope;
  }
  async function post(role, task, action, body) {
    const response = await fetch(ctx.apiUrl + '/tasks/' + task.code + '/' + action, {
      method: 'POST', headers: { authorization: 'Bearer ' + actors[role].token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }
  return { createTask, runCli, post };
}

function success(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

test('CLI workflow inspects a Run and cancels it only after confirmation with its current snapshot', async t => {
  const { createTask, runCli, post } = await fixture(t);
  const task = await createTask(1010, 'assigned');
  const runCode = testCode(1011);
  success(await post('member', task, 'claim', {
    run_code: runCode, workspace_code: testCode(1012), profile: 'builder',
    workspace_path: '/isolated/test/workspace', git_base: 'a'.repeat(40), base_snapshot: task.base_snapshot,
  }));
  const { execution } = success(await runCli('owner', ['workflow', task.code]));
  assert.equal(execution.run_code, runCode);
  assert.equal(execution.can_cancel_execution, true);
  assert.equal(execution.cancellation_requires_confirmation, true);

  const attempt = ['cancel', task.code, '--execution', '--reason', '已有替代方案'];
  assert.equal((await runCli('owner', attempt)).error.code, 'base_snapshot_required');
  const flags = [...attempt, '--base-snapshot', String(execution.base_snapshot), '--idempotency-key', 'cancel-1011'];
  assert.equal((await runCli('owner', flags)).error.code, 'task_execution_confirmation_required');
  const receipt = success(await runCli('owner', [...flags, '--confirm-active']));
  assert.equal(receipt.status, 'cancelled');
  assert.deepEqual(receipt.stopped_run_codes, [runCode]);
  const current = success(await runCli('owner', ['status', task.code]));
  assert.equal(current.status, 'cancelled');
  assert.equal(current.runs.find(run => run.run_code === runCode).status, 'cancelled');
  assert.deepEqual(success(await runCli('owner', [...flags, '--confirm-active'])), receipt);

  const draft = await createTask(1013, 'draft');
  assert.equal(success(await runCli('owner', ['cancel', draft.code, '--reason', '撤回草稿'])).status, 'cancelled');
});

test('CLI review pins the submission, rejects partial coverage and closes a verified task', async t => {
  const { createTask, runCli, post } = await fixture(t);
  const task = await createTask(1010, 'assigned');
  const submitted = success(await post('member', task, 'web-workflow', {
    action: 'record_delivery', base_snapshot: task.base_snapshot,
    artifact_uri: 'https://example.test/commits/' + 'b'.repeat(40), content_hash: 'b'.repeat(40),
    summary: '自测两项均通过', acceptance_refs: ['AC-1', 'AC-2'],
  }));
  const { delivery } = success(await runCli('owner', ['workflow', task.code]));
  assert.equal(delivery.can_start_review, true);
  const start = ['review-start', task.code, '--base-snapshot', String(submitted.base_snapshot)];
  assert.equal((await runCli('member', start)).error.code, 'task_review_self');
  const started = success(await runCli('owner', start));
  const finish = ['review-finish', task.code, '--base-snapshot', String(started.base_snapshot), '--result', 'pass',
    '--summary', '验收固定提交', '--report-uri', 'https://example.test/reviews/1010'];
  assert.equal((await runCli('owner', [...finish, '--submission-code', testCode(9999),
    '--acceptance-refs', 'AC-1,AC-2'])).error.code, 'task_review_submission_changed');
  const pinned = [...finish, '--submission-code', delivery.submission_code];
  assert.equal((await runCli('owner', [...pinned, '--acceptance-refs', 'AC-1'])).error.code, 'acceptance_coverage_incomplete');
  const verified = success(await runCli('owner', [...pinned, '--acceptance-refs', 'AC-1, AC-2']));
  assert.equal(verified.status, 'verified');

  const close = ['close', task.code, '--base-snapshot'];
  assert.equal((await runCli('owner', [...close, String(started.base_snapshot)])).error.code, 'base_snapshot_mismatch');
  assert.equal(success(await runCli('owner', [...close, String(verified.base_snapshot)])).status, 'closed');
});
