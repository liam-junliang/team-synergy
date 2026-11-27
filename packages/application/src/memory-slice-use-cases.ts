import { createHash } from 'node:crypto';
import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { lockAggregate } from './aggregate-lock.js';
import { assertProjectAccess } from './project-access.js';
import { codeCondition, createPublicCode } from './public-code.js';
import { createRequirementCollaborationUseCases } from './requirement-collaboration-use-cases.js';
import { createRequirementUseCases, parseAcceptanceCriteria } from './requirement-use-cases.js';
import type { TaskResult } from './task-service.js';
import { documentMemoryEvidence, readDocumentMemoryPage } from './memory-document-sources.js';
import { projectMaterialMemoryEvidence } from './project-material-memory.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Actor = { principalCode: string; projectCode: string };
type Binding = Actor & { topicCode: string; requirementCode: string };
type Event = Actor & Partial<Pick<Binding, 'topicCode' | 'requirementCode'>> & {
  sessionId: string; eventId: string; sourceText: string; referenceText?: string;
  expectedRevision?: number; expectedHead?: string | null;
};
type Part = { kind: 'discussion' | 'preference' | 'adopt'; text: string; applicability?: 'account' | 'project' };
type Receipt = typeof schema.memoryCaptureReceipts.$inferSelect;
type Fragment = typeof schema.memoryFragments.$inferSelect;
const { memoryCaptureReceipts: receipts, memoryFragments: fragments, requirementTopicEntries: entries } = schema;

function reject(code: string, message: string): never {
  throw new DomainError(code, message);
}

function unwrap<T>(result: TaskResult<T>): T {
  if (result.ok) return result.data;
  throw new DomainError(result.error.code, result.error.message);
}

async function authorize(tx: Tx, cmd: Actor, capability: 'read' | 'write' | 'manage') {
  const projectKey = cmd.projectCode.trim();
  const principalKey = cmd.principalCode.trim();
  if (!projectKey || !principalKey) reject('project_forbidden', '缺少项目或账号');
  const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects)
    .where(codeCondition(schema.projects, projectKey)).limit(1);
  if (!project) reject('project_forbidden', '无权访问项目');
  await lockAggregate(tx, 'project', project.id, capability === 'read');
  const [principal] = await tx.select({ id: schema.users.id, code: schema.users.code }).from(schema.users)
    .where(and(codeCondition(schema.users, principalKey), eq(schema.users.status, 'active'),
      eq(schema.users.pending_deletion, false), isNull(schema.users.deleted_at)))
    .limit(1).for('share');
  if (!principal) reject('project_forbidden', '无权访问项目');
  await assertProjectAccess(tx, project.id, principal.id, capability);
  return { projectId: project.id, principalId: principal.id, principalCode: principal.code };
}

async function resolveBinding(tx: Tx, projectId: bigint, cmd: Binding, writing = false) {
  if (!cmd.topicCode.trim() || !cmd.requirementCode.trim()) reject('memory_scope_mismatch', '缺少目标议题或需求');
  const [topic] = await tx.select().from(schema.requirementTopics).where(and(
    eq(schema.requirementTopics.project_id, projectId), eq(schema.requirementTopics.code, cmd.topicCode),
  )).limit(1);
  if (!topic) reject('memory_scope_mismatch', '议题与当前项目不匹配');
  const { requirements: r, features: f, projectModules: m, requirementDocuments: d } = schema;
  const target = tx.select({ requirement: r, featureProject: f.project_id, moduleProject: m.project_id, documentProject: d.project_id })
    .from(r).leftJoin(f, eq(r.feature_id, f.id)).leftJoin(m, eq(r.module_id, m.id)).leftJoin(d, eq(r.document_id, d.id))
    .where(codeCondition(r, cmd.requirementCode)).limit(1);
  const [bound] = writing ? await target.for('update', { of: r }) : await target;
  if (!bound) reject('memory_scope_mismatch', '需求与当前项目不匹配');
  const { requirement, featureProject, moduleProject, documentProject } = bound;
  const parents = [[requirement.feature_id, featureProject], [requirement.module_id, moduleProject], [requirement.document_id, documentProject]];
  if (!parents.some(([id]) => id !== null) || parents.some(([id, project]) => id !== null && project !== projectId)) {
    reject('memory_scope_mismatch', '需求与当前项目不匹配');
  }
  const [head] = await tx.select().from(entries).where(eq(entries.topic_id, topic.id)).orderBy(desc(entries.id)).limit(1);
  return { topic, requirement, head };
}

