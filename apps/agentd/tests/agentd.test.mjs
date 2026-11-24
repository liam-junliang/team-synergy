import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { writeDeviceProfile } from '@team-synergy/contracts/device-session';
import { apiRequest } from '../dist/api.js';
import { buildServer } from '../../core-api/dist/server.js';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { closeDb, openDb, schema } from '@team-synergy/persistence';
import { assertOwnedTestDatabase, requireTestContext } from '../../../scripts/test-database-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');
const tspEntry = path.resolve(here, '../../cli/dist/index.js');
const migrationsFolder = path.resolve(here, '../../../packages/persistence/drizzle');
const testDatabaseUrl = requireTestContext().databaseUrl;
let databaseEnsured = false;
const code = (value) => String(value).padStart(20, '0');
const IDS = Object.freeze({ team: 1n, user: 2n, project: 3n, feature: 4n, task: 5n, workspace: 6n, run: 7n });
const CODES = Object.freeze({
  team: code(1), user: code(2), project: code(3), feature: code(4),
  task: code(5), workspace: code(6), run: code(7),
});

async function ensureTestDatabase() {
  if (databaseEnsured) return;
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await assertOwnedTestDatabase(pool);
    databaseEnsured = true;
  } finally {
    await pool.end();
  }
}

async function truncateAllTables(db) {
  await assertOwnedTestDatabase(db.$client);
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
  let app = await buildServer({ db, logger: false });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const env = { ...process.env, TSP_DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/must_not_connect', ACP_API_URL: apiUrl, ACP_DEVICE_TOKEN: deviceToken, AGENTCTL_HOME: path.join(root, 'auth'), AGENTD_HOME: path.join(root, 'journal'), AGENTD_WATCHDOG_INTERVAL_MS: '250' };
  const invoke = (entry, args, overrides = {}, workingDirectory = repo) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: workingDirectory,
      env: { ...env, ...overrides },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
  const run = (args, overrides, workingDirectory) => invoke(cliEntry, args, overrides, workingDirectory);

  return {
    root,
    run,
    tsp: (args, overrides) => invoke(tspEntry, args, overrides),
    db,
    apiUrl,
    deviceToken,
    async restart() {
      await app.close();
      app = await buildServer({ db, logger: false });
      assert.equal(await app.listen({ host: '127.0.0.1', port: Number(new URL(apiUrl).port) }), apiUrl);
    },
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

test('a proxy restart is a transient transport failure while explicit auth revocation still fences', async () => {
  const proxy = createServer((request, response) => {
    if (request.url === '/gateway') { response.writeHead(502, { 'Content-Type': 'text/html' }).end('<h1>Bad Gateway</h1>'); return; }
    response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'revoked' } }));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const config = { apiUrl: 'http://127.0.0.1:' + proxy.address().port, deviceToken: 'fixture' };
    await assert.rejects(apiRequest(config, 'GET', '/gateway'), { code: 'api_unreachable' });
    await assert.rejects(apiRequest(config, 'GET', '/revoked'), { code: 'unauthorized' });
  } finally { await new Promise(resolve => proxy.close(resolve)); }
});

