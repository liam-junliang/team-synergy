import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { closeDb, openDb, schema } from '@team-synergy/persistence';
import { assertDisposableTestDatabase, assertOwnedTestDatabase, requireTestContext } from '../../../scripts/test-database-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../dist/migrations');
const testDatabaseUrl = requireTestContext().databaseUrl;
assertDisposableTestDatabase(testDatabaseUrl);

let ensured = false;

async function ensureTestDatabase() {
  if (ensured) return;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await assertOwnedTestDatabase(adminPool);
    ensured = true;
  } finally {
    await adminPool.end();
  }
}

async function truncateAllTables(db) {
  await assertOwnedTestDatabase(db.$client);
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
