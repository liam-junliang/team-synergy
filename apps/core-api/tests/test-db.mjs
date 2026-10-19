import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { closeDb, openDb, schema } from '@team-synergy/persistence';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../dist/migrations');
const testDatabaseUrl = process.env.ACP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acp_test';

let ensured = false;

function databaseNameOf(databaseUrl) {
  const pathname = new URL(databaseUrl).pathname.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_]+$/.test(pathname)) {
    throw new Error(`Unsupported test database name: ${pathname}`);
  }
  return pathname;
}

function adminDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function ensureTestDatabase() {
  if (ensured) return;
  const databaseName = databaseNameOf(testDatabaseUrl);
  const adminPool = new Pool({ connectionString: adminDatabaseUrl(testDatabaseUrl) });
  try {
    const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (exists.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    }
    ensured = true;
  } finally {
    await adminPool.end();
  }
}

async function truncateAllTables(db) {
  const { rows } = await db.$client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'",
  );
  if (rows.length === 0) return;
  const tables = rows.map(({ tablename }) => `"${String(tablename).replace(/"/g, '""')}"`);
  await db.$client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function openTestDb() {
  await ensureTestDatabase();
  const db = await openDb({ databaseUrl: testDatabaseUrl, migrationsFolder });
  await truncateAllTables(db);
  return db;
}

export async function closeTestDb(db) {
  await closeDb(db);
}

export function publicCode(value) {
  return String(value).padStart(20, '0');
}

export async function insertUser(db, values) {
  const [row] = await db.insert(schema.users).values(values).returning();
  return row;
}

export async function insertTeam(db, values) {
  const [row] = await db.insert(schema.teams).values(values).returning();
  return row;
}

export async function insertTeamMember(db, values) {
  const [row] = await db.insert(schema.teamMembers).values(values).returning();
  return row;
}

export async function insertProject(db, values) {
  const [row] = await db.insert(schema.projects).values(values).returning();
  return row;
}

export async function insertProjectMember(db, values) {
  const [row] = await db.insert(schema.members).values(values).returning();
  return row;
}

export async function insertFeature(db, values) {
  const [row] = await db.insert(schema.features).values(values).returning();
  return row;
}

export async function insertProjectModule(db, values) {
  const [row] = await db.insert(schema.projectModules).values(values).returning();
  return row;
}

export async function insertProjectPhase(db, values) {
  const [row] = await db.insert(schema.projectPhases).values(values).returning();
  return row;
}

export async function insertProjectMilestone(db, values) {
  const [row] = await db.insert(schema.projectMilestones).values(values).returning();
  return row;
}
