import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import type { AccessDb } from './project-access.js';
import { listCurrentProjectMaterialCandidates } from './project-material-catalog.js';

const versions = schema.projectMaterialIndexVersions, jobs = schema.memoryProjectionJobs;
/** Index matches are discovery hints. Current original PG revision and project ACL (caller) remain authoritative. */
export async function projectMaterialMemoryEvidence(tx: AccessDb, projectId: bigint, input: {
  query?: string; engineRefs?: readonly string[]; sources?: readonly string[]; limit?: number;
} = {}) {
  if (input.sources && !input.sources.length) return [];
  const refs = input.engineRefs ?? [];
  // Resolve the authoritative catalog once, rather than rereading four catalogs per evidence row.
  const currentSources = new Map((await listCurrentProjectMaterialCandidates(tx, { projectId })).map(row => [row.sourceCitation, row]));
  const rows = await tx.select({ index: versions, externalRef: jobs.external_ref, projectionStatus: jobs.status, operation: jobs.operation })
    .from(versions).leftJoin(jobs, eq(jobs.material_index_id, versions.id))
    .where(and(eq(versions.project_id, projectId), eq(versions.active, true),
      input.sources ? inArray(versions.source_citation, [...input.sources]) : undefined)).limit(8000);
  const output = [];
  for (const row of rows) {
    const semantic = row.projectionStatus === 'synced' && row.operation === 'upsert' &&
      (refs.includes(row.externalRef ?? '') || refs.includes(row.index.code));
    const literal = input.query ? `${row.index.path} ${row.index.title} ${row.index.summary} ${row.index.object_code} ${row.index.source_citation}`
      .toLocaleLowerCase().includes(input.query.toLocaleLowerCase()) : false;
    if (input.query && !literal && !semantic) continue;
    const current = currentSources.get(row.index.source_citation);
    if (!current || current.metadataHash !== row.index.metadata_hash || current.revisionCode !== row.index.revision_code) continue;
    output.push({ literal, externalRef: row.externalRef, data: {
      source: current.sourceCitation, sourceKind: 'project_material' as const, materialSourceKind: current.sourceKind,
      scope: 'project' as const, state: 'documented' as const, documentCode: current.objectCode, objectCode: current.objectCode,
      sourceRevision: current.revision, title: current.title, titleTruncated: current.titleTruncated, text: `${current.title}\n${current.summary}`,
      path: current.path, summaryOrigin: current.summaryOrigin, textSearchable: current.textSearchable,
      locator: { sourceCitation: current.sourceCitation }, metadataHash: current.metadataHash,
      evidenceStatus: '这是当前资料的索引卡。记载不代表方案已确认或实际落实；正文请按locator调用read_project_material。',
    } });
  }
  return output.sort((a, b) => Number(b.literal) - Number(a.literal) ||
    ((refs.indexOf(a.externalRef ?? '') + 1 || Number.MAX_SAFE_INTEGER) - (refs.indexOf(b.externalRef ?? '') + 1 || Number.MAX_SAFE_INTEGER)))
    .slice(0, input.limit ?? 30);
}
