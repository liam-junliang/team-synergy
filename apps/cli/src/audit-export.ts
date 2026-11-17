import type { Command } from 'commander';
import type { createApiClient } from './api-client.js';

export function registerAuditCommands(program: Command, requireApiClient: () => ReturnType<typeof createApiClient>) {
  program.command('audit:export').description('以 NDJSON 导出指定时间之后的审计事件（系统管理员）').requiredOption('--since <iso>', '含起点的 ISO 时间').action(async (options: { since: string }) => {
    try {
      const client = requireApiClient();
      let cursor: string | undefined, snapshot: string | undefined;
      do {
        const query = new URLSearchParams({ since: options.since });
        if (cursor) query.set('cursor', cursor);
        if (snapshot) query.set('snapshot', snapshot);
        const result = await client.exportAudit(query);
        if (!result.ok) throw new Error('export rejected');
        const page = result.data;
        if (!Array.isArray(page.items) || !/^\d+$/.test(page.snapshot) || (snapshot && snapshot !== page.snapshot)
          || (page.next_cursor !== null && (!/^\d+$/.test(page.next_cursor) || BigInt(page.next_cursor) <= BigInt(cursor ?? '0')))) throw new Error('invalid page');
        for (const event of page.items) await new Promise<void>((resolve, reject) => {
          process.stdout.write(JSON.stringify(event) + '\n', error => error ? reject(error) : resolve());
        });
        snapshot = page.snapshot;
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    } catch {
      process.stderr.write(JSON.stringify({ ok: false, error: { code: 'audit_export_failed', message: '审计导出失败，请检查管理员身份、时间与服务连接；已输出的数据可能不完整' } }) + '\n');
      process.exitCode = 1;
    }
  });
}
