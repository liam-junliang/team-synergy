// Local, reversible backup/restore rehearsal. Never migrates the source or starts a service.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const command = args.shift() ?? 'inspect';
const options = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (name === '--keep-clone') { options.keepClone = true; continue; }
  if (!['--connection-config', '--manifest', '--backup-dir'].includes(name) || !args[i + 1]) throw Error('Unknown rollout option');
  options[name.slice(2)] = args[++i];
}
assert.ok(['inspect', 'backup-verify'].includes(command), 'Choose inspect or backup-verify');
const configPath = path.resolve(options['connection-config'] ?? 'F:/workspace/team-synergy-runtime/start-service.ps1');
const text = await readFile(configPath, 'utf8');
const matched = /postgres(?:ql)?:\/\/[^'"\s]+/u.exec(text)?.[0];
assert.ok(matched, 'Private connection configuration missing');
const source = new URL(matched);
assert.ok(['postgres:', 'postgresql:'].includes(source.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname), 'Only loopback databases are supported');
const sourceDatabase = decodeURIComponent(source.pathname.slice(1));
assert.ok(/^[a-zA-Z0-9_]+$/u.test(sourceDatabase), 'Invalid source database name');
const manifestPath = path.resolve(options.manifest ?? path.join(root, 'docs/experiments/memory-platform-rollout', command === 'inspect' ? 'inventory.json' : 'backup-verification.json'));
const report = { command, startedAt: new Date().toISOString(), sourceDatabase, sourceMutated: false };
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(value).digest('hex');
const connect = url => new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000,
  options: '-c timezone=UTC -c DateStyle=ISO,MDY', statement_timeout: 120000 });
let phase = 'inspect';

