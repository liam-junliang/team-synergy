import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { eq, is, sql, Table } from 'drizzle-orm';
import { openDb, closeDb, traverseSubgraph, schema } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, '../drizzle');
const testDatabaseUrl =
  process.env.ACP_TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/acp_test';
const PUBLIC_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const migrationJournal = JSON.parse(await readFile(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8'));

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseNameFromUrl(connectionString) {
  const databaseUrl = new URL(connectionString);
  return databaseUrl.pathname.replace(/^\//, '');
}

function adminDatabaseUrl(connectionString) {
  const databaseUrl = new URL(connectionString);
  databaseUrl.pathname = '/postgres';
  return databaseUrl.toString();
}

async function ensureTestDatabase() {
  const databaseName = databaseNameFromUrl(testDatabaseUrl);
  const adminPool = new Pool({ connectionString: adminDatabaseUrl(testDatabaseUrl) });
  try {
    const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (result.rowCount === 0) {
      await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await adminPool.end();
  }
}

async function resetPublicSchema() {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
}

async function truncateBusinessTables() {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    const result = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations' ORDER BY tablename",
    );
    if (result.rowCount === 0) {
      return;
    }

    const tables = result.rows.map((row) => quoteIdentifier(row.tablename));
    await pool.query(`TRUNCATE TABLE ${tables.join(', ')}`);
  } finally {
    await pool.end();
  }
}

async function freshDb(options = {}) {
  return openDb({ databaseUrl: testDatabaseUrl, migrationsFolder, ...options });
}

/** Use the real migrator/journal to reproduce a previously deployed schema. */
async function freshDbThrough(maxTag) {
  const prefixFolder = await mkdtemp(path.join(tmpdir(), 'acp-migration-prefix-'));
  const entries = migrationJournal.entries.filter(entry => Number(entry.tag.slice(0, 4)) <= maxTag);
  try {
    await mkdir(path.join(prefixFolder, 'meta'));
    await writeFile(path.join(prefixFolder, 'meta/_journal.json'), JSON.stringify({ ...migrationJournal, entries }));
    for (const entry of entries) await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(prefixFolder, `${entry.tag}.sql`));
    return await freshDb({ migrationsFolder: prefixFolder });
  } finally {
    for (const entry of entries) await unlink(path.join(prefixFolder, `${entry.tag}.sql`)).catch(() => {});
    await unlink(path.join(prefixFolder, 'meta/_journal.json')).catch(() => {});
    await rmdir(path.join(prefixFolder, 'meta')).catch(() => {});
    await rmdir(prefixFolder);
  }
}

async function withDb(run, options = {}) {
  const db = await freshDb(options);
  try {
    return await run(db);
  } finally {
    await closeDb(db);
  }
}

function assertPublicCode(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, PUBLIC_CODE_PATTERN);
}

async function migrationFilePaths(maxTag) {
  const files = await readdir(migrationsFolder);
  return files
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .sort()
    .filter((file) => Number(file.slice(0, 4)) <= maxTag)
    .map((file) => path.join(migrationsFolder, file));
}

async function executeSqlFile(pool, filePath) {
  const content = await readFile(filePath, 'utf8');
  const statements = content
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }
}

async function applyMigrationsThrough(maxTag) {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    const files = await migrationFilePaths(maxTag);
    for (const file of files) {
      await executeSqlFile(pool, file);
    }
  } finally {
    await pool.end();
  }
}

async function seedIdentityBase(db) {
  // These fixtures run on deployed schemas as old as 0026. Today's ORM inserts
  // expand even omitted columns, so identity writes use only the original SQL columns.
  let [team] = await db.select({ id: schema.teams.id, code: schema.teams.code }).from(schema.teams).where(eq(schema.teams.legacy_code, 'TEAM-LEGACY'));
  if (!team) {
    const { rows: [row] } = await db.$client.query(
      'INSERT INTO teams (legacy_code, name, created_at) VALUES ($1, $2, $3) RETURNING id, code',
      ['TEAM-LEGACY', 'Legacy workspace', 't0'],
    );
    team = { id: BigInt(row.id), code: row.code };
  }
  let [user] = await db.select({ id: schema.users.id, code: schema.users.code }).from(schema.users).where(eq(schema.users.legacy_code, 'user-chen'));
  if (!user) {
    const { rows: [row] } = await db.$client.query(
      'INSERT INTO users (legacy_code, account, display_name, created_at) VALUES ($1, $2, $3, $4) RETURNING id, code',
      ['user-chen', 'chen', 'chen', 't0'],
    );
    user = { id: BigInt(row.id), code: row.code };
  }
  // This fixture also seeds pre-0029 databases: select/insert only columns that
  // existed there, rather than letting today's Drizzle schema expand the SQL.
  let [project] = await db.select({ id: schema.projects.id, code: schema.projects.code })
    .from(schema.projects).where(eq(schema.projects.legacy_code, 'PROJECT-A'));
  if (!project) {
    const { rows } = await db.$client.query(
      `INSERT INTO projects (legacy_code, team_id, name, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id, code`,
      ['PROJECT-A', team.id, 'Team Synergy', 't0'],
    );
    project = { id: BigInt(rows[0].id), code: rows[0].code };
  }

  const [teamMember] = await db
    .select()
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.team_id, team.id));
  if (!teamMember) {
    await db.insert(schema.teamMembers).values({
      team_id: team.id,
      principal_id: user.id,
      role: 'owner',
      display_name: 'chen',
      created_at: 't0',
    });
  }

  const [member] = await db.select().from(schema.members).where(eq(schema.members.project_id, project.id));
  if (!member) {
    await db.insert(schema.members).values({
      principal_id: user.id,
      project_id: project.id,
      role: 'owner',
      display_name: 'chen',
      created_at: 't0',
    });
  }

  return { team, user, project };
}

async function seedLegacyProject(db, teamId, name) {
  const { rows: [row] } = await db.$client.query(
    'INSERT INTO projects (team_id, name, created_at) VALUES ($1, $2, $3) RETURNING id, code',
    [teamId, name, 'p0'],
  );
  return { id: BigInt(row.id), code: row.code };
}

async function seedTaskBase(db) {
  const { team, user, project } = await seedIdentityBase(db);
  const [feature] = await db
    .insert(schema.features)
    .values({
      legacy_code: 'FEATURE-12',
      project_id: project.id,
      title: '用户登录',
      goal: '邮箱密码登录',
    })
    .returning({ id: schema.features.id, code: schema.features.code });
  const [requirement] = await db
    .insert(schema.requirements)
    .values({
      legacy_code: 'REQ-0142',
      feature_id: feature.id,
      title: '邮箱登录',
      state: 'confirmed',
      owner_principal_id: user.id,
    })
    .returning({ id: schema.requirements.id, code: schema.requirements.code });
  const [task] = await db
    .insert(schema.tasks)
    .values({
      legacy_code: 'TASK-301',
      feature_id: feature.id,
      title: '实现认证失败统一响应与锁定策略',
      profile: 'builder',
      status: 'ready',
      requirement_id: requirement.id,
      acceptance: JSON.stringify([{ id: 'AC-1', text: 'x' }]),
      base_snapshot: 28,
      created_at: 't0',
    })
    .returning({ id: schema.tasks.id, code: schema.tasks.code });

  return { team, user, project, feature, requirement, task };
}

async function seedGraph(db, graphLegacyCode = 'G1', graphSnapshot = 28) {
  const { project } = await seedIdentityBase(db);
  const [graph] = await db
    .insert(schema.contextGraphs)
    .values({
      legacy_code: graphLegacyCode,
      project_id: project.id,
      created_at: 't',
    })
    .returning({ id: schema.contextGraphs.id, code: schema.contextGraphs.code });
  const [snapshot] = await db
    .insert(schema.contextGraphSnapshots)
    .values({
      graph_id: graph.id,
      graph_snapshot: graphSnapshot,
      created_at: 't',
    })
    .returning({ id: schema.contextGraphSnapshots.id, code: schema.contextGraphSnapshots.code });

  return { project, graph, snapshot };
}

async function insertNode(db, snapshotId, nodeKey) {
  const [node] = await db
    .insert(schema.contextNodes)
    .values({
      snapshot_id: snapshotId,
      node_key: nodeKey,
      kind: 'service',
      verification: 'confirmed',
      freshness: 'current',
    })
    .returning({ id: schema.contextNodes.id, node_key: schema.contextNodes.node_key });
  return node;
}

async function insertEdge(db, snapshotId, fromNodeId, toNodeId, legacyKey) {
  await db.insert(schema.contextEdges).values({
    legacy_key: legacyKey,
    snapshot_id: snapshotId,
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    relation: 'calls',
    verification: 'confirmed',
    freshness: 'current',
  });
}

before(async () => {
  await ensureTestDatabase();
  await resetPublicSchema();
});

beforeEach(async () => {
  await resetPublicSchema();
});

after(async () => {
  await truncateBusinessTables();
});

test('迁移可重复执行：空库顺序迁移到最新版本后表数量稳定', async () => {
  const db1 = await freshDb();
  await closeDb(db1);

  const db2 = await freshDb();
  try {
    const tables = await db2.execute(sql`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
      ORDER BY tablename
    `);
    assert.equal(tables.rows.length, Object.values(schema).filter(value => is(value, Table)).length);
  } finally {
    await closeDb(db2);
  }
});

