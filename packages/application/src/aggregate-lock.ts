import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';

type ScopeDb = Pick<Db, 'execute' | 'select'>;
/** Keep this encoding aligned with acp_lock_context_materials in migration 0046. */
export function lockScope(kind: string, id: bigint | string) {
  return sql`hashtext(${`${kind}:${id}`})::bigint`;
}

export async function lockAggregate(tx: Pick<Db, 'execute'>, kind: string, id: bigint | string, shared = false) {
  await tx.execute(shared
    ? sql`select pg_advisory_xact_lock_shared(${lockScope(kind, id)})`
    : sql`select pg_advisory_xact_lock(${lockScope(kind, id)})`);
}

/** Resolve immutable identity before taking any row locks, then re-read under the fence. */
export async function lockProjectByCode(tx: ScopeDb, code: string, shared = false) {
  const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.code, code)).limit(1);
  if (project) await lockAggregate(tx, 'project', project.id, shared);
}

export async function lockTaskProject(tx: ScopeDb, code: string, shared = true) {
  const [scope] = await tx.select({ id: schema.features.project_id }).from(schema.tasks)
    .innerJoin(schema.features, eq(schema.features.id, schema.tasks.feature_id)).where(eq(schema.tasks.code, code)).limit(1);
  if (scope) await lockAggregate(tx, 'project', scope.id, shared);
}
