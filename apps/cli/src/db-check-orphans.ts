import type { Command } from 'commander';

/** Server-local, SELECT-only diagnostics. No HTTP or automatic migration fallback. */
export function registerDbCheckOrphans(program: Command): void {
  program.command('db:check-orphans').description('只读检查实体孤儿和跨项目关系，输出 JSON').action(async () => {
    if (!process.env.TSP_DATABASE_URL?.trim()) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'database_url_required', message: '必须显式设置服务器本机 TSP_DATABASE_URL' } }) + '\n');
      process.exitCode = 1;
      return;
    }
    let db: Awaited<ReturnType<typeof import('@team-synergy/persistence')['openDb']>> | undefined;
    let close: typeof import('@team-synergy/persistence')['closeDb'] | undefined;
    try {
      const persistence = await import('@team-synergy/persistence');
      close = persistence.closeDb;
      db = await persistence.openDb({ databaseUrl: process.env.TSP_DATABASE_URL, migrate: false });
      const data = await persistence.checkDatabaseIntegrity(db);
      process.stdout.write(JSON.stringify({ ok: data.total_orphans === 0, data }) + '\n');
      if (data.total_orphans > 0) process.exitCode = 1;
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'integrity_check_failed', message: '只读巡检失败，请检查数据库权限、迁移版本或查询时限' } }) + '\n');
      process.exitCode = 1;
    } finally {
      if (db && close) await close(db).catch(() => { process.exitCode = 1; });
    }
  });
}