test('迁移幂等：同一数据库连续两次 openDb 不重复记录迁移', async () => {
  const db1 = await freshDb();
  try {
    const migrations1 = await db1.execute(sql`SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(migrations1.rows[0].n, migrationJournal.entries.length);
  } finally {
    await closeDb(db1);
  }

  const db2 = await freshDb();
  try {
    const migrations2 = await db2.execute(sql`SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`);
    assert.equal(migrations2.rows[0].n, migrationJournal.entries.length);
  } finally {
    await closeDb(db2);
  }
});

test('0026 repairs an already-migrated legacy handover table without losing its records', async () => {
  const db = await freshDbThrough(25);
  let row;
  try {
    [row] = await db.insert(schema.taskHandovers).values({
      task_id: 41n, source_run_id: 42n, target_principal_id: 43n, source_device_id: 44n,
      source_epoch: 1, preparation_grant_hash: 'legacy-grant-hash',
      preparation_expires_at: '2026-10-14T00:00:00.000Z', expires_at: '2026-10-14T00:00:00.000Z',
      created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z',
    }).returning();
    await db.$client.query('ALTER TABLE task_handovers DROP COLUMN drift_approval');
    const repair = migrationJournal.entries.find(entry => entry.tag.startsWith('0026_'));
    await db.$client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [repair.when]);
    const before = await db.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    assert.equal(before.rows[0].n, migrationJournal.entries.filter(entry => entry.when < repair.when).length);
    await assert.rejects(db.$client.query('SELECT drift_approval FROM task_handovers'), error => error.code === '42703');
  } finally { await closeDb(db); }
  const repaired = await freshDb();
  try {
    const [preserved] = await repaired.select().from(schema.taskHandovers).where(eq(schema.taskHandovers.id, row.id));
    assert.equal(preserved.code, row.code);
    assert.equal(preserved.preparation_grant_hash, 'legacy-grant-hash');
    assert.equal(preserved.source_run_id, 42n);
    assert.equal(preserved.status, 'preparing');
    assert.equal(preserved.drift_approval, null);
    await executeSqlFile(repaired.$client, path.join(migrationsFolder, '0026_handover_drift_approval_repair.sql'));
    assert.equal((await repaired.select().from(schema.taskHandovers)).length, 1);
    assert.equal((await repaired.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
  } finally { await closeDb(repaired); }
});

test('0026 升级到 0027：保留既有需求任务，基线绑定默认空且重新打开幂等', async () => {
  const previous = await freshDbThrough(26);
  let seeded;
  try {
    const { project, user } = await seedIdentityBase(previous);
    const [feature] = await previous.insert(schema.features).values({ project_id: project.id, title: '用户登录' }).returning();
    const [requirement] = await previous.insert(schema.requirements).values({ feature_id: feature.id, title: '邮箱登录', state: 'confirmed', owner_principal_id: user.id }).returning();
    // The current Drizzle task schema includes the new column, so seed the deployed schema via SQL.
    const inserted = await previous.$client.query(`INSERT INTO tasks (feature_id, title, profile, status, requirement_id, acceptance, base_snapshot, created_at)
      VALUES ($1, $2, 'builder', 'ready', $3, '[]', 28, 't0') RETURNING id, code`, [feature.id, '实现认证失败统一响应与锁定策略', requirement.id]);
    seeded = { requirement, task: { ...inserted.rows[0], id: BigInt(inserted.rows[0].id) } };
    await assert.rejects(previous.$client.query('SELECT requirement_baseline_id FROM tasks'), error => error.code === '42703');
  } finally { await closeDb(previous); }
  const upgraded = await freshDb();
  try {
    const [task] = await upgraded.select().from(schema.tasks).where(eq(schema.tasks.id, seeded.task.id));
    const [requirement] = await upgraded.select().from(schema.requirements).where(eq(schema.requirements.id, seeded.requirement.id));
    assert.equal(task.code, seeded.task.code);
    assert.equal(task.requirement_id, seeded.requirement.id);
    assert.equal(task.requirement_baseline_id, null);
    assert.equal(task.title, '实现认证失败统一响应与锁定策略');
    assert.equal(requirement.code, seeded.requirement.code);
    assert.equal(requirement.title, '邮箱登录');
    assert.equal((await upgraded.select().from(schema.requirementBaselines)).length, 0);
    assert.equal((await upgraded.select().from(schema.requirementBaselineItems)).length, 0);
    const column = await upgraded.$client.query("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'requirement_baseline_id'");
    assert.deepEqual(column.rows, [{ is_nullable: 'YES', data_type: 'bigint' }]);
  } finally { await closeDb(upgraded); }
  const reopened = await freshDb();
  try {
    const [task] = await reopened.select().from(schema.tasks).where(eq(schema.tasks.id, seeded.task.id));
    assert.equal(task.code, seeded.task.code);
    assert.equal(task.requirement_baseline_id, null);
    assert.equal((await reopened.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
  } finally { await closeDb(reopened); }
});

test('0031 升级到 0032：独立架构图源与版本表不修改现有项目或文档', async () => {
  const oldDb = await freshDbThrough(31);
  const { project, user } = await seedIdentityBase(oldDb);
  const [prototype] = await oldDb.insert(schema.designPrototypes).values({ project_id: project.id, title: '原有设计', owner_principal_id: user.id, created_at: 't0', updated_at: 't0' }).returning();
  const [originalRevision] = await oldDb.insert(schema.designPrototypeRevisions).values({ prototype_id: prototype.id, revision: 1, html_content: '<html>保留</html>', change_summary: 'init', created_by: user.id, created_at: 't0' }).returning();
  const beforeProjects = (await oldDb.$client.query('SELECT * FROM projects ORDER BY id')).rows;
  const beforeFolders = await oldDb.select().from(schema.projectDocumentFolders);
  await closeDb(oldDb);
  const db = await freshDb();
  try {
    const afterProjects = (await db.$client.query('SELECT * FROM projects ORDER BY id')).rows;
    assert.deepEqual(afterProjects.map((row, index) => Object.fromEntries(Object.keys(beforeProjects[index]).map(key => [key, row[key]]))), beforeProjects);
    assert.equal(afterProjects[0].owner_principal_id, user.id.toString(), '0034 resolves the unambiguous existing owner');
    assert.equal(afterProjects[0].created_by, null, 'Historic creator is not inferred without creation evidence');
    assert.equal(afterProjects[0].member_policy, 'private');
    const upgradedFolders = await db.select().from(schema.projectDocumentFolders);
    assert.deepEqual(upgradedFolders.filter(folder => !['architecture', 'testing'].includes(folder.system_role)), beforeFolders);
    assert.equal(upgradedFolders.filter(folder => folder.system_role === 'architecture').length, 1);
    assert.equal(upgradedFolders.filter(folder => folder.system_role === 'testing').length, 1);
    assert.deepEqual(await db.select().from(schema.designPrototypeRevisions), [originalRevision]);
    assert.deepEqual(await db.select().from(schema.architectureDocuments), []);
    const [document] = await db.insert(schema.architectureDocuments).values({
      project_id: project.id, title: '总体架构', content_kind: 'mermaid', owner_principal_id: user.id, created_at: 't0', updated_at: 't0',
    }).returning();
    assertPublicCode(document.code);
    const revisionInput = { document_id: document.id, revision: 1, title: '总体架构', content_kind: 'mermaid',
      source_content: 'flowchart LR\n A --> B', preview_svg: '<svg/>', change_summary: '初始版本', created_by: user.id, created_at: 't0' };
    const [revision] = await db.insert(schema.architectureDocumentRevisions).values(revisionInput).returning();
    assertPublicCode(revision.code);
    assert.equal(revision.source_content, revisionInput.source_content);
    const constraint = error => error.cause?.constraint ?? error.constraint;
    await assert.rejects(db.insert(schema.architectureDocumentRevisions).values(revisionInput), error => constraint(error) === 'uq_architecture_document_revisions_document_revision');
    await assert.rejects(db.insert(schema.architectureDocumentRevisions).values({ ...revisionInput, revision: 2, content_kind: 'html' }), error => constraint(error) === 'ck_architecture_document_revisions_kind');
    await assert.rejects(db.insert(schema.architectureDocumentRevisions).values({ ...revisionInput, revision: 2, source_content: '' }), error => constraint(error) === 'ck_architecture_document_revisions_source_size');
    await assert.rejects(db.insert(schema.architectureDocumentRevisions).values({ ...revisionInput, revision: 0 }), error => constraint(error) === 'ck_architecture_document_revisions_revision');
    const second = await freshDb();
    try {
      assert.deepEqual(await second.select().from(schema.architectureDocumentRevisions), [revision]);
      assert.equal((await second.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
    } finally { await closeDb(second); }
  } finally { await closeDb(db); }
});

test('0032 升级到 0033：架构关联目录与类型升级保留所有正文、图源、旧用途和历史子树', async () => {
  const previous = await freshDbThrough(32);
  let seeded;
  try {
    const { project, user, team } = await seedIdentityBase(previous);
    const emptyProject = await seedLegacyProject(previous, team.id, 'Empty project');
    const [standards] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, name: '项目规范', system_role: 'standards', created_at: 'f0', updated_at: 'f0' }).returning();
    const [child] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, parent_id: standards.id, name: '保留规范子目录', created_by: user.id, created_at: 'f1', updated_at: 'f1' }).returning();
    const [ordinary] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, name: '架构设计', created_by: user.id, created_at: 'f2', updated_at: 'f2' }).returning();
    const [document] = await previous.insert(schema.projectDocuments).values({ project_id: project.id, folder_id: child.id, kind: 'deployment', title: '旧部署说明', content: '# 保留正文', created_by: user.id, updated_by: user.id, created_at: 'd0', updated_at: 'd0' }).returning();
    const docRevisions = await previous.insert(schema.projectDocumentRevisions).values({ document_id: document.id, revision: 1,
      title: document.title, content: document.content, change_summary: '初始', created_by: user.id, created_at: 'd0' }).returning();
    const [architecture] = await previous.insert(schema.architectureDocuments).values({ project_id: project.id, title: '总体架构',
      content_kind: 'mermaid', current_revision: 2, owner_principal_id: user.id, created_at: 'a0', updated_at: 'a1' }).returning();
    const architectureRevisions = await previous.insert(schema.architectureDocumentRevisions).values([1, 2].map(revision => ({
      document_id: architecture.id, revision, title: `版本${revision}`, summary: `摘要${revision}`, content_kind: 'mermaid',
      source_content: `flowchart LR\n A --> B${revision}`, notes_markdown: `# 说明${revision}`, preview_svg: '<svg/>',
      change_summary: `修订${revision}`, created_by: user.id, created_at: `a${revision}`,
    }))).returning();
    const [requirement] = await previous.insert(schema.requirementDocuments).values({ project_id: project.id, module_key: '模块', title: '需求', owner_principal_id: user.id, created_at: 'r0', updated_at: 'r0' }).returning();
    const requirementRevisions = await previous.insert(schema.requirementDocumentRevisions).values({ document_id: requirement.id, revision: 1,
      summary: '摘要', content: '# 需求正文', change_summary: '初始', created_by: user.id, created_at: 'r0' }).returning();
    seeded = { project, user, emptyProject, standards, child, ordinary, document, docRevisions, architecture, architectureRevisions, requirement, requirementRevisions };
  } finally { await closeDb(previous); }
  let rootCode;
  const upgraded = await freshDb();
  try {
    const folders = await upgraded.select().from(schema.projectDocumentFolders);
    const roots = folders.filter(folder => folder.system_role === 'architecture');
    assert.equal(roots.length, 2);
    rootCode = roots.find(folder => folder.project_id === seeded.project.id).code;
    for (const root of roots) {
      assertPublicCode(root.code);
      assert.equal(root.name, '架构设计');
      assert.equal(root.parent_id, null);
      assert.equal(root.status, 'active');
      assert.equal(root.created_by, null);
    }
    assert.deepEqual(folders.find(folder => folder.id === seeded.child.id), seeded.child);
    assert.deepEqual(folders.find(folder => folder.id === seeded.standards.id), seeded.standards);
    assert.deepEqual(folders.find(folder => folder.id === seeded.ordinary.id), { ...seeded.ordinary, name: `架构设计（原目录 ${seeded.ordinary.code}）` });
    assert.deepEqual(await upgraded.select().from(schema.projectDocuments), [seeded.document]);
    assert.deepEqual(await upgraded.select().from(schema.projectDocumentRevisions), seeded.docRevisions);
    assert.deepEqual(await upgraded.select().from(schema.architectureDocuments), [seeded.architecture]);
    assert.deepEqual(await upgraded.select().from(schema.architectureDocumentRevisions).orderBy(schema.architectureDocumentRevisions.revision), seeded.architectureRevisions);
    assert.deepEqual(await upgraded.select().from(schema.requirementDocuments), [seeded.requirement]);
    assert.deepEqual(await upgraded.select().from(schema.requirementDocumentRevisions), seeded.requirementRevisions);
    for (const kind of ['doc', 'api', 'diagram']) {
      await upgraded.insert(schema.projectDocuments).values({ project_id: seeded.project.id, kind, title: kind, content: kind,
        created_by: seeded.user.id, updated_by: seeded.user.id, created_at: 'new', updated_at: 'new' });
    }
    const root = roots.find(folder => folder.project_id === seeded.project.id);
    const constraint = error => error.cause?.constraint ?? error.constraint;
    for (const change of [{ name: 'Renamed' }, { parent_id: seeded.child.id }, { status: 'archived' }]) {
      await assert.rejects(upgraded.update(schema.projectDocumentFolders).set(change).where(eq(schema.projectDocumentFolders.id, root.id)), error => constraint(error) === 'ck_project_document_folders_system_shape');
    }
  } finally { await closeDb(upgraded); }
  const reopened = await freshDb();
  try {
    const roots = await reopened.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.system_role, 'architecture'));
    assert.equal(roots.length, 2);
    assert.equal(roots.find(folder => folder.project_id === seeded.project.id).code, rootCode);
    assert.deepEqual(await reopened.select().from(schema.architectureDocumentRevisions).orderBy(schema.architectureDocumentRevisions.revision), seeded.architectureRevisions);
  } finally { await closeDb(reopened); }
});

