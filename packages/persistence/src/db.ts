import { instrumentDatabasePool } from './db-observability.js';
export { observeSlowQueries, withDatabaseRequestContext, type DatabaseRequestContext, type SlowQueryEvent } from './db-observability.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/team_synergy';

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export interface OpenDbOptions {
  /** PostgreSQL 连接串；省略时使用环境变量或本地默认值 */
  databaseUrl?: string;
  /** 迁移 SQL 目录；省略时回退到包内置 drizzle 目录 */
  migrationsFolder?: string;
  /** 是否自动执行迁移 */
  migrate?: boolean;
  /** Server-side statement deadline; defaults to TSP_DB_STATEMENT_TIMEOUT_MS or 30 seconds. Zero disables it. */
  statementTimeoutMs?: number;
}

export function resolveMigrationsFolder(bundledFolder?: string): string {
  if (bundledFolder && existsSync(path.join(bundledFolder, 'meta/_journal.json'))) return bundledFolder;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../drizzle');
}

/**
 * 打开 PostgreSQL 数据库：
 * - 默认读取 TSP_DATABASE_URL，缺省回退到本地开发库
 * - 默认自动执行 drizzle 迁移（幂等，由 __drizzle_migrations 跟踪）
 */
export async function openDb(options: OpenDbOptions = {}): Promise<Db> {
  const statementTimeoutMs = options.statementTimeoutMs ?? Number(process.env.TSP_DB_STATEMENT_TIMEOUT_MS ?? 30_000);
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 0 || statementTimeoutMs > 2_147_483_647) {
    throw new Error('TSP_DB_STATEMENT_TIMEOUT_MS must be an integer from 0 to 2147483647');
  }
  const pool = new Pool({
    connectionString: options.databaseUrl ?? process.env.TSP_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    connectionTimeoutMillis: 3_000,
    // Keep timestamp wire strings stable under database-level zone/DateStyle settings.
    options: '-c timezone=UTC -c DateStyle=ISO,MDY',
    statement_timeout: statementTimeoutMs,
  });
  instrumentDatabasePool(pool);
  // pg emits idle-client disconnects outside query promises. Keep liveness alive;
  // the next query obtains a new connection and readiness reports dependency failure.
  pool.on('error', () => {
    process.stderr.write('Database idle connection lost; readiness checks will retry.\n');
  });
  const db = drizzle(pool, { schema });

  try {
    if (options.migrate !== false) {
      await drizzleMigrate(db, {
        migrationsFolder: resolveMigrationsFolder(options.migrationsFolder),
      });
    }
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/** 关闭数据库连接池（review 建议 1：避免句柄泄漏） */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

export { schema };

/** Fail closed until the exact packaged migration head has been applied. */
export async function databaseReady(db: Db, migrationsFolder?: string): Promise<boolean> {
  await db.$client.query('select 1');
  const folder = resolveMigrationsFolder(migrationsFolder);
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string; when: number }[];
  };
  const head = journal.entries.at(-1);
  if (!head) return false;
  const hash = createHash('sha256').update(readFileSync(path.join(folder, `${head.tag}.sql`), 'utf8')).digest('hex');
  const result = await db.$client.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
  );
  return result.rows[0]?.hash === hash && Number(result.rows[0]?.created_at) === head.when;
}
