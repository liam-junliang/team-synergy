import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createHttpTestContext, insertTeam, insertUser, insertProject, insertMember, testCode } from './http-test-helpers.mjs';

function git(cwd, ...args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); }
function passed(result, action) { let parsed; try { parsed = JSON.parse(result.out); } catch { assert.fail(`${action}: ${result.out} ${result.err}`); } assert.equal(parsed.ok, true, `${action}: ${result.out} ${result.err}`); assert.equal(result.status, 0, action); return parsed.data; }

// Uses the real Fastify server, application transactions, auth middleware and PostgreSQL.
// Must run serially with the existing database suites because their helper truncates acp_test.
test('real HTTP CLI: two identities and Git clones continue a task, replay old-version receipts and submit with the target lease', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  try {
    const timestamp = new Date().toISOString();
    const team = await insertTeam(ctx.db, { code: testCode(9500) });
    const source = await insertUser(ctx.db, { code: testCode(9501), account: 'handover-source', displayName: 'A' });
    const target = await insertUser(ctx.db, { code: testCode(9502), account: 'handover-target', displayName: 'B' });
    const project = await insertProject(ctx.db, { code: testCode(9503), teamId: team.id });
    await insertMember(ctx.db, { principalId: source.id, projectId: project.id, role: 'owner', displayName: 'A' });
    await insertMember(ctx.db, { principalId: target.id, projectId: project.id, role: 'member', displayName: 'B' });
    const sourceToken = 'http-handover-source-device-token'; const targetToken = 'http-handover-target-device-token';
    await ctx.db.insert(schema.devices).values([
      { code: testCode(9504), principal_id: source.id, device_name: 'A-computer', credential_hash: createHash('sha256').update(sourceToken).digest('hex'), created_at: timestamp },
      { code: testCode(9505), principal_id: target.id, device_name: 'B-computer', credential_hash: createHash('sha256').update(targetToken).digest('hex'), created_at: timestamp },
    ]);
    const aHome = path.join(ctx.tmp, 'A-auth'); const bHome = path.join(ctx.tmp, 'B-auth');
    for (const [directory, user, token] of [[aHome, source, sourceToken], [bHome, target, targetToken]]) {
      mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ api_url: ctx.apiUrl, device_token: token, user_code: user.code, device_name: directory }), { mode: 0o600 });
    }
    const bare = path.join(ctx.tmp, 'shared.git'); git(ctx.tmp, 'init', '--bare', bare);
    const aRepo = ctx.makeRepo('A-code'); git(aRepo, 'config', 'core.autocrlf', 'false'); git(aRepo, 'remote', 'add', 'origin', bare); git(aRepo, 'push', 'origin', 'HEAD'); git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const bRepo = path.join(ctx.tmp, 'B-code'); git(ctx.tmp, 'clone', bare, bRepo); git(bRepo, 'config', 'core.autocrlf', 'false');
    const [repository] = await ctx.db.insert(schema.projectRepositories).values({ code: testCode(9506), project_id: project.id, name: 'code', remote_url: bare, default_branch: 'main', created_by: source.id, created_at: timestamp, updated_at: timestamp }).returning();
    const [feature] = await ctx.db.insert(schema.features).values({ code: testCode(9507), project_id: project.id, title: 'Portable work', status: 'active' }).returning();
    const [task] = await ctx.db.insert(schema.tasks).values({ code: testCode(9508), feature_id: feature.id, title: 'Continue on B', brief: 'Complete A work using B own Agent.', profile: 'builder', source: 'ad-hoc', status: 'running', assignee_principal_id: source.id, acceptance: JSON.stringify([{ id: 'AC-1', text: 'Exact restored code and fresh test' }]), base_snapshot: 1, created_at: timestamp }).returning();
    const [workspace] = await ctx.db.insert(schema.workspaces).values({ code: testCode(9509), run_id: -9509n, path: aRepo, git_base: git(aRepo, 'rev-parse', 'HEAD'), created_at: timestamp }).returning();
    const [sourceRun] = await ctx.db.insert(schema.runs).values({ code: testCode(9510), task_id: task.id, principal_id: source.id, profile: 'builder', workspace_id: workspace.id, status: 'active', base_snapshot: 1, started_at: timestamp }).returning();
    await ctx.db.update(schema.workspaces).set({ run_id: sourceRun.id }).where(eq(schema.workspaces.id, workspace.id));
    await ctx.db.insert(schema.projectDocuments).values({ code: testCode(9511), project_id: project.id, kind: 'general', title: 'Original project fact', content: 'Keep this fixed source text.', revision: 1, status: 'active', created_by: source.id, updated_by: source.id, created_at: timestamp, updated_at: timestamp });
    writeFileSync(path.join(aRepo, 'README.md'), 'A staged text\n'); git(aRepo, 'add', 'README.md'); writeFileSync(path.join(aRepo, 'README.md'), 'A current unfinished text\n');
    writeFileSync(path.join(aRepo, 'new.txt'), 'Untracked required implementation\n');
    const indexBefore = readFileSync(path.join(aRepo, '.git', 'index'));
    const summary = path.join(ctx.tmp, 'reviewed-summary.json'); writeFileSync(summary, JSON.stringify({ goal: 'Continue A feature', completed: ['Implemented initial code'], remaining: ['Run fresh tests'], next_actions: ['Verify restored code'] }));
    const cleanLeaseEnvironment = { ACP_DEVICE_TOKEN: '', ACP_RUN_LEASE_TOKEN: '', ACP_EXECUTION_EPOCH: '' };
    const runA = (args) => ctx.runCli(args, { ...cleanLeaseEnvironment, AGENTCTL_HOME: aHome }, { cwd: aRepo });
    const runB = (args, extra = {}) => ctx.runCli(args, { ...cleanLeaseEnvironment, AGENTCTL_HOME: bHome, ...extra }, { cwd: bRepo });
    const prepareArgs = ['task', 'handover', 'prepare', task.code, '--target', target.code, '--run', sourceRun.code, '--summary', summary, '--repo', aRepo, '--repository', repository.code, '--agent-stopped'];
    const wrongRepositoryArgs = [...prepareArgs]; wrongRepositoryArgs[wrongRepositoryArgs.indexOf(repository.code)] = testCode(9599);
    const wrongRepository = await runA(wrongRepositoryArgs);
    assert.equal(JSON.parse(wrongRepository.out).error.code, 'handover_repository_mismatch');
    assert.equal(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/acp/handover/'), '');
    const [notPaused] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, sourceRun.id)); assert.equal(notPaused.status, 'active');
    const prepared = passed(await runA(prepareArgs), 'prepare');
    assert.deepEqual(readFileSync(path.join(aRepo, '.git', 'index')), indexBefore);
    const handoverCode = prepared.handover_code;
    await ctx.db.update(schema.taskHandovers).set({ preparation_expires_at: '2000-01-01T00:00:00.000Z' }).where(eq(schema.taskHandovers.code, handoverCode));
    const refreshed = passed(await runA(prepareArgs), 'prepare retry refreshes expired source grant through original receipt');
    assert.equal(refreshed.handover_code, handoverCode); assert.equal(refreshed.workspace_manifest.snapshot_commit, prepared.workspace_manifest.snapshot_commit);
    passed(await runA(['task', 'handover', 'publish', handoverCode]), 'publish');
    passed(await runB(['task', 'handover', 'accept', handoverCode]), 'accept');
    const worktree = path.join(ctx.tmp, 'B-worktree');
    const restoreArgs = ['task', 'handover', 'restore', handoverCode, '--repo', bRepo, '--dir', worktree];
    const restored = passed(await runB(restoreArgs), 'restore');
    const restoredAgain = passed(await runB(restoreArgs), 'restore receipt replay with old version');
    assert.equal(restoredAgain.target_run_code, restored.target_run_code);
    assert.equal(readFileSync(path.join(worktree, 'README.md'), 'utf8'), 'A current unfinished text\n');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), prepared.workspace_manifest.snapshot_commit);
    assert.ok(readFileSync(restored.brief_path, 'utf8').includes('Run fresh tests'));
    const activateArgs = ['task', 'handover', 'activate', handoverCode];
    const activated = passed(await runB(activateArgs), 'activate');
    const journalPath = path.join(bHome, 'handovers', `${handoverCode}.json`);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')); const originalLease = journal.activated.lease.lease_token;
    delete journal.activated; writeFileSync(journalPath, JSON.stringify(journal));
    const replay = passed(await runB(activateArgs), 'activate lost-response retry with old version');
    assert.equal(replay.run_code, activated.run_code);
    const runs = await ctx.db.select().from(schema.runs).where(eq(schema.runs.task_id, task.id));
    assert.equal(runs.length, 2); assert.equal(runs.find((row) => row.id === sourceRun.id).status, 'transferred');
    assert.equal(runs.find((row) => row.code === activated.run_code).continued_from_run_id, sourceRun.id);
    const receipts = await ctx.db.select().from(schema.commandReceipts).where(eq(schema.commandReceipts.principal_id, target.id));
    assert.equal(receipts.filter((row) => row.operation === 'handover.restore').length, 1);
    assert.equal(receipts.filter((row) => row.operation === 'handover.activate').length, 1);
    const submitArgs = ['task', 'submit', task.code, '--run-code', activated.run_code, '--artifact-kind', 'commit', '--artifact-uri', `git:${prepared.workspace_manifest.snapshot_commit}`, '--artifact-hash', 'fresh-test-code-hash', '--evidence-type', 'self_test', '--evidence-result', 'pass', '--acceptance-refs', 'AC-1', '--evidence-command', 'node --test', '--evidence-summary', 'B verified own restored environment'];
    const [beforeSubmitTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    const withoutLease = await fetch(`${ctx.apiUrl}/tasks/${task.code}/submit`, { method: 'POST', headers: { authorization: `Bearer ${targetToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ run_code: activated.run_code, base_snapshot: beforeSubmitTask.base_snapshot, artifact: { kind: 'commit', uri: `git:${prepared.workspace_manifest.snapshot_commit}`, contentHash: 'fresh-test-code-hash' }, evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'] } }) });
    assert.equal((await withoutLease.json()).error.code, 'execution_lease_invalid');
    const replayJournal = JSON.parse(readFileSync(journalPath, 'utf8'));
    replayJournal.activated.lease.expires_at = '2000-01-01T00:00:00.000Z';
    writeFileSync(journalPath, JSON.stringify(replayJournal));
    const activeTargetRun = runs.find((row) => row.code === activated.run_code);
    await ctx.db.update(schema.runLeases).set({ expires_at: '2000-01-01T00:00:00.000Z' }).where(eq(schema.runLeases.run_id, activeTargetRun.id));
    const submitted = passed(await runB(submitArgs), 'new Run submit automatically uses local device lease');
    assert.equal(submitted.status, 'submitted');
    const [savedTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    assert.equal(savedTask.assignee_principal_id, target.id);
    const [targetRun] = runs.filter((row) => row.code === activated.run_code);
    const leases = await ctx.db.select().from(schema.runLeases).where(and(eq(schema.runLeases.run_id, targetRun.id), eq(schema.runLeases.epoch, activated.execution_epoch)));
    assert.ok(leases.length >= 1); assert.ok(originalLease);
    assert.ok(!JSON.stringify(activated).includes(originalLease));
    const verifier = passed(await runA(['task', 'claim', task.code, '--profile', 'verifier', '--repo', worktree]), 'ordinary verifier claim after handover');
    const verified = passed(await runA(['task', 'verify', task.code, '--run-code', verifier.run_code, '--evidence-result', 'pass', '--acceptance-refs', 'AC-1', '--evidence-summary', 'A independently verified B continuation']), 'verifier without handover journal obtains own device lease');
    assert.equal(verified.status, 'verified');
  } finally { await ctx.cleanup(); }
});