test('0030 升级到 0031：需求系统目录保留原需求正文、历史、评审与同名普通目录', async () => {
  const previous = await freshDbThrough(30);
  let seeded;
  try {
    const { project, user, team } = await seedIdentityBase(previous);
    const emptyProject = await seedLegacyProject(previous, team.id, 'Empty project');
    const [legacyFolder] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, name: '需求文档', created_by: user.id, created_at: 'f0', updated_at: 'f0' }).returning();
    const [child] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, parent_id: legacyFolder.id, name: '保留子目录', created_by: user.id, created_at: 'f0', updated_at: 'f0' }).returning();
    const [ordinary] = await previous.insert(schema.projectDocuments).values({ project_id: project.id, folder_id: legacyFolder.id, title: '原目录普通文档', content: '保持原样', created_by: user.id, updated_by: user.id, created_at: 'd0', updated_at: 'd0' }).returning();
    const [document] = await previous.insert(schema.requirementDocuments).values({ project_id: project.id, module_key: '模块A', title: '版本化需求', current_revision: 2, owner_principal_id: user.id, created_at: 'd0', updated_at: 'd1' }).returning();
    const revisions = await previous.insert(schema.requirementDocumentRevisions).values([1, 2].map(revision => ({ document_id: document.id, revision,
      summary: `摘要${revision}`, content: `# 版本${revision}\n\n正文无需复制`, keywords: '["关键字"]', change_summary: `变更${revision}`, created_by: user.id, created_at: `r${revision}` }))).returning();
    const [review] = await previous.insert(schema.requirementDocumentReviews).values({ document_revision_id: revisions[0].id, requested_by: user.id, opened_at: 'review0' }).returning();
    const [archived] = await previous.insert(schema.requirementDocuments).values({ project_id: project.id, module_key: '归档', title: '已归档需求', state: 'archived', owner_principal_id: user.id, created_at: 'a0', updated_at: 'a0' }).returning();
    await previous.insert(schema.requirementDocumentRevisions).values({ document_id: archived.id, revision: 1, summary: '归档摘要', content: '归档正文', change_summary: '创建', created_by: user.id, created_at: 'a0' });
    seeded = { project, emptyProject, user, legacyFolder, child, ordinary, document, review,
      documents: await previous.select().from(schema.requirementDocuments).orderBy(schema.requirementDocuments.id),
      revisions: await previous.select().from(schema.requirementDocumentRevisions).orderBy(schema.requirementDocumentRevisions.id) };
  } finally { await closeDb(previous); }
  let folderCode;
  const upgraded = await freshDb();
  try {
    const folders = await upgraded.select().from(schema.projectDocumentFolders);
    const roots = folders.filter(folder => folder.system_role === 'requirements');
    assert.equal(roots.length, 2, 'every existing project, including empty projects, receives a system folder');
    for (const root of roots) {
      assertPublicCode(root.code);
      assert.equal(root.name, '需求文档');
      assert.equal(root.parent_id, null);
      assert.equal(root.status, 'active');
      assert.equal(root.created_by, null);
    }
    const root = roots.find(folder => folder.project_id === seeded.project.id);
    folderCode = root.code;
    assert.deepEqual(folders.find(folder => folder.id === seeded.legacyFolder.id), { ...seeded.legacyFolder, name: `需求文档（原目录 ${seeded.legacyFolder.code}）` });
    assert.deepEqual(folders.find(folder => folder.id === seeded.child.id), seeded.child);
    assert.deepEqual(await upgraded.select().from(schema.projectDocuments), [seeded.ordinary], 'no duplicate document body is inserted');
    assert.deepEqual(await upgraded.select().from(schema.requirementDocuments).orderBy(schema.requirementDocuments.id), seeded.documents);
    assert.deepEqual(await upgraded.select().from(schema.requirementDocumentRevisions).orderBy(schema.requirementDocumentRevisions.id), seeded.revisions);
    assert.deepEqual(await upgraded.select().from(schema.requirementDocumentReviews), [seeded.review]);
    const pgCode = error => error.cause?.code ?? error.code;
    for (const change of [{ name: 'Renamed' }, { parent_id: seeded.child.id }, { status: 'archived' }, { system_role: 'unknown' }, { system_role: 'standards' }]) {
      await assert.rejects(upgraded.update(schema.projectDocumentFolders).set(change).where(eq(schema.projectDocumentFolders.id, root.id)), error => pgCode(error) === '23514');
    }
    await assert.rejects(upgraded.insert(schema.projectDocumentFolders).values({ project_id: seeded.project.id, name: '需求文档', system_role: 'requirements', created_at: 't0', updated_at: 't0' }), error => pgCode(error) === '23505');
  } finally { await closeDb(upgraded); }
  const reopened = await freshDb();
  try {
    const roots = await reopened.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.system_role, 'requirements'));
    assert.equal(roots.length, 2);
    assert.equal(roots.find(folder => folder.project_id === seeded.project.id).code, folderCode);
    assert.deepEqual(await reopened.select().from(schema.requirementDocumentRevisions).orderBy(schema.requirementDocumentRevisions.id), seeded.revisions);
    assert.equal((await reopened.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
  } finally { await closeDb(reopened); }
});