test('tsp commands and a detached agentd share one rotation, survive API restart, and stop on device revocation', { timeout: 25_000 }, async () => {
  const f = await fixture();
  const local = { ACP_DEVICE_TOKEN: '', ACP_TOKEN: '', ACP_DEVICE_SESSION_CODE: '' };
  const directory = path.join(f.root, 'auth');
  const readProfile = () => JSON.parse(readFileSync(path.join(directory, 'auth.json'), 'utf8'));
  const bindToken = 'isolated-agentd-renewal-fixture';
  const call = (route, token, method = 'GET') => fetch(f.apiUrl + route, { method, headers: { authorization: 'Bearer ' + token } });
  try {
    await f.db.update(schema.users).set({ bind_token_hash: createHash('sha256').update(bindToken).digest('hex'),
      bind_token_expires_at: new Date(Date.now() + 60_000).toISOString() }).where(eq(schema.users.id, IDS.user));
    await parseSuccess(f.tsp(['auth', 'login', '--api', f.apiUrl, '--token', bindToken], local));
    const issued = readProfile();
    assert.ok(issued.refresh_token);
    const wrong = await f.tsp(['auth', 'status'], { ...local, ACP_API_URL: 'http://127.0.0.1:1' });
    assert.equal(JSON.parse(wrong.stdout).error.code, 'auth_profile_mismatch');
    assert.equal(wrong.stdout.includes(issued.device_token) || wrong.stdout.includes(issued.refresh_token), false);
    const status = await parseSuccess(f.tsp(['auth', 'status'], local));
    assert.equal(status.credential_source, 'device_profile');
    assert.equal(status.renewable, true);
    // Model an active session installed before renewable metadata was added.
    await f.db.update(schema.deviceSessions).set({ refresh_token_hash: null, access_expires_at: null })
      .where(eq(schema.deviceSessions.code, issued.session_code));
    writeDeviceProfile(directory, { ...issued, refresh_token: undefined, access_expires_at: undefined, session_code: undefined });
    const mockCommand = f.command('renewal-watchdog', 'setInterval(() => {}, 1000);\n');
    const session = await parseSuccess(f.run(['start', '--run', CODES.run, '--agent-command', mockCommand], { ...local, AGENTCTL_HOME: 'auth' }, f.root));
    const first = readProfile();
    assert.ok(first.refresh_token);
    assert.equal(first.session_code, issued.session_code);
    const soon = new Date(Date.now() + 2 * 60_000).toISOString();
    writeDeviceProfile(directory, { ...first, access_expires_at: soon });
    const callers = await Promise.all([
      parseSuccess(f.tsp(['auth', 'status'], local)),
      parseSuccess(f.tsp(['auth', 'whoami'], local)),
      parseSuccess(f.run(['sessions', '--run', CODES.run], local)),
    ]);
    const next = readProfile();
    assert.notEqual(next.device_token, first.device_token);
    assert.equal(next.session_code, first.session_code);
    assert.equal(next.device_code, first.device_code);
    assert.ok(next.last_refreshed_at);
    assert.equal(callers[0].last_refreshed_at, next.last_refreshed_at);
    const [persisted] = await f.db.select().from(schema.deviceSessions).where(eq(schema.deviceSessions.code, next.session_code));
    assert.equal(persisted.previous_refresh_token_hash, createHash('sha256').update(first.refresh_token).digest('hex'));
    assert.equal(processIsAlive(session.process_id), true);
    await f.restart();
    assert.equal((await call('/auth/whoami', next.device_token)).status, 200);
    assert.equal((await parseSuccess(f.run(['sessions', '--run', CODES.run], local))).sessions[0].status, 'running');
    assert.equal((await call('/devices/' + next.device_code + '/revoke', f.deviceToken, 'POST')).status, 200);
    assert.equal((await call('/auth/whoami', next.device_token)).status, 401);
    assert.equal((await call('/auth/whoami', first.device_token)).status, 401);
    const deadline = Date.now() + 6_000;
    while (processIsAlive(session.process_id) && Date.now() < deadline) await delay(100);
    assert.equal(processIsAlive(session.process_id), false);
  } finally {
    await f.run(['stop', '--run', CODES.run], local);
    await f.cleanup();
  }
});

const upgradeDistributions = [
  process.env.TSP_UPGRADE_LEGACY_DIST,
  process.env.TSP_UPGRADE_BRIDGE_DIST,
  process.env.TSP_UPGRADE_NEXT_DIST,
];

