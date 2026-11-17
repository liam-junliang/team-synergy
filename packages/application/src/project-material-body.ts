import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema } from '@team-synergy/persistence';
import type { AccessDb } from './project-access.js';
import type { ProjectMaterialMetadata, ProjectMaterialSourceKind } from '@team-synergy/contracts';
import { loadProjectMaterialCatalog, type ProjectMaterialBodyLocator, type ProjectMaterialCandidate } from './project-material-catalog.js';

export const MATERIAL_BODY_LIMIT = 8 * 1024 * 1024;
type Selector = { sourceKind?: ProjectMaterialSourceKind; objectCode?: string; sourceCitation?: string; revision?: number };
export const materialHash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function findMaterialSource(db: AccessDb, projectId: bigint, sourceCitation: string) {
  const definitions = [
    ['project', schema.projectDocuments, schema.projectDocumentRevisions],
    ['requirement', schema.requirementDocuments, schema.requirementDocumentRevisions],
    ['architecture', schema.architectureDocuments, schema.architectureDocumentRevisions],
    ['testing', schema.testAssets, schema.testAssetRevisions],
  ] as const;
  const matches: Array<{ objectCode: string; revision: number; sourceKind: ProjectMaterialSourceKind }> = [];
  for (const [sourceKind, object, revision] of definitions) {
    const rows = await db.select({ objectCode: object.code, revision: revision.revision }).from(object)
      .innerJoin(revision, eq(revision.document_id, object.id)).where(and(eq(object.project_id, projectId), eq(revision.code, sourceCitation))).limit(1);
    matches.push(...rows.map(row => ({ ...row, sourceKind })));
  }
  const match = matches[0];
  if (matches.length !== 1 || !match) throw new DomainError('material_not_found', '资料版本不存在或不属于当前项目');
  return match;
}

/** Reads only textual fields. Binary attachment/image bytes are never selected. */
export async function loadProjectMaterialBody(db: AccessDb, projectId: bigint, selector: Selector, maxChars = MATERIAL_BODY_LIMIT) {
  const resolved = selector.sourceCitation ? await findMaterialSource(db, projectId, selector.sourceCitation) : selector;
  if (!resolved.sourceKind || !resolved.objectCode) throw new DomainError('material_invalid', '请提供明确资料来源');
  const catalog = await loadProjectMaterialCatalog(db, projectId, resolved, { includeExecutionEvidence: true });
  const metadata = catalog.items.find(row => row.sourceKind === resolved.sourceKind && row.objectCode === resolved.objectCode);
  if (!metadata) throw new DomainError('material_not_found', '资料不存在或当前修订不完整');
  const revisionNumber = resolved.revision ?? metadata.revision;
  let row: { code: string; revision: number; title: string; summary: string | null; body: string | null; binary: boolean; totalChars: number; contentType: string } | undefined;
  const kind = resolved.sourceKind;
  if (kind === 'project' || kind === 'requirement') {
    const document = kind === 'project' ? schema.projectDocuments : schema.requirementDocuments;
    const revision = kind === 'project' ? schema.projectDocumentRevisions : schema.requirementDocumentRevisions;
    [row] = await db.select({ code: revision.code, revision: revision.revision,
      title: kind === 'project' ? schema.projectDocumentRevisions.title : schema.requirementDocuments.title,
      summary: revision.summary, body: sql<string>`substring(${revision.content} from 1 for ${maxChars + 1})`,
      binary: sql<boolean>`false`, totalChars: sql<number>`char_length(${revision.content})`, contentType: sql<string>`'text/markdown'` }).from(document)
      .innerJoin(revision, eq(revision.document_id, document.id)).where(and(eq(document.project_id, projectId), eq(document.code, resolved.objectCode), eq(revision.revision, revisionNumber))).limit(1);
  } else if (kind === 'architecture') {
    const d = schema.architectureDocuments, r = schema.architectureDocumentRevisions;
    const body = sql<string>`concat(${r.source_content}, case when ${r.notes_markdown} = '' then '' else E'\n\n' || ${r.notes_markdown} end)`;
    [row] = await db.select({ code: r.code, revision: r.revision, title: r.title, summary: r.summary,
      body: sql<string | null>`case when ${r.content_kind} = 'image' then null else substring(${body} from 1 for ${maxChars + 1}) end`,
      binary: sql<boolean>`${r.content_kind} = 'image'`, totalChars: sql<number>`case when ${r.content_kind} = 'image' then 0 else char_length(${body}) end`,
      contentType: sql<string>`case when ${r.content_kind} = 'image' then 'binary' when ${r.content_kind} = 'drawio' then 'application/xml' else 'text/markdown' end` }).from(d)
      .innerJoin(r, eq(r.document_id, d.id)).where(and(eq(d.project_id, projectId), eq(d.code, resolved.objectCode), eq(r.revision, revisionNumber))).limit(1);
  } else {
    const d = schema.testAssets, r = schema.testAssetRevisions;
    const body = sql<string>`concat(coalesce(${r.content_json}::jsonb ->> 'content', ''),
      case when ${r.content_json}::jsonb ->> 'url' is null then '' else E'\n\nURL: ' || (${r.content_json}::jsonb ->> 'url') end,
      case when ${r.content_json}::jsonb -> 'git' is null or ${r.content_json}::jsonb -> 'git' = 'null'::jsonb then '' else E'\n\nGit: ' || (${r.content_json}::jsonb -> 'git')::text end)`;
    [row] = await db.select({ code: r.code, revision: r.revision,
      title: sql<string>`coalesce(${r.content_json}::jsonb ->> 'title', ${d.title})`, summary: sql<string>`coalesce(${r.content_json}::jsonb ->> 'summary', ${d.summary})`,
      body: sql<string | null>`case when ${r.content_json}::jsonb ->> 'storage_kind' = 'file' then null else substring(${body} from 1 for ${maxChars + 1}) end`,
      binary: sql<boolean>`${r.content_json}::jsonb ->> 'storage_kind' = 'file'`,
      totalChars: sql<number>`case when ${r.content_json}::jsonb ->> 'storage_kind' = 'file' then 0 else char_length(${body}) end`,
      contentType: sql<string>`case when ${r.content_json}::jsonb ->> 'storage_kind' = 'file' then 'binary' else 'text/markdown' end` }).from(d)
      .innerJoin(r, eq(r.document_id, d.id)).where(and(eq(d.project_id, projectId), eq(d.code, resolved.objectCode), eq(r.revision, revisionNumber))).limit(1);
  }
  if (!row) throw new DomainError('material_not_found', '资料修订不存在');
  const resultMetadata: ProjectMaterialMetadata = { ...metadata, source: row.code,
    title: row.title.slice(0, 256).replace(/[\uD800-\uDBFF]$/u, ''), titleTruncated: row.title.length > 256,
    summary: (row.summary || metadata.summary).slice(0, 600).replace(/[\uD800-\uDBFF]$/u, ''),
    revision: row.revision, revisionCode: row.code, sourceCitation: row.code, textSearchable: !row.binary,
    contentType: row.contentType };
  return { metadata: resultMetadata, body: row.body, totalChars: row.totalChars, current: metadata.revisionCode === row.code,
    oversize: row.body !== null && row.body.length > maxChars };
}

