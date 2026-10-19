import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildServer } from '../../core-api/dist/server.js';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { closeDb, openDb, schema } from '@team-synergy/persistence';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');
const migrationsFolder = path.resolve(here, '../../../packages/persistence/drizzle');
const testDatabaseUrl = process.env.ACP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acp_test';
let databaseEnsured = false;
const code = (value) => String(value).padStart(20, '0');
const IDS = Object.freeze({ team: 1n, user: 2n, project: 3n, feature: 4n, task: 5n, workspace: 6n, run: 7n });
const CODES = Object.freeze({
  team: code(1), user: code(2), project: code(3), feature: code(4),
  task: code(5), workspace: code(6), run: code(7),
});

function databaseNameOf(databaseUrl) {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsupported test database name: ${databaseName}`);
  }
  return databaseName;
}

function adminDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function ensureTestDatabase() {
  if (databaseEnsured) return;
  const databaseName = databaseNameOf(testDatabaseUrl);
  const pool = new Pool({ connectionString: adminDatabaseUrl(testDatabaseUrl) });
  try {
    const result = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (result.rowCount === 0) {
      await pool.query(`CREATE DATABASE "${databaseName}"`);
    }
    databaseEnsured = true;
  } finally {
    await pool.end();
  }
}

async function truncateAllTables(db) {
  const result = await db.$client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'",
  );
  if (result.rows.length === 0) return;
  const tables = result.rows.map(({ tablename }) => `"${String(tablename).replaceAll('"', '""')}"`);
  await db.$client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

async function fixture() {
  const root = path.join(os.tmpdir(), `agentd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspace = path.join(root, 'workspace');
  const repo = path.join(workspace, 'repo');
  const brief = path.join(workspace, '.agent', 'project-state', 'brief.md');
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.dirname(brief), { recursive: true });
  writeFileSync(brief, '# Test brief\n');

  await ensureTestDatabase();
  const db = await openDb({ databaseUrl: testDatabaseUrl, migrationsFolder });
  await truncateAllTables(db);
  await db.insert(schema.teams).values({ id: IDS.team, code: CODES.team, name: 'team', created_at: '2026-01-01T00:00:00.000Z' });
  await db.insert(schema.users).values({
    id: IDS.user, code: CODES.user, account: 'wang', display_name: 'wang',
    status: 'active', created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.teamMembers).values({
    team_id: IDS.team, principal_id: IDS.user, role: 'member', display_name: 'wang',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.projects).values({
    id: IDS.project, code: CODES.project, team_id: IDS.team, name: 'project',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.members).values({
    principal_id: IDS.user, project_id: IDS.project, role: 'member', display_name: 'wang',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.features).values({
    id: IDS.feature, code: CODES.feature, project_id: IDS.project, title: 'feature',
  });
  await db.insert(schema.tasks).values({
    id: IDS.task, code: CODES.task, feature_id: IDS.feature, title: 'task', profile: 'builder', status: 'running',
    assignee_principal_id: IDS.user, acceptance: '[{"id":"AC-1","text":"x"}]',
    base_snapshot: 1, created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.workspaces).values({
    id: IDS.workspace, code: CODES.workspace, run_id: IDS.run, path: workspace, git_base: 'abc',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await db.insert(schema.runs).values({
    id: IDS.run, code: CODES.run, task_id: IDS.task, principal_id: IDS.user, profile: 'builder',
    workspace_id: IDS.workspace, status: 'active', base_snapshot: 1,
    started_at: '2026-01-01T00:00:00.000Z',
  });
  const deviceToken = 'agentd-test-device-token';
  await db.insert(schema.devices).values({ code: code(8), principal_id: IDS.user, credential_hash: createHash('sha256').update(deviceToken).digest('hex'), created_at: '2026-01-01T00:00:00.000Z' });
  const app = await buildServer({ db, logger: false });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const env = { ...process.env, ACP_DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/must_not_connect', ACP_API_URL: apiUrl, ACP_DEVICE_TOKEN: deviceToken, AGENTCTL_HOME: path.join(root, 'auth'), AGENTD_HOME: path.join(root, 'journal'), AGENTD_WATCHDOG_INTERVAL_MS: '250' };
  const run = (args, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: repo,
    env: { ...env, ...overrides },
  });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });

  return {
    root,
    run,
    db,
    apiUrl,
    deviceToken,
    command(name, source) {
      const file = path.join(repo, `${name}.mjs`);
      writeFileSync(file, source);
      return `"${process.execPath}" "${file}"`;
    },
    open() {
      return openDb({ databaseUrl: testDatabaseUrl, migrationsFolder });
    },
    async cleanup() {
      await run(['stop', '--run', CODES.run]);
      await app.close();
      await closeDb(db);
      await delay(200);
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

async function parseSuccess(pending) {
  const result = await pending;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

async function waitForStatus(f, sessionCode, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await parseSuccess(f.run(['sync', '--run', CODES.run]));
    const session = data.sessions.find((candidate) => candidate.session_code === sessionCode);
    if (session?.status === expected) return session;
    await delay(50);
  }
  assert.fail(`Session ${sessionCode} 未在 ${timeoutMs}ms 内进入 ${expected}`);
}

async function storedSession(db, sessionCode) {
  const [session] = await db.select().from(schema.agentSessions)
    .where(eq(schema.agentSessions.code, sessionCode)).limit(1);
  assert.ok(session, `Session ${sessionCode} 应已落库`);
  return session;
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

test('start 使用注入命令启动并落库 running Session 与审计状态', async () => {
  const f = await fixture();
  try {
    const mockCommand = f.command('start-running', 'setTimeout(() => process.exit(0), 5000);\n');
    const launchStartedAt = Date.now();
    const session = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', mockCommand]));
    assert.ok(Date.now() - launchStartedAt < 3000, 'start 不应等待后台 Agent 退出');
    assert.equal(session.run_code, CODES.run);
    assert.equal(session.agent_command, mockCommand);
    assert.equal(session.launch_kind, 'custom');
    assert.equal(session.status, 'running');
    assert.equal(typeof session.process_id, 'number');

    const db = await f.open();
    const persisted = await storedSession(db, session.session_code);
    assert.equal(persisted.status, 'running');
    const audit = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity_id, persisted.id));
    assert.equal(audit[0].to_state, 'starting');
    assert.ok(audit.some(event => event.to_state === 'running'));
    await closeDb(db);
  } finally {
    await f.cleanup();
  }
});

test('resume 读回最近一次 Session 命令并创建关联的恢复记录', async () => {
  const f = await fixture();
  try {
    const mockCommand = f.command('resume-running', 'setTimeout(() => process.exit(0), 2000);\n');
    const db = await f.open();
    await db.insert(schema.agentSessions).values({
      id: 50n, code: code(50), run_id: IDS.run, agent_command: mockCommand,
      launch_kind: 'custom', prompt_path: null, status: 'finished',
      started_at: '2026-01-01T00:00:00.000Z',
    });
    await closeDb(db);

    const resumed = await parseSuccess(f.run(['resume', '--run', CODES.run]));
    assert.notEqual(resumed.session_code, code(50));
    assert.equal(resumed.agent_command, mockCommand);
    assert.equal(resumed.status, 'running');

    const verifyDb = await f.open();
    const records = await verifyDb.select().from(schema.agentSessions)
      .where(eq(schema.agentSessions.run_id, IDS.run));
    assert.equal(records.length, 2);
    const resumedStored = await storedSession(verifyDb, resumed.session_code);
    const audit = await verifyDb.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity_id, resumedStored.id));
    assert.equal(audit[0].action, 'agent_session.resume');
    await closeDb(verifyDb);
  } finally {
    await f.cleanup();
  }
});

test('sessions 以 JSON envelope 列出 Run 的全部会话', async () => {
  const f = await fixture();
  try {
    const db = await f.open();
    await db.insert(schema.agentSessions).values([
      { id: 51n, code: code(51), run_id: IDS.run, agent_command: 'one', launch_kind: 'custom', status: 'running', started_at: '2026-01-01T00:00:00.000Z' },
      { id: 52n, code: code(52), run_id: IDS.run, agent_command: 'two', launch_kind: 'custom', status: 'failed', started_at: '2026-01-02T00:00:00.000Z', finished_at: '2026-01-02T00:01:00.000Z', last_error: 'boom' },
    ]);
    await closeDb(db);

    const data = await parseSuccess(f.run(['sessions', '--run', CODES.run]));
    assert.equal(data.run_code, CODES.run);
    assert.deepEqual(data.sessions.map((session) => session.session_code), [code(52), code(51)]);
    assert.equal(data.sessions[0].last_error, 'boom');
  } finally {
    await f.cleanup();
  }
});

test('sync 将正常退出的后台 Session 标记为 finished', async () => {
  const f = await fixture();
  try {
    const command = f.command('exit-zero', "console.log('normal-output');\nprocess.exit(0);\n");
    const started = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    const finished = await waitForStatus(f, started.session_code, 'finished');
    assert.equal(finished.exit_code, 0);
    assert.equal(finished.last_error, null);
    assert.match(finished.last_output, /normal-output/);

    const db = await f.open();
    const stored = await storedSession(db, started.session_code);
    const audit = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity_id, stored.id));
    assert.equal(audit.at(-1).to_state, 'finished');
    await closeDb(db);
  } finally {
    await f.cleanup();
  }
});

test('sync 将异常退出标记为 failed 并记录 exit_code、last_error 与审计', async () => {
  const f = await fixture();
  try {
    const command = f.command('exit-three', "console.error('fatal-output');\nprocess.exit(3);\n");
    const started = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    const failed = await waitForStatus(f, started.session_code, 'failed');
    assert.equal(failed.exit_code, 3);
    assert.match(failed.last_error, /code 3/);
    assert.match(failed.last_output, /fatal-output/);

    const db = await f.open();
    const stored = await storedSession(db, started.session_code);
    const audit = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity_id, stored.id));
    assert.equal(audit.at(-1).to_state, 'failed');
    assert.equal(JSON.parse(audit.at(-1).payload).exit_code, 3);
    await closeDb(db);
  } finally {
    await f.cleanup();
  }
});

test('stop 终止后台进程树并将 Session 标记为 cancelled', async () => {
  const f = await fixture();
  try {
    const command = f.command(
      'wait-for-cancel',
      "console.log('waiting-for-cancel');\nsetInterval(() => {}, 1000);\n",
    );
    const started = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    assert.equal(processIsAlive(started.process_id), true);

    const stopped = await parseSuccess(f.run(['stop', '--session', started.session_code]));
    assert.equal(stopped.sessions[0].status, 'cancelled');
    assert.match(stopped.sessions[0].last_error, /cancelled/i);
    assert.equal(processIsAlive(started.process_id), false);

    const db = await f.open();
    const stored = await storedSession(db, started.session_code);
    const audit = await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity_id, stored.id));
    assert.equal(audit.at(-1).action, 'agent_session.stop');
    assert.equal(audit.at(-1).to_state, 'cancelled');
    await closeDb(db);
  } finally {
    await f.cleanup();
  }
});

test('只保留 stdout/stderr 合并后的最后 50 行输出快照', async () => {
  const f = await fixture();
  try {
    const command = f.command(
      'many-output-lines',
      "for (let i = 0; i < 60; i += 1) console.log(`line-${i}`);\nsetTimeout(() => console.error('stderr-last'), 50);\n",
    );
    const started = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    const finished = await waitForStatus(f, started.session_code, 'finished');
    const lines = finished.last_output.split('\n');
    assert.equal(lines.length, 50);
    assert.doesNotMatch(finished.last_output, /line-0(?:\D|$)/);
    assert.match(finished.last_output, /line-59/);
    assert.match(finished.last_output, /\[stderr\] stderr-last/);
  } finally {
    await f.cleanup();
  }
});

test('HTTP身份仅接受自己的设备凭据，不能以principal环境变量冒充', async () => {
  const f = await fixture();
  try {
    const result = await f.run(['sessions', '--run', CODES.run], { ACP_DEVICE_TOKEN: 'invalid-token', ACP_PRINCIPAL_CODE: CODES.user });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'unauthorized');
    await f.db.insert(schema.users).values({ id: 20n, code: code(20), account: 'other', display_name: 'Other', status: 'active', created_at: new Date().toISOString() });
    await f.db.insert(schema.devices).values({ code: code(21), principal_id: 20n, credential_hash: createHash('sha256').update('other-token').digest('hex'), created_at: new Date().toISOString() });
    const other = await f.run(['sessions', '--run', CODES.run], { ACP_DEVICE_TOKEN: 'other-token', ACP_PRINCIPAL_CODE: CODES.user });
    assert.equal(other.status, 1);
    assert.equal(JSON.parse(other.stdout).error.code, 'forbidden');
  } finally { await f.cleanup(); }
});

test('start-key重试不创建第二会话和进程，Run preparing禁止启动', async () => {
  const f = await fixture();
  try {
    const command = f.command('idempotent', 'setInterval(() => {}, 1000);\n');
    const args = ['start', '--run', CODES.run, '--agent-command', command, '--start-key', 'same-key'];
    const first = await parseSuccess(f.run(args));
    const second = await parseSuccess(f.run(args));
    assert.equal(first.session_code, second.session_code);
    assert.equal(first.process_id, second.process_id);
    const records = await f.db.select().from(schema.agentSessions);
    assert.equal(records.length, 1);
    await f.run(['stop', '--run', CODES.run]);
    await f.db.update(schema.runs).set({ status: 'preparing' }).where(eq(schema.runs.id, IDS.run));
    const inactive = await f.run(['start', '--run', CODES.run, '--agent-command', command]);
    assert.equal(inactive.status, 1);
    assert.equal(JSON.parse(inactive.stdout).error.code, 'run_not_active');
  } finally { await f.cleanup(); }
});

test('撤销租约后watchdog终止托管Agent，旧设备不能续租或更新Session', async () => {
  const f = await fixture();
  try {
    const command = f.command('watchdog', 'console.log("watchdog-alive"); setInterval(() => {}, 1000);\n');
    const first = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    const deadline = Date.now() + 5000;
    const journalFile = path.join(f.root, 'journal', `${first.session_code}.json`);
    let journal;
    while (Date.now() < deadline) {
      journal = JSON.parse(readFileSync(journalFile, 'utf8'));
      if (journal.childProcessId) break;
      await delay(25);
    }
    assert.ok(journal.childProcessId);
    await f.db.update(schema.runLeases).set({ revoked_at: new Date().toISOString() });
    const denied = await fetch(`${f.apiUrl}/runs/${CODES.run}/lease/renew`, { method: 'POST', headers: { authorization: `Bearer ${f.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch }) });
    assert.equal((await denied.json()).ok, false);
    const until = Date.now() + 5000;
    while (Date.now() < until && processIsAlive(journal.childProcessId)) await delay(50);
    assert.equal(processIsAlive(journal.childProcessId), false);
    const stale = await fetch(`${f.apiUrl}/agent-sessions/${first.session_code}/state`, { method: 'POST', headers: { authorization: `Bearer ${f.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'finished', lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch }) });
    assert.equal((await stale.json()).ok, false);
  } finally { await f.cleanup(); }
});

test('源Run暂停且租约撤销后，stop仍通过本机journal停止并保留Run状态', async () => {
  const f = await fixture();
  try {
    const command = f.command('suspended-stop', 'setInterval(() => {}, 1000);\n');
    const first = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    await f.db.update(schema.runs).set({ status: 'suspended' }).where(eq(schema.runs.id, IDS.run));
    await f.db.update(schema.runLeases).set({ revoked_at: new Date().toISOString() });
    const stopped = await parseSuccess(f.run(['stop', '--run', CODES.run]));
    assert.equal(stopped.local_stopped, true);
    assert.equal(processIsAlive(first.process_id), false);
    const [run] = await f.db.select().from(schema.runs).where(eq(schema.runs.id, IDS.run));
    assert.equal(run.status, 'suspended');
  } finally { await f.cleanup(); }
});

test('租约mint幂等返回相同token，续租不rotate，过期后允许本人另一设备重新领取', async () => {
  const f = await fixture();
  try {
    const post = async (url, body, token = f.deviceToken) => (await fetch(`${f.apiUrl}${url}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const first = await post(`/runs/${CODES.run}/lease`, { execution_epoch: 0 });
    const second = await post(`/runs/${CODES.run}/lease`, { execution_epoch: 0 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.data.lease_token, second.data.lease_token);
    const renewed = await post(`/runs/${CODES.run}/lease/renew`, first.data);
    assert.equal(renewed.data.lease_token, first.data.lease_token);
    let leases = await f.db.select().from(schema.runLeases);
    assert.equal(leases.length, 1);
    assert.notEqual(leases[0].token_hash, first.data.lease_token);
    await f.db.insert(schema.devices).values({ code: code(22), principal_id: IDS.user, credential_hash: createHash('sha256').update('second-device-token').digest('hex'), created_at: new Date().toISOString() });
    const conflict = await post(`/runs/${CODES.run}/lease`, { execution_epoch: 0 }, 'second-device-token');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'execution_device_mismatch');
    await f.db.update(schema.runLeases).set({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const replacement = await post(`/runs/${CODES.run}/lease`, { execution_epoch: 0 }, 'second-device-token');
    assert.equal(replacement.ok, true);
    assert.notEqual(replacement.data.lease_token, first.data.lease_token);
    const old = await post(`/runs/${CODES.run}/lease/renew`, first.data);
    assert.equal(old.ok, false);
    leases = await f.db.select().from(schema.runLeases);
    assert.equal(leases.filter(lease => lease.revoked_at === null).length, 1);
  } finally { await f.cleanup(); }
});

test('源交接cancel后显式agentd resume恢复Run；pending交接拒绝恢复', async () => {
  const f = await fixture();
  try {
    await f.db.insert(schema.users).values({ id: 20n, code: code(20), account: 'handover-target', display_name: 'Target', status: 'active', created_at: new Date().toISOString() });
    await f.db.insert(schema.members).values({ principal_id: 20n, project_id: IDS.project, role: 'member', display_name: 'Target', created_at: new Date().toISOString() });
    const command = f.command('resume-source', 'setInterval(() => {}, 1000);\n');
    const first = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', command]));
    const post = async (url, body = {}) => (await fetch(`${f.apiUrl}${url}`, { method: 'POST', headers: { authorization: `Bearer ${f.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const prepared = await post(`/tasks/${CODES.task}/handovers/prepare`, { source_run_code: CODES.run, target_user_code: code(20), base_snapshot: 1 });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    await parseSuccess(f.run(['stop', '--run', CODES.run]));
    const denied = await f.run(['resume', '--run', CODES.run]);
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stdout).error.code, 'task_handover_pending');
    const cancelled = await post(`/handovers/${prepared.data.handover_code}/cancel`);
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    let [run] = await f.db.select().from(schema.runs).where(eq(schema.runs.id, IDS.run));
    assert.equal(run.status, 'suspended');
    const resumed = await parseSuccess(f.run(['resume', '--run', CODES.run]));
    assert.notEqual(resumed.session_code, first.session_code);
    assert.equal(resumed.status, 'running');
    [run] = await f.db.select().from(schema.runs).where(eq(schema.runs.id, IDS.run));
    assert.equal(run.status, 'active');
    assert.equal(run.execution_epoch, resumed.execution_epoch);
  } finally { await f.cleanup(); }
});

test('项目归档后保留本人会话只读记录，但拒绝启动和续租', async () => {
  const f = await fixture();
  try {
    const leaseResponse = await fetch(`${f.apiUrl}/runs/${CODES.run}/lease`, { method: 'POST', headers: { authorization: `Bearer ${f.deviceToken}`, 'content-type': 'application/json' }, body: '{}' });
    const lease = (await leaseResponse.json()).data;
    await f.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, IDS.project));
    const sessions = await f.run(['sessions', '--run', CODES.run]);
    assert.equal(sessions.status, 0, sessions.stdout);
    assert.equal(JSON.parse(sessions.stdout).ok, true);
    const started = await f.run(['start', '--run', CODES.run, '--agent-command', f.command('archived', 'console.log("must not execute");')]);
    assert.equal(started.status, 1);
    assert.equal(JSON.parse(started.stdout).error.code, 'project_archived');
    assert.deepEqual(await f.db.select().from(schema.agentSessions), []);
    const renewed = await fetch(`${f.apiUrl}/runs/${CODES.run}/lease/renew`, { method: 'POST', headers: { authorization: `Bearer ${f.deviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(lease) });
    assert.equal((await renewed.json()).ok, false);
  } finally { await f.cleanup(); }
});

test('默认Codex start和resume用stdin完整传递上下文，shell字符保持原文', async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.root, 'shim-bin');
    mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'capture-stdin.mjs');
    writeFileSync(shim, `import { writeFileSync } from 'node:fs';\nlet text = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => { text += chunk; });\nprocess.stdin.on('end', () => { writeFileSync(process.env.ACP_STDIN_CAPTURE_FILE, JSON.stringify({ stdin: text, args: process.argv.slice(2) })); console.log('captured stdin'); });\n`);
    if (process.platform === 'win32') {
      writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`);
    } else {
      const launcher = path.join(bin, 'codex');
      writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${shim.replaceAll("'", "'\\''")}' "$@"\n`);
      chmodSync(launcher, 0o700);
    }
    const prompt = path.join(f.root, 'context.md');
    const capture = path.join(f.root, 'stdin-capture.json');
    const text = 'first line\n$(echo shell-substitution)\n`echo backtick-substitution`\n%ACP_TEST_EXPANSION%\n"quotes" & echo shell-operator\n中文 😀\n';
    writeFileSync(prompt, text);
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`, ACP_STDIN_CAPTURE_FILE: capture, ACP_TEST_EXPANSION: 'MUST_NOT_EXPAND' };
    const first = await parseSuccess(f.run(['start', '--run', CODES.run, '--prompt', prompt], env));
    assert.equal(first.agent_command, 'codex exec -');
    assert.equal(first.launch_kind, 'default');
    await waitForStatus(f, first.session_code, 'finished');
    let received = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(received.stdin, text);
    assert.deepEqual(received.args, ['exec', '-']);
    const resumedText = `${text}resume has another newline\n$HOME %USERPROFILE% \\ quoted "literal"\n`;
    writeFileSync(prompt, resumedText);
    const second = await parseSuccess(f.run(['resume', '--run', CODES.run], env));
    assert.equal(second.agent_command, 'codex exec -');
    await waitForStatus(f, second.session_code, 'finished');
    received = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(received.stdin, resumedText);
    assert.deepEqual(received.args, ['exec', '-']);
  } finally { await f.cleanup(); }
});
