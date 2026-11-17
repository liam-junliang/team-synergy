import type { Command } from 'commander';

/** Server-local, read-only mapping inventory. Planning never assigns customers. */
export function registerDbPlanTenants(program: Command): void {
  program.command('db:plan-tenants').description('只读盘点客户映射缺口，输出待决策 JSON').action(async () => {
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
      const data = await persistence.planTenantMapping(db);
      process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: 'tenant_inventory_failed', message: '只读客户映射盘点失败，请检查数据库权限、迁移版本或查询时限' } }) + '\n');
      process.exitCode = 1;
    } finally {
      if (db && close) await close(db).catch(() => { process.exitCode = 1; });
    }
  });
}
