import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { PersonalMemoryListView, PersonalMemoryView } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { lockAggregate } from './aggregate-lock.js';
import { codeCondition, createPublicCode } from './public-code.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Identity = { principalCode: string };
type Target = Identity & { source: string };
type Change = Target & { expectedRevision: number; reason?: string };
const { memoryFragments: fragments, memoryCaptureReceipts: receipts, memoryProjectionJobs: jobs } = schema;
function fail(code: string, message: string): never { throw new DomainError(code, message); }
const iso = (value: Date) => value.toISOString();

async function owner(tx: Tx, cmd: Identity) {
  if (typeof cmd.principalCode !== 'string' || !cmd.principalCode.trim()) fail('memory_forbidden', '缺少账号身份');
  const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(and(
    codeCondition(schema.users, cmd.principalCode), eq(schema.users.status, 'active'),
    eq(schema.users.pending_deletion, false), isNull(schema.users.deleted_at))).limit(1).for('share');
  if (!user) fail('memory_forbidden', '无权管理个人记忆');
  return user.id;
}

async function rootFor(tx: Tx, principalId: bigint, source: string) {
  if (typeof source !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{20}$/u.test(source)) fail('memory_invalid', '来源编码无效');
  const [fragment] = await tx.select({ id: fragments.id, rootId: fragments.root_id }).from(fragments)
    .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).where(and(eq(fragments.code, source),
      isNull(fragments.root_id), eq(fragments.state, 'preference'), eq(receipts.principal_id, principalId))).limit(1);
  if (!fragment) fail('memory_not_found', '找不到个人记忆');
  return fragment.rootId ?? fragment.id;
}

async function view(tx: Tx, rootId: bigint): Promise<PersonalMemoryView> {
  const rows = await tx.select({ fragment: fragments, receipt: receipts, projectCode: schema.projects.code, projectName: schema.projects.name, job: jobs }).from(fragments)
    .innerJoin(receipts, eq(receipts.id, fragments.receipt_id))
    .innerJoin(schema.projects, eq(schema.projects.id, receipts.project_id))
    .leftJoin(jobs, eq(jobs.fragment_id, fragments.id))
    .where(or(eq(fragments.id, rootId), eq(fragments.root_id, rootId))).orderBy(asc(fragments.revision));
  const root = rows[0], latest = rows.at(-1);
  if (!root || !latest) fail('memory_not_found', '找不到个人记忆');
  const cleanupPending = rows.some(row => row.job?.operation === 'delete' && row.job.status !== 'synced');
  const pending = rows.map(row => row.job).filter(job => job !== null && job.status !== 'synced');
  const priority = ['needs_reconcile', 'processing', 'pending'] as const;
  const status = priority.find(status => pending.some(job => job?.status === status)) ?? (latest.job?.status ?? 'not_queued');
  const lastError = pending.find(job => job?.last_error)?.last_error;
  return { source: root.fragment.code, revisionSource: latest.fragment.code, revision: latest.fragment.revision,
    text: latest.fragment.text, status: latest.fragment.withdrawn_at === null ? 'active' : 'withdrawn',
    applicability: root.fragment.applicability, projectCode: root.projectCode, projectName: root.projectName,
    createdAt: iso(root.fragment.created_at), updatedAt: iso(latest.fragment.created_at),
    provenance: { receiptCode: root.receipt.code, sessionId: root.receipt.session_key, eventId: root.receipt.event_key },
    projection: { status, operation: latest.job?.operation ?? (latest.fragment.withdrawn_at ? 'delete' : 'upsert'),
      generation: latest.job?.generation ?? 0, cleanupPending, ...(lastError ? { lastError } : {}) },
    history: rows.map(row => ({ source: row.fragment.code, revision: row.fragment.revision, text: row.fragment.text,
      status: row.fragment.withdrawn_at === null ? 'active' : 'withdrawn',
      ...(row.fragment.change_reason ? { reason: row.fragment.change_reason } : {}), createdAt: iso(row.fragment.created_at) })) };
}

/** Owner-managed private records survive project membership changes; retrieval
 * still applies the current project's ACL and the immutable applicability. */
