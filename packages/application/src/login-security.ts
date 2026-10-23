import { and, asc, count, countDistinct, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { hashToken, normalizeAccount } from './user-use-cases.js';
import { createPublicCode } from './public-code.js';
import { fail, insertAudit, now } from './task-service.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Writer = Db | Tx;
type SecurityEvent = typeof schema.authSecurityEvents.$inferInsert;
export interface LoginSecurityContext { ip?: string }
export const LOGIN_FAILURE_REASONS = ['invalid_credentials', 'locked', 'rate_limited'] as const;
export function loginSecurityHashes(account: string, context: LoginSecurityContext = {}) {
  return { account_hash: hashToken(`login-account:${normalizeAccount(account)}`), ip_hash: context.ip ? hashToken(`login-ip:${context.ip}`) : null };
}
export async function recordLoginSecurityEvent(db: Writer, input: {
  account: string; context?: LoginSecurityContext; principalId?: bigint; kind: SecurityEvent['kind']; reason: SecurityEvent['reason'];
}) {
  await db.insert(schema.authSecurityEvents).values({ kind: input.kind, reason: input.reason,
    principal_id: input.principalId ?? null, ...loginSecurityHashes(input.account, input.context) });
}
export async function recordRateLimitedLogin(db: Db, account: string, context: LoginSecurityContext) {
  const [subject] = await db.select().from(schema.users).where(eq(schema.users.account, normalizeAccount(account))).limit(1);
  await db.transaction(async tx => {
    if (subject) await auditLoginFailure(tx, subject, 'rate_limited', subject.login_failure_count, Boolean(subject.login_locked_until && subject.login_locked_until.getTime() > Date.now()), context);
    else await recordLoginSecurityEvent(tx, { account, context, kind: 'login_failed', reason: 'rate_limited' });
  });
}
export async function auditLoginFailure(tx: Writer, user: typeof schema.users.$inferSelect,
  reason: typeof LOGIN_FAILURE_REASONS[number], failures: number, locked: boolean, context: LoginSecurityContext = {}) {
  const audit = { entity_type: 'user', entity_id: user.id, principal_id: user.id, base_snapshot: 0,
    action: 'user.login_failed', payload: { failure_count: failures, locked, actor_authenticated: false, reason, ...loginSecurityHashes(user.account, context) } };
  assertAuditedChange(audit);
  await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
  await recordLoginSecurityEvent(tx, { account: user.account, context, principalId: user.id, kind: 'login_failed', reason });
}
export async function auditLoginState(tx: Writer, user: typeof schema.users.$inferSelect,
  kind: 'locked' | 'unlocked', reason: 'failure_limit' | 'expired' | 'password_changed' | 'local_admin_reset', context: LoginSecurityContext = {}) {
  const audit = { entity_type: 'user', entity_id: user.id, principal_id: user.id, base_snapshot: 0,
    action: `user.${kind}`, payload: { reason, actor_authenticated: reason === 'password_changed', ...loginSecurityHashes(user.account, context) } };
  assertAuditedChange(audit);
  await insertAudit(tx, toAuditEvent(audit, createPublicCode(), now()));
  await recordLoginSecurityEvent(tx, { account: user.account, context, principalId: user.id, kind, reason });
}
export async function auditLoginUnlock(tx: Writer, user: typeof schema.users.$inferSelect,
  reason: 'expired' | 'password_changed' | 'local_admin_reset', context: LoginSecurityContext = {}) {
  if (user.login_locked_until !== null) await auditLoginState(tx, user, 'unlocked', reason, context);
}
export async function readLoginFailureTotals(db: Db) {
  return db.select({ reason: schema.authSecurityEvents.reason, count: count() }).from(schema.authSecurityEvents)
    .where(and(eq(schema.authSecurityEvents.kind, 'login_failed'), inArray(schema.authSecurityEvents.reason, [...LOGIN_FAILURE_REASONS])))
    .groupBy(schema.authSecurityEvents.reason);
}
export interface LoginSecurityFilter { groupBy: 'account' | 'ip'; since?: string; until?: string; limit?: number; offset?: number; accountHash?: string; ipHash?: string; invalidParameters?: boolean }
function validSecurityTime(value: string | undefined) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return !value.startsWith('0000') && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
}
export async function aggregateLoginSecurity(db: Db, principalCode: string, filter: LoginSecurityFilter) {
  try {
    return await db.transaction(async tx => {
      // Authorization precedes parsing, so invalid queries never reveal validation details to a non-admin.
      const [actor] = await tx.select().from(schema.users).where(eq(schema.users.code, principalCode)).for('share').limit(1);
      if (!actor?.is_system_admin || actor.status !== 'active' || actor.deleted_at || actor.pending_deletion) throw new DomainError('admin_forbidden', '仅有效系统管理员可以查询登录安全事件');
      const limit = filter.limit ?? 50, offset = filter.offset ?? 0;
      // Match the persistence clock used by occurred_at rather than an API host's possibly skewed clock.
      const databaseNow = filter.until === undefined ? (await tx.execute(sql`select clock_timestamp() as now`)).rows[0]?.now : undefined;
      const until = filter.until === undefined
        ? new Date(databaseNow instanceof Date ? databaseNow.getTime() : String(databaseNow)) : new Date(filter.until);
      const since = filter.since === undefined ? new Date(until.getTime() - 86400000) : new Date(filter.since);
      if (filter.invalidParameters || !['account', 'ip'].includes(filter.groupBy) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000
        || !validSecurityTime(filter.since) || !validSecurityTime(filter.until) || !Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || until <= since || until.getTime() - since.getTime() > 31 * 86400000
        || [filter.accountHash, filter.ipHash].some(hash => hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) {
        throw new DomainError('validation_failed', '安全事件查询范围、哈希或分页参数无效');
      }
      const event = schema.authSecurityEvents;
      const key = filter.groupBy === 'account' ? event.account_hash : event.ip_hash;
      const where = and(gte(event.occurred_at, since), lte(event.occurred_at, until), filter.accountHash ? eq(event.account_hash, filter.accountHash) : undefined, filter.ipHash ? eq(event.ip_hash, filter.ipHash) : undefined);
      const failures = sql<number>`count(*) filter (where ${event.kind} = 'login_failed')`.mapWith(Number);
      const [rows, totals] = await Promise.all([
        tx.select({ key, login_failures: failures,
          locks: sql<number>`count(*) filter (where ${event.kind} = 'locked')`.mapWith(Number),
          unlocks: sql<number>`count(*) filter (where ${event.kind} = 'unlocked')`.mapWith(Number),
        }).from(event).where(where).groupBy(key).orderBy(desc(failures), asc(key)).limit(limit).offset(offset),
        tx.select({ value: countDistinct(sql`coalesce(${key}, 'unknown')`) }).from(event).where(where),
      ]);
      return { ok: true as const, data: { items: rows, total: totals[0]?.value ?? 0, limit, offset, has_more: offset + rows.length < (totals[0]?.value ?? 0), since: since.toISOString(), until: until.toISOString() } };
    });
  } catch (error) { return fail(error instanceof DomainError ? error : new DomainError('internal_error', '安全事件查询失败')); }
}