function validateEvent(cmd: Event) {
  const binding = [cmd.topicCode, cmd.requirementCode, cmd.expectedRevision, cmd.expectedHead];
  const count = binding.filter(value => value !== undefined).length;
  if (count !== 0 && count !== 4) reject('memory_invalid', '议题、需求和版本必须完整提供或全部省略');
  if (![cmd.sessionId, cmd.eventId].every(key => typeof key === 'string' && key.trim().length > 0 && key.length <= 200 && !key.includes('\0'))
    || (count === 4 && (typeof cmd.expectedRevision !== 'number' || !Number.isSafeInteger(cmd.expectedRevision) || cmd.expectedRevision <= 0
      || typeof cmd.topicCode !== 'string' || !cmd.topicCode.trim() || typeof cmd.requirementCode !== 'string' || !cmd.requirementCode.trim()))
    || typeof cmd.sourceText !== 'string' || !cmd.sourceText.trim() || cmd.sourceText.length > 32_000 || cmd.sourceText.includes('\0')
    || (cmd.referenceText !== undefined && (typeof cmd.referenceText !== 'string' || cmd.referenceText.length > 1000 || cmd.referenceText.includes('\0')))
    || (cmd.expectedHead !== undefined && cmd.expectedHead !== null && (typeof cmd.expectedHead !== 'string' || cmd.expectedHead.length !== 20))) {
    reject('memory_invalid', '事件标识、来源或绑定版本无效');
  }
}

function validateParts(parts: readonly Part[], source: string) {
  if (!parts.length || parts.length > 12) reject('memory_invalid', '需要有来源的记忆片段');
  const seen = new Set<string>();
  for (const part of parts) {
    if (!['discussion', 'preference', 'adopt'].includes(part.kind) || !part.text.trim()
      || part.text.length > 4000 || !source.includes(part.text) || seen.has(part.text)) {
      reject('memory_invalid', '片段必须对应本次会话中的独立原文');
    }
    if (part.kind === 'adopt' && !isSourceSentence(source, part.text)) reject('memory_ambiguous', '请用完整的确认语句说明是否采纳');
    seen.add(part.text);
  }
  if (parts.filter(p => p.kind !== 'preference').length > 1 && parts.some(p => p.kind === 'adopt')) {
    reject('memory_ambiguous', '请单独确认要采纳的现有方案');
  }
  const preferences = parts.filter(p => p.kind === 'preference');
  if (parts.some(p => p.kind !== 'preference' && preferences.some(pref => p.text.includes(pref.text) || pref.text.includes(p.text)))) {
    reject('memory_invalid', '私有与共享来源范围重叠，请分别记录');
  }
}

const qualification = /但是|不过|然而|除外|例外|除非|除了|并非|实际上|其实|相反|视情况|仅限|仅在|只在|仅适用于|这次|本次|不是所有项目|不适用于|不要跨项目|取决于/u;

function isSourceSentence(source: string, text: string) {
  return source.split(/(?<=[。！？!?；;])|\n/u).some(sentence => sentence.trim() === text.trim());
}

function accountDeclaration(text: string): boolean {
  const declaration = /^(?:在所有项目中[，,\s]*我(?:都)?(?:习惯|偏好|喜欢)|(?:无论哪个项目|跨项目)[，,\s]*我都(?:习惯|偏好|喜欢)?)(.+?)[。！.!]?$/u.exec(text.trim());
  if (!declaration?.[1]) return false;
  const body = declaration[1];
  return !qualification.test(body) && !/[不没非无未仅只但却除若当如！？?!，,；;。\n]/u.test(body)
    && !/时候|才|遇到|对于|针对|这个|当前|项目|分支|仓库|条件|场景|个别|部分|特定|前提|错误|取消|撤销|否认|按需|origin\/|https?:\/\/|[A-Z]:\\/iu.test(body);
}

