import { count, eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';

/** Operational aggregates expose no principals, titles, instructions or project identifiers. */
export async function readOperationalMetrics(db: Db, principalCode: string) {
  const [actor] = await db.select().from(schema.users).where(eq(schema.users.code, principalCode)).limit(1);
  if (!actor || actor.status !== 'active' || actor.deleted_at || actor.pending_deletion || !actor.is_system_admin) {
    return { ok: false as const, error: { code: 'admin_forbidden', message: '只有有效系统管理员可以查看运行指标' } };
  }
  const [tasks, jobs] = await Promise.all([
    db.select({ status: schema.tasks.status, count: count() }).from(schema.tasks).groupBy(schema.tasks.status),
    db.select({ status: schema.systemAgentJobs.status, count: count() }).from(schema.systemAgentJobs).groupBy(schema.systemAgentJobs.status),
  ]);
  return { ok: true as const, data: { tasks, jobs } };
}