test('Windows packaged CLI upgrade and rollback preserve login, workspace binding and a live Run', {
  skip: process.platform !== 'win32' || !upgradeDistributions.every(Boolean),
  timeout: 180_000,
}, async () => {
  const distribution = mkdtempSync(path.join(os.tmpdir(), 'tsp-upgrade-feed-'));
  const priorDistribution = process.env.ACP_CLI_DIST_DIR;
  process.env.ACP_CLI_DIST_DIR = distribution;
  function publish(source) {
    const manifestFile = path.join(source, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const artifact = manifest.artifacts.find((entry) => entry.platform === 'win32' && entry.arch === process.arch);
    assert.ok(artifact);
    copyFileSync(path.join(source, artifact.filename), path.join(distribution, artifact.filename));
    copyFileSync(manifestFile, path.join(distribution, 'manifest.json'));
    return artifact.release;
  }
  let f;
  let stopInstalled;
  try {
    f = await fixture();
    const installDir = path.join(f.root, 'managed CLI');
    const work = path.join(f.root, 'workspace', 'repo');
    const authDir = path.join(f.root, 'auth');
    const binding = path.join(work, '.agent', 'bound-project.yaml');
    const env = {
      ...process.env,
      TSP_DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/must_not_connect',
      ACP_API_URL: f.apiUrl, ACP_DEVICE_TOKEN: undefined, ACP_TOKEN: undefined, ACP_DEVICE_SESSION_CODE: undefined,
      AGENTCTL_HOME: authDir, AGENTD_HOME: path.join(f.root, 'journal'),
      AGENTD_WATCHDOG_INTERVAL_MS: '250',
    };
    function powershell(args, overrides = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
          cwd: work, env: { ...env, ...overrides }, windowsHide: true,
        });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        // An old detached process can keep a cmd.exe pipe alive after the launcher exits.
        child.once('exit', (status) => setImmediate(() => {
          child.stdout.destroy(); child.stderr.destroy();
          resolve({ status, stdout, stderr });
        }));
      });
    }
    function install(source) {
      return powershell(['-File', path.join(source, 'install.ps1'), '-BaseUrl', f.apiUrl, '-InstallDir', installDir, '-NoModifyPath']);
    }
    function launch(binary, ...args) {
      return powershell([
        '-Command',
        '$launcherArgs = @((ConvertFrom-Json $env:TSP_TEST_ARGUMENTS) | ForEach-Object { $_ }); & $env:TSP_TEST_LAUNCHER @launcherArgs; exit $LASTEXITCODE',
      ], { TSP_TEST_LAUNCHER: path.join(installDir, 'bin', `${binary}.cmd`), TSP_TEST_ARGUMENTS: JSON.stringify(args) });
    }
    const tsp = (...args) => parseSuccess(launch('tsp', ...args));
    stopInstalled = () => launch('agentd', 'stop', '--run', CODES.run);
    const old = publish(upgradeDistributions[0]);
    assert.ok(old.startsWith('0.1.0-'));
    const legacyInstall = await install(upgradeDistributions[0]);
    assert.equal(legacyInstall.status, 0, legacyInstall.stderr);
    const bindToken = 'isolated-packaged-cli-upgrade-fixture';
    await f.db.update(schema.users).set({ bind_token_hash: createHash('sha256').update(bindToken).digest('hex'),
      bind_token_expires_at: new Date(Date.now() + 60_000).toISOString() }).where(eq(schema.users.id, IDS.user));
    await tsp('auth', 'login', '--api', f.apiUrl, '--token', bindToken);
    const account = await tsp('auth', 'whoami');
    const profile = () => JSON.parse(readFileSync(path.join(authDir, 'auth.json'), 'utf8'));
    const legacyProfile = profile();
    assert.equal(legacyProfile.refresh_token, undefined);
    await tsp('project', 'bind', CODES.project);
    const bound = await tsp('project', 'current');
    const initialBinding = readFileSync(binding, 'utf8');
    const active = await parseSuccess(launch('agentd', 'start', '--run', CODES.run, '--agent-command',
      f.command('packaged-upgrade-watchdog', 'setInterval(() => {}, 1000);\n')));
    assert.equal(active.status, 'running');

    const bridge = publish(upgradeDistributions[1]);
    const bridgeInstall = await install(upgradeDistributions[1]);
    assert.equal(bridgeInstall.status, 0, bridgeInstall.stderr);
    assert.equal((await tsp('version')).release, bridge);
    const next = publish(upgradeDistributions[2]);
    assert.notEqual(bridge, next);
    const check = await tsp('update', '--check');
    assert.equal(check.available, next);
    assert.equal(check.update_available, true);
    const unconfirmed = await launch('tsp', 'update');
    assert.equal(JSON.parse(unconfirmed.stdout).error.code, 'cli_update_confirmation_required');
    assert.equal((await tsp('version')).release, bridge);
    assert.equal((await tsp('update', '--yes')).updated, true);
    assert.equal((await tsp('version')).release, next);
    assert.equal((await tsp('update', '--check')).update_available, false);
    assert.deepEqual(await tsp('auth', 'whoami'), account);
    const [legacySession] = await f.db.select().from(schema.deviceSessions)
      .where(eq(schema.deviceSessions.token_hash, createHash('sha256').update(legacyProfile.device_token).digest('hex')));
    assert.equal(legacySession.refresh_token_hash, null);
    assert.equal(legacySession.access_expires_at, null, 'the fixed token must keep its original lifetime during the Run');
    assert.ok(profile().upgrade_retry_at > Date.now());
    assert.deepEqual(await tsp('project', 'current'), bound);
    assert.equal(readFileSync(binding, 'utf8'), initialBinding);
    const stillRunning = await parseSuccess(launch('agentd', 'sessions', '--run', CODES.run));
    assert.equal(stillRunning.sessions[0].session_code, active.session_code);
    assert.equal(stillRunning.sessions[0].status, 'running');
    assert.equal(processIsAlive(active.process_id), true);
    assert.equal((await tsp('update', '--rollback', '--yes')).release, bridge);
    assert.equal((await tsp('version')).release, bridge);
    assert.deepEqual(await tsp('auth', 'whoami'), account);
    assert.deepEqual(await tsp('project', 'current'), bound);
    assert.equal(processIsAlive(active.process_id), true);
    await parseSuccess(launch('agentd', 'stop', '--run', CODES.run));
    await f.db.update(schema.runLeases).set({ expires_at: new Date(Date.now() - 1000).toISOString() });
    writeDeviceProfile(authDir, { ...profile(), upgrade_retry_at: 0 });
    assert.deepEqual(await tsp('auth', 'whoami'), account);
    assert.equal(profile().session_code, legacySession.code);
    assert.ok(profile().refresh_token, 'the same legacy authorization should renew after the original Run ends');
  } finally {
    if (priorDistribution === undefined) delete process.env.ACP_CLI_DIST_DIR;
    else process.env.ACP_CLI_DIST_DIR = priorDistribution;
    try {
      if (stopInstalled) await stopInstalled();
      if (f) await f.cleanup();
    }
    finally { rmSync(distribution, { recursive: true, force: true }); }
  }
});

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