function preferenceApplicability(part: Part, source: string): 'account' | 'project' {
  if (part.kind !== 'preference' || part.applicability === 'project') return 'project';
  // Split evidence can omit a later qualification in the same turn. The model cannot widen its scope.
  return accountDeclaration(part.text) && isSourceSentence(source, part.text) && !qualification.test(source) ? 'account' : 'project';
}

function acceptanceText(proposal: string) {
  return proposal.replace(/^(?:我们建议|我建议|建议|我提议|提议|我觉得可以考虑|可以考虑|我们考虑)[\s，,：:]*(?=\S)/u, '').trim() || proposal;
}

function assertAdoptionReference(part: Part, proposal: string, referenceText?: string) {
  const criterion = acceptanceText(proposal).replace(/[。.!！]+$/u, '').trim();
  const statement = part.text.trim().replace(/[。.!！]+$/u, '').trim();
  const explicit = /^确认采纳[：:]\s*(.+)$/u.exec(statement);
  if (explicit && explicit[1] === criterion) return;
  const bare = /^(?:就按这个方案做|按这个方案做|确认采纳这个方案|确认采用这个方案|采纳这个方案)$/u;
  if (bare.test(statement) && referenceText) {
    const reference = referenceText.trim();
    const question = /^是否采纳《([^《》]+)》[？?]$/u.exec(reference);
    const quotedCriterion = question ? question[1] : acceptanceText(reference);
    if (quotedCriterion?.replace(/[。.!！]+$/u, '').trim() === criterion) return;
  }
  reject('memory_ambiguous', '请明确说明要采纳的验收条件，或在引用该方案原文的问题后确认');
}

function item(fragment: Pick<Fragment, 'state' | 'text' | 'code'>, entryCode: string | null) {
  return { source: entryCode ?? fragment.code, state: fragment.state, text: fragment.text,
    scope: fragment.state === 'preference' ? 'personal' as const : 'project' as const };
}

// Native timeline withdrawal and decision replacement also invalidate an old receipt or engine hit.
function currentEvidence() {
  return and(isNull(fragments.withdrawn_at),
    sql`not exists (select 1 from memory_fragments newer where newer.supersedes_id = ${fragments.id})`,
    or(eq(fragments.state, 'preference'),
    and(eq(fragments.state, 'discussed'), isNull(receipts.topic_id), isNull(fragments.entry_id)),
    and(isNull(entries.withdrawn_at),
    eq(entries.topic_id, receipts.topic_id),
    sql`exists (select 1 from requirement_topics t where t.id = ${entries.topic_id} and t.project_id = ${receipts.project_id})`,
    sql`not exists (select 1 from requirement_topic_entries next where next.supersedes_entry_id = ${entries.id})`)));
}

async function receiptResult(tx: Tx, receipt: Receipt, replayed: boolean) {
  const rows = await tx.select({ fragment: fragments, entryCode: entries.code }).from(fragments)
    .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).leftJoin(entries, eq(entries.id, fragments.entry_id))
    .where(and(eq(fragments.receipt_id, receipt.id), currentEvidence())).orderBy(asc(fragments.id));
  return { receiptCode: receipt.code, replayed, expectedHead: receipt.head_after, expectedRevision: receipt.revision_after,
    items: rows.map(r => item(r.fragment, r.entryCode)) };
}

function sourceHash(cmd: Event) {
  return createHash('sha256').update(JSON.stringify([cmd.topicCode, cmd.requirementCode, cmd.expectedHead,
    cmd.expectedRevision, cmd.sourceText, ...(cmd.referenceText === undefined ? [] : [cmd.referenceText])])).digest('hex');
}

async function prior(tx: Tx, actor: { projectId: bigint; principalId: bigint }, cmd: Event) {
  const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.project_id, actor.projectId),
    eq(receipts.principal_id, actor.principalId), eq(receipts.session_key, cmd.sessionId), eq(receipts.event_key, cmd.eventId))).limit(1);
  if (!receipt) return null;
  if (receipt.source_hash !== sourceHash(cmd)) reject('memory_event_conflict', '同一事件已用于不同来源或绑定');
  return receiptResult(tx, receipt, true);
}