export function createPersonalMemoryUseCases(db: Db) {
  async function list(cmd: Identity & { projectCode?: string; status?: 'active' | 'withdrawn' | 'all' }): Promise<PersonalMemoryListView> {
    if (cmd.status !== undefined && !['active', 'withdrawn', 'all'].includes(cmd.status)) fail('memory_invalid', '个人记忆状态无效');
    return db.transaction(async tx => {
      const principalId = await owner(tx, cmd);
      const roots = await tx.select({ id: sql<bigint>`coalesce(${fragments.root_id}, ${fragments.id})` }).from(fragments)
        .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).innerJoin(schema.projects, eq(schema.projects.id, receipts.project_id))
        .where(and(eq(receipts.principal_id, principalId), eq(fragments.state, 'preference'),
          sql`not exists (select 1 from memory_fragments newer where newer.supersedes_id = ${fragments.id})`,
          cmd.status === 'all' ? undefined : cmd.status === 'withdrawn' ? isNotNull(fragments.withdrawn_at) : isNull(fragments.withdrawn_at),
          cmd.projectCode === undefined ? undefined : eq(schema.projects.code, cmd.projectCode)))
        .orderBy(desc(fragments.id)).limit(101);
      const items: PersonalMemoryView[] = [];
      for (const root of roots) {
        const item = await view(tx, root.id);
        items.push(item);
      }
      return { items: items.slice(0, 100), truncated: items.length > 100 };
    });
  }
  async function read(cmd: Target): Promise<PersonalMemoryView> {
    return db.transaction(async tx => {
      const principalId = await owner(tx, cmd), rootId = await rootFor(tx, principalId, cmd.source);
      await lockAggregate(tx, 'personal_memory', rootId, true);
      return view(tx, rootId);
    });
  }
  async function change(cmd: Change & { text?: string }, withdrawal: boolean): Promise<PersonalMemoryView> {
    const text = typeof cmd.text === 'string' ? cmd.text.trim() : '';
    if (!Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision < 1
      || (cmd.reason !== undefined && (typeof cmd.reason !== 'string' || !cmd.reason.trim() || cmd.reason.length > 1000 || cmd.reason.includes('\0')))
      || (!withdrawal && (typeof cmd.text !== 'string' || !cmd.text.trim() || cmd.text.length > 4000 || cmd.text.includes('\0')))) {
      fail('memory_invalid', '个人记忆内容或版本无效');
    }
    return db.transaction(async tx => {
      const principalId = await owner(tx, cmd), rootId = await rootFor(tx, principalId, cmd.source);
      await lockAggregate(tx, 'personal_memory', rootId);
      const [current] = await tx.select().from(fragments).where(or(eq(fragments.id, rootId), eq(fragments.root_id, rootId)))
        .orderBy(desc(fragments.revision)).limit(1).for('update');
      if (!current || current.revision !== cmd.expectedRevision) fail('memory_revision_conflict', '个人记忆已变化，请重新读取');
      if (withdrawal && current.withdrawn_at !== null) fail('memory_already_withdrawn', '个人记忆已撤回');
      const previous = await tx.select({ id: fragments.id }).from(fragments).where(or(eq(fragments.id, rootId), eq(fragments.root_id, rootId)));
      // Requeue cleanup with a new fence. A worker holding the old upsert lease
      // cannot acknowledge it over this deletion intent.
      await tx.update(jobs).set({ operation: 'delete', generation: sql`${jobs.generation} + 1`, status: 'pending',
        lease_until: null, last_error: null, attempts: 0 }).where(inArray(jobs.fragment_id, previous.map(row => row.id)));
      const [next] = await tx.insert(fragments).values({ code: createPublicCode(), receipt_id: current.receipt_id,
        state: 'preference', applicability: current.applicability, text: withdrawal ? current.text : text,
        root_id: rootId, supersedes_id: current.id, revision: current.revision + 1,
        withdrawn_at: withdrawal ? new Date() : null, withdrawn_by: withdrawal ? principalId : null,
        change_reason: cmd.reason?.trim() ?? null }).returning({ id: fragments.id });
      if (!next) throw new Error('Personal memory revision insert failed');
      await tx.insert(jobs).values({ fragment_id: next.id, engine: 'openviking', operation: withdrawal ? 'delete' : 'upsert' });
      return view(tx, rootId);
    });
  }
  const edit = (cmd: Change & { text: string }) => change(cmd, false);
  const withdraw = (cmd: Change) => change(cmd, true);
  return { list, read, edit, withdraw };
}
