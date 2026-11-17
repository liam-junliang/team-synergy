import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { clearInheritedPostgresEnvironment, loadTestRuntime, verifyTestConnection, testAdminUrl } from './test-database-guard.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
export const defaultRuntimeFile = path.resolve(repo, '../team-synergy-runtime/test-postgres/runtime.private.json');
const role = 'tsp_test_runner', adminRole = 'tsp_test_admin';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const run = (file, args) => execFileSync(file, args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function startKnownLocalCluster(config) {
  if (config.provisionMode === 'ci' || path.resolve(config.dataDirectory) !== path.join(config.runtimeRoot, 'data')) throw Error('Unknown test cluster');
  const bin = process.platform === 'win32' ? 'F:/DB/PostgreSQL/16/bin' : '/usr/lib/postgresql/16/bin';
  const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const identifier = /Database system identifier:\s+(\d+)/u.exec(run(exe('pg_controldata'), ['-D',config.dataDirectory]))?.[1];
  if (identifier !== config.systemIdentifier) throw Error('Offline test cluster identity changed; refusing startup');
  const fd = openSync(path.join(config.runtimeRoot, 'launcher.private.log'), 'a');
  try {
    const result = spawnSync(exe('pg_ctl'), ['-D',config.dataDirectory,'-l',path.join(config.runtimeRoot,'postgres.log'),'-w','start'],
      { windowsHide: true, stdio: ['ignore',fd,fd] });
    if (result.status !== 0) throw Error('Dedicated test PostgreSQL did not start');
  } finally { closeSync(fd); }
}
const sql = nonce => `
CREATE SCHEMA tsp_test_guard AUTHORIZATION tsp_test_admin;
REVOKE ALL ON SCHEMA tsp_test_guard FROM PUBLIC;
CREATE TABLE tsp_test_guard.cluster_marker (singleton boolean PRIMARY KEY CHECK(singleton),nonce text NOT NULL);
INSERT INTO tsp_test_guard.cluster_marker VALUES(true,${quote(nonce)});
CREATE TABLE tsp_test_guard.fixture (singleton boolean PRIMARY KEY CHECK(singleton),database_oid oid NOT NULL,
 database_name name NOT NULL,owner_role name NOT NULL,run_token text NOT NULL,fixture_token text NOT NULL);
CREATE FUNCTION tsp_test_guard.identity() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('systemIdentifier',(pg_catalog.pg_control_system()).system_identifier::text,
 'dataDirectory',current_setting('data_directory'),'port',inet_server_port(),
 'nonce',(SELECT nonce FROM tsp_test_guard.cluster_marker WHERE singleton),
 'databaseName',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'fixture',(SELECT to_jsonb(f) FROM tsp_test_guard.fixture f WHERE singleton)) $$;
CREATE FUNCTION tsp_test_guard.claim_fixture(rt text,ft text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF session_user <> 'tsp_test_runner' OR current_database() !~ '^tsp_tests_[a-z0-9_]+$'
 OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> session_user
 OR rt !~ '^[0-9a-f]{32}$' OR ft !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Invalid test fixture claim'; END IF;
 INSERT INTO tsp_test_guard.fixture SELECT true,oid,datname,session_user,rt,ft FROM pg_database WHERE datname=current_database();
END $$;
REVOKE ALL ON FUNCTION tsp_test_guard.identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION tsp_test_guard.claim_fixture(text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA tsp_test_guard TO tsp_test_runner;
GRANT EXECUTE ON FUNCTION tsp_test_guard.identity(),tsp_test_guard.claim_fixture(text,text) TO tsp_test_runner;
`;

export async function provisionTestPostgres({ runtimeFile = defaultRuntimeFile, ci = false } = {}) {
  clearInheritedPostgresEnvironment();
  runtimeFile = path.resolve(runtimeFile);
  const runtimeRoot = path.dirname(runtimeFile);
  if (existsSync(runtimeFile)) {
    const config = loadTestRuntime(runtimeFile);
    let client = new pg.Client({ connectionString: testAdminUrl(config), connectionTimeoutMillis: 3000 });
    try { await client.connect(); }
    catch (error) {
      await client.end();
      if (error.code !== 'ECONNREFUSED') throw error;
      startKnownLocalCluster(config);
      client = new pg.Client({ connectionString: testAdminUrl(config), connectionTimeoutMillis: 3000 }); await client.connect();
    }
    try { await verifyTestConnection(client, null, config); } finally { await client.end(); }
    return { runtimeFile, port: 55432, reused: true };
  }
  const pendingFile = path.join(runtimeRoot, 'bootstrap.pending.private.json');
  const pending = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : null;
  if (existsSync(runtimeRoot) && !pending) throw Error('Refusing to overwrite an unverified existing test PostgreSQL directory');
  assert.ok(ci ? process.env.CI === 'true' : runtimeRoot === path.resolve(repo, '../team-synergy-runtime/test-postgres'), 'Unexpected test cluster directory');
  if (!pending) mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const owner = run('whoami', []).trim();
    run('icacls.exe', [runtimeRoot, '/inheritance:r', '/grant:r', owner + ':(OI)(CI)F', '/q']);
  }
  if (pending && (pending.runtimeRoot !== runtimeRoot || pending.version !== 1 || !/^[0-9a-f]{32}$/u.test(pending.nonce)
    || typeof pending.adminPassword !== 'string' || typeof pending.password !== 'string')) throw Error('Unverified incomplete test cluster');
  const adminPassword = pending?.adminPassword ?? (ci ? process.env.TSP_TEST_BOOTSTRAP_PASSWORD : randomBytes(32).toString('base64url'));
  if (!adminPassword || adminPassword.length < 24) throw Error('Missing dedicated CI test-cluster bootstrap secret');
  const password = pending?.password ?? randomBytes(32).toString('base64url'), nonce = pending?.nonce ?? randomBytes(16).toString('hex');
  const state = pending ?? { version: 1, runtimeRoot, adminPassword, password, nonce, initialized: false };
  writeFileSync(pendingFile, JSON.stringify(state), { mode: 0o600 });
  let dataDirectory;
  if (!ci) {
    await new Promise((done, fail) => { const probe = createServer(); probe.once('error', () => fail(Error('Test port 55432 is already occupied; refusing reuse')));
      probe.listen(55432, '127.0.0.1', () => probe.close(done)); });
    const bin = process.platform === 'win32' ? 'F:/DB/PostgreSQL/16/bin' : '/usr/lib/postgresql/16/bin';
    const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
    if (!existsSync(exe('initdb'))) throw Error('Official PostgreSQL 16 tools are required');
    const pwfile = path.join(runtimeRoot, 'bootstrap-password.private');
    dataDirectory = path.join(runtimeRoot, 'data');
    if (!state.initialized) {
      if (existsSync(dataDirectory)) throw Error('Refusing to initialize an existing unverified data directory');
      writeFileSync(pwfile, adminPassword, { mode: 0o600 });
      try { run(exe('initdb'), ['-D', dataDirectory, '--username=' + adminRole, '--pwfile=' + pwfile,
        '--auth=scram-sha-256', '--encoding=UTF8', '--no-locale']); } finally { unlinkSync(pwfile); }
      writeFileSync(path.join(dataDirectory, 'tsp-test.conf'), "listen_addresses='127.0.0.1'\nport=55432\ntimezone='UTC'\ncluster_name='tsp-tests-" + nonce + "'\n");
      appendFileSync(path.join(dataDirectory, 'postgresql.conf'), "\ninclude='tsp-test.conf'\n");
      state.initialized = true;
      state.systemIdentifier = /Database system identifier:\s+(\d+)/u.exec(run(exe('pg_controldata'), ['-D', dataDirectory]))?.[1];
      if (!state.systemIdentifier) throw Error('Cannot establish the new cluster identity');
      writeFileSync(pendingFile, JSON.stringify(state), { mode: 0o600 });
    } else if (/Database system identifier:\s+(\d+)/u.exec(run(exe('pg_controldata'), ['-D', dataDirectory]))?.[1] !== state.systemIdentifier) {
      throw Error('Incomplete test cluster identity changed; refusing reuse');
    }
    const fd = openSync(path.join(runtimeRoot, 'launcher.private.log'), 'a');
    const result = spawnSync(exe('pg_ctl'), ['-D', dataDirectory, '-l', path.join(runtimeRoot, 'postgres.log'), '-w', 'start'],
    { windowsHide: true, stdio: ['ignore',fd,fd] });
    closeSync(fd);
    if (result.status !== 0) throw Error('Dedicated test PostgreSQL did not start; inspect its private log');
    dataDirectory = realpathSync.native(dataDirectory);
  }
  const adminUrl = new URL('postgresql://127.0.0.1:55432/postgres'); adminUrl.username = adminRole; adminUrl.password = adminPassword;
  const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  let identity;
  try {
    const existing = await admin.query("select datname from pg_database where datname not in ('postgres','template0','template1')");
    assert.equal(existing.rowCount, 0, 'Bootstrap requires a fresh isolated cluster');
    const check = await admin.query("select (pg_control_system()).system_identifier::text as id,current_setting('data_directory') as directory,inet_server_port() as port,current_user as role");
    assert.equal(check.rows[0].port, 55432); assert.equal(check.rows[0].role, adminRole);
    if (dataDirectory) assert.equal(path.resolve(check.rows[0].directory), path.resolve(dataDirectory));
    else dataDirectory = check.rows[0].directory;
    identity = check.rows[0].id;
    const existingRole = await admin.query("select rolname from pg_roles where rolname='tsp_test_runner'");
    if (!existingRole.rowCount) await admin.query('CREATE ROLE tsp_test_runner LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ' + quote(password));
    const marker = await admin.query("select 1 from pg_namespace where nspname='tsp_test_guard'");
    if (!marker.rowCount) await admin.query(sql(nonce));
    else assert.equal((await admin.query('select nonce from tsp_test_guard.cluster_marker')).rows[0]?.nonce, nonce);
  } finally { await admin.end(); }
  const templateUrl = new URL(adminUrl); templateUrl.pathname = '/template1';
  const template = new pg.Client({ connectionString: templateUrl.href }); await template.connect();
  try {
    if (!(await template.query("select 1 from pg_namespace where nspname='tsp_test_guard'")).rowCount) await template.query(sql(nonce));
    else assert.equal((await template.query('select nonce from tsp_test_guard.cluster_marker')).rows[0]?.nonce, nonce);
  } finally { await template.end(); }
  mkdirSync(path.join(runtimeRoot, 'runs'), { mode: 0o700 });
  writeFileSync(path.join(runtimeRoot, 'admin.private.json'), JSON.stringify({ adminRole, adminPassword }, null, 2), { mode: 0o600 });
  const ready = { version: 1, host: '127.0.0.1', port: 55432, role, password,
    systemIdentifier: identity, nonce, dataDirectory, runtimeRoot, provisionMode: ci ? 'ci' : 'local' };
  const runner = new pg.Client({ connectionString: testAdminUrl(ready), connectionTimeoutMillis: 3000 }); await runner.connect();
  try { await verifyTestConnection(runner, null, ready); } finally { await runner.end(); }
  writeFileSync(runtimeFile, JSON.stringify(ready, null, 2), { mode: 0o600 });
  chmodSync(runtimeFile, 0o600);
  unlinkSync(pendingFile);
  return { runtimeFile, port: 55432, reused: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await provisionTestPostgres({ ci: process.argv.includes('--ci') }))); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