export async function readCurrentProjectMaterialCandidate(db: AccessDb, locator: ProjectMaterialBodyLocator) {
  const [project] = await db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, locator.projectId)).limit(1);
  const catalog = await loadProjectMaterialCatalog(db, locator.projectId, locator);
  const current = catalog.items.find(row => row.sourceKind === locator.sourceKind && row.objectCode === locator.objectCode);
  if (!project || project.status !== 'active' || !current || current.status !== 'active' || current.revisionCode !== locator.revisionCode ||
      current.revision !== locator.revision || current.metadataHash !== locator.metadataHash) {
    throw new DomainError('material_source_stale', '资料来源已变化，请重新读取索引候选');
  }
  const result = await loadProjectMaterialBody(db, locator.projectId, locator);
  if (result.oversize) throw new DomainError('material_body_limit', '资料正文超过读取上限');
  const latest = await resolveCurrentProjectMaterialSource(db, { projectId: locator.projectId, sourceCitation: locator.revisionCode });
  if (!latest || latest.metadataHash !== locator.metadataHash) throw new DomainError('material_source_stale', '资料来源已变化，请重新读取索引候选');
  return { ...result, sha256: result.body === null ? null : materialHash(result.body) };
}

/** Current citation fence for workers/authorized memory resolution; historical read is a separate API. */
export async function resolveCurrentProjectMaterialSource(db: AccessDb, input: { projectId: bigint; sourceCitation: string }): Promise<ProjectMaterialCandidate | null> {
  const [project] = await db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, input.projectId)).limit(1);
  if (!project || project.status !== 'active') return null;
  let selector;
  try { selector = await findMaterialSource(db, input.projectId, input.sourceCitation); }
  catch (error) { if (error instanceof DomainError && error.code === 'material_not_found') return null; throw error; }
  const catalog = await loadProjectMaterialCatalog(db, input.projectId, selector);
  const row = catalog.items.find(item => item.sourceKind === selector.sourceKind && item.objectCode === selector.objectCode &&
    item.status === 'active' && item.sourceCitation === input.sourceCitation);
  return row ? { ...row, bodyLocator: { projectId: input.projectId, sourceKind: row.sourceKind, objectCode: row.objectCode,
    revision: row.revision, revisionCode: row.revisionCode, metadataHash: row.metadataHash } } : null;
}
