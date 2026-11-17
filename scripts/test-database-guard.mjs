import assert from 'node:assert/strict';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repo = fileURLToPath(new URL('../', import.meta.url));
const defaultFile = path.resolve(repo, '../team-synergy-runtime/test-postgres/runtime.private.json');
const message = 'Test database isolation rejected: use the dedicated test runner and its fresh fixture lease';
const tokenPattern = /^[0-9a-f]{32}$/u;
export const claimSymbol = Symbol.for('tsp.test.fresh-database-claim');
const fail = () => { throw Error(message); };
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function clearInheritedPostgresEnvironment() {
  for (const key of Object.keys(process.env)) if (/^(?:PG|SSL)/iu.test(key)) delete process.env[key];
}

export function loadTestRuntime(file = process.env.TSP_TEST_RUNTIME_FILE ?? defaultFile) {
  try {
    const config = read(file);
    if (config.version !== 1 || config.host !== '127.0.0.1' || config.port !== 55432 || config.role !== 'tsp_test_runner'
      || typeof config.password !== 'string' || config.password.length < 32 || !/^\d+$/u.test(config.systemIdentifier)
      || !tokenPattern.test(config.nonce) || !path.isAbsolute(config.dataDirectory)
      || path.resolve(config.runtimeRoot) !== path.dirname(path.resolve(file))
      || (config.provisionMode === 'ci' ? process.env.CI !== 'true' : path.resolve(config.dataDirectory) !== path.join(config.runtimeRoot, 'data'))) fail();
    return { ...config, runtimeFile: path.resolve(file) };
  } catch { return fail(); }
}

