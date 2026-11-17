import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DomainError } from '@team-synergy/domain';
import { schema } from '@team-synergy/persistence';
import type { ProjectMaterialMetadata, ProjectMaterialSourceKind } from '@team-synergy/contracts';
import { DOCUMENT_LIBRARY_TEST_PURPOSES } from '@team-synergy/contracts';
import { assertProjectAccess, type AccessDb } from './project-access.js';

export const MATERIAL_CATALOG_LIMIT = 2000;
export interface ProjectMaterialBodyLocator {
  projectId: bigint; sourceKind: ProjectMaterialSourceKind; objectCode: string; revision: number;
  revisionCode: string; metadataHash: string;
}
export interface ProjectMaterialCandidate extends ProjectMaterialMetadata { bodyLocator: ProjectMaterialBodyLocator }
type Row = { objectCode: string; title: string; summary: string | null; excerpt: string | null; revision: number; revisionCode: string;
  status: string; contentType: string; updatedAt: string; folderCode: string | null; textSearchable: boolean };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const plain = (text: string) => text.replace(/<[^>]{0,500}>/g, ' ').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
function prefix(text: string, limit: number) {
  const end = limit < text.length && /[\uDC00-\uDFFF]/.test(text[limit] ?? '') && /[\uD800-\uDBFF]/.test(text[limit - 1] ?? '') ? limit - 1 : limit;
  return text.slice(0, end);
}
function metadata(row: Row, sourceKind: ProjectMaterialSourceKind, projectCode: string): ProjectMaterialMetadata {
  const authored = plain(row.summary ?? ''), excerpt = plain(row.excerpt ?? '');
  const summaryOrigin = authored ? 'authored' as const : excerpt ? 'excerpt' as const : 'title' as const;
  const value = { sourceKind, objectCode: row.objectCode, projectCode, path: `${sourceKind}/${row.objectCode}.md`, title: prefix(row.title, 256),
    titleTruncated: row.title.length > 256,
    summary: prefix(authored || excerpt || plain(row.title), 600), summaryOrigin, revision: row.revision,
    revisionCode: row.revisionCode, source: row.revisionCode, sourceCitation: row.revisionCode,
    status: row.status === 'archived' ? 'archived' as const : 'active' as const, state: 'documented' as const,
    contentType: row.contentType, textSearchable: row.textSearchable, updatedAt: row.updatedAt, folderCode: row.folderCode };
  return { ...value, metadataHash: hash(JSON.stringify(value)) };
}

