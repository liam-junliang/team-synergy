import { after, before, beforeEach } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { closeDb, openDb, schema } from '@team-synergy/persistence';

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
  const { Client } = await import('pg');
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
  const tableNames = result.rows.map((row) => row.tablename);
  if (tableNames.length === 0) {
    return;
  }
  const tableList = tableNames.map(quoteIdentifier).join(', ');
  await db.execute(sql.raw(`TRUNCATE TABLE ${tableList} CASCADE`));
}

export function useTestDb(metaUrl) {
  const here = path.dirname(fileURLToPath(metaUrl));
  const migrationsFolder = path.resolve(here, '../../persistence/drizzle');
  const databaseUrl = process.env.ACP_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  let db;

  before(async () => {
    await ensureTestDatabase(databaseUrl);
    db = await openDb({ databaseUrl, migrationsFolder });
  });

  beforeEach(async () => {
    await truncateAllTables(db);
  });

  after(async () => {
    if (db) {
      await closeDb(db);
    }
  });

  return {
    get db() {
      if (!db) {
        throw new Error('test database is not ready');
      }
      return db;
    },
    databaseUrl,
    migrationsFolder,
  };
}

export async function insertTeam(db, { legacyCode = null, name, createdAt = 't0' }) {
  const [team] = await db.insert(schema.teams).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    name,
    created_at: createdAt,
  }).returning();
  return team;
}

export async function insertUser(db, {
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
}) {
  const [user] = await db.insert(schema.users).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
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

export async function addTeamMember(db, {
  teamId,
  principalId,
  role,
  displayName,
  createdAt = 't0',
}) {
  await db.insert(schema.teamMembers).values({
    team_id: teamId,
    principal_id: principalId,
    role,
    display_name: displayName,
    created_at: createdAt,
  });
}

export async function insertProject(db, {
  legacyCode = null,
  teamId,
  name,
  currentSnapshot = 0,
  createdAt = 't0',
}) {
  const [project] = await db.insert(schema.projects).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    team_id: teamId,
    name,
    current_snapshot: currentSnapshot,
    created_at: createdAt,
  }).returning();
  return project;
}

export async function addProjectMember(db, {
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

export async function insertFeature(db, {
  legacyCode = null,
  projectId,
  moduleId = null,
  milestoneId = null,
  title,
  goal = null,
  status = 'active',
}) {
  const [feature] = await db.insert(schema.features).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    project_id: projectId,
    module_id: moduleId,
    milestone_id: milestoneId,
    title,
    goal,
    status,
  }).returning();
  return feature;
}

export async function insertRequirement(db, {
  legacyCode = null,
  featureId = null,
  moduleId = null,
  documentId = null,
  title,
  currentRevision = 1,
  state = 'confirmed',
  ownerPrincipalId,
}) {
  const [requirement] = await db.insert(schema.requirements).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    feature_id: featureId,
    module_id: moduleId,
    document_id: documentId,
    title,
    current_revision: currentRevision,
    state,
    owner_principal_id: ownerPrincipalId,
  }).returning();
  return requirement;
}

export async function insertTask(db, {
  legacyCode = null,
  featureId,
  requirementId = null,
  defectId = null,
  title,
  brief = '',
  profile,
  source = 'requirement',
  status = 'draft',
  assigneePrincipalId = null,
  acceptance,
  validationSeams = null,
  scope = null,
  baseSnapshot = 0,
  createdAt = 't0',
}) {
  const [task] = await db.insert(schema.tasks).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    feature_id: featureId,
    requirement_id: requirementId,
    defect_id: defectId,
    title,
    brief,
    profile,
    source,
    status,
    assignee_principal_id: assigneePrincipalId,
    acceptance: JSON.stringify(acceptance),
    validation_seams: validationSeams ? JSON.stringify(validationSeams) : null,
    scope: scope ? JSON.stringify(scope) : null,
    base_snapshot: baseSnapshot,
    created_at: createdAt,
  }).returning();
  return task;
}

export async function insertRequirementDocument(db, {
  legacyCode = null,
  projectId,
  moduleId = null,
  moduleKey,
  title,
  currentRevision = 1,
  state = 'active',
  ownerPrincipalId,
  createdAt = 't0',
  updatedAt = createdAt,
}) {
  const [document] = await db.insert(schema.requirementDocuments).values({
    ...(legacyCode ? { legacy_code: legacyCode } : {}),
    project_id: projectId,
    module_id: moduleId,
    module_key: moduleKey,
    title,
    current_revision: currentRevision,
    state,
    owner_principal_id: ownerPrincipalId,
    created_at: createdAt,
    updated_at: updatedAt,
  }).returning();
  return document;
}

export async function seedWorkspaceProject(db, {
  teamLegacyCode = 'TEAM-LEGACY',
  teamName = 'Workspace Team',
  projectLegacyCode = 'PROJECT-LEGACY',
  projectName = 'Workspace Project',
  users,
}) {
  const team = await insertTeam(db, { legacyCode: teamLegacyCode, name: teamName });
  const project = await insertProject(db, { legacyCode: projectLegacyCode, teamId: team.id, name: projectName });
  const principals = {};
  for (const userSpec of users) {
    const user = await insertUser(db, {
      legacyCode: userSpec.legacyCode ?? null,
      account: userSpec.account,
      displayName: userSpec.displayName,
      status: userSpec.status ?? 'active',
      isSystemAdmin: userSpec.isSystemAdmin ?? false,
      passwordHash: userSpec.passwordHash ?? null,
      mustChangePassword: userSpec.mustChangePassword ?? false,
      passwordExpiresAt: userSpec.passwordExpiresAt ?? null,
      bindTokenHash: userSpec.bindTokenHash ?? null,
      bindTokenExpiresAt: userSpec.bindTokenExpiresAt ?? null,
      createdAt: userSpec.createdAt ?? 't0',
    });
    await addTeamMember(db, {
      teamId: team.id,
      principalId: user.id,
      role: userSpec.teamRole ?? 'member',
      displayName: user.display_name,
      createdAt: userSpec.createdAt ?? 't0',
    });
    await addProjectMember(db, {
      projectId: project.id,
      principalId: user.id,
      role: userSpec.projectRole ?? 'member',
      displayName: user.display_name,
      createdAt: userSpec.createdAt ?? 't0',
    });
    principals[userSpec.key] = user;
  }
  return { team, project, users: principals };
}
