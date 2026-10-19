import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { closeDb, openDb } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../../core-api/dist/server.js';

const DEFAULT_TEST_DATABASE_URL = process.env.ACP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acp_test';

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function toAdminDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, '');
  url.pathname = '/postgres';
  return { adminUrl: url.toString(), databaseName };
}

async function ensureTestDatabase(databaseUrl) {
  const { adminUrl, databaseName } = toAdminDatabaseUrl(databaseUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (rows.length === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await client.end();
  }
}

async function truncateAllTables(db) {
  const result = await db.execute(sql`
    select tablename
    from pg_tables
    where schemaname = 'public' and tablename <> '__drizzle_migrations'
    order by tablename
  `);
  const tableNames = result.rows.map((row) => String(row.tablename));
  if (tableNames.length === 0) {
    return;
  }
  const tableList = tableNames.map(quoteIdentifier).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${tableList} CASCADE`));
}

export async function createHttpTestContext(metaUrl) {
  const here = path.dirname(fileURLToPath(metaUrl));
  const cliJs = path.resolve(here, '../dist/index.js');
  const migrationsFolder = path.resolve(here, '../../../packages/persistence/drizzle');
  const databaseUrl = DEFAULT_TEST_DATABASE_URL;

  await ensureTestDatabase(databaseUrl);
  const db = await openDb({ databaseUrl, migrationsFolder });
  await truncateAllTables(db);

  const server = await buildServer({ db, logger: false });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve test server address');
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'agentctl-http-'));
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const authHome = path.join(tmp, 'agentctl-home');
  const workspacesDir = path.join(tmp, 'worktrees');

  function env(extra = {}) {
    return {
      ...process.env,
      ACP_API_URL: apiUrl,
      ACP_PRINCIPAL_CODE: '',
      ACP_PRINCIPAL_ID: '',
      ACP_TOKEN: '',
      AGENTCTL_HOME: authHome,
      ACP_WORKSPACES_DIR: workspacesDir,
      ...extra,
    };
  }

  function runCli(args, extraEnv = {}, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliJs, ...args], {
        cwd: options.cwd,
        env: env(extraEnv),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
      child.on('close', (status) => resolve({ status, out, err }));
    });
  }

  function makeRepo(name = 'repo') {
    const repoDir = path.join(tmp, name);
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(path.join(repoDir, 'README.md'), '# repo\n', 'utf8');
    const git = (args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
    return repoDir;
  }

  async function cleanup() {
    await server.close();
    await closeDb(db);
    rmSync(tmp, { recursive: true, force: true });
  }

  return {
    apiUrl,
    authHome,
    db,
    env,
    makeRepo,
    runCli,
    tmp,
    workspacesDir,
    cleanup,
  };
}

export function testCode(n) {
  return String(n).padStart(20, '0');
}

export async function insertTeam(db, {
  code = testCode(1),
  legacyCode = null,
  name = 'Team',
  createdAt = 't0',
} = {}) {
  const [team] = await db.insert(schema.teams).values({
    code,
    legacy_code: legacyCode,
    name,
    created_at: createdAt,
  }).returning();
  return team;
}

export async function insertUser(db, {
  code,
  legacyCode = null,
  account,
  displayName,
  status = 'active',
  isSystemAdmin = false,
  passwordHash = null,
  mustChangePassword = false,
  passwordExpiresAt = null,
  bindTokenHash = null,
  bindTokenExpiresAt = null,
  createdAt = 't0',
} = {}) {
  const [user] = await db.insert(schema.users).values({
    code,
    legacy_code: legacyCode,
    account,
    display_name: displayName,
    status,
    is_system_admin: isSystemAdmin,
    password_hash: passwordHash,
    must_change_password: mustChangePassword,
    password_expires_at: passwordExpiresAt,
    bind_token_hash: bindTokenHash,
    bind_token_expires_at: bindTokenExpiresAt,
    created_at: createdAt,
  }).returning();
  return user;
}

export async function insertProject(db, {
  code,
  legacyCode = null,
  teamId,
  name = 'acp',
  currentSnapshot = 0,
  createdAt = 't0',
} = {}) {
  const [project] = await db.insert(schema.projects).values({
    code,
    legacy_code: legacyCode,
    team_id: teamId,
    name,
    current_snapshot: currentSnapshot,
    created_at: createdAt,
  }).returning();
  return project;
}

export async function insertMember(db, {
  principalId,
  projectId,
  role,
  displayName,
  createdAt = 't0',
}) {
  await db.insert(schema.members).values({
    principal_id: principalId,
    project_id: projectId,
    role,
    display_name: displayName,
    created_at: createdAt,
  });
}