/** Bounded metadata projection: complete bodies, images and attachment bytes stay in their original tables. */
export async function loadProjectMaterialCatalog(db: AccessDb, projectId: bigint, only?: { sourceKind?: ProjectMaterialSourceKind; objectCode?: string },
  options: { includeExecutionEvidence?: boolean } = {}) {
  const [project] = await db.select({ code: schema.projects.code }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!project) throw new DomainError('project_not_found', '项目不存在');
  const p = schema.projectDocuments, pr = schema.projectDocumentRevisions, f = schema.projectDocumentFolders;
  const r = schema.requirementDocuments, rr = schema.requirementDocumentRevisions;
  const a = schema.architectureDocuments, ar = schema.architectureDocumentRevisions;
  const t = schema.testAssets, tr = schema.testAssetRevisions;
  const queries = [
    only?.sourceKind && only.sourceKind !== 'project' ? undefined : db.select({ objectCode: p.code, title: p.title, summary: p.summary, excerpt: sql<string>`substring(${p.content} from 1 for 600)`,
      revision: p.revision, revisionCode: pr.code, status: p.status, contentType: sql<string>`'text/markdown'`, updatedAt: p.updated_at,
      folderCode: f.code, textSearchable: sql<boolean>`true` }).from(p).innerJoin(pr, and(eq(pr.document_id, p.id), eq(pr.revision, p.revision)))
      .leftJoin(f, eq(f.id, p.folder_id)).where(and(eq(p.project_id, projectId), only?.objectCode ? eq(p.code, only.objectCode) : undefined)).orderBy(asc(p.code)).limit(MATERIAL_CATALOG_LIMIT + 1),
    only?.sourceKind && only.sourceKind !== 'requirement' ? undefined : db.select({ objectCode: r.code, title: r.title, summary: rr.summary, excerpt: sql<string>`substring(${rr.content} from 1 for 600)`,
      revision: r.current_revision, revisionCode: rr.code, status: r.state, contentType: sql<string>`'text/markdown'`, updatedAt: r.updated_at,
      folderCode: sql<string | null>`null`, textSearchable: sql<boolean>`true` }).from(r).innerJoin(rr, and(eq(rr.document_id, r.id), eq(rr.revision, r.current_revision)))
      .where(and(eq(r.project_id, projectId), only?.objectCode ? eq(r.code, only.objectCode) : undefined)).orderBy(asc(r.code)).limit(MATERIAL_CATALOG_LIMIT + 1),
    only?.sourceKind && only.sourceKind !== 'architecture' ? undefined : db.select({ objectCode: a.code, title: a.title, summary: a.summary, excerpt: sql<string>`substring(${ar.notes_markdown} from 1 for 600)`,
      revision: a.current_revision, revisionCode: ar.code, status: sql<string>`'active'`, contentType: sql<string>`case when ${ar.content_kind} = 'image' then 'binary' when ${ar.content_kind} = 'drawio' then 'application/xml' else 'text/markdown' end`, updatedAt: a.updated_at,
      folderCode: sql<string | null>`null`, textSearchable: sql<boolean>`${ar.content_kind} <> 'image'` }).from(a).innerJoin(ar, and(eq(ar.document_id, a.id), eq(ar.revision, a.current_revision)))
      .where(and(eq(a.project_id, projectId), only?.objectCode ? eq(a.code, only.objectCode) : undefined)).orderBy(asc(a.code)).limit(MATERIAL_CATALOG_LIMIT + 1),
    only?.sourceKind && only.sourceKind !== 'testing' ? undefined : db.select({ objectCode: t.code, title: t.title, summary: t.summary,
      excerpt: sql<string>`substring(${tr.content_json}::jsonb ->> 'content' from 1 for 600)`, revision: t.current_revision, revisionCode: tr.code,
      status: sql<string>`'active'`, contentType: sql<string>`case when ${tr.content_json}::jsonb ->> 'storage_kind' = 'file' then 'binary' else 'text/markdown' end`, updatedAt: t.updated_at,
      folderCode: sql<string | null>`null`, textSearchable: sql<boolean>`coalesce(${tr.content_json}::jsonb ->> 'storage_kind', '') <> 'file'` }).from(t).innerJoin(tr, and(eq(tr.document_id, t.id), eq(tr.revision, t.current_revision)))
      .where(and(eq(t.project_id, projectId), only?.objectCode ? eq(t.code, only.objectCode) : undefined,
        options.includeExecutionEvidence ? undefined : inArray(sql<string>`${tr.content_json}::jsonb ->> 'purpose'`, [...DOCUMENT_LIBRARY_TEST_PURPOSES])))
      .orderBy(asc(t.code)).limit(MATERIAL_CATALOG_LIMIT + 1),
  ];
  // AccessDb can be one transaction connection. Execute lazily and serially instead of queuing concurrent pg queries.
  const groups: Row[][] = [];
  for (const query of queries) groups.push(query ? await query : []);
  const kinds = ['project', 'requirement', 'architecture', 'testing'] as const;
  return { items: groups.flatMap((rows, index) => {
    const kind = kinds[index];
    return !kind || only?.sourceKind && only.sourceKind !== kind ? [] : rows.slice(0, MATERIAL_CATALOG_LIMIT).map(row => metadata(row, kind, project.code));
  })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    truncated: groups.some(rows => rows.length > MATERIAL_CATALOG_LIMIT) };
}

export async function authorizeProjectMaterialQuery(db: AccessDb, actor: { principalCode: string; projectCode: string }) {
  const [principal] = await db.select().from(schema.users).where(eq(schema.users.code, actor.principalCode)).limit(1);
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.code, actor.projectCode)).limit(1);
  if (!principal) throw new DomainError('principal_not_found', '账号不存在');
  if (!project) throw new DomainError('project_not_found', '项目不存在');
  await assertProjectAccess(db, project.id, principal.id, 'read');
  return project;
}

/** Internal worker API: the caller owns a project-scoped job; no synthetic member identity. */
export async function listCurrentProjectMaterialCandidates(db: AccessDb, input: { projectId: bigint }): Promise<ProjectMaterialCandidate[]> {
  const [project] = await db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, input.projectId)).limit(1);
  if (!project || project.status !== 'active') return [];
  const catalog = await loadProjectMaterialCatalog(db, input.projectId);
  if (catalog.truncated) throw new DomainError('material_catalog_limit', '项目资料超过单轮索引扫描上限');
  return catalog.items.filter(row => row.status === 'active').map(row => ({ ...row, bodyLocator: {
    projectId: input.projectId, sourceKind: row.sourceKind, objectCode: row.objectCode,
    revision: row.revision, revisionCode: row.revisionCode, metadataHash: row.metadataHash,
  } }));
}