test('0029 升级到 0030：固定规范目录只迁移明确绑定，保留同名旧目录及所有正文和历史', async () => {
  const previous = await freshDbThrough(29);
  let seeded;
  try {
    const { project, user, team } = await seedIdentityBase(previous);
    // Today's folder schema includes system_role; seed the deployed schema with SQL.
    const { rows: [legacyFolder] } = await previous.$client.query(`INSERT INTO project_document_folders
      (project_id, name, created_by, created_at, updated_at) VALUES ($1, '项目规范', $2, 'f0', 'f0') RETURNING *`, [project.id, user.id]);
    const { rows: [child] } = await previous.$client.query(`INSERT INTO project_document_folders
      (project_id, parent_id, name, created_by, created_at, updated_at) VALUES ($1, $2, 'Existing child', $3, 'f0', 'f0') RETURNING *`, [project.id, legacyFolder.id, user.id]);
    const insertDoc = async (projectId, title, folderId = null, status = 'active') => (await previous.insert(schema.projectDocuments).values({
      project_id: projectId, folder_id: folderId, title, summary: `${title} summary`, content: `# ${title}\n\nCurrent exact body`,
      revision: 2, status, created_by: user.id, updated_by: user.id, created_at: 'd0', updated_at: 'd1',
    }).returning())[0];
    const bound = await insertDoc(project.id, 'Explicit legacy standards', BigInt(legacyFolder.id));
    const unrelated = await insertDoc(project.id, 'Same-name folder is not mandatory', BigInt(legacyFolder.id));
    const descendant = await insertDoc(project.id, 'Existing child is not mandatory', BigInt(child.id));
    for (const document of [bound, unrelated, descendant]) {
      await previous.insert(schema.projectDocumentRevisions).values([1, 2].map(revision => ({ document_id: document.id, revision,
        title: document.title, summary: document.summary, content: revision === 1 ? 'Original historical body' : document.content,
        change_summary: `Version ${revision}`, created_by: user.id, created_at: `r${revision}` })));
    }
    const newProject = async (name) => seedLegacyProject(previous, team.id, name);
    const foreign = await newProject('Cross-project legacy link');
    const archivedProject = await newProject('Archived document link');
    const empty = await newProject('Empty project without members');
    const archived = await insertDoc(archivedProject.id, 'Archived standards', null, 'archived');
    await previous.update(schema.projects).set({ overview_document_id: bound.id, guide_document_id: unrelated.id, standards_document_id: bound.id }).where(eq(schema.projects.id, project.id));
    await previous.update(schema.projects).set({ standards_document_id: bound.id }).where(eq(schema.projects.id, foreign.id));
    await previous.update(schema.projects).set({ standards_document_id: archived.id }).where(eq(schema.projects.id, archivedProject.id));
    await previous.insert(schema.auditEvents).values({ entity_type: 'project_document', entity_id: bound.id, principal_id: user.id,
      base_snapshot: 1, action: 'project_document.revised', payload: JSON.stringify({ document_code: bound.code, revision: 2 }), timestamp: 'r2' });
    const history = await previous.select().from(schema.projectDocumentRevisions);
    const audits = await previous.select().from(schema.auditEvents);
    seeded = { project, foreign, archivedProject, empty, user, bound, unrelated, descendant, archived, legacyFolder, child, history, audits };
    await assert.rejects(previous.$client.query('SELECT system_role FROM project_document_folders'), error => error.code === '42703');
  } finally { await closeDb(previous); }
  const upgraded = await freshDb();
  let rootCode;
  try {
    const folders = await upgraded.select().from(schema.projectDocumentFolders);
    const roots = folders.filter(folder => folder.system_role === 'standards');
    assert.equal(roots.length, 4);
    for (const project of [seeded.project, seeded.foreign, seeded.archivedProject, seeded.empty]) {
      const root = roots.find(folder => folder.project_id === project.id);
      assertPublicCode(root.code);
      assert.equal(root.name, '项目规范');
      assert.equal(root.parent_id, null);
      assert.equal(root.status, 'active');
      assert.equal(root.created_by, null);
    }
    const root = roots.find(folder => folder.project_id === seeded.project.id);
    rootCode = root.code;
    const original = folders.find(folder => folder.code === seeded.legacyFolder.code);
    assert.equal(original.id, BigInt(seeded.legacyFolder.id));
    assert.equal(original.name, `项目规范（原目录 ${seeded.legacyFolder.code}）`);
    assert.equal(original.system_role, null);
    assert.equal(original.created_at, seeded.legacyFolder.created_at);
    const child = folders.find(folder => folder.code === seeded.child.code);
    assert.equal(child.parent_id, original.id);
    const documents = await upgraded.select().from(schema.projectDocuments);
    for (const old of [seeded.bound, seeded.unrelated, seeded.descendant, seeded.archived]) {
      const current = documents.find(document => document.id === old.id);
      const { folder_id: ignoredCurrentFolder, ...currentBody } = current;
      const { folder_id: ignoredOldFolder, ...oldBody } = old;
      assert.deepEqual(currentBody, oldBody);
    }
    assert.equal(documents.find(document => document.id === seeded.bound.id).folder_id, root.id);
    assert.equal(documents.find(document => document.id === seeded.unrelated.id).folder_id, original.id);
    assert.equal(documents.find(document => document.id === seeded.descendant.id).folder_id, child.id);
    assert.equal(documents.find(document => document.id === seeded.archived.id).folder_id, roots.find(folder => folder.project_id === seeded.archivedProject.id).id);
    assert.deepEqual(await upgraded.select().from(schema.projectDocumentRevisions), seeded.history);
    assert.deepEqual(await upgraded.select().from(schema.auditEvents), seeded.audits);
    const projects = await upgraded.select().from(schema.projects);
    assert.ok(projects.every(project => project.standards_document_id === null));
    assert.equal(projects.find(project => project.id === seeded.project.id).overview_document_id, seeded.bound.id);
    assert.equal(projects.find(project => project.id === seeded.project.id).guide_document_id, seeded.unrelated.id);
    await assert.rejects(upgraded.insert(schema.projectDocumentFolders).values({ project_id: seeded.project.id, name: '项目规范', system_role: 'standards',
      created_at: 't0', updated_at: 't0' }), error => (error.cause?.code ?? error.code) === '23505');
    for (const change of [{ name: 'Renamed' }, { parent_id: original.id }, { status: 'archived' }]) {
      await assert.rejects(upgraded.update(schema.projectDocumentFolders).set(change).where(eq(schema.projectDocumentFolders.id, root.id)),
        error => (error.cause?.code ?? error.code) === '23514');
    }
    await assert.rejects(upgraded.insert(schema.projectDocumentFolders).values({ project_id: seeded.project.id, name: 'Ordinary missing creator',
      created_at: 't0', updated_at: 't0' }), error => (error.cause?.code ?? error.code) === '23514');
    const trigger = await upgraded.$client.query(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'project_document_folders' AND t.tgname = 'acp_context_material_fence'`);
    assert.equal(trigger.rows.length, 1);
  } finally { await closeDb(upgraded); }
  const reopened = await freshDb();
  try {
    const roots = await reopened.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.system_role, 'standards'));
    assert.equal(roots.length, 4);
    assert.equal(roots.find(folder => folder.project_id === seeded.project.id).code, rootCode);
    assert.deepEqual(await reopened.select().from(schema.projectDocumentRevisions), seeded.history);
    assert.equal((await reopened.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
  } finally { await closeDb(reopened); }
});

test('0034 升级到 0035：测试固定目录保留同名普通子树、正文和版本，并持久保存新测试快照', async () => {
  const previous = await freshDbThrough(34);
  let seeded;
  const tableNames = ['test_cases', 'test_case_revisions', 'test_assets', 'test_asset_revisions', 'test_executions', 'test_execution_results'];
  try {
    const { project, user, team } = await seedIdentityBase(previous);
    const emptyProject = await seedLegacyProject(previous, team.id, 'Archived empty project');
    await previous.update(schema.projects).set({ owner_principal_id: user.id, created_by: user.id, member_policy: 'team_read' }).where(eq(schema.projects.id, project.id));
    await previous.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, emptyProject.id));
    const [ordinary] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, name: '测试资料', sort_order: 7,
      created_by: user.id, created_at: 'f0', updated_at: 'f1' }).returning();
    const [child] = await previous.insert(schema.projectDocumentFolders).values({ project_id: project.id, parent_id: ordinary.id,
      name: '测试资料', sort_order: 2, created_by: user.id, created_at: 'c0', updated_at: 'c1' }).returning();
    const documents = [];
    for (const [folder, title] of [[ordinary, '旧测试说明'], [child, '旧测试数据说明']]) {
      const [document] = await previous.insert(schema.projectDocuments).values({ project_id: project.id, folder_id: folder.id,
        kind: 'doc', title, summary: `${title}摘要`, content: `# ${title}\n\n当前正文：不可丢失`, revision: 2,
        created_by: user.id, updated_by: user.id, created_at: 'd0', updated_at: 'd1' }).returning();
      documents.push(document);
      await previous.insert(schema.projectDocumentRevisions).values([1, 2].map(revision => ({ document_id: document.id, revision,
        title, summary: `${title}摘要`, content: revision === 1 ? `# ${title}\n\n历史正文` : document.content,
        change_summary: `Revision ${revision}`, created_by: user.id, created_at: `r${revision}` })));
    }
    await previous.insert(schema.auditEvents).values({ entity_type: 'project_document', entity_id: documents[0].id,
      principal_id: user.id, base_snapshot: 1, action: 'project_document.revised', payload: '{"revision":2}', timestamp: 'r2' });
    for (const name of tableNames) assert.equal((await previous.$client.query('SELECT to_regclass($1) AS relation', [`public.${name}`])).rows[0].relation, null);
    seeded = { project, user, emptyProject, ordinary, child, documents,
      revisions: await previous.select().from(schema.projectDocumentRevisions).orderBy(schema.projectDocumentRevisions.id),
      projects: await previous.select().from(schema.projects).orderBy(schema.projects.id),
      audits: await previous.select().from(schema.auditEvents).orderBy(schema.auditEvents.id) };
  } finally { await closeDb(previous); }

  const upgraded = await freshDb();
  let roots;
  let snapshots;
  try {
    for (const name of tableNames) assert.equal((await upgraded.$client.query('SELECT to_regclass($1) AS relation', [`public.${name}`])).rows[0].relation, name);
    assert.deepEqual(await upgraded.select().from(schema.projects).orderBy(schema.projects.id), seeded.projects, 'Testing migration must not alter project ownership, policy or status');
    const folders = await upgraded.select().from(schema.projectDocumentFolders);
    roots = folders.filter(folder => folder.system_role === 'testing').sort((a, b) => Number(a.project_id - b.project_id));
    assert.equal(roots.length, 2, 'Every existing project receives a fixed testing root, including empty archived projects');
    for (const root of roots) {
      assertPublicCode(root.code);
      assert.equal(root.name, '测试资料'); assert.equal(root.status, 'active'); assert.equal(root.parent_id, null); assert.equal(root.created_by, null);
    }
    assert.deepEqual(folders.find(folder => folder.id === seeded.ordinary.id), { ...seeded.ordinary, name: `测试资料（原目录 ${seeded.ordinary.code}）` });
    assert.deepEqual(folders.find(folder => folder.id === seeded.child.id), seeded.child, 'Nested same-name folders retain their own names and ancestry');
    assert.deepEqual(await upgraded.select().from(schema.projectDocuments).orderBy(schema.projectDocuments.id), seeded.documents);
    assert.deepEqual(await upgraded.select().from(schema.projectDocumentRevisions).orderBy(schema.projectDocumentRevisions.id), seeded.revisions);
    assert.deepEqual(await upgraded.select().from(schema.auditEvents).orderBy(schema.auditEvents.id), seeded.audits);
    const root = roots.find(folder => folder.project_id === seeded.project.id);
    const pgCode = error => error.cause?.code ?? error.code;
    await assert.rejects(upgraded.insert(schema.projectDocumentFolders).values({ project_id: seeded.project.id,
      name: '测试资料', system_role: 'testing', created_at: 't0', updated_at: 't0' }), error => pgCode(error) === '23505');
    for (const change of [{ name: 'Renamed' }, { parent_id: seeded.child.id }, { status: 'archived' }]) {
      await assert.rejects(upgraded.update(schema.projectDocumentFolders).set(change).where(eq(schema.projectDocumentFolders.id, root.id)), error => pgCode(error) === '23514');
    }

    const documentValues = { project_id: seeded.project.id, title: '登录冒烟', summary: '登录场景', current_revision: 1,
      owner_principal_id: seeded.user.id, created_at: 't0', updated_at: 't0' };
    const [testCase] = await upgraded.insert(schema.testCases).values(documentValues).returning();
    const caseContent = JSON.stringify({ title: testCase.title, steps: [{ action: '输入错误密码', expected: '显示提示' }] });
    const caseRevisionValues = { document_id: testCase.id, revision: 1, content_json: caseContent, change_summary: '初始用例', created_by: seeded.user.id, created_at: 't0' };
    const [caseRevision] = await upgraded.insert(schema.testCaseRevisions).values(caseRevisionValues).returning();
    const [asset] = await upgraded.insert(schema.testAssets).values({ ...documentValues, title: '冒烟说明' }).returning();
    const [assetRevision] = await upgraded.insert(schema.testAssetRevisions).values({ ...caseRevisionValues, document_id: asset.id,
      content_json: JSON.stringify({ title: asset.title, storage_kind: 'markdown', content: '# 冒烟步骤' }) }).returning();
    const [execution] = await upgraded.insert(schema.testExecutions).values({ project_id: seeded.project.id, title: '登录冒烟 build 1',
      environment: 'staging', tested_version: 'build-1', commit_sha: 'a'.repeat(40), source: 'agent', notes_markdown: '首次执行',
      assets_json: JSON.stringify([{ asset_code: asset.code, revision: 1, snapshot: JSON.parse(assetRevision.content_json) }]),
      executor_principal_id: seeded.user.id, created_at: 'e0' }).returning();
    const resultValues = { execution_id: execution.id, case_code: testCase.code, case_revision: 1, result: 'fail',
      actual_result: '返回 500', notes: '重复两次', report_urls_json: '["https://example.invalid/report"]', snapshot_json: caseContent };
    const [result] = await upgraded.insert(schema.testExecutionResults).values(resultValues).returning();
    for (const row of [testCase, caseRevision, asset, assetRevision, execution, result]) assertPublicCode(row.code);
    await assert.rejects(upgraded.insert(schema.testCaseRevisions).values(caseRevisionValues), error => pgCode(error) === '23505');
    await assert.rejects(upgraded.insert(schema.testAssetRevisions).values({ ...caseRevisionValues, document_id: asset.id }), error => pgCode(error) === '23505');
    await assert.rejects(upgraded.insert(schema.testCases).values({ ...documentValues, current_revision: 0 }), error => pgCode(error) === '23514');
    await assert.rejects(upgraded.insert(schema.testExecutionResults).values(resultValues), error => pgCode(error) === '23505');
    await assert.rejects(upgraded.insert(schema.testExecutionResults).values({ ...resultValues, case_code: 'other-case', result: 'unknown' }), error => pgCode(error) === '23514');
    const [nextCaseRevision] = await upgraded.insert(schema.testCaseRevisions).values({ ...caseRevisionValues, revision: 2,
      content_json: JSON.stringify({ title: '新登录用例', steps: [{ action: '新的操作', expected: '新的预期' }] }), change_summary: '新增步骤' }).returning();
    await upgraded.update(schema.testCases).set({ current_revision: 2, title: '新登录用例', updated_at: 't1' }).where(eq(schema.testCases.id, testCase.id));
    assert.deepEqual(await upgraded.select().from(schema.testExecutionResults), [result], 'New definitions must not rewrite a saved execution snapshot');
    snapshots = { cases: await upgraded.select().from(schema.testCases), caseRevisions: [caseRevision, nextCaseRevision],
      assets: [asset], assetRevisions: [assetRevision], executions: [execution], results: [result] };
  } finally { await closeDb(upgraded); }

  const reopened = await freshDb();
  try {
    const reopenedRoots = await reopened.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.system_role, 'testing')).orderBy(schema.projectDocumentFolders.project_id);
    assert.deepEqual(reopenedRoots, roots, 'Reopening must not recreate system roots or change public codes');
    assert.deepEqual(await reopened.select().from(schema.projectDocuments).orderBy(schema.projectDocuments.id), seeded.documents);
    assert.deepEqual(await reopened.select().from(schema.projectDocumentRevisions).orderBy(schema.projectDocumentRevisions.id), seeded.revisions);
    assert.deepEqual(await reopened.select().from(schema.testCases), snapshots.cases);
    assert.deepEqual(await reopened.select().from(schema.testCaseRevisions).orderBy(schema.testCaseRevisions.revision), snapshots.caseRevisions);
    assert.deepEqual(await reopened.select().from(schema.testAssets), snapshots.assets);
    assert.deepEqual(await reopened.select().from(schema.testAssetRevisions), snapshots.assetRevisions);
    assert.deepEqual(await reopened.select().from(schema.testExecutions), snapshots.executions);
    assert.deepEqual(await reopened.select().from(schema.testExecutionResults), snapshots.results);
    assert.equal((await reopened.$client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n, migrationJournal.entries.length);
  } finally { await closeDb(reopened); }
});

