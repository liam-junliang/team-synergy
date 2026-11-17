import { and, desc, eq, exists, inArray, not, or, sql } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const { projectDocuments: documents, projectDocumentRevisions: revisions, memoryProjectionJobs: jobs } = schema;
const previewLimit = 1600;

// Offsets are UTF-16 code units, as used by JS strings. Never split a surrogate pair.
function pageEnd(content: string, end: number) {
  if (end > 0 && end < content.length && content.charCodeAt(end) >= 0xDC00 && content.charCodeAt(end) <= 0xDFFF &&
      content.charCodeAt(end - 1) >= 0xD800 && content.charCodeAt(end - 1) <= 0xDBFF) return end - 1;
  return end;
}

export async function documentMemoryEvidence(tx: Tx, projectId: bigint, input: {
  query?: string; engineRefs?: readonly string[]; sources?: readonly string[]; limit?: number;
} = {}) {
  if (input.sources && !input.sources.length) return [];
  const refs = input.engineRefs ?? [];
  const literal = input.query ? sql<boolean>`strpos(lower(${revisions.title} || E'\n' || ${revisions.content}), lower(${input.query})) > 0` : sql<boolean>`false`;
  const engineMatch = refs.length ? exists(tx.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.project_document_revision_id, revisions.id), eq(jobs.status, 'synced'), inArray(jobs.external_ref, [...refs]),
  ))) : undefined;
  const rows = await tx.select({ source: revisions.code, documentCode: documents.code, sourceRevision: revisions.revision,
    title: sql<string>`substring(${revisions.title} from 1 for 241)`, titleMore: sql<boolean>`char_length(${revisions.title}) > 240`,
    preview: sql<string>`substring(${revisions.content} from 1 for ${previewLimit + 1})`,
    more: sql<boolean>`char_length(${revisions.content}) > ${previewLimit}`, literal, externalRef: jobs.external_ref,
  }).from(revisions).innerJoin(documents, eq(documents.id, revisions.document_id))
    .innerJoin(schema.projects, eq(schema.projects.id, documents.project_id))
    .leftJoin(jobs, and(eq(jobs.project_document_revision_id, revisions.id), eq(jobs.status, 'synced')))
    .where(and(eq(documents.project_id, projectId), eq(documents.status, 'active'), eq(schema.projects.status, 'active'),
      eq(revisions.revision, documents.revision), input.sources ? inArray(revisions.code, [...input.sources]) : undefined,
      // New material indexes return bounded cards, never a second legacy body excerpt for the same current source.
      not(exists(tx.select({ id: schema.projectMaterialIndexVersions.id }).from(schema.projectMaterialIndexVersions).where(and(
        eq(schema.projectMaterialIndexVersions.project_id, projectId), eq(schema.projectMaterialIndexVersions.source_citation, revisions.code),
        eq(schema.projectMaterialIndexVersions.active, true),
      )))),
      input.query ? or(literal, engineMatch) : undefined))
    .orderBy(...(input.query ? [desc(literal)] : []), ...(refs.length ? [sql`array_position(ARRAY[${sql.join(refs.map(ref => sql`${ref}`), sql`, `)}]::text[], ${jobs.external_ref}) asc nulls last`] : []),
      desc(documents.updated_at), desc(revisions.id)).limit(input.limit ?? 30);
  return rows.map(row => {
    const end = pageEnd(row.preview, Math.min(previewLimit, row.preview.length));
    const titleEnd = pageEnd(row.title, Math.min(240, row.title.length));
    return { literal: row.literal, externalRef: row.externalRef, data: {
      source: row.source, sourceKind: 'project_document' as const, state: 'documented' as const, scope: 'project' as const,
      documentCode: row.documentCode, sourceRevision: row.sourceRevision, title: row.title.slice(0, titleEnd),
      titleTruncated: row.titleMore || titleEnd < row.title.length, text: row.preview.slice(0, end),
      excerpt: { offset: 0, nextOffset: row.more || end < row.preview.length ? end : null, unit: 'utf16' as const },
    } };
  });
}

/** Call only after the shared project authorization; immutable revision IDs never redirect to a new version. */
export async function readDocumentMemoryPage(tx: Tx, projectId: bigint, input: { source: string; offset?: number; limit?: number; query?: string; occurrence?: 'first' | 'last' }) {
  let offset = input.offset ?? 0;
  const limit = input.limit ?? 4000;
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/u.test(input.source) || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 2 || limit > 8000 || (input.query !== undefined &&
        (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 256 || input.offset !== undefined)) ||
      (input.occurrence !== undefined && (input.query === undefined || !['first', 'last'].includes(input.occurrence)))) {
    throw new DomainError('memory_invalid', '文档来源或分页范围无效。');
  }
  const [row] = await tx.select({ source: revisions.code, documentCode: documents.code, sourceRevision: revisions.revision,
    title: sql<string>`substring(${revisions.title} from 1 for 241)`, titleMore: sql<boolean>`char_length(${revisions.title}) > 240`,
    content: revisions.content }).from(revisions)
    .innerJoin(documents, eq(documents.id, revisions.document_id)).innerJoin(schema.projects, eq(schema.projects.id, documents.project_id))
    .where(and(eq(revisions.code, input.source), eq(documents.project_id, projectId), eq(documents.status, 'active'),
      eq(schema.projects.status, 'active'), eq(revisions.revision, documents.revision))).limit(1);
  if (!row) throw new DomainError('memory_source_unavailable', '文档来源已更新、归档或当前不可读，请重新检索。');
  if (input.query !== undefined) {
    const escaped = input.query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'giu');
    let hit = pattern.exec(row.content);
    if (input.occurrence === 'last') {
      for (let next = pattern.exec(row.content); next; next = pattern.exec(row.content)) hit = next;
    }
    if (!hit) throw new DomainError('memory_document_no_match', '该文档版本未找到此字面内容。');
    if (hit[0].length > limit) throw new DomainError('memory_invalid', '分页长度至少需要覆盖查询内容。');
    const context = Math.min(200, Math.floor(Math.max(0, limit - hit[0].length - 2) / 3));
    offset = pageEnd(row.content, Math.max(0, hit.index - context));
  }
  if (offset > row.content.length || pageEnd(row.content, offset) !== offset) {
    throw new DomainError('memory_invalid', '请使用返回的 nextOffset 连续读取文档。');
  }
  const end = pageEnd(row.content, Math.min(row.content.length, offset + limit));
  const titleEnd = pageEnd(row.title, Math.min(240, row.title.length));
  return { source: row.source, sourceKind: 'project_document' as const, state: 'documented' as const, scope: 'project' as const,
    documentCode: row.documentCode, sourceRevision: row.sourceRevision, title: row.title.slice(0, titleEnd),
    titleTruncated: row.titleMore || titleEnd < row.title.length, text: row.content.slice(offset, end),
    range: { offset, nextOffset: end < row.content.length ? end : null, total: row.content.length, unit: 'utf16' as const } };
}
