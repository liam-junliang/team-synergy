import { and, asc, eq, gt, lte, max, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import { redactAuditValue } from './audit-redaction.js';

export interface AuditExportFilter { since: string; cursor?: string; snapshot?: string; limit?: number }
function id(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new DomainError('validation_failed', '审计分页游标无效');
  return BigInt(value);
}
export async function exportAuditPage(db: Db, principalCode: string, filter: AuditExportFilter) {
  const limit = filter.limit ?? 100;
  const date = new Date(filter.since);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(filter.since) || !Number.isFinite(date.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new DomainError('validation_failed', '审计时间或分页数量无效');
  const day = new Date(filter.since.slice(0,10) + 'T00:00:00Z');
  if (filter.since.startsWith('0000') || !Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== filter.since.slice(0,10)) throw new DomainError('validation_failed', '审计日期无效');
  const cursor = id(filter.cursor) ?? 0n, requestedSnapshot = id(filter.snapshot);
  return db.transaction(async tx => {
    const [actor] = await tx.select().from(schema.users).where(eq(schema.users.code, principalCode)).for('share');
    if (!actor || !actor.is_system_admin || actor.status !== 'active' || actor.deleted_at || actor.pending_deletion) throw new DomainError('admin_forbidden', '仅有效系统管理员可以导出全局审计');
    const since = filter.since.length === 10 ? filter.since + 'T00:00:00Z' : filter.since;
    const snapshot = requestedSnapshot ?? (await tx.select({ head: max(schema.auditEvents.id) }).from(schema.auditEvents))[0]?.head ?? 0n;
    const rows = await tx.select().from(schema.auditEvents).where(and(sql`${schema.auditEvents.timestamp}::timestamptz >= ${since}::timestamptz`,gt(schema.auditEvents.id, cursor),lte(schema.auditEvents.id, snapshot)))
      .orderBy(asc(schema.auditEvents.id)).limit(limit + 1);
    const items = rows.slice(0,limit).map(row => {
      let payload: unknown = null;
      try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = '[REDACTED: invalid historical payload]'; }
      return redactAuditValue({ ...row, id: String(row.id), principal_id: String(row.principal_id), run_id: row.run_id === null ? null : String(row.run_id), entity_id: row.entity_id === null ? null : String(row.entity_id), payload }) as Record<string, unknown>;
    });
    return { items, snapshot: String(snapshot), next_cursor: rows.length > limit ? String(rows[limit - 1]?.id) : null };
  });
}