async function tool(program, argv, env = process.env) {
  const child = spawn(program, argv, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errBytes = 0;
  child.stdout.setEncoding('utf8').on('data', chunk => { if (out.length < 32768) out += chunk; });
  child.stderr.on('data', chunk => { errBytes += chunk.length; });
  const [code] = await once(child, 'close');
  if (code !== 0) throw Object.assign(Error('Rollout utility failed'), { safeCode: program + '_exit_' + code, stderrBytes: errBytes });
  return out;
}

async function snapshot(client, label = 'source') {
  const tables = (await client.query(`select schemaname,tablename from pg_tables
    where schemaname in ('public','drizzle') order by schemaname,tablename`)).rows;
  const data = [];
  for (const table of tables) {
    const hash = createHash('sha256'); let count = 0;
    const query = new pg.Query(`select to_jsonb(t)::text as row from ${identifier(table.schemaname)}.${identifier(table.tablename)} t
      order by to_jsonb(t)::text collate "C"`);
    await new Promise((resolve, reject) => {
      query.on('row', row => { hash.update(row.row).update('\n'); count++; });
      query.on('end', resolve); query.on('error', reject); client.query(query);
    });
    data.push({ table: table.schemaname + '.' + table.tablename, count, sha256: hash.digest('hex') });
  }
  const columns = (await client.query(`select table_schema,table_name,column_name,ordinal_position,data_type,udt_name,
    is_nullable,column_default,is_identity,identity_generation from information_schema.columns
    where table_schema in ('public','drizzle') order by table_schema,table_name,ordinal_position`)).rows;
  // pg_dump recreates visible columns in the same logical order, without old
  // attnum holes left by DROP COLUMN. Compare order and types, not those holes.
  const ordinals = new Map(); const gaps = new Map();
  const logicalColumns = columns.map(column => {
    const key = column.table_schema + '.' + column.table_name;
    const position = (ordinals.get(key) ?? 0) + 1; ordinals.set(key, position);
    if (column.ordinal_position !== position) gaps.set(key, column.ordinal_position - position);
    return { ...column, ordinal_position: position };
  });
  report.physicalColumnGaps ??= {};
  report.physicalColumnGaps[label] = [...gaps].map(([table, droppedSlots]) => ({ table, droppedSlots }));
  const constraints = (await client.query(`select n.nspname as schema,c.relname as table_name,k.conname,k.contype,k.convalidated,
    pg_get_constraintdef(k.oid,true) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') order by n.nspname,c.relname,k.conname`)).rows;
  const indexes = (await client.query(`select schemaname,tablename,indexname,indexdef from pg_indexes
    where schemaname in ('public','drizzle') order by schemaname,tablename,indexname`)).rows;
  const functions = (await client.query(`select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','drizzle') and p.prokind in ('f','p') order by n.nspname,p.proname,arguments`)).rows;
  const migrationTable = tables.find(table => table.tablename === '__drizzle_migrations');
  const migrations = migrationTable ? (await client.query(`select id,hash,created_at from ${identifier(migrationTable.schemaname)}.__drizzle_migrations order by created_at`)).rows : [];
  return { tables: data, schemaSha256: digest(JSON.stringify({ columns: logicalColumns, constraints, indexes, functions })),
    schemaParts: Object.fromEntries(Object.entries({ columns: logicalColumns, constraints, indexes, functions }).map(([key, rows]) =>
      [key, { count: rows.length, sha256: digest(JSON.stringify(rows)) }])),
    migrations, totalTables: data.length };
}

async function privateDirectory(directory) {
  assert.ok(path.isAbsolute(directory), 'Backup directory must be absolute');
  const relative = path.relative(root, directory);
  assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Private backups must stay outside the workspace');
  await mkdir(path.dirname(directory), { recursive: true });
  // Refuse an existing destination so a retry cannot replace an earlier backup.
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    const who = await tool('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const sid = /S-1-[0-9-]+/u.exec(who)?.[0];
    assert.ok(sid, 'Current user SID is unavailable');
    await tool('icacls.exe', [directory, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F']);
  }
}

function pgEnvironment(database = sourceDatabase) {
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, PGHOST: source.hostname.replace(/^\[|\]$/gu, ''), PGPORT: source.port || '5432',
    PGDATABASE: database, PGUSER: decodeURIComponent(source.username), PGPASSWORD: decodeURIComponent(source.password),
    PGCONNECT_TIMEOUT: '5', ...(source.searchParams.has('sslmode') ? { PGSSLMODE: source.searchParams.get('sslmode') } : {}) };
}

async function inventory() {
  const client = connect(source);
  try {
    await client.connect(); await client.query('begin transaction isolation level repeatable read read only');
    const version = (await client.query("select current_setting('server_version') as version")).rows[0].version;
    const content = await snapshot(client);
    await client.query('commit');
    return { serverVersion: version, ...content };
  } finally { await client.end(); }
}

async function backupVerify() {
  const suffix = new Date().toISOString().replace(/[-:.]/gu, '').replace('T', '-').replace('Z', '') + '-' + randomBytes(4).toString('hex');
  const backupDir = path.resolve(options['backup-dir'] ?? 'F:/workspace/team-synergy-runtime/backups/memory-platform-' + suffix);
  const partial = path.join(backupDir, 'database.dump.partial'), archive = path.join(backupDir, 'database.dump');
  assert.equal(path.dirname(archive), backupDir); assert.equal(path.dirname(partial), backupDir);
  await privateDirectory(backupDir);
  const sourceClient = connect(source);
  let sourceSnapshot;
  try {
    phase = 'source_snapshot'; await sourceClient.connect();
    await sourceClient.query('begin transaction isolation level repeatable read read only');
    const exported = (await sourceClient.query('select pg_export_snapshot() as snapshot')).rows[0].snapshot;
    assert.match(exported, /^[0-9A-F-]+$/u);
    sourceSnapshot = await snapshot(sourceClient);
    phase = 'pg_dump';
    await tool('pg_dump.exe', ['--format=custom', '--no-password', '--snapshot=' + exported, '--file', partial], pgEnvironment());
    await sourceClient.query('commit');
  } finally { await sourceClient.end(); }
  phase = 'archive_validation';
  await tool('pg_restore.exe', ['--list', partial], pgEnvironment());
  await rename(partial, archive);
  const archiveHash = createHash('sha256');
  for await (const bytes of createReadStream(archive)) archiveHash.update(bytes);
  const clone = 'tsp_memory_restore_' + randomBytes(12).toString('hex');
  assert.match(clone, /^tsp_memory_restore_[a-f0-9]{24}$/u); assert.notEqual(clone, sourceDatabase);
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const admin = connect(adminUrl); let oid; let accepted = false;
  try {
    phase = 'clone_create'; await admin.connect();
    await admin.query('create database ' + identifier(clone));
    oid = (await admin.query('select oid from pg_database where datname=$1', [clone])).rows[0].oid;
    phase = 'pg_restore';
    await tool('pg_restore.exe', ['--exit-on-error', '--no-owner', '--no-privileges', '--no-password', '--dbname', clone, archive], pgEnvironment(clone));
    const cloneUrl = new URL(source); cloneUrl.pathname = '/' + clone;
    const restoredClient = connect(cloneUrl); let restored;
    try {
      phase = 'restore_fingerprint'; await restoredClient.connect();
      await restoredClient.query('begin transaction isolation level repeatable read read only');
      restored = await snapshot(restoredClient, 'restored'); await restoredClient.query('commit');
    } finally { await restoredClient.end(); }
    phase = 'restore_compare';
    Object.assign(report, { backupDirectory: backupDir, archive, archiveBytes: (await stat(archive)).size,
      archiveSha256: archiveHash.digest('hex'), source: sourceSnapshot, restored,
      tableDifferences: sourceSnapshot.tables.filter(table => {
        const copy = restored.tables.find(row => row.table === table.table);
        return !copy || copy.count !== table.count || copy.sha256 !== table.sha256;
      }).map(table => table.table) });
    assert.deepEqual(restored, sourceSnapshot, 'Restored schema, migration or data fingerprint mismatch');
    const privateConfig = path.join(backupDir, 'restore-target.private.json');
    if (options.keepClone) {
      await writeFile(privateConfig, JSON.stringify({ databaseUrl: cloneUrl.href, database: clone, oid, createdAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    Object.assign(report, {
      schemaAndAllTableHashesMatch: true, cloneDatabase: clone, cloneOid: oid, cloneKept: !!options.keepClone,
      ...(options.keepClone ? { privateCloneConfig: privateConfig } : {}) });
    accepted = true;
  } finally {
    if (oid && (!options.keepClone || !accepted)) {
      phase = accepted ? 'clone_cleanup' : phase;
      const current = (await admin.query('select oid from pg_database where datname=$1', [clone])).rows[0]?.oid;
      assert.equal(current, oid, 'Refusing to drop a replaced restore database');
      await admin.query('drop database ' + identifier(clone));
    }
    await admin.end();
  }
}

try {
  if (command === 'inspect') Object.assign(report, { inventory: await inventory() });
  else await backupVerify();
  report.accepted = true;
} catch (error) {
  report.accepted = false; report.failure = { phase, code: error.safeCode ?? error.code ?? error.name };
  process.exitCode = 1;
}
report.endedAt = new Date().toISOString();
await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ accepted: report.accepted, command, sourceDatabase,
  totalTables: report.source?.totalTables ?? report.inventory?.totalTables,
  cloneDatabase: report.cloneDatabase, cloneKept: report.cloneKept, manifest: manifestPath, failure: report.failure }));