test('0012 升级到 0013：保留原项目并支持 HTML 原型 Revision 与需求关联', async () => {
  await applyMigrationsThrough(12);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, name, created_at) VALUES ('11111111111111111111', 'Design Team', 't0');
      INSERT INTO users (code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('22222222222222222222', 'designer', 'Designer', 'active', false, false, 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('33333333333333333333', 1, 'Existing Project', 0, 't0');
      INSERT INTO features (code, project_id, title, status)
      VALUES ('44444444444444444444', 1, 'Design Feature', 'active');
      INSERT INTO requirements (code, feature_id, title, current_revision, state, owner_principal_id)
      VALUES ('55555555555555555555', 1, 'Prototype Requirement', 1, 'confirmed', 1);
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0013_design_html_prototypes.sql'));
    await pool.query(`
      INSERT INTO design_prototypes (
        code, project_id, title, summary, status, current_revision, owner_principal_id, created_at, updated_at
      ) VALUES ('66666666666666666666', 1, 'HTML Prototype', 'Existing requirement', 'ready', 1, 1, 't1', 't1');
      INSERT INTO design_prototype_revisions (
        code, prototype_id, revision, html_content, change_summary, created_by, created_at
      ) VALUES ('77777777777777777777', 1, 1, '<html><body>prototype</body></html>', 'initial', 1, 't1');
      INSERT INTO design_prototype_requirements (prototype_id, requirement_id) VALUES (1, 1);
    `);
    const joined = await pool.query(`
      SELECT p.name AS project_name, d.title, r.revision, q.title AS requirement_title
      FROM design_prototypes d
      JOIN projects p ON p.id = d.project_id
      JOIN design_prototype_revisions r ON r.prototype_id = d.id AND r.revision = d.current_revision
      JOIN design_prototype_requirements link ON link.prototype_id = d.id
      JOIN requirements q ON q.id = link.requirement_id
    `);
    assert.deepEqual(joined.rows, [{
      project_name: 'Existing Project',
      title: 'HTML Prototype',
      revision: 1,
      requirement_title: 'Prototype Requirement',
    }]);
  } finally {
    await pool.end();
  }
});

test('0013 升级到 0014：原型 Revision 增加同版本配套设计说明且旧数据安全回填', async () => {
  await applyMigrationsThrough(13);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO design_prototypes (
        code, project_id, title, summary, status, current_revision, owner_principal_id, created_at, updated_at
      ) VALUES ('11111111111111111111', 1, 'Visual Prototype', '', 'draft', 1, 1, 't0', 't0');
      INSERT INTO design_prototype_revisions (
        code, prototype_id, revision, html_content, change_summary, created_by, created_at
      ) VALUES ('22222222222222222222', 1, 1, '<html><body>visual</body></html>', 'initial', 1, 't0');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0014_design_prototype_notes.sql'));
    const backfilled = await pool.query('SELECT notes_markdown FROM design_prototype_revisions WHERE id = 1');
    assert.equal(backfilled.rows[0].notes_markdown, '');
    await pool.query("UPDATE design_prototype_revisions SET notes_markdown = '# 业务逻辑' WHERE id = 1");
    const updated = await pool.query('SELECT notes_markdown FROM design_prototype_revisions WHERE id = 1');
    assert.equal(updated.rows[0].notes_markdown, '# 业务逻辑');
  } finally {
    await pool.end();
  }
});

test('0014 升级到 0015：旧项目保留名称并获得可空简介字段', async () => {
  await applyMigrationsThrough(14);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, name, created_at) VALUES ('11111111111111111111', 'Project Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('22222222222222222222', 1, 'Existing Project', 0, 't0');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0015_project_description.sql'));
    const migrated = await pool.query("SELECT name, description FROM projects WHERE code = '22222222222222222222'");
    assert.deepEqual(migrated.rows, [{ name: 'Existing Project', description: null }]);
    await pool.query("UPDATE projects SET description = '项目简介' WHERE code = '22222222222222222222'");
    const updated = await pool.query("SELECT description FROM projects WHERE code = '22222222222222222222'");
    assert.equal(updated.rows[0].description, '项目简介');
  } finally {
    await pool.end();
  }
});

test('0015 升级到 0016：按用户回填团队和项目的个人排序', async () => {
  await applyMigrationsThrough(15);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO users (code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('11111111111111111111', 'sorter', 'Sorter', 'active', false, false, 't0');
      INSERT INTO teams (code, name, created_at) VALUES
        ('22222222222222222222', 'Later Team', 't2'),
        ('33333333333333333333', 'Earlier Team', 't1');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at) VALUES
        ('44444444444444444444', 1, 'Later Project', 0, 't2'),
        ('55555555555555555555', 2, 'Earlier Project', 0, 't1');
      INSERT INTO team_members (team_id, principal_id, role, display_name, created_at) VALUES
        (1, 1, 'owner', 'Sorter', 't2'),
        (2, 1, 'owner', 'Sorter', 't1');
      INSERT INTO members (principal_id, project_id, role, display_name, created_at) VALUES
        (1, 1, 'owner', 'Sorter', 't2'),
        (1, 2, 'owner', 'Sorter', 't1');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0016_personal_workspace_order.sql'));
    const teamOrder = await pool.query('SELECT team_id, sort_order FROM team_members ORDER BY sort_order');
    const projectOrder = await pool.query('SELECT project_id, sort_order FROM members ORDER BY sort_order');
    assert.deepEqual(teamOrder.rows, [{ team_id: '2', sort_order: 0 }, { team_id: '1', sort_order: 1 }]);
    assert.deepEqual(projectOrder.rows, [{ project_id: '2', sort_order: 0 }, { project_id: '1', sort_order: 1 }]);
  } finally {
    await pool.end();
  }
});

test('0016 升级到 0017：新增项目工作空间与多代码仓库且不保存本机路径', async () => {
  await applyMigrationsThrough(16);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO users (code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('11111111111111111111', 'workspace.owner', 'Workspace Owner', 'active', false, false, 't0');
      INSERT INTO teams (code, name, created_at) VALUES ('22222222222222222222', 'Workspace Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('33333333333333333333', 1, 'Workspace Project', 0, 't0');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0017_project_workspaces_repositories.sql'));
    await pool.query(`
      INSERT INTO project_repositories (code, project_id, name, remote_url, status, created_by, created_at, updated_at)
      VALUES
        ('44444444444444444444', 1, 'Web', 'git@example.com:team/web.git', 'active', 1, 't1', 't1'),
        ('55555555555555555555', 1, 'API', 'git@example.com:team/api.git', 'active', 1, 't1', 't1');
      INSERT INTO project_workspaces (code, project_id, principal_id, name, status, last_seen_at, created_at)
      VALUES ('66666666666666666666', 1, 1, 'Product Workspace', 'active', 't1', 't1');
    `);
    const repositories = await pool.query('SELECT name, remote_url FROM project_repositories ORDER BY name');
    assert.deepEqual(repositories.rows, [
      { name: 'API', remote_url: 'git@example.com:team/api.git' },
      { name: 'Web', remote_url: 'git@example.com:team/web.git' },
    ]);
    const workspaceColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'project_workspaces'
      ORDER BY column_name
    `);
    assert.equal(workspaceColumns.rows.some((row) => row.column_name === 'path'), false);
  } finally {
    await pool.end();
  }
});

test('0017 升级到 0018：存量项目保留并默认处于启用状态', async () => {
  await applyMigrationsThrough(17);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, name, created_at) VALUES ('11111111111111111111', 'Archive Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('22222222222222222222', 1, 'Existing Project', 0, 't0');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0018_project_archive_status.sql'));
    const projects = await pool.query('SELECT name, status FROM projects');
    assert.deepEqual(projects.rows, [{ name: 'Existing Project', status: 'active' }]);
    await pool.query(`UPDATE projects SET status = 'archived' WHERE code = '22222222222222222222'`);
    await assert.rejects(
      pool.query(`UPDATE projects SET status = 'deleted' WHERE code = '22222222222222222222'`),
      /ck_projects_status/,
    );
  } finally {
    await pool.end();
  }
});

test('0018 升级到 0019：单份项目文档无损升级为多文件夹交接文档库', async () => {
  await applyMigrationsThrough(18);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO users (code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('11111111111111111111', 'handoff.owner', 'Handoff Owner', 'active', false, false, 't0');
      INSERT INTO teams (code, name, created_at)
      VALUES ('22222222222222222222', 'Handoff Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('33333333333333333333', 1, 'Handoff Project', 0, 't0');
      INSERT INTO project_documents (code, project_id, title, content, revision, updated_by, updated_at)
      VALUES ('44444444444444444444', 1, '原项目文档', '# 原项目文档', 3, 1, 't3');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0019_handoff_document_library.sql'));

    const migrated = await pool.query(`
      SELECT d.title, d.kind, d.status, d.created_by, d.created_at,
             r.revision, r.content, r.change_summary
      FROM project_documents d
      JOIN project_document_revisions r ON r.document_id = d.id
      WHERE d.code = '44444444444444444444'
    `);
    assert.deepEqual(migrated.rows, [{
      title: '原项目文档',
      kind: 'general',
      status: 'active',
      created_by: '1',
      created_at: 't3',
      revision: 3,
      content: '# 原项目文档',
      change_summary: '迁移现有项目交接文档',
    }]);

    await pool.query(`
      INSERT INTO project_document_folders (project_id, name, created_by, created_at, updated_at)
      VALUES (1, '前后端对接', 1, 't4', 't4');
      INSERT INTO project_documents (
        project_id, folder_id, kind, title, summary, content, revision, status,
        created_by, created_at, updated_by, updated_at
      ) VALUES (
        1, 1, 'api', 'Core API 接口约定', '前后端接口', '# API', 1, 'active',
        1, 't4', 1, 't4'
      );
    `);
    const documents = await pool.query('SELECT kind, title FROM project_documents ORDER BY id');
    assert.deepEqual(documents.rows, [
      { kind: 'general', title: '原项目文档' },
      { kind: 'api', title: 'Core API 接口约定' },
    ]);
  } finally {
    await pool.end();
  }
});

test('0019 升级到 0020：新增需求发现、议题决策和文档版本评审，存量任务获得可空来源版本', async () => {
  await applyMigrationsThrough(19);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO users (code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('11111111111111111111', 'discovery.owner', 'Discovery Owner', 'active', false, false, 't0');
      INSERT INTO teams (code, name, created_at) VALUES ('22222222222222222222', 'Discovery Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('33333333333333333333', 1, 'Discovery Project', 0, 't0');
      INSERT INTO features (code, project_id, title, status) VALUES ('44444444444444444444', 1, 'Discovery', 'active');
      INSERT INTO tasks (code, feature_id, title, profile, source, status, acceptance, base_snapshot, created_at)
      VALUES ('55555555555555555555', 1, 'Existing task', 'builder', 'requirement', 'draft', '[{"id":"AC-1","text":"ok"}]', 0, 't0');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0020_requirement_discovery_and_reviews.sql'));
    const task = (await pool.query(`SELECT source_requirement_revision_id, source_document_revision_id FROM tasks`)).rows[0];
    assert.deepEqual(task, { source_requirement_revision_id: null, source_document_revision_id: null });
    const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'requirement_%'`);
    for (const expected of ['requirement_ideas', 'requirement_topics', 'requirement_topic_entries', 'requirement_document_reviews', 'requirement_document_review_votes']) {
      assert.equal(tables.rows.some((row) => row.tablename === expected), true, `${expected} should exist`);
    }
  } finally {
    await pool.end();
  }
});