async function proposedCriterion(tx: Tx, binding: Awaited<ReturnType<typeof resolveBinding>>) {
  const { topic, requirement } = binding;
  const [lastDecision] = await tx.select({ id: entries.id }).from(entries)
    .where(and(eq(entries.topic_id, topic.id), eq(entries.entry_type, 'decision'))).orderBy(desc(entries.id)).limit(1);
  const candidates = await tx.select({ id: entries.id, content: entries.content }).from(entries).where(and(eq(entries.topic_id, topic.id),
    eq(entries.entry_type, 'alternative'), isNull(entries.withdrawn_at), lastDecision ? gt(entries.id, lastDecision.id) : undefined)).limit(2);
  const [candidate] = candidates;
  if (!candidate || candidates.length !== 1) reject('memory_ambiguous', '需要明确一条当前有效的备选方案');
  const [proposal] = await tx.select({ fragment: fragments, baseRevision: receipts.base_revision }).from(fragments)
    .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).where(and(eq(fragments.entry_id, candidate.id), eq(fragments.state, 'discussed'),
      eq(receipts.topic_id, topic.id), eq(receipts.requirement_id, requirement.id))).limit(1);
  if (!proposal || proposal.baseRevision !== requirement.current_revision || proposal.fragment.text !== candidate.content) {
    reject('memory_proposal_changed', '备选方案的来源、验收内容或需求版本已变化');
  }
  return proposal.fragment;
}

