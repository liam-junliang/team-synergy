import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { clearInheritedPostgresEnvironment, closeTestRun, createTestRun, loadTestRuntime, requireTestContext, verifyTestConnection } from './test-database-guard.mjs';
import { provisionTestPostgres } from './provision-test-postgres.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const inherited = Boolean(process.env.TSP_TEST_RUN_FILE);
let context, child, code = 1;
try {
  clearInheritedPostgresEnvironment();
  if (!inherited) {
    if (['TSP_TEST_DATABASE_URL','TSP_INTEGRITY_TEST_DATABASE_URL','TSP_DATABASE_URL','ACP_DATABASE_URL','DATABASE_URL'].some(key => process.env[key])) {
      throw Error('Unset database URL overrides; the test runner creates its own isolated database');
    }
    await provisionTestPostgres();
    context = await createTestRun(loadTestRuntime());
  } else {
    context = requireTestContext();
    const client = new pg.Client({ connectionString: context.databaseUrl }); await client.connect();
    try { await verifyTestConnection(client, context.lease, context.config); } finally { await client.end(); }
  }
  const separator = process.argv.indexOf('--'), original = separator < 0 ? [] : process.argv.slice(separator + 1);
  if (!original.length) throw Error('Usage: node scripts/run-tests.mjs -- <test command> [arguments]');
  const args = original.slice(1).flatMap(value => {
    if (!value.endsWith('*.test.mjs')) return [value];
    const folder = path.dirname(value), absolute = path.resolve(folder);
    return readdirSync(absolute).filter(file => file.endsWith('.test.mjs')).sort().map(file => path.join(folder, file));
  });
  const config = context.config;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PG|SSL)/iu.test(key) || /(?:^|_)(?:DATABASE_URL|DB_URL|DATABASE_PASSWORD|DB_PASSWORD)$/iu.test(key)
      || /^TSP_TEST_BOOTSTRAP_PASSWORD$/iu.test(key)) delete env[key];
  }
  Object.assign(env, { TSP_TEST_RUNTIME_FILE: config.runtimeFile, TSP_TEST_RUN_FILE: context.run.file,
    TSP_TEST_LEASE_FILE: context.lease.file, TSP_TEST_DATABASE_URL: context.databaseUrl,
    TSP_INTEGRITY_TEST_DATABASE_URL: context.databaseUrl, TSP_DATABASE_URL: context.databaseUrl,
    ACP_DATABASE_URL: context.databaseUrl, DATABASE_URL: context.databaseUrl,
    PGHOST: config.host, PGPORT: String(config.port), PGUSER: config.role, PGPASSWORD: config.password,
    PGDATABASE: context.lease.databaseName, PGSSLMODE: 'disable',
    NODE_OPTIONS: '--import=' + pathToFileURL(path.join(repo, 'scripts/test-postgres-preload.mjs')).href });
  delete env.TSP_TEST_BOOTSTRAP_PASSWORD;
  let command = original[0], commandArgs = args;
  if (command === 'node') command = process.execPath;
  else if (process.platform === 'win32' && command === 'pnpm') {
    if (args.some(value => !/^[a-zA-Z0-9_@/.:=*-]+$/u.test(value))) throw Error('Unsafe workspace command');
    commandArgs = ['/d','/s','/c','pnpm ' + args.join(' ')]; command = process.env.ComSpec ?? 'cmd.exe';
  }
  child = spawn(command, commandArgs, { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true });
  writeFileSync(path.join(context.run.directory, 'process-' + process.pid + '.json'), JSON.stringify({ pid: child.pid,
    runnerPid: process.pid, databaseName: context.lease.databaseName, oid: context.lease.oid,
    startedAt: new Date().toISOString(), command: original[0], args: original.slice(1) }, null, 2));
  code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', value => done(value ?? 1)); });
} catch (error) {
  process.stderr.write((error?.message?.includes('Test database isolation') || error?.message?.startsWith('Unset database URL overrides')
    ? error.message : 'Isolated test runner failed; inspect its dedicated cluster and run records') + '\n');
} finally {
  if (!inherited && context) {
    try { await closeTestRun(context); }
    catch { process.stderr.write('Owned test fixture cleanup failed; preserved its identity record.\n'); code = 1; }
  }
}
process.exitCode = code;