test('0020 升级到 0021：议题记录支持受约束的图片附件', async () => {
  await applyMigrationsThrough(20);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await executeSqlFile(pool, path.join(migrationsFolder, '0021_requirement_topic_entry_images.sql'));
    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'requirement_topic_entry_images'
      ORDER BY ordinal_position
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'id', 'code', 'entry_id', 'file_name', 'mime_type', 'byte_size', 'data_url', 'sort_order', 'created_at',
    ]);
    const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'requirement_topic_entry_images'`);
    assert.equal(indexes.rows.some((row) => row.indexname === 'idx_requirement_topic_entry_images_entry'), true);
  } finally {
    await pool.end();
  }
});

test('0021 升级到 0022：议题记录支持保留审计事实的软撤回', async () => {
  await applyMigrationsThrough(21);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await executeSqlFile(pool, path.join(migrationsFolder, '0022_requirement_topic_entry_withdrawal.sql'));
    const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'requirement_topic_entries'
    `);
    const names = columns.rows.map((row) => row.column_name);
    for (const expected of ['withdrawn_at', 'withdrawn_by', 'withdrawal_reason']) assert.ok(names.includes(expected), `${expected} should exist`);
    const constraints = await pool.query(`SELECT conname FROM pg_constraint WHERE conname = 'ck_requirement_topic_entries_withdrawn'`);
    assert.equal(constraints.rowCount, 1);
  } finally {
    await pool.end();
  }
});

test('0022 升级到 0023：存量 Feature 获得稳定排序并建立项目排序索引', async () => {
  await applyMigrationsThrough(22);
  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, name, created_at) VALUES ('11111111111111111111', 'Sort Team', 't0');
      INSERT INTO projects (code, team_id, name, current_snapshot, created_at)
      VALUES ('22222222222222222222', 1, 'Sort Project', 0, 't0');
      INSERT INTO features (code, project_id, title, status) VALUES
        ('33333333333333333333', 1, 'B Feature', 'active'),
        ('44444444444444444444', 1, 'A Feature', 'active');
    `);
    await executeSqlFile(pool, path.join(migrationsFolder, '0023_feature_sort_order.sql'));
    const rows = await pool.query('SELECT title, sort_order FROM features ORDER BY sort_order');
    assert.deepEqual(rows.rows, [
      { title: 'A Feature', sort_order: 0 },
      { title: 'B Feature', sort_order: 1 },
    ]);
    const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'features'`);
    assert.equal(indexes.rows.some((row) => row.indexname === 'idx_features_project_sort'), true);
  } finally {
    await pool.end();
  }
});

test('0009 升级到 0010：从文档 module_key 回填 project_modules、requirement_documents.module_id、requirements.module_id', async () => {
  await applyMigrationsThrough(9);

  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, legacy_code, name, created_at) VALUES ('11111111111111111111', 'TEAM-STRUCT', 'Struct Team', 't0');
      INSERT INTO users (code, legacy_code, account, display_name, status, is_system_admin, must_change_password, created_at)
      VALUES ('22222222222222222222', 'USER-OWNER', 'owner', 'owner', 'active', false, false, 't0');
      INSERT INTO projects (code, legacy_code, team_id, name, current_snapshot, created_at)
      VALUES ('33333333333333333333', 'PROJECT-STRUCT', 1, 'Struct Project', 0, 't0');
      INSERT INTO members (principal_id, project_id, role, display_name, created_at)
      VALUES (1, 1, 'owner', 'owner', 't0');
      INSERT INTO features (code, legacy_code, project_id, title, goal, status)
      VALUES ('44444444444444444444', 'FEATURE-STRUCT', 1, 'Structured Feature', NULL, 'active');
      INSERT INTO requirement_documents (
        code, legacy_code, project_id, module_key, title, current_revision, state, owner_principal_id, created_at, updated_at
      ) VALUES
        ('55555555555555555555', 'DOC-AUTH', 1, 'auth', 'Auth Doc', 1, 'active', 1, 't0', 't1'),
        ('66666666666666666666', 'DOC-BILLING', 1, 'billing', 'Billing Doc', 1, 'archived', 1, 't0', 't2');
      INSERT INTO requirement_document_revisions (
        code, document_id, revision, summary, content, keywords, change_summary, created_by, created_at
      ) VALUES
        ('77777777777777777777', 1, 1, 'auth summary', 'auth content', '[]', 'init', 1, 't0'),
        ('88888888888888888888', 2, 1, 'billing summary', 'billing content', '[]', 'init', 1, 't0');
      INSERT INTO requirements (
        code, legacy_code, feature_id, document_id, title, current_revision, state, owner_principal_id
      ) VALUES (
        '99999999999999999999', 'REQ-AUTH', 1, 1, 'Auth Requirement', 1, 'draft', 1
      );
      INSERT INTO requirement_revisions (
        code, requirement_id, revision, summary, acceptance_criteria, open_questions, created_at
      ) VALUES (
        'AAAAAAAAAAAAAAAAAAAA', 1, 1, 'Need auth', '[{\"id\":\"AC-1\",\"text\":\"auth\"}]', '[]', 't0'
      );
    `);

    await executeSqlFile(pool, path.join(migrationsFolder, '0010_project_structure_modules_phases_milestones.sql'));
  } finally {
    await pool.end();
  }

  await withDb(async (db) => {
    const modules = await db.select().from(schema.projectModules).orderBy(schema.projectModules.sort_order);
    assert.equal(modules.length, 2);
    assert.deepEqual(modules.map((row) => ({ name: row.name, status: row.status })), [
      { name: 'AUTH', status: 'active' },
      { name: 'BILLING', status: 'archived' },
    ]);

    const docs = await db.select().from(schema.requirementDocuments).orderBy(schema.requirementDocuments.code);
    assert.equal(docs.every((row) => row.module_id !== null), true);

    const requirement = (await db.select().from(schema.requirements).where(eq(schema.requirements.legacy_code, 'REQ-AUTH')))[0];
    assert.equal(requirement.module_id, docs.find((row) => row.legacy_code === 'DOC-AUTH')?.module_id ?? null);

    const feature = (await db.select({
      module_id: schema.features.module_id,
      milestone_id: schema.features.milestone_id,
    }).from(schema.features).where(eq(schema.features.legacy_code, 'FEATURE-STRUCT')))[0];
    assert.equal(feature.module_id, null);
    assert.equal(feature.milestone_id, null);
  }, { migrate: false });
});

test('0010 升级到 0011：里程碑开始日期为空且原记录保留', async () => {
  await applyMigrationsThrough(10);

  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, legacy_code, name, created_at)
      VALUES ('11111111111111111111', 'TEAM-SCHEDULE', 'Schedule Team', 't0');
      INSERT INTO projects (code, legacy_code, team_id, name, current_snapshot, created_at)
      VALUES ('22222222222222222222', 'PROJECT-SCHEDULE', 1, 'Schedule Project', 0, 't0');
      INSERT INTO project_phases (code, project_id, name, sort_order, status, created_at, updated_at)
      VALUES ('33333333333333333333', 1, 'MVP', 0, 'planned', 't0', 't0');
      INSERT INTO project_milestones (code, project_id, phase_id, name, target_date, sort_order, status, created_at, updated_at)
      VALUES ('44444444444444444444', 1, 1, 'First delivery', '2026-08-31', 0, 'planned', 't0', 't0');
    `);

    await executeSqlFile(pool, path.join(migrationsFolder, '0011_milestone_schedule_start.sql'));
    const result = await pool.query('SELECT code, start_date, target_date FROM project_milestones');
    assert.deepEqual(result.rows, [{ code: '44444444444444444444', start_date: null, target_date: '2026-08-31' }]);
  } finally {
    await pool.end();
  }
});