export function assertTestDatabaseUrl(value, { admin = false, config = loadTestRuntime() } = {}) {
  try {
    const url = new URL(value), name = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== config.host || Number(url.port) !== config.port
      || decodeURIComponent(url.username) !== config.role || !equalSecret(decodeURIComponent(url.password), config.password)
      || url.search || url.hash || !(admin ? name === 'postgres' : /^tsp_tests_[a-z0-9_]{1,53}$/u.test(name))) fail();
    return name;
  } catch { return fail(); }
}
export function testAdminUrl(config = loadTestRuntime()) {
  const url = new URL('postgresql://127.0.0.1:55432/postgres'); url.username = config.role; url.password = config.password; return url.href;
}
function contained(file, root) {
  const relative = path.relative(realpathSync.native(root), realpathSync.native(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail();
}
function currentRun(config) {
  const file = process.env.TSP_TEST_RUN_FILE; if (!file) fail();
  contained(file, path.join(config.runtimeRoot, 'runs'));
  const run = read(file);
  if (run.version !== 1 || run.status !== 'active' || !tokenPattern.test(run.token)
    || run.systemIdentifier !== config.systemIdentifier || run.nonce !== config.nonce
    || path.dirname(file) !== path.join(config.runtimeRoot, 'runs', run.token)) fail();
  try { process.kill(run.pid, 0); } catch { fail(); }
  return { ...run, file, directory: path.dirname(file) };
}
function leaseByName(name, config, run) {
  for (const file of readdirSync(run.directory).filter(value => /^[0-9a-f]{32}\.fixture\.private\.json$/u.test(value))) {
    const lease = read(path.join(run.directory, file));
    if (lease.databaseName === name) {
      if (lease.status !== 'active' || lease.runToken !== run.token || lease.systemIdentifier !== config.systemIdentifier
        || !tokenPattern.test(lease.token) || !/^\d+$/u.test(lease.oid) || assertTestDatabaseUrl(lease.databaseUrl, { config }) !== name) fail();
      return { ...lease, file: path.join(run.directory, file) };
    }
  }
  return fail();
}
export function requireTestContext() {
  const config = loadTestRuntime(), run = currentRun(config);
  const name = assertTestDatabaseUrl(process.env.TSP_TEST_DATABASE_URL, { config }), lease = leaseByName(name, config, run);
  if (process.env.TSP_TEST_LEASE_FILE !== lease.file) fail();
  return { config, run, lease, databaseUrl: lease.databaseUrl };
}
/** Legacy name retained; names alone no longer authorize destructive tests. */
export function assertDisposableTestDatabase(url) {
  const { config, run } = requireTestContext(); const name = assertTestDatabaseUrl(url, { config }); leaseByName(name, config, run); return name;
}
export async function verifyTestConnection(connection, lease = null, config = loadTestRuntime(), { fresh = null } = {}) {
  const result = await connection.query(`select tsp_test_guard.identity() as identity,session_user as role,current_user as current_role,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls from pg_catalog.pg_roles r where r.rolname=session_user`);
  const row = result.rows[0], identity = row?.identity;
  if (!row || row.role !== config.role || row.current_role !== config.role || row.rolsuper || !row.rolcreatedb || !row.rolcreaterole
    || row.rolreplication || row.rolbypassrls || identity?.systemIdentifier !== config.systemIdentifier || identity.nonce !== config.nonce
    || identity.port !== 55432 || path.resolve(identity.dataDirectory) !== path.resolve(config.dataDirectory)) fail();
  if (fresh) {
    if (identity.databaseName !== fresh.databaseName || identity.oid !== fresh.oid || identity.owner !== config.role || identity.fixture !== null) fail();
  } else if (lease) {
    const claim = identity.fixture;
    if (identity.databaseName !== lease.databaseName || identity.oid !== lease.oid || identity.owner !== config.role || !claim
      || String(claim.database_oid) !== lease.oid || claim.database_name !== lease.databaseName || claim.owner_role !== config.role
      || claim.run_token !== lease.runToken || claim.fixture_token !== lease.token) fail();
  } else if (identity.databaseName !== 'postgres' || identity.fixture !== null) fail();
  return identity;
}
/** Runs before pg opens its socket, including raw Pool/openDb test callers. */
export function validateTestConnectionParameters(parameters, fresh = null) {
  const config = loadTestRuntime(), run = currentRun(config);
  if (parameters.host !== config.host || Number(parameters.port) !== 55432 || parameters.user !== config.role || !equalSecret(parameters.password, config.password)) fail();
  if (parameters.database === 'postgres') return { config, lease: null };
  if (fresh) {
    if (!/^tsp_tests_[a-z0-9_]+$/u.test(fresh.databaseName) || parameters.database !== fresh.databaseName) fail();
    return { config, lease: null, fresh };
  }
  return { config, lease: leaseByName(parameters.database, config, run) };
}
export async function assertOwnedTestDatabase(connection, lease) {
  const { config, run } = requireTestContext();
  if (!lease) {
    const result = await connection.query('select tsp_test_guard.identity() as identity');
    lease = leaseByName(result.rows[0]?.identity?.databaseName, config, run);
  }
  const current = leaseByName(lease.databaseName, config, run);
  if (current.oid !== lease.oid || current.token !== lease.token) fail();
  return verifyTestConnection(connection, current, config);
}
async function allocate(config, run, label) {
  const name = 'tsp_tests_' + label.replace(/[^a-z0-9]/gu, '').slice(0, 16) + '_' + randomBytes(10).toString('hex');
  const token = randomBytes(16).toString('hex'), admin = new pg.Client({ connectionString: testAdminUrl(config) }); await admin.connect();
  let created = false, oid;
  try {
    await verifyTestConnection(admin, null, config);
    assert.equal((await admin.query('select oid from pg_database where datname=$1', [name])).rowCount, 0, message);
    await admin.query('CREATE DATABASE "' + name + '"'); created = true;
    const result = await admin.query('select oid::text,pg_get_userbyid(datdba) as owner from pg_database where datname=$1', [name]);
    oid = result.rows[0]?.oid; assert.equal(result.rows[0]?.owner, config.role, message);
    const url = new URL(testAdminUrl(config)); url.pathname = '/' + name;
    const client = new pg.Client({ connectionString: url.href }); client[claimSymbol] = { databaseName: name, oid }; await client.connect();
    try { await verifyTestConnection(client, null, config, { fresh: { databaseName: name, oid } });
      await client.query('select tsp_test_guard.claim_fixture($1,$2)', [run.token, token]); } finally { await client.end(); }
    const lease = { version: 1, status: 'active', databaseName: name, databaseUrl: url.href, oid, token, runToken: run.token,
      systemIdentifier: config.systemIdentifier, createdAt: new Date().toISOString() };
    const file = path.join(run.directory, token + '.fixture.private.json'); save(file, lease); return { ...lease, file };
  } catch (error) {
    if (created) save(path.join(run.directory, token + '.incomplete.private.json'), { databaseName: name, oid, createdAt: new Date().toISOString() });
    throw error;
  } finally { await admin.end(); }
}
export async function createTestFixture(label, baseUrl) {
  const { config, run } = requireTestContext(); if (baseUrl !== undefined) assertDisposableTestDatabase(baseUrl);
  const lease = await allocate(config, run, label);
  return { ...lease, assertOwned: connection => assertOwnedTestDatabase(connection, lease), dispose: () => disposeTestFixture(lease, config) };
}
export async function disposeTestFixture(lease, config = loadTestRuntime()) {
  const admin = new pg.Client({ connectionString: testAdminUrl(config) }); await admin.connect();
  try {
    await verifyTestConnection(admin, null, config);
    const result = await admin.query('select oid::text,pg_get_userbyid(datdba) as owner from pg_database where datname=$1', [lease.databaseName]);
    assert.deepEqual(result.rows, [{ oid: lease.oid, owner: config.role }], message);
    const client = new pg.Client({ connectionString: lease.databaseUrl }); await client.connect();
    try { await verifyTestConnection(client, lease, config); } finally { await client.end(); }
    await admin.query('DROP DATABASE "' + lease.databaseName + '"');
    assert.equal((await admin.query('select oid from pg_database where datname=$1 or oid=$2', [lease.databaseName, lease.oid])).rowCount, 0, message);
    save(lease.file, { ...lease, status: 'disposed', disposedAt: new Date().toISOString() });
  } finally { await admin.end(); }
}
export async function createTestRun(config = loadTestRuntime()) {
  const token = randomBytes(16).toString('hex'), directory = path.join(config.runtimeRoot, 'runs', token); mkdirSync(directory, { mode: 0o700 });
  const run = { version: 1, status: 'active', token, systemIdentifier: config.systemIdentifier, nonce: config.nonce,
    pid: process.pid, startedAt: new Date().toISOString(), directory, file: path.join(directory, 'run.private.json') }; save(run.file, run);
  const lease = await allocate(config, run, 'run'); return { config, run, lease, databaseUrl: lease.databaseUrl };
}
export async function closeTestRun({ config, run }) {
  for (const file of readdirSync(run.directory).filter(value => value.endsWith('.fixture.private.json'))) {
    const lease = { ...read(path.join(run.directory, file)), file: path.join(run.directory, file) };
    if (lease.status === 'active') await disposeTestFixture(lease, config);
  }
  save(run.file, { ...run, status: 'completed', endedAt: new Date().toISOString() });
}