export function createMemorySliceUseCases(db: Db) {
  async function canCapture(cmd: Actor) {
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      try {
        await assertProjectAccess(tx, actor.projectId, actor.principalId, 'write');
        return true;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'project_forbidden') return false;
        throw error;
      }
    });
  }

  async function inspect(cmd: Actor & Partial<Pick<Binding, 'topicCode' | 'requirementCode'>>) {
    if ((cmd.topicCode === undefined) !== (cmd.requirementCode === undefined)) {
      reject('memory_invalid', '议题和需求必须同时提供或全部省略');
    }
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      if (cmd.topicCode === undefined && cmd.requirementCode === undefined) return {};
      if (typeof cmd.topicCode !== 'string' || typeof cmd.requirementCode !== 'string') reject('memory_invalid', '议题和需求绑定无效');
      const { requirement, topic, head } = await resolveBinding(tx, actor.projectId,
        { ...cmd, topicCode: cmd.topicCode, requirementCode: cmd.requirementCode });
      return { topicCode: topic.code, requirementCode: requirement.code, expectedHead: head?.code ?? null, expectedRevision: requirement.current_revision };
    });
  }

  async function replay(cmd: Event) {
    validateEvent(cmd);
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'write');
      return prior(tx, actor, cmd);
    });
  }

  async function capture(cmd: Event & { parts: readonly Part[] }) {
    validateEvent(cmd);
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'write');
      const replayed = await prior(tx, actor, cmd);
      if (replayed) return replayed;
      if (cmd.topicCode === undefined && cmd.parts.some(part => part.kind === 'adopt')) {
        reject('memory_ambiguous', '请先明确要采纳方案关联的议题与需求');
      }
      if (cmd.parts.some(p => p.kind === 'adopt')) await assertProjectAccess(tx, actor.projectId, actor.principalId, 'manage');
      validateParts(cmd.parts, cmd.sourceText);
      const binding = cmd.topicCode === undefined ? null : await resolveBinding(tx, actor.projectId, cmd as Event & Binding, true);
      const topic = binding?.topic, requirement = binding?.requirement;
      let expectedHead = binding?.head?.code ?? null;
      let expectedRevision = requirement?.current_revision ?? null;
      if (binding && expectedRevision !== cmd.expectedRevision) reject('memory_revision_conflict', '需求修订已变化，请重新读取');
      if (binding && expectedHead !== cmd.expectedHead) reject('memory_head_conflict', '议题时间线已变化，请重新读取');
      if (topic?.status === 'archived') reject('requirement_topic_archived', '议题已归档');
      const [receipt] = await tx.insert(receipts).values({ code: createPublicCode(), project_id: actor.projectId,
        principal_id: actor.principalId, topic_id: topic?.id ?? null, requirement_id: requirement?.id ?? null, source_hash: sourceHash(cmd),
        session_key: cmd.sessionId, event_key: cmd.eventId, base_revision: expectedRevision, revision_after: expectedRevision }).returning();
      if (!receipt) throw new Error('Memory receipt insert failed');
      // These application entry points use the Drizzle query API and nested transactions (savepoints).
      const unit = tx as unknown as Db;
      for (const part of cmd.parts) {
        const adopted = part.kind === 'adopt' && binding ? await proposedCriterion(tx, binding) : null;
        if (adopted) assertAdoptionReference(part, adopted.text, cmd.referenceText);
        const value = adopted ? acceptanceText(adopted.text) : part.text;
        let entryId: bigint | null = null;
        if (part.kind !== 'preference' && topic && requirement) {
          const added = unwrap(await createRequirementCollaborationUseCases(unit).addTopicEntry({
            topicCode: topic.code, principalCode: actor.principalCode, entryType: adopted ? 'decision' : 'alternative',
            content: value, sourceEntityType: 'requirement', sourceEntityCode: requirement.code,
          }));
          if (!added || typeof added !== 'object' || !('entry_code' in added) || typeof added.entry_code !== 'string') {
            throw new Error('Missing topic entry');
          }
          const [entry] = await tx.select({ id: entries.id, code: entries.code }).from(entries).where(eq(entries.code, added.entry_code));
          if (!entry) throw new Error('Missing topic entry');
          entryId = entry.id;
          expectedHead = entry.code;
        }
        if (adopted && requirement && expectedRevision !== null) {
          const [revision] = await tx.select().from(schema.requirementRevisions).where(and(
            eq(schema.requirementRevisions.requirement_id, requirement.id), eq(schema.requirementRevisions.revision, expectedRevision))).limit(1);
          if (!revision) reject('requirement_revision_not_found', '找不到需求当前修订');
          const criteria = parseAcceptanceCriteria(revision.acceptance_criteria);
          if (criteria.some(c => c.text === value)) reject('memory_proposal_changed', '该验收条件已存在');
          const updated = unwrap(await createRequirementUseCases(unit).updateRequirement({ requirementCode: requirement.code,
            principalCode: actor.principalCode, acceptanceCriteria: [...criteria, { id: `AC-${adopted.code}`, text: value }] }));
          expectedRevision = updated.current_revision;
        }
        const state = part.kind === 'preference' ? 'preference' : adopted ? 'confirmed' : 'discussed';
        const [fragment] = await tx.insert(fragments).values({ code: createPublicCode(), receipt_id: receipt.id, state,
          applicability: preferenceApplicability(part, cmd.sourceText), text: value, entry_id: entryId, adopted_from_id: adopted?.id ?? null }).returning({ id: fragments.id });
        if (!fragment) throw new Error('Memory fragment insert failed');
        await tx.insert(schema.memoryProjectionJobs).values({ fragment_id: fragment.id, engine: state === 'preference' ? 'openviking' : 'tencent' });
      }
      await tx.update(receipts).set({ head_after: expectedHead, revision_after: expectedRevision }).where(eq(receipts.id, receipt.id));
      return receiptResult(tx, { ...receipt, head_after: expectedHead, revision_after: expectedRevision }, false);
    });
  }

  async function visibleRows(tx: Tx, actor: Awaited<ReturnType<typeof authorize>>, scope?: 'project' | 'personal', filter?: SQL,
      literal = sql<boolean>`false`, rankedRefs: readonly string[] = [], limit = 30) {
      const relevance = rankedRefs.length ? [
        desc(literal), sql`array_position(ARRAY[${sql.join(rankedRefs.map(ref => sql`${ref}`), sql`, `)}]::text[], ${schema.memoryProjectionJobs.external_ref}) asc nulls last`,
      ] : [];
      const rows = await tx.select({
        fragment: fragments, entryCode: entries.code, originProject: receipts.project_id, literal,
        rootText: sql<string>`(select original.text from memory_fragments original where original.id = coalesce(${fragments.root_id}, ${fragments.id}))`,
        externalRef: schema.memoryProjectionJobs.external_ref,
        topicCode: schema.requirementTopics.code, topicStatus: schema.requirementTopics.status,
        requirementCode: schema.requirements.code, revision: receipts.revision_after,
      }).from(fragments)
        .innerJoin(receipts, eq(receipts.id, fragments.receipt_id)).leftJoin(entries, eq(entries.id, fragments.entry_id))
        .leftJoin(schema.requirementTopics, eq(schema.requirementTopics.id, receipts.topic_id))
        .leftJoin(schema.requirements, eq(schema.requirements.id, receipts.requirement_id))
        .leftJoin(schema.memoryProjectionJobs, and(eq(schema.memoryProjectionJobs.fragment_id, fragments.id), eq(schema.memoryProjectionJobs.status, 'synced'), eq(schema.memoryProjectionJobs.operation, 'upsert')))
        .where(and(or(eq(receipts.project_id, actor.projectId), and(eq(fragments.state, 'preference'), eq(fragments.applicability, 'account'))),
          or(ne(fragments.state, 'preference'), eq(receipts.principal_id, actor.principalId)),
          scope === 'personal' ? eq(fragments.state, 'preference') : scope === 'project' ? ne(fragments.state, 'preference') : undefined,
          currentEvidence(), filter)).orderBy(...relevance, desc(fragments.id)).limit(limit);
      // Applicability cannot be widened by an edit. Revalidate the immutable
      // first declaration so legacy rows also retain the original scope guard.
      return rows.filter(row => row.originProject === actor.projectId || accountDeclaration(row.rootText)).map(row => {
        const result = item(row.fragment, row.entryCode);
        const data = result.scope === 'personal' ? { ...result, applicability: row.fragment.applicability } :
          { ...result, ...(row.topicCode === null ? { binding: 'unbound' as const } :
            { topicCode: row.topicCode, topicStatus: row.topicStatus, requirementCode: row.requirementCode, sourceRevision: row.revision }) };
        return { data, externalRef: row.externalRef, literal: row.literal };
      });
  }

  async function searchEvidence(cmd: Actor & { query: string; scope?: 'project' | 'personal'; engineRefs?: readonly string[] }) {
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      const query = cmd.query.trim();
      if (!query || query.length > 1000 || query.includes('\0')) reject('memory_invalid', '请输入有效查询');
      if (cmd.scope !== undefined && cmd.scope !== 'project' && cmd.scope !== 'personal') reject('memory_invalid', '检索范围无效');
      const refs = [...new Set(cmd.engineRefs?.slice(0, 40).filter(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 2048))];
      const jobs = schema.memoryProjectionJobs;
      const engineMatch = refs.length ? exists(tx.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.fragment_id, fragments.id), eq(jobs.status, 'synced'), eq(jobs.operation, 'upsert'), inArray(jobs.external_ref, refs),
      ))) : undefined;
      const literal = sql<boolean>`strpos(lower(${fragments.text}), lower(${query})) > 0`;
      const fragmentRows = await visibleRows(tx, actor, cmd.scope, or(literal, engineMatch), literal, refs);
      const documents = cmd.scope === 'personal' ? [] : await documentMemoryEvidence(tx, actor.projectId, { query, engineRefs: refs });
      const materials = cmd.scope === 'personal' ? [] : await projectMaterialMemoryEvidence(tx, actor.projectId, { query, engineRefs: refs });
      const materialSources = new Set(materials.map(row => row.data.source));
      return [...fragmentRows, ...materials, ...documents.filter(row => !materialSources.has(row.data.source))].sort((a, b) => Number(b.literal) - Number(a.literal) ||
        ((refs.indexOf(a.externalRef ?? '') + 1 || Number.MAX_SAFE_INTEGER) -
          (refs.indexOf(b.externalRef ?? '') + 1 || Number.MAX_SAFE_INTEGER))).slice(0, 30);
    });
  }
  async function search(cmd: Parameters<typeof searchEvidence>[0]) {
    return (await searchEvidence(cmd)).map(row => row.data);
  }
  async function readSources(cmd: Actor & { sources: readonly string[]; scope?: 'project' | 'personal' }) {
    if (!Array.isArray(cmd.sources) || !cmd.sources.length || cmd.sources.length > 40 ||
        cmd.sources.some(code => typeof code !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{20}$/u.test(code))) {
      reject('memory_invalid', '请提供最多四十个有效来源编码');
    }
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      const rows = await visibleRows(tx,actor,cmd.scope,or(inArray(entries.code,[...cmd.sources]),
        inArray(fragments.code,[...cmd.sources])),undefined,[],40);
      const documents = cmd.scope === 'personal' ? [] : await documentMemoryEvidence(tx, actor.projectId, { sources: cmd.sources, limit: 40 });
      const materials = cmd.scope === 'personal' ? [] : await projectMaterialMemoryEvidence(tx, actor.projectId, { sources: cmd.sources, limit: 40 });
      const materialSources = new Set(materials.map(row => row.data.source));
      return [...rows, ...materials, ...documents.filter(row => !materialSources.has(row.data.source))].map(row => row.data);
    });
  }

  async function readDocument(cmd: Actor & { source: string; offset?: number; limit?: number; query?: string; occurrence?: 'first' | 'last' }) {
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      return readDocumentMemoryPage(tx, actor.projectId, cmd);
    });
  }

  async function brief(cmd: Actor & { scope: 'project' | 'personal' }) {
    return db.transaction(async tx => {
      const actor = await authorize(tx, cmd, 'read');
      if (cmd.scope !== 'project' && cmd.scope !== 'personal') reject('memory_invalid', '请指定单个记忆范围');
      const active = cmd.scope === 'project' ? or(isNull(receipts.topic_id), and(
        ne(schema.requirementTopics.status, 'archived'),
        eq(schema.requirements.current_revision, receipts.revision_after),
        or(
          // A decision closes the earlier proposal, not later observations.
          // Keep new evidence readable while its asynchronous index is pending.
          and(eq(fragments.state, 'discussed'), or(ne(schema.requirementTopics.status, 'decided'),
            sql`${entries.id} > (select max(decision.id) from requirement_topic_entries decision
              where decision.topic_id = ${entries.topic_id} and decision.entry_type = 'decision' and decision.withdrawn_at is null)`)),
          and(eq(fragments.state, 'confirmed'), eq(schema.requirementTopics.status, 'decided'),
            sql`not exists (select 1 from requirement_topic_entries newer where newer.topic_id = ${entries.topic_id}
              and newer.entry_type = 'decision' and newer.withdrawn_at is null and newer.id > ${entries.id})`),
        ),
      )) : undefined;
      const fragmentRows = await visibleRows(tx, actor, cmd.scope, active);
      const documents = cmd.scope === 'personal' ? [] : await documentMemoryEvidence(tx, actor.projectId);
      const materials = cmd.scope === 'personal' ? [] : await projectMaterialMemoryEvidence(tx, actor.projectId);
      const projectRows = [...materials, ...documents];
      const rows = [...fragmentRows.slice(0, 2), ...projectRows.slice(0, 2), ...fragmentRows.slice(2), ...projectRows.slice(2)];
      // Budget whole excerpts. Truncating a qualification could reverse a decision.
      const status = {
        discussed: '此条在议题讨论中记录。方案是否采纳应查决定；原文引用的提交或测试可独立证明对应的代码或本地验证事实。',
        confirmed: '方案已确认。此来源只证明作出了决定，实施、测试或上线需要另外的执行证据。',
        preference: '这是本人范围的记录，适用范围见 applicability。工作习惯与单次实测笔记应按原文区分，执行操作依照当次授权。',
        documented: '这是项目文档当前修订的摘录，文档记载不代表方案已确认或实际已完成。完整原文用 read_memory_document 按 nextOffset 分页读取。',
      } as const;
      const result = [];
      let remaining = 4800;
      for (const {data:row} of rows) {
        if (result.length === 6) break;
        if (row.text.length > remaining) continue;
        result.push({ ...row, evidenceStatus: 'sourceKind' in row && row.sourceKind === 'project_material' ? row.evidenceStatus : status[row.state] });
        remaining -= row.text.length;
      }
      return result;
    });
  }
  return { canCapture, inspect, replay, capture, search, searchEvidence, readSources, readDocument, brief };
}