test('0011 升级到 0012：Feature 排期字段为空且原记录保留', async () => {
  await applyMigrationsThrough(11);

  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO teams (code, legacy_code, name, created_at)
      VALUES ('11111111111111111111', 'TEAM-FEATURE-DATE', 'Feature Date Team', 't0');
      INSERT INTO projects (code, legacy_code, team_id, name, current_snapshot, created_at)
      VALUES ('22222222222222222222', 'PROJECT-FEATURE-DATE', 1, 'Feature Date Project', 0, 't0');
      INSERT INTO features (code, legacy_code, project_id, title, status)
      VALUES ('33333333333333333333', 'FEATURE-DATE', 1, 'Scheduled later', 'active');
    `);

    await executeSqlFile(pool, path.join(migrationsFolder, '0012_feature_schedule_window.sql'));
    const result = await pool.query('SELECT code, start_date, end_date FROM features');
    assert.deepEqual(result.rows, [{ code: '33333333333333333333', start_date: null, end_date: null }]);
  } finally {
    await pool.end();
  }
});

test('0008 存量升级到 0009：保留 legacy 映射、生成公开 code，并回填 bigint 关联', async () => {
  await applyMigrationsThrough(8);

  const pool = new Pool({ connectionString: testDatabaseUrl });
  try {
    await pool.query(`
      INSERT INTO users (
        user_id, display_name, status, bind_token_hash, bind_token_expires_at, created_at,
        password_hash, account, is_system_admin, must_change_password, password_expires_at
      ) VALUES (
        'user-chen', 'chen', 'active', NULL, NULL, 't0',
        'hash', 'chen', true, false, NULL
      );
      INSERT INTO team_members (team_id, principal_id, role, display_name, created_at)
      VALUES ('TEAM-LEGACY', 'user-chen', 'owner', 'chen', 't0');
      INSERT INTO projects (id, team_id, name, current_snapshot, created_at)
      VALUES ('PROJECT-A', 'TEAM-LEGACY', 'Team Synergy', 28, 't0');
      INSERT INTO members (principal_id, project_id, role, display_name, created_at)
      VALUES ('user-chen', 'PROJECT-A', 'owner', 'chen', 't0');
      INSERT INTO project_documents (project_id, title, content, revision, updated_by, updated_at)
      VALUES ('PROJECT-A', 'Overview', '# Overview', 2, 'user-chen', 't1');
      INSERT INTO requirement_documents (
        document_id, project_id, module_key, title, current_revision, state, owner_principal_id, created_at, updated_at
      ) VALUES (
        'DOC-1', 'PROJECT-A', 'auth', '认证需求', 1, 'active', 'user-chen', 't0', 't1'
      );
      INSERT INTO requirement_document_revisions (
        document_id, revision, summary, content, keywords, change_summary, created_by, created_at
      ) VALUES (
        'DOC-1', 1, 'summary', 'content', '[]', 'init', 'user-chen', 't0'
      );
      INSERT INTO features (feature_id, project_id, title, goal, status)
      VALUES ('FEATURE-1', 'PROJECT-A', '登录', '邮箱密码登录', 'active');
      INSERT INTO requirements (
        requirement_id, feature_id, document_id, title, current_revision, state, owner_principal_id
      ) VALUES (
        'REQ-1', 'FEATURE-1', 'DOC-1', '邮箱登录', 1, 'confirmed', 'user-chen'
      );
      INSERT INTO requirement_revisions (
        requirement_id, revision, summary, acceptance_criteria, open_questions, created_at
      ) VALUES (
        'REQ-1', 1, 'summary', '["AC-1"]', '[]', 't0'
      );
      INSERT INTO defects (
        defect_id, feature_id, title, severity, reported_by, found_in, description, status, related_requirement
      ) VALUES (
        'DEFECT-1', 'FEATURE-1', '登录失败', 'high', 'user-chen', 'staging', 'broken', 'reported', 'REQ-1'
      );
      INSERT INTO tasks (
        task_id, feature_id, title, profile, source, status, requirement_id, defect_id,
        assignee_principal_id, acceptance, validation_seams, scope, base_snapshot, created_at
      ) VALUES (
        'TASK-411', 'FEATURE-1', '收敛认证失败响应', 'builder', 'requirement', 'submitted', 'REQ-1', NULL,
        'user-chen', '[{"id":"AC-1"}]', '["api"]', 'auth', 28, 't0'
      );
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('TASK-411', 'TASK-411');
      INSERT INTO workspaces (workspace_id, run_id, path, git_base, created_at)
      VALUES ('WS-1', 'RUN-1', '/ws1', 'main', 't0');
      INSERT INTO runs (
        run_id, task_id, principal_id, profile, workspace_id, status, base_snapshot, started_at, finished_at
      ) VALUES (
        'RUN-1', 'TASK-411', 'user-chen', 'builder', 'WS-1', 'completed', 28, 't0', 't1'
      );
      INSERT INTO agent_sessions (
        session_id, run_id, agent_command, launch_kind, prompt_path, resumed_from_session_id,
        process_id, status, started_at, finished_at, exit_code, last_error, last_output
      ) VALUES (
        'SESSION-1', 'RUN-1', 'codex', 'default', NULL, NULL, 100, 'completed', 't0', 't1', 0, NULL, 'ok'
      );
      INSERT INTO artifacts (
        artifact_id, task_id, run_id, kind, uri, content_hash, published, published_at,
        project_id, title, summary
      ) VALUES (
        'ART-1', 'TASK-411', 'RUN-1', 'report', 'file:///report', 'hash', true, 't1',
        'PROJECT-A', 'report', 'summary'
      );
      INSERT INTO evidences (
        evidence_id, task_id, run_id, type, acceptance_refs, result, command, summary, report_uri, recorded_at
      ) VALUES (
        'EVD-1', 'TASK-411', 'RUN-1', 'self_test', '["AC-1"]', 'pass', 'npm test', 'ok', 'file:///evidence', 't1'
      );
      INSERT INTO audit_events (
        event_id, timestamp, principal_id, run_id, action, entity_id, base_snapshot, from_state, to_state, payload
      ) VALUES (
        'AUDIT-1', 't1', 'user-chen', 'RUN-1', 'task.submitted', 'TASK-411', 28, 'ready', 'submitted', '{"ok":true}'
      ), (
        'AUDIT-2', 't2', 'user-chen', NULL, 'legacy.external', 'EXT-404', 28, NULL, NULL, '{"legacy":true}'
      );
      INSERT INTO context_graph_snapshots (graph_id, graph_snapshot, project_id, created_at)
      VALUES ('G1', 28, 'PROJECT-A', 't0');
      INSERT INTO context_nodes (
        node_id, graph_id, graph_snapshot, kind, verification, freshness, payload
      ) VALUES
        ('A', 'G1', 28, 'service', 'confirmed', 'current', NULL),
        ('B', 'G1', 28, 'service', 'confirmed', 'current', NULL);
      INSERT INTO context_edges (
        edge_id, graph_id, graph_snapshot, from_node, to_node, relation, verification, freshness
      ) VALUES (
        'EDGE-1', 'G1', 28, 'A', 'B', 'calls', 'confirmed', 'current'
      );
    `);

    await executeSqlFile(pool, path.join(migrationsFolder, '0009_numeric_ids_public_codes.sql'));
  } finally {
    await pool.end();
  }

  const verifyPool = new Pool({ connectionString: testDatabaseUrl });
  try {
    const tasks = await verifyPool.query(`SELECT id, code FROM tasks WHERE legacy_code = 'TASK-411'`);
    assert.equal(tasks.rows.length, 1);
    assertPublicCode(tasks.rows[0].code);

    const runs = await verifyPool.query(`SELECT id, workspace_id FROM runs WHERE legacy_code = 'RUN-1'`);
    const workspaces = await verifyPool.query(`SELECT id, run_id FROM workspaces WHERE legacy_code = 'WS-1'`);
    assert.equal(runs.rows[0].workspace_id, workspaces.rows[0].id);
    assert.equal(workspaces.rows[0].run_id, runs.rows[0].id);

    const audit1 = await verifyPool.query(`SELECT entity_type, entity_id, legacy_entity_code FROM audit_events WHERE legacy_code = 'AUDIT-1'`);
    assert.equal(audit1.rows[0].entity_type, 'task');
    assert.equal(audit1.rows[0].entity_id, tasks.rows[0].id);
    assert.equal(audit1.rows[0].legacy_entity_code, 'TASK-411');

    const audit2 = await verifyPool.query(`SELECT entity_type, entity_id, legacy_entity_code FROM audit_events WHERE legacy_code = 'AUDIT-2'`);
    assert.equal(audit2.rows[0].entity_type, 'legacy_reference');
    assert.equal(audit2.rows[0].entity_id, null);
    assert.equal(audit2.rows[0].legacy_entity_code, 'EXT-404');

    const graphs = await verifyPool.query(`SELECT id, code FROM context_graphs WHERE legacy_code = 'G1'`);
    assert.equal(graphs.rows.length, 1);
    assertPublicCode(graphs.rows[0].code);

    const snapshots = await verifyPool.query(`SELECT id FROM context_graph_snapshots WHERE graph_id = $1`, [graphs.rows[0].id]);
    assert.equal(snapshots.rows.length, 1);
    const nodes = await verifyPool.query(`SELECT node_key FROM context_nodes WHERE snapshot_id = $1`, [snapshots.rows[0].id]);
    assert.deepEqual(
      nodes.rows.map((node) => node.node_key).sort(),
      ['A', 'B'],
    );
    const edges = await verifyPool.query(`SELECT id FROM context_edges WHERE snapshot_id = $1`, [snapshots.rows[0].id]);
    assert.equal(edges.rows.length, 1);

    const counts = (await verifyPool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM projects) AS projects,
        (SELECT COUNT(*)::int FROM features) AS features,
        (SELECT COUNT(*)::int FROM requirements) AS requirements,
        (SELECT COUNT(*)::int FROM tasks) AS tasks,
        (SELECT COUNT(*)::int FROM runs) AS runs,
        (SELECT COUNT(*)::int FROM audit_events) AS audits
    `)).rows[0];
    assert.deepEqual(counts, {
      users: 1,
      projects: 1,
      features: 1,
      requirements: 1,
      tasks: 1,
      runs: 1,
      audits: 2,
    });

    await assert.rejects(
      verifyPool.query("UPDATE tasks SET code = '00000000000000000000' WHERE legacy_code = 'TASK-411'"),
      /immutable/i,
    );
  } finally {
    await verifyPool.end();
  }
});

test('孤儿 task 由用例层校验拒绝（库层软引用允许插入）', async () => {
  await withDb(async (db) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        feature_id: 999n,
        title: 'x',
        profile: 'builder',
        acceptance: '[]',
        base_snapshot: 0,
        created_at: 't',
      })
      .returning({ id: schema.tasks.id });

    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
    assert.equal(rows[0]?.title, 'x');
  });
});

