import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/acp';

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

export interface OpenDbOptions {
  /** PostgreSQL 连接串；省略时使用环境变量或本地默认值 */
  databaseUrl?: string;
  /** 迁移 SQL 目录；省略时回退到包内置 drizzle 目录 */
  migrationsFolder?: string;
  /** 是否自动执行迁移 */
  migrate?: boolean;
}

function defaultMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../drizzle');
}

/**
 * 打开 PostgreSQL 数据库：
 * - 默认读取 ACP_DATABASE_URL，缺省回退到本地开发库
 * - 默认自动执行 drizzle 迁移（幂等，由 __drizzle_migrations 跟踪）
 */
export async function openDb(options: OpenDbOptions = {}): Promise<Db> {
  const pool = new Pool({
    connectionString: options.databaseUrl ?? process.env.ACP_DATABASE_URL ?? DEFAULT_DATABASE_URL,
  });
  const db = drizzle(pool, { schema });

  try {
    if (options.migrate !== false) {
      await drizzleMigrate(db, {
        migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
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
