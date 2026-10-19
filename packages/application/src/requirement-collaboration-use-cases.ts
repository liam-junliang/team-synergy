import { assertProjectAccess, effectiveProjectMember, isProjectManager } from './project-access.js';
import { and, asc, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { schema } from '@team-synergy/persistence';
import { DomainError, assertAuditedChange, toAuditEvent } from '@team-synergy/domain';
import { fail, insertAudit, now, type TaskResult } from './task-service.js';
import {
  createPublicCode,
  findProjectByCode,
  findRequirementDocumentByCode,
  findUserByCode,
} from './public-code.js';

export type RequirementIdeaStatus = 'active' | 'archived';
export type RequirementTopicStatus = 'open' | 'decided' | 'reopened' | 'archived';
export type RequirementTopicEntryType = 'comment' | 'alternative' | 'feedback' | 'decision';
export type RequirementTopicImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface RequirementTopicEntryImageInput { fileName: string; dataUrl: string }
export type RequirementReviewVote = 'support' | 'changes_requested' | 'abstain';
export type RequirementReviewConclusion = 'passed' | 'changes_requested' | 'no_consensus';

const IDEA_STATUSES = new Set<RequirementIdeaStatus>(['active', 'archived']);
const TOPIC_STATUSES = new Set<RequirementTopicStatus>(['open', 'decided', 'reopened', 'archived']);
const ENTRY_TYPES = new Set<RequirementTopicEntryType>(['comment', 'alternative', 'feedback', 'decision']);
const REVIEW_VOTES = new Set<RequirementReviewVote>(['support', 'changes_requested', 'abstain']);
const REVIEW_CONCLUSIONS = new Set<RequirementReviewConclusion>(['passed', 'changes_requested', 'no_consensus']);
const TOPIC_IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_TOPIC_IMAGES = 4;
const MAX_TOPIC_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOPIC_IMAGES_TOTAL_BYTES = 5 * 1024 * 1024;

type MemberRow = typeof schema.members.$inferSelect;
type TopicRow = typeof schema.requirementTopics.$inferSelect;

function prepareTopicImages(images: RequirementTopicEntryImageInput[] = []) {
  if (images.length > MAX_TOPIC_IMAGES) throw new DomainError('requirement_topic_images_too_many', `每条记录最多上传 ${MAX_TOPIC_IMAGES} 张图片`);
  let totalBytes = 0;
  return images.map((image, index) => {
    const fileName = image.fileName.trim();
    if (!fileName || fileName.length > 255) throw new DomainError('requirement_topic_image_name_invalid', '图片文件名不能为空且不能超过 255 个字符');
    const match = TOPIC_IMAGE_DATA_URL.exec(image.dataUrl);
    if (!match) throw new DomainError('requirement_topic_image_type_invalid', '仅支持 PNG、JPG、WebP 或 GIF 图片');
    const mimeType = match[1] as RequirementTopicImageMime;
    const payload = match[2]!;
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const byteSize = Math.floor(payload.length * 3 / 4) - padding;
    if (byteSize <= 0 || byteSize > MAX_TOPIC_IMAGE_BYTES) throw new DomainError('requirement_topic_image_too_large', '单张图片不能超过 2 MB');
    totalBytes += byteSize;
    if (totalBytes > MAX_TOPIC_IMAGES_TOTAL_BYTES) throw new DomainError('requirement_topic_images_too_large', '每条记录的图片总大小不能超过 5 MB');
    return { fileName, mimeType, byteSize, dataUrl: image.dataUrl, sortOrder: index };
  });
}

async function requireProjectMember(db: Db, projectId: bigint, principalCode: string, write = false) {
  const principal = await findUserByCode(db, principalCode);
  if (!principal || principal.status !== 'active') {
    throw new DomainError('user_not_found', `用户不存在：${principalCode}`);
  }
  const member = await effectiveProjectMember(db, projectId, principal.id);
  if (!member) throw new DomainError('requirement_collaboration_forbidden', '当前用户不是项目成员');
  if (write) await assertProjectAccess(db, projectId, principal.id, 'write');
  return { principal, member };
}

async function findIdea(db: Db, code: string) {
  const [row] = await db.select().from(schema.requirementIdeas).where(eq(schema.requirementIdeas.code, code.trim())).limit(1);
  return row;
}

async function findTopic(db: Db, code: string) {
  const [row] = await db.select().from(schema.requirementTopics).where(eq(schema.requirementTopics.code, code.trim())).limit(1);
  return row;
}

async function findTopicEntry(db: Db, code: string) {
  const [row] = await db.select().from(schema.requirementTopicEntries).where(eq(schema.requirementTopicEntries.code, code.trim())).limit(1);
  return row;
}

async function findReview(db: Db, code: string) {
  const [row] = await db.select().from(schema.requirementDocumentReviews).where(eq(schema.requirementDocumentReviews.code, code.trim())).limit(1);
  return row;
}

async function usersByIds(db: Db, ids: bigint[]) {
  if (ids.length === 0) return new Map<bigint, typeof schema.users.$inferSelect>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

function ideaDto(row: typeof schema.requirementIdeas.$inferSelect, author?: typeof schema.users.$inferSelect, topicCount = 0) {
  return {
    idea_code: row.code,
    title: row.title,
    detail: row.detail,
    source: row.source,
    status: row.status,
    created_by: author?.code ?? null,
    created_by_name: author?.display_name ?? null,
    topic_count: topicCount,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function topicSummary(db: Db, row: TopicRow) {
  const [ideaLinks, documentLinks, entries] = await Promise.all([
    db.select().from(schema.requirementTopicIdeas).where(eq(schema.requirementTopicIdeas.topic_id, row.id)),
    db.select().from(schema.requirementTopicDocuments).where(eq(schema.requirementTopicDocuments.topic_id, row.id)),
    db.select().from(schema.requirementTopicEntries).where(eq(schema.requirementTopicEntries.topic_id, row.id)).orderBy(desc(schema.requirementTopicEntries.created_at)),
  ]);
  const currentDecision = entries.find((entry) => entry.entry_type === 'decision');
  return {
    topic_code: row.code,
    title: row.title,
    problem_statement: row.problem_statement,
    goal: row.goal,
    status: row.status,
    idea_count: ideaLinks.length,
    document_count: documentLinks.length,
    entry_count: entries.length,
    current_decision: currentDecision ? { entry_code: currentDecision.code, content: currentDecision.content, rationale: currentDecision.rationale, created_at: currentDecision.created_at } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function reviewDto(db: Db, review: typeof schema.requirementDocumentReviews.$inferSelect) {
  const [revision, votes] = await Promise.all([
    db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, review.document_revision_id)).limit(1).then((rows) => rows[0]),
    db.select().from(schema.requirementDocumentReviewVotes).where(eq(schema.requirementDocumentReviewVotes.review_id, review.id)).orderBy(asc(schema.requirementDocumentReviewVotes.responded_at)),
  ]);
  if (!revision) throw new DomainError('requirement_document_revision_not_found', '评审绑定的文档版本不存在');
  const document = await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, revision.document_id)).limit(1).then((rows) => rows[0]);
  if (!document) throw new DomainError('requirement_document_not_found', '评审绑定的文档不存在');
  const users = await usersByIds(db, [review.requested_by, ...votes.map((vote) => vote.principal_id)]);
  return {
    review_code: review.code,
    document_code: document.code,
    document_title: document.title,
    revision_code: revision.code,
    revision: revision.revision,
    status: review.status,
    conclusion: review.conclusion,
    requested_by: users.get(review.requested_by)?.code ?? null,
    requested_by_name: users.get(review.requested_by)?.display_name ?? null,
    opened_at: review.opened_at,
    closed_at: review.closed_at,
    votes: votes.map((vote) => ({
      principal_code: users.get(vote.principal_id)?.code ?? null,
      principal_name: users.get(vote.principal_id)?.display_name ?? null,
      vote: vote.vote,
      comment: vote.comment,
      responded_at: vote.responded_at,
    })),
  };
}

function canManage(member: MemberRow, ownerId: bigint, principalId: bigint) {
  return member.role !== 'viewer' && (isProjectManager(member.role) || ownerId === principalId);
}

export function createRequirementCollaborationUseCases(db: Db) {
  async function listIdeas(cmd: { projectCode: string; principalCode: string; query?: string; status?: RequirementIdeaStatus }): Promise<TaskResult<unknown[]>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`);
      await requireProjectMember(db, project.id, cmd.principalCode);
      const pattern = cmd.query?.trim() ? `%${cmd.query.trim()}%` : undefined;
      const rows = await db.select().from(schema.requirementIdeas).where(and(
        eq(schema.requirementIdeas.project_id, project.id),
        cmd.status ? eq(schema.requirementIdeas.status, cmd.status) : undefined,
        pattern ? or(ilike(schema.requirementIdeas.title, pattern), ilike(schema.requirementIdeas.detail, pattern)) : undefined,
      )).orderBy(desc(schema.requirementIdeas.updated_at));
      const [authors, links] = await Promise.all([
        usersByIds(db, rows.map((row) => row.created_by)),
        rows.length ? db.select().from(schema.requirementTopicIdeas).where(inArray(schema.requirementTopicIdeas.idea_id, rows.map((row) => row.id))) : Promise.resolve([]),
      ]);
      const counts = new Map<bigint, number>();
      for (const link of links) counts.set(link.idea_id, (counts.get(link.idea_id) ?? 0) + 1);
      return { ok: true, data: rows.map((row) => ideaDto(row, authors.get(row.created_by), counts.get(row.id) ?? 0)) };
    } catch (error) { return fail(error); }
  }

  async function createIdea(cmd: { projectCode: string; principalCode: string; title: string; detail?: string; source?: string }): Promise<TaskResult<unknown>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`);
      const { principal } = await requireProjectMember(db, project.id, cmd.principalCode, true);
      const title = cmd.title.trim();
      if (!title) throw new DomainError('requirement_idea_title_required', '想法标题不能为空');
      const createdAt = now();
      const [row] = await db.insert(schema.requirementIdeas).values({
        code: createPublicCode(), project_id: project.id, title, detail: cmd.detail?.trim() ?? '', source: cmd.source?.trim() || null,
        status: 'active', created_by: principal.id, created_at: createdAt, updated_at: createdAt,
      }).returning();
      if (!row) throw new DomainError('internal_error', '想法创建失败');
      const audit = { entity_type: 'requirement_idea', entity_id: row.id, principal_id: principal.id, base_snapshot: 0, to: 'active', action: 'requirement_idea.created', payload: { project_code: project.code, title } };
      assertAuditedChange(audit); await insertAudit(db, toAuditEvent(audit, createPublicCode(), createdAt));
      return { ok: true, data: ideaDto(row, principal) };
    } catch (error) { return fail(error); }
  }

  async function updateIdea(cmd: { ideaCode: string; principalCode: string; title?: string; detail?: string; source?: string | null; status?: RequirementIdeaStatus }): Promise<TaskResult<unknown>> {
    try {
      const idea = await findIdea(db, cmd.ideaCode);
      if (!idea) throw new DomainError('requirement_idea_not_found', `想法不存在：${cmd.ideaCode}`);
      const { principal, member } = await requireProjectMember(db, idea.project_id, cmd.principalCode, true);
      if (!canManage(member, idea.created_by, principal.id)) throw new DomainError('requirement_idea_forbidden', '只有想法创建人或项目 Owner 可以修改');
      const title = cmd.title === undefined ? idea.title : cmd.title.trim();
      if (!title) throw new DomainError('requirement_idea_title_required', '想法标题不能为空');
      if (cmd.status && !IDEA_STATUSES.has(cmd.status)) throw new DomainError('requirement_idea_status_invalid', `非法想法状态：${cmd.status}`);
      const updatedAt = now();
      const [row] = await db.update(schema.requirementIdeas).set({
        title,
        detail: cmd.detail === undefined ? idea.detail : cmd.detail.trim(),
        source: cmd.source === undefined ? idea.source : cmd.source?.trim() || null,
        status: cmd.status ?? idea.status,
        updated_at: updatedAt,
      }).where(eq(schema.requirementIdeas.id, idea.id)).returning();
      return { ok: true, data: ideaDto(row!, principal) };
    } catch (error) { return fail(error); }
  }

  async function listTopics(cmd: { projectCode: string; principalCode: string; query?: string; status?: RequirementTopicStatus }): Promise<TaskResult<unknown[]>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`);
      await requireProjectMember(db, project.id, cmd.principalCode);
      const pattern = cmd.query?.trim() ? `%${cmd.query.trim()}%` : undefined;
      const rows = await db.select().from(schema.requirementTopics).where(and(
        eq(schema.requirementTopics.project_id, project.id),
        cmd.status ? eq(schema.requirementTopics.status, cmd.status) : undefined,
        pattern ? or(ilike(schema.requirementTopics.title, pattern), ilike(schema.requirementTopics.problem_statement, pattern), ilike(schema.requirementTopics.goal, pattern)) : undefined,
      )).orderBy(desc(schema.requirementTopics.updated_at));
      return { ok: true, data: await Promise.all(rows.map((row) => topicSummary(db, row))) };
    } catch (error) { return fail(error); }
  }

  async function createTopic(cmd: { projectCode: string; principalCode: string; title: string; problemStatement?: string; goal?: string; ideaCodes?: string[] }): Promise<TaskResult<unknown>> {
    try {
      const project = await findProjectByCode(db, cmd.projectCode);
      if (!project) throw new DomainError('project_not_found', `项目不存在：${cmd.projectCode}`);
      const { principal } = await requireProjectMember(db, project.id, cmd.principalCode, true);
      const title = cmd.title.trim();
      if (!title) throw new DomainError('requirement_topic_title_required', '议题标题不能为空');
      const ideaCodes = [...new Set((cmd.ideaCodes ?? []).map((code) => code.trim()).filter(Boolean))];
      const ideas = ideaCodes.length ? await db.select().from(schema.requirementIdeas).where(inArray(schema.requirementIdeas.code, ideaCodes)) : [];
      if (ideas.some((idea) => idea.project_id !== project.id) || ideas.length !== ideaCodes.length) throw new DomainError('requirement_topic_idea_invalid', '包含不存在或不属于当前项目的想法');
      const createdAt = now();
      const row = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, project.id, principal.id, 'write');
        const [topic] = await tx.insert(schema.requirementTopics).values({
          code: createPublicCode(), project_id: project.id, title, problem_statement: cmd.problemStatement?.trim() ?? '', goal: cmd.goal?.trim() ?? '',
          status: 'open', created_by: principal.id, created_at: createdAt, updated_at: createdAt,
        }).returning();
        if (!topic) throw new DomainError('internal_error', '需求议题创建失败');
        if (ideas.length) await tx.insert(schema.requirementTopicIdeas).values(ideas.map((idea) => ({ topic_id: topic.id, idea_id: idea.id, created_at: createdAt })));
        const audit = { entity_type: 'requirement_topic', entity_id: topic.id, principal_id: principal.id, base_snapshot: 0, to: 'open', action: 'requirement_topic.created', payload: { project_code: project.code, title, idea_codes: ideaCodes } };
        assertAuditedChange(audit); await insertAudit(tx, toAuditEvent(audit, createPublicCode(), createdAt));
        return topic;
      });
      return { ok: true, data: await topicSummary(db, row) };
    } catch (error) { return fail(error); }
  }

  async function getTopic(topicCode: string, principalCode: string): Promise<TaskResult<unknown>> {
    try {
      const topic = await findTopic(db, topicCode);
      if (!topic) throw new DomainError('requirement_topic_not_found', `需求议题不存在：${topicCode}`);
      const { principal, member } = await requireProjectMember(db, topic.project_id, principalCode);
      const [project] = await db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, topic.project_id)).limit(1);
      const writable = project?.status === 'active' && member.role !== 'viewer';
      const [ideaLinks, documentLinks, entries] = await Promise.all([
        db.select({ idea: schema.requirementIdeas }).from(schema.requirementTopicIdeas).innerJoin(schema.requirementIdeas, eq(schema.requirementIdeas.id, schema.requirementTopicIdeas.idea_id)).where(eq(schema.requirementTopicIdeas.topic_id, topic.id)),
        db.select({ document: schema.requirementDocuments }).from(schema.requirementTopicDocuments).innerJoin(schema.requirementDocuments, eq(schema.requirementDocuments.id, schema.requirementTopicDocuments.document_id)).where(eq(schema.requirementTopicDocuments.topic_id, topic.id)),
        db.select().from(schema.requirementTopicEntries).where(eq(schema.requirementTopicEntries.topic_id, topic.id)).orderBy(desc(schema.requirementTopicEntries.created_at), desc(schema.requirementTopicEntries.id)),
      ]);
      const authors = await usersByIds(db, [topic.created_by, ...ideaLinks.map((link) => link.idea.created_by), ...entries.map((entry) => entry.author_principal_id), ...entries.flatMap((entry) => entry.withdrawn_by ? [entry.withdrawn_by] : [])]);
      const images = entries.length
        ? await db.select().from(schema.requirementTopicEntryImages).where(inArray(schema.requirementTopicEntryImages.entry_id, entries.map((entry) => entry.id))).orderBy(asc(schema.requirementTopicEntryImages.sort_order))
        : [];
      const allIdeaLinks = ideaLinks.length
        ? await db.select().from(schema.requirementTopicIdeas).where(inArray(schema.requirementTopicIdeas.idea_id, ideaLinks.map((link) => link.idea.id)))
        : [];
      const ideaTopicCounts = new Map<bigint, number>();
      for (const link of allIdeaLinks) ideaTopicCounts.set(link.idea_id, (ideaTopicCounts.get(link.idea_id) ?? 0) + 1);
      return { ok: true, data: {
        ...(await topicSummary(db, topic)),
        ideas: ideaLinks.map((link) => ideaDto(link.idea, authors.get(link.idea.created_by), ideaTopicCounts.get(link.idea.id) ?? 0)),
        documents: documentLinks.map((link) => ({ document_code: link.document.code, title: link.document.title, current_revision: link.document.current_revision, state: link.document.state })),
        entries: entries.map((entry) => ({ entry_code: entry.code, entry_type: entry.entry_type, content: entry.withdrawn_at ? '' : entry.content, rationale: entry.withdrawn_at ? null : entry.rationale, supersedes_entry_code: entries.find((candidate) => candidate.id === entry.supersedes_entry_id)?.code ?? null, source_entity_type: entry.withdrawn_at ? null : entry.source_entity_type, source_entity_code: entry.withdrawn_at ? null : entry.source_entity_code, author_code: authors.get(entry.author_principal_id)?.code ?? null, author_name: authors.get(entry.author_principal_id)?.display_name ?? null, images: entry.withdrawn_at ? [] : images.filter((image) => image.entry_id === entry.id).map((image) => ({ image_code: image.code, file_name: image.file_name, mime_type: image.mime_type, byte_size: image.byte_size, data_url: image.data_url })), withdrawn_at: entry.withdrawn_at, withdrawn_by_code: entry.withdrawn_by ? authors.get(entry.withdrawn_by)?.code ?? null : null, withdrawn_by_name: entry.withdrawn_by ? authors.get(entry.withdrawn_by)?.display_name ?? null : null, withdrawal_reason: entry.withdrawal_reason, can_withdraw: writable && !entry.withdrawn_at && entry.entry_type !== 'decision' && topic.status !== 'archived' && canManage(member, entry.author_principal_id, principal.id), created_at: entry.created_at })),
        can_manage: writable && canManage(member, topic.created_by, principal.id),
        can_decide: writable && topic.status !== 'archived' && isProjectManager(member.role),
      } };
    } catch (error) { return fail(error); }
  }

  async function updateTopic(cmd: { topicCode: string; principalCode: string; title?: string; problemStatement?: string; goal?: string; status?: RequirementTopicStatus }): Promise<TaskResult<unknown>> {
    try {
      const topic = await findTopic(db, cmd.topicCode);
      if (!topic) throw new DomainError('requirement_topic_not_found', `需求议题不存在：${cmd.topicCode}`);
      const { principal, member } = await requireProjectMember(db, topic.project_id, cmd.principalCode, true);
      if (!canManage(member, topic.created_by, principal.id)) throw new DomainError('requirement_topic_forbidden', '只有议题创建人或项目 Owner 可以修改');
      const title = cmd.title === undefined ? topic.title : cmd.title.trim();
      if (!title) throw new DomainError('requirement_topic_title_required', '议题标题不能为空');
      if (cmd.status && !TOPIC_STATUSES.has(cmd.status)) throw new DomainError('requirement_topic_status_invalid', `非法议题状态：${cmd.status}`);
      const [row] = await db.transaction(async tx => {
        const access = await assertProjectAccess(tx, topic.project_id, principal.id, cmd.status !== undefined && cmd.status !== topic.status ? 'manage' : 'write');
        if (!isProjectManager(access.role) && topic.created_by !== principal.id) throw new DomainError('requirement_topic_forbidden', '只有议题创建人或项目管理者可以修改');
        return tx.update(schema.requirementTopics).set({ title, problem_statement: cmd.problemStatement === undefined ? topic.problem_statement : cmd.problemStatement.trim(), goal: cmd.goal === undefined ? topic.goal : cmd.goal.trim(), status: cmd.status ?? topic.status, updated_at: now() }).where(eq(schema.requirementTopics.id, topic.id)).returning();
      });
      return { ok: true, data: await topicSummary(db, row!) };
    } catch (error) { return fail(error); }
  }

  async function addTopicEntry(cmd: { topicCode: string; principalCode: string; entryType: RequirementTopicEntryType; content: string; rationale?: string; supersedesEntryCode?: string; sourceEntityType?: string; sourceEntityCode?: string; images?: RequirementTopicEntryImageInput[] }): Promise<TaskResult<unknown>> {
    try {
      const topic = await findTopic(db, cmd.topicCode);
      if (!topic) throw new DomainError('requirement_topic_not_found', `需求议题不存在：${cmd.topicCode}`);
      const { principal } = await requireProjectMember(db, topic.project_id, cmd.principalCode, true);
      if (topic.status === 'archived') throw new DomainError('requirement_topic_archived', '已归档议题不能继续讨论');
      const content = cmd.content.trim();
      if (!content) throw new DomainError('requirement_topic_entry_content_required', '内容不能为空');
      if (!ENTRY_TYPES.has(cmd.entryType)) throw new DomainError('requirement_topic_entry_type_invalid', `非法议题记录类型：${cmd.entryType}`);
      const preparedImages = prepareTopicImages(cmd.images);
      const supersedes = cmd.supersedesEntryCode ? await findTopicEntry(db, cmd.supersedesEntryCode) : undefined;
      if (supersedes && (supersedes.topic_id !== topic.id || supersedes.entry_type !== 'decision')) throw new DomainError('requirement_topic_supersedes_invalid', '只能替代当前议题中的历史决策');
      const createdAt = now();
      const row = await db.transaction(async (tx) => {
        await assertProjectAccess(tx, topic.project_id, principal.id, cmd.entryType === 'decision' ? 'manage' : 'write');
        const [entry] = await tx.insert(schema.requirementTopicEntries).values({
          code: createPublicCode(), topic_id: topic.id, entry_type: cmd.entryType, content, rationale: cmd.rationale?.trim() || null,
          supersedes_entry_id: supersedes?.id ?? null, source_entity_type: cmd.sourceEntityType?.trim() || null, source_entity_code: cmd.sourceEntityCode?.trim() || null,
          author_principal_id: principal.id, created_at: createdAt,
        }).returning();
        if (!entry) throw new DomainError('internal_error', '议题记录创建失败');
        const insertedImages = preparedImages.length ? await tx.insert(schema.requirementTopicEntryImages).values(preparedImages.map((image) => ({
          code: createPublicCode(), entry_id: entry.id, file_name: image.fileName, mime_type: image.mimeType, byte_size: image.byteSize,
          data_url: image.dataUrl, sort_order: image.sortOrder, created_at: createdAt,
        }))).returning() : [];
        const nextStatus: RequirementTopicStatus = cmd.entryType === 'decision' ? 'decided' : topic.status === 'decided' && cmd.entryType === 'feedback' ? 'reopened' : topic.status;
        await tx.update(schema.requirementTopics).set({ status: nextStatus, updated_at: createdAt }).where(eq(schema.requirementTopics.id, topic.id));
        const audit = { entity_type: 'requirement_topic_entry', entity_id: entry.id, principal_id: principal.id, base_snapshot: 0, to: cmd.entryType, action: `requirement_topic.${cmd.entryType}_added`, payload: { topic_code: topic.code, supersedes_entry_code: supersedes?.code ?? null, image_count: insertedImages.length } };
        assertAuditedChange(audit); await insertAudit(tx, toAuditEvent(audit, createPublicCode(), createdAt));
        return { entry, images: insertedImages };
      });
      return { ok: true, data: { entry_code: row.entry.code, entry_type: row.entry.entry_type, content: row.entry.content, rationale: row.entry.rationale, images: row.images.map((image) => ({ image_code: image.code, file_name: image.file_name, mime_type: image.mime_type, byte_size: image.byte_size, data_url: image.data_url })), created_at: row.entry.created_at } };
    } catch (error) { return fail(error); }
  }

  async function withdrawTopicEntry(cmd: { entryCode: string; principalCode: string; reason?: string }): Promise<TaskResult<unknown>> {
    try {
      const entry = await findTopicEntry(db, cmd.entryCode);
      if (!entry) throw new DomainError('requirement_topic_entry_not_found', `议题记录不存在：${cmd.entryCode}`);
      const topic = await db.select().from(schema.requirementTopics).where(eq(schema.requirementTopics.id, entry.topic_id)).limit(1).then((rows) => rows[0]);
      if (!topic) throw new DomainError('requirement_topic_not_found', '议题记录所属议题不存在');
      const { principal, member } = await requireProjectMember(db, topic.project_id, cmd.principalCode, true);
      if (topic.status === 'archived') throw new DomainError('requirement_topic_archived', '已归档议题不能撤回记录');
      if (entry.entry_type === 'decision') throw new DomainError('requirement_topic_decision_withdraw_forbidden', '决策不能撤回，请通过方案调整和新决策替代');
      if (entry.withdrawn_at) throw new DomainError('requirement_topic_entry_already_withdrawn', '该记录已经撤回');
      if (!canManage(member, entry.author_principal_id, principal.id)) throw new DomainError('requirement_topic_entry_withdraw_forbidden', '只有记录作者或项目 Owner 可以撤回');
      const reason = cmd.reason?.trim() || null;
      if (reason && reason.length > 500) throw new DomainError('requirement_topic_entry_withdraw_reason_too_long', '撤回原因不能超过 500 个字符');
      const withdrawnAt = now();
      await db.transaction(async (tx) => {
        const access = await assertProjectAccess(tx, topic.project_id, principal.id, 'write');
        if (!isProjectManager(access.role) && entry.author_principal_id !== principal.id) throw new DomainError('requirement_topic_entry_withdraw_forbidden', '只有记录作者或项目管理者可以撤回');
        await tx.update(schema.requirementTopicEntries).set({ withdrawn_at: withdrawnAt, withdrawn_by: principal.id, withdrawal_reason: reason }).where(eq(schema.requirementTopicEntries.id, entry.id));
        const remainingEntries = await tx.select().from(schema.requirementTopicEntries).where(and(eq(schema.requirementTopicEntries.topic_id, topic.id), isNull(schema.requirementTopicEntries.withdrawn_at))).orderBy(asc(schema.requirementTopicEntries.created_at), asc(schema.requirementTopicEntries.id));
        const latestDecision = [...remainingEntries].reverse().find((candidate) => candidate.entry_type === 'decision');
        const hasFeedbackAfterDecision = latestDecision ? remainingEntries.some((candidate) => candidate.entry_type === 'feedback' && (candidate.created_at > latestDecision.created_at || (candidate.created_at === latestDecision.created_at && candidate.id > latestDecision.id))) : false;
        const nextStatus: RequirementTopicStatus = latestDecision ? hasFeedbackAfterDecision ? 'reopened' : 'decided' : 'open';
        await tx.update(schema.requirementTopics).set({ status: nextStatus, updated_at: withdrawnAt }).where(eq(schema.requirementTopics.id, topic.id));
        const audit = { entity_type: 'requirement_topic_entry', entity_id: entry.id, principal_id: principal.id, base_snapshot: 0, from: entry.entry_type, to: 'withdrawn', action: 'requirement_topic.entry_withdrawn', payload: { topic_code: topic.code, entry_code: entry.code, reason } };
        assertAuditedChange(audit); await insertAudit(tx, toAuditEvent(audit, createPublicCode(), withdrawnAt));
      });
      return { ok: true, data: { entry_code: entry.code, withdrawn_at: withdrawnAt, withdrawn_by_code: principal.code, withdrawn_by_name: principal.display_name, withdrawal_reason: reason } };
    } catch (error) { return fail(error); }
  }

  async function linkIdeas(cmd: { topicCode: string; principalCode: string; ideaCodes: string[] }): Promise<TaskResult<unknown>> {
    try {
      const topic = await findTopic(db, cmd.topicCode);
      if (!topic) throw new DomainError('requirement_topic_not_found', `需求议题不存在：${cmd.topicCode}`);
      await requireProjectMember(db, topic.project_id, cmd.principalCode, true);
      const codes = [...new Set(cmd.ideaCodes.map((code) => code.trim()).filter(Boolean))];
      const ideas = codes.length ? await db.select().from(schema.requirementIdeas).where(inArray(schema.requirementIdeas.code, codes)) : [];
      if (ideas.length !== codes.length || ideas.some((idea) => idea.project_id !== topic.project_id)) throw new DomainError('requirement_topic_idea_invalid', '包含不存在或不属于当前项目的想法');
      if (ideas.length) await db.insert(schema.requirementTopicIdeas).values(ideas.map((idea) => ({ topic_id: topic.id, idea_id: idea.id, created_at: now() }))).onConflictDoNothing();
      await db.update(schema.requirementTopics).set({ updated_at: now() }).where(eq(schema.requirementTopics.id, topic.id));
      return await getTopic(topic.code, cmd.principalCode);
    } catch (error) { return fail(error); }
  }

  async function linkDocuments(cmd: { topicCode: string; principalCode: string; documentCodes: string[] }): Promise<TaskResult<unknown>> {
    try {
      const topic = await findTopic(db, cmd.topicCode);
      if (!topic) throw new DomainError('requirement_topic_not_found', `需求议题不存在：${cmd.topicCode}`);
      await requireProjectMember(db, topic.project_id, cmd.principalCode, true);
      const codes = [...new Set(cmd.documentCodes.map((code) => code.trim()).filter(Boolean))];
      const documents = codes.length ? await db.select().from(schema.requirementDocuments).where(inArray(schema.requirementDocuments.code, codes)) : [];
      if (documents.length !== codes.length || documents.some((document) => document.project_id !== topic.project_id)) throw new DomainError('requirement_topic_document_invalid', '包含不存在或不属于当前项目的需求文档');
      if (documents.length) await db.insert(schema.requirementTopicDocuments).values(documents.map((document) => ({ topic_id: topic.id, document_id: document.id, created_at: now() }))).onConflictDoNothing();
      await db.update(schema.requirementTopics).set({ updated_at: now() }).where(eq(schema.requirementTopics.id, topic.id));
      return await getTopic(topic.code, cmd.principalCode);
    } catch (error) { return fail(error); }
  }

  async function listDocumentReviews(documentCode: string, principalCode: string): Promise<TaskResult<unknown[]>> {
    try {
      const document = await findRequirementDocumentByCode(db, documentCode);
      if (!document) throw new DomainError('requirement_document_not_found', `需求文档不存在：${documentCode}`);
      await requireProjectMember(db, document.project_id, principalCode);
      const revisions = await db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.document_id, document.id));
      if (!revisions.length) return { ok: true, data: [] };
      const reviews = await db.select().from(schema.requirementDocumentReviews).where(inArray(schema.requirementDocumentReviews.document_revision_id, revisions.map((revision) => revision.id))).orderBy(desc(schema.requirementDocumentReviews.opened_at));
      return { ok: true, data: await Promise.all(reviews.map((review) => reviewDto(db, review))) };
    } catch (error) { return fail(error); }
  }

  async function startDocumentReview(cmd: { documentCode: string; principalCode: string }): Promise<TaskResult<unknown>> {
    try {
      const document = await findRequirementDocumentByCode(db, cmd.documentCode);
      if (!document) throw new DomainError('requirement_document_not_found', `需求文档不存在：${cmd.documentCode}`);
      const { principal, member } = await requireProjectMember(db, document.project_id, cmd.principalCode, true);
      if (!canManage(member, document.owner_principal_id, principal.id)) throw new DomainError('requirement_review_forbidden', '只有文档维护人或项目 Owner 可以发起评审');
      const [revision] = await db.select().from(schema.requirementDocumentRevisions).where(and(eq(schema.requirementDocumentRevisions.document_id, document.id), eq(schema.requirementDocumentRevisions.revision, document.current_revision))).limit(1);
      if (!revision) throw new DomainError('requirement_document_revision_not_found', '文档当前版本不存在');
      const [existing] = await db.select().from(schema.requirementDocumentReviews).where(eq(schema.requirementDocumentReviews.document_revision_id, revision.id)).limit(1);
      if (existing) return { ok: true, data: await reviewDto(db, existing) };
      const openedAt = now();
      const [review] = await db.insert(schema.requirementDocumentReviews).values({ code: createPublicCode(), document_revision_id: revision.id, status: 'open', requested_by: principal.id, opened_at: openedAt }).returning();
      if (!review) throw new DomainError('internal_error', '文档评审创建失败');
      const audit = { entity_type: 'requirement_document_review', entity_id: review.id, principal_id: principal.id, base_snapshot: revision.revision, to: 'open', action: 'requirement_document.review_started', payload: { document_code: document.code, revision: revision.revision } };
      assertAuditedChange(audit); await insertAudit(db, toAuditEvent(audit, createPublicCode(), openedAt));
      return { ok: true, data: await reviewDto(db, review) };
    } catch (error) { return fail(error); }
  }

  async function getDocumentReview(reviewCode: string, principalCode: string): Promise<TaskResult<unknown>> {
    try {
      const review = await findReview(db, reviewCode);
      if (!review) throw new DomainError('requirement_review_not_found', `评审不存在：${reviewCode}`);
      const revision = await db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, review.document_revision_id)).limit(1).then((rows) => rows[0]);
      const document = revision ? await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, revision.document_id)).limit(1).then((rows) => rows[0]) : undefined;
      if (!document) throw new DomainError('requirement_document_not_found', '评审绑定的文档不存在');
      await requireProjectMember(db, document.project_id, principalCode);
      return { ok: true, data: await reviewDto(db, review) };
    } catch (error) { return fail(error); }
  }

  async function voteDocumentReview(cmd: { reviewCode: string; principalCode: string; vote: RequirementReviewVote; comment?: string }): Promise<TaskResult<unknown>> {
    try {
      const review = await findReview(db, cmd.reviewCode);
      if (!review) throw new DomainError('requirement_review_not_found', `评审不存在：${cmd.reviewCode}`);
      if (review.status !== 'open') throw new DomainError('requirement_review_closed', '评审已经结束，不能继续投票');
      if (!REVIEW_VOTES.has(cmd.vote)) throw new DomainError('requirement_review_vote_invalid', `非法评审意见：${cmd.vote}`);
      const revision = await db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, review.document_revision_id)).limit(1).then((rows) => rows[0]);
      const document = revision ? await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, revision.document_id)).limit(1).then((rows) => rows[0]) : undefined;
      if (!document) throw new DomainError('requirement_document_not_found', '评审绑定的文档不存在');
      const { principal } = await requireProjectMember(db, document.project_id, cmd.principalCode, true);
      const respondedAt = now();
      await db.insert(schema.requirementDocumentReviewVotes).values({ review_id: review.id, principal_id: principal.id, vote: cmd.vote, comment: cmd.comment?.trim() ?? '', responded_at: respondedAt }).onConflictDoUpdate({ target: [schema.requirementDocumentReviewVotes.review_id, schema.requirementDocumentReviewVotes.principal_id], set: { vote: cmd.vote, comment: cmd.comment?.trim() ?? '', responded_at: respondedAt } });
      return { ok: true, data: await reviewDto(db, review) };
    } catch (error) { return fail(error); }
  }

  async function closeDocumentReview(cmd: { reviewCode: string; principalCode: string; conclusion: RequirementReviewConclusion }): Promise<TaskResult<unknown>> {
    try {
      const review = await findReview(db, cmd.reviewCode);
      if (!review) throw new DomainError('requirement_review_not_found', `评审不存在：${cmd.reviewCode}`);
      if (review.status !== 'open') throw new DomainError('requirement_review_closed', '评审已经结束');
      if (!REVIEW_CONCLUSIONS.has(cmd.conclusion)) throw new DomainError('requirement_review_conclusion_invalid', `非法评审结论：${cmd.conclusion}`);
      const revision = await db.select().from(schema.requirementDocumentRevisions).where(eq(schema.requirementDocumentRevisions.id, review.document_revision_id)).limit(1).then((rows) => rows[0]);
      const document = revision ? await db.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, revision.document_id)).limit(1).then((rows) => rows[0]) : undefined;
      if (!document) throw new DomainError('requirement_document_not_found', '评审绑定的文档不存在');
      const { principal } = await requireProjectMember(db, document.project_id, cmd.principalCode, true);
      await assertProjectAccess(db, document.project_id, principal.id, 'manage');
      const closedAt = now();
      const [updated] = await db.transaction(async tx => {
        await assertProjectAccess(tx, document.project_id, principal.id, 'manage');
        return tx.update(schema.requirementDocumentReviews).set({ status: 'closed', conclusion: cmd.conclusion, closed_by: principal.id, closed_at: closedAt }).where(and(eq(schema.requirementDocumentReviews.id, review.id), eq(schema.requirementDocumentReviews.status, 'open'))).returning();
      });
      if (!updated) throw new DomainError('requirement_review_closed', '评审已经结束');
      return { ok: true, data: await reviewDto(db, updated!) };
    } catch (error) { return fail(error); }
  }

  return { listIdeas, createIdea, updateIdea, listTopics, createTopic, getTopic, updateTopic, addTopicEntry, withdrawTopicEntry, linkIdeas, linkDocuments, listDocumentReviews, startDocumentReview, getDocumentReview, voteDocumentReview, closeDocumentReview };
}