test('members 复合主键：同用户可加入多个项目，但同项目不得重复', async () => {
  await withDb(async (db) => {
    const { team, user } = await seedIdentityBase(db);
    const [project1] = await db
      .insert(schema.projects)
      .values({ team_id: team.id, name: 'P1', created_at: 't' })
      .returning({ id: schema.projects.id });
    const [project2] = await db
      .insert(schema.projects)
      .values({ team_id: team.id, name: 'P2', created_at: 't' })
      .returning({ id: schema.projects.id });

    await db.insert(schema.members).values({
      principal_id: user.id,
      project_id: project1.id,
      role: 'owner',
      display_name: 'chen',
      created_at: 't',
    });
    await db.insert(schema.members).values({
      principal_id: user.id,
      project_id: project2.id,
      role: 'member',
      display_name: 'chen',
      created_at: 't',
    });

    await assert.rejects(
      db.insert(schema.members).values({
        principal_id: user.id,
        project_id: project1.id,
        role: 'owner',
        display_name: 'chen',
        created_at: 't',
      }),
    );

    const rows = await db.select().from(schema.members).where(eq(schema.members.principal_id, user.id));
    assert.equal(rows.length, 3);
  });
});

test('端点索引：context_edges 的 from_node_id 索引被查询计划使用', async () => {
  await withDb(async (db) => {
    const { snapshot } = await seedGraph(db);
    const nodes = new Map();
    for (let index = 0; index < 200; index += 1) {
      const node = await insertNode(db, snapshot.id, `N-${index}`);
      nodes.set(node.node_key, node.id);
    }
    const a = await insertNode(db, snapshot.id, 'A');
    const b = await insertNode(db, snapshot.id, 'B');

    for (let index = 0; index < 200; index += 1) {
      await insertEdge(
        db,
        snapshot.id,
        nodes.get(`N-${index}`),
        index === 199 ? a.id : nodes.get(`N-${index + 1}`),
        `bulk-${index}`,
      );
    }
    await insertEdge(db, snapshot.id, a.id, b.id, 'focus-edge');

    await db.execute(sql`SET enable_seqscan = off`);
    const plan = await db.execute(
      sql`EXPLAIN SELECT * FROM context_edges WHERE from_node_id = ${a.id} AND snapshot_id = ${snapshot.id}`,
    );
    const detail = plan.rows.map((row) => row['QUERY PLAN']).join(' ');
    assert.match(detail, /idx_edges_from/);
  });
});

test('Recursive CTE：A→B→C→D，从 A 出发 outgoing depth 1 只到 B', async () => {
  await withDb(async (db) => {
    const { graph, snapshot } = await seedGraph(db);
    const a = await insertNode(db, snapshot.id, 'A');
    const b = await insertNode(db, snapshot.id, 'B');
    const c = await insertNode(db, snapshot.id, 'C');
    const d = await insertNode(db, snapshot.id, 'D');
    await insertEdge(db, snapshot.id, a.id, b.id, 'e-a-b');
    await insertEdge(db, snapshot.id, b.id, c.id, 'e-b-c');
    await insertEdge(db, snapshot.id, c.id, d.id, 'e-c-d');

    const depth1 = await traverseSubgraph(db, {
      graphId: graph.code,
      graphSnapshot: 28,
      focusNodes: ['A'],
      depth: 1,
      direction: 'outgoing',
      visibleNodeIds: ['A', 'B', 'C', 'D'],
    });
    assert.deepEqual(
      depth1.map((row) => row.node_id).sort(),
      ['A', 'B'],
    );

    const depthAll = await traverseSubgraph(db, {
      graphId: graph.code,
      graphSnapshot: 28,
      focusNodes: ['A'],
      depth: 3,
      direction: 'outgoing',
      visibleNodeIds: ['A', 'B', 'C', 'D'],
    });
    assert.deepEqual(
      depthAll.map((row) => row.node_id).sort(),
      ['A', 'B', 'C', 'D'],
    );
  });
});

test('Recursive CTE：双向遍历从 C 出发 depth 2 覆盖 B/D', async () => {
  await withDb(async (db) => {
    const { graph, snapshot } = await seedGraph(db);
    const a = await insertNode(db, snapshot.id, 'A');
    const b = await insertNode(db, snapshot.id, 'B');
    const c = await insertNode(db, snapshot.id, 'C');
    const d = await insertNode(db, snapshot.id, 'D');
    const e = await insertNode(db, snapshot.id, 'E');
    await insertEdge(db, snapshot.id, a.id, b.id, 'e-a-b');
    await insertEdge(db, snapshot.id, b.id, c.id, 'e-b-c');
    await insertEdge(db, snapshot.id, c.id, d.id, 'e-c-d');
    await insertEdge(db, snapshot.id, d.id, e.id, 'e-d-e');

    const result = await traverseSubgraph(db, {
      graphId: graph.code,
      graphSnapshot: 28,
      focusNodes: ['C'],
      depth: 2,
      direction: 'both',
      visibleNodeIds: ['A', 'B', 'C', 'D', 'E'],
    });
    const byId = new Map(result.map((row) => [row.node_id, row.depth]));
    assert.deepEqual([...byId.keys()].sort(), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(byId.get('C'), 0);
    assert.equal(byId.get('B'), 1);
    assert.equal(byId.get('D'), 1);
    assert.equal(byId.get('A'), 2);
    assert.equal(byId.get('E'), 2);
  });
});

test('快照隔离：同图不同 snapshot 不串数据', async () => {
  await withDb(async (db) => {
    const { graph } = await seedGraph(db, 'G1', 28);
    const [snapshot29] = await db
      .insert(schema.contextGraphSnapshots)
      .values({ graph_id: graph.id, graph_snapshot: 29, created_at: 't' })
      .returning({ id: schema.contextGraphSnapshots.id });

    const [snapshot28] = await db
      .select()
      .from(schema.contextGraphSnapshots)
      .where(eq(schema.contextGraphSnapshots.graph_snapshot, 28));

    const a28 = await insertNode(db, snapshot28.id, 'A');
    await insertNode(db, snapshot29.id, 'A');
    const x29 = await insertNode(db, snapshot29.id, 'X');
    const a29 = await db
      .select()
      .from(schema.contextNodes)
      .where(eq(schema.contextNodes.snapshot_id, snapshot29.id));
    const nodeA29 = a29.find((row) => row.node_key === 'A');
    await insertEdge(db, snapshot29.id, nodeA29.id, x29.id, 'e1');

    const result28 = await traverseSubgraph(db, {
      graphId: graph.code,
      graphSnapshot: 28,
      focusNodes: ['A'],
      depth: 2,
      direction: 'both',
      visibleNodeIds: ['A'],
    });
    assert.deepEqual(
      result28.map((row) => row.node_id),
      ['A'],
    );

    assert.equal(typeof a28.id, 'bigint');
  });
});

test('图隔离：同 snapshot 不同 graph 不串数据', async () => {
  await withDb(async (db) => {
    const { graph: g1, snapshot: s1 } = await seedGraph(db, 'G1', 28);
    const { graph: g2, snapshot: s2 } = await seedGraph(db, 'G2', 28);
    const a1 = await insertNode(db, s1.id, 'A');
    const b1 = await insertNode(db, s1.id, 'B');
    const a2 = await insertNode(db, s2.id, 'A');
    const secret2 = await insertNode(db, s2.id, 'SECRET');
    await insertEdge(db, s1.id, a1.id, b1.id, 'e1');
    await insertEdge(db, s2.id, a2.id, secret2.id, 'e2');

    const result = await traverseSubgraph(db, {
      graphId: g1.code,
      graphSnapshot: 28,
      focusNodes: ['A'],
      depth: 2,
      direction: 'outgoing',
      visibleNodeIds: ['A', 'B', 'SECRET'],
    });
    assert.deepEqual(
      result.map((row) => row.node_id).sort(),
      ['A', 'B'],
    );
  });
});

test('权限前置：隐藏节点不泄露也不成为路径', async () => {
  await withDb(async (db) => {
    const { graph, snapshot } = await seedGraph(db);
    const a = await insertNode(db, snapshot.id, 'A');
    const b = await insertNode(db, snapshot.id, 'B');
    const c = await insertNode(db, snapshot.id, 'C');
    const d = await insertNode(db, snapshot.id, 'D');
    await insertEdge(db, snapshot.id, a.id, b.id, 'e-a-b');
    await insertEdge(db, snapshot.id, b.id, c.id, 'e-b-c');
    await insertEdge(db, snapshot.id, c.id, d.id, 'e-c-d');

    const result = await traverseSubgraph(db, {
      graphId: graph.code,
      graphSnapshot: 28,
      focusNodes: ['A'],
      depth: 3,
      direction: 'outgoing',
      visibleNodeIds: ['A', 'C', 'D'],
    });
    assert.deepEqual(
      result.map((row) => row.node_id).sort(),
      ['A'],
    );

    await assert.rejects(
      traverseSubgraph(db, {
        graphId: graph.code,
        graphSnapshot: 28,
        focusNodes: ['A'],
        depth: 1,
        direction: 'outgoing',
        visibleNodeIds: [],
      }),
      (error) => error.code === 'visible_set_required',
    );
  });
});

test('context 图采用软引用：孤儿节点与边可插入，遍历仅按 snapshot_id 过滤', async () => {
  await withDb(async (db) => {
    await db.insert(schema.contextNodes).values({
      snapshot_id: 999n,
      node_key: 'ORPHAN',
      kind: 'service',
      verification: 'confirmed',
      freshness: 'current',
    });
    await db.insert(schema.contextEdges).values({
      legacy_key: 'ORPHAN-EDGE',
      snapshot_id: 999n,
      from_node_id: 111n,
      to_node_id: 222n,
      relation: 'calls',
      verification: 'confirmed',
      freshness: 'current',
    });

    const nodes = await db.select().from(schema.contextNodes).where(eq(schema.contextNodes.snapshot_id, 999n));
    const edges = await db.select().from(schema.contextEdges).where(eq(schema.contextEdges.snapshot_id, 999n));
    assert.equal(nodes.length, 1);
    assert.equal(edges.length, 1);
  });
});

test('部分唯一索引：同一 Task 的第二个 active Run 被数据库拒绝', async () => {
  await withDb(async (db) => {
    const { user, task } = await seedTaskBase(db);
    const [workspace1] = await db
      .insert(schema.workspaces)
      .values({
        legacy_code: 'W1',
        run_id: 1n,
        path: '/ws1',
        git_base: 'b',
        created_at: 't',
      })
      .returning({ id: schema.workspaces.id });
    const [run1] = await db
      .insert(schema.runs)
      .values({
        legacy_code: 'R1',
        task_id: task.id,
        principal_id: user.id,
        profile: 'builder',
        workspace_id: workspace1.id,
        status: 'active',
        base_snapshot: 28,
        started_at: 't',
      })
      .returning({ id: schema.runs.id });
    await db.update(schema.workspaces).set({ run_id: run1.id }).where(eq(schema.workspaces.id, workspace1.id));

    const [workspace2] = await db
      .insert(schema.workspaces)
      .values({
        legacy_code: 'W2',
        run_id: 2n,
        path: '/ws2',
        git_base: 'b',
        created_at: 't',
      })
      .returning({ id: schema.workspaces.id });

    await assert.rejects(
      db.insert(schema.runs).values({
        legacy_code: 'R2',
        task_id: task.id,
        principal_id: user.id,
        profile: 'builder',
        workspace_id: workspace2.id,
        status: 'active',
        base_snapshot: 28,
        started_at: 't',
      }),
    );
  });
});
