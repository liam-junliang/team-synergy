import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { createPublicCode } from './public-code.js';

export const PROJECT_SYSTEM_FOLDER_NAMES = {
  root: '项目资料',
  overview: '项目说明',
  standards: '项目规范',
  requirements: '需求文档',
  architecture: '架构设计',
  testing: '测试资料',
} as const;
export type ProjectSystemFolderRole = keyof typeof PROJECT_SYSTEM_FOLDER_NAMES;

const SYSTEM_FOLDER_ORDER: Record<ProjectSystemFolderRole, number> = {
  root: -10,
  overview: -9,
  standards: -8,
  requirements: -7,
  architecture: -6,
  testing: -5,
};

type FolderWriter = Pick<Db, 'select' | 'insert' | 'update' | 'execute'>;

/** Existing folder initialization uses the shared material fence also installed by migration 0025 triggers. */
export async function lockProjectSystemFolders(tx: FolderWriter) {
  await tx.execute(sql`select pg_advisory_xact_lock(1094930512::bigint)`);
}

/** Governance callers must use this before any fenced writes, rolling back the whole transaction when busy. */
export async function tryLockProjectSystemFolders(tx: FolderWriter): Promise<boolean> {
  const result = await tx.execute(sql`select pg_try_advisory_xact_lock(1094930512::bigint) as acquired`);
  return result.rows[0]?.acquired === true;
}

/** Must run inside the caller's transaction, after project membership is checked. */
export async function ensureProjectSystemFolder(
  tx: FolderWriter,
  projectId: bigint,
  role: ProjectSystemFolderRole,
): Promise<typeof schema.projectDocumentFolders.$inferSelect> {
  await lockProjectSystemFolders(tx);
  const [existing] = await tx.select().from(schema.projectDocumentFolders).where(and(
    eq(schema.projectDocumentFolders.project_id, projectId), eq(schema.projectDocumentFolders.system_role, role),
  )).limit(1);
  if (existing) return existing;
  const parent: typeof schema.projectDocumentFolders.$inferSelect | null = role === 'root'
    ? null
    : await ensureProjectSystemFolder(tx, projectId, 'root');
  const name = PROJECT_SYSTEM_FOLDER_NAMES[role];
  // Keep ordinary same-name root directories distinct, matching the migration.
  await tx.update(schema.projectDocumentFolders).set({ name: sql`${name} || '（原目录 ' || ${schema.projectDocumentFolders.code} || '）'` }).where(and(
    eq(schema.projectDocumentFolders.project_id, projectId), isNull(schema.projectDocumentFolders.parent_id),
    isNull(schema.projectDocumentFolders.system_role), eq(schema.projectDocumentFolders.name, name),
  ));
  const timestamp = new Date().toISOString();
  const [folder] = await tx.insert(schema.projectDocumentFolders).values({
    code: createPublicCode(), project_id: projectId, parent_id: parent?.id ?? null, name,
    system_role: role, sort_order: SYSTEM_FOLDER_ORDER[role], status: 'active', created_by: null,
    created_at: timestamp, updated_at: timestamp,
  }).returning();
  if (!folder) throw new DomainError('internal_error', `${name}目录创建失败`);
  return folder;
}

export async function ensureProjectSystemFolders(tx: FolderWriter, projectId: bigint) {
  const root = await ensureProjectSystemFolder(tx, projectId, 'root');
  const overview = await ensureProjectSystemFolder(tx, projectId, 'overview');
  const standards = await ensureProjectSystemFolder(tx, projectId, 'standards');
  const requirements = await ensureProjectSystemFolder(tx, projectId, 'requirements');
  const architecture = await ensureProjectSystemFolder(tx, projectId, 'architecture');
  const testing = await ensureProjectSystemFolder(tx, projectId, 'testing');
  return { root, overview, standards, requirements, architecture, testing };
}
