import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import type { AccessDb } from './project-access.js';
import { listCurrentProjectMaterialCandidates } from './project-material-catalog.js';

const versions = schema.projectMaterialIndexVersions;

/** Called inside the caller's project transaction. No body or binary is loaded. */
export async function reconcileProjectMaterialIndexes(tx: AccessDb, projectId: bigint) {
  const candidates = await listCurrentProjectMaterialCandidates(tx, { projectId });
  const current = await tx.select().from(versions).where(and(eq(versions.project_id, projectId), eq(versions.active, true)));
  const key = (row: { sourceKind: string; objectCode: string }) => row.sourceKind + ':' + row.objectCode;
  const wanted = new Map(candidates.map(row => [key(row), row]));
  let retired = 0, queued = 0;
  for (const previous of current) {
    const next = wanted.get(previous.source_kind + ':' + previous.object_code);
    if (next && next.revisionCode === previous.revision_code && next.metadataHash === previous.metadata_hash) {
      wanted.delete(key(next)); continue;
    }
    await tx.update(versions).set({ active: false, retired_at: new Date() }).where(eq(versions.id, previous.id));
    // A generation change also compensates an interrupted/late write to this
    // immutable remote name. Withdrawal never waits for remote cleanup.
    await tx.execute(sql`update memory_projection_jobs set operation='delete',generation=generation+1,
      status='pending',lease_until=null,last_error=null where material_index_id=${previous.id}`);
    retired++;
  }
  for (const candidate of wanted.values()) {
    const [row] = await tx.insert(versions).values({ project_id: projectId, source_kind: candidate.sourceKind,
      object_code: candidate.objectCode, revision: candidate.revision, revision_code: candidate.revisionCode,
      metadata_hash: candidate.metadataHash, source_citation: candidate.sourceCitation, path: candidate.path,
      title: candidate.title, summary: candidate.summary, summary_origin: candidate.summaryOrigin, text_searchable: candidate.textSearchable,
    }).returning({ id: versions.id });
    if (!row) throw Error('material_index_insert_failed');
    await tx.insert(schema.memoryProjectionJobs).values({ material_index_id: row.id, engine: 'tencent' }); queued++;
  }
  // Historical native-document full copies are retired, including uncertain
  // deliveries. Only the dedicated compatibility cleanup may read their body.
  const legacy = await tx.execute(sql`update memory_projection_jobs j set operation='delete',generation=j.generation+1,
    status=case when j.attempts=0 and j.external_ref is null then 'synced' else 'pending' end,
    lease_until=null,last_error=null from project_document_revisions r join project_documents d on d.id=r.document_id
    where j.project_document_revision_id=r.id and d.project_id=${projectId} and j.operation='upsert' returning j.id`);
  if (retired || queued || legacy.rows.length) await tx.insert(schema.projectMaterialIndexEvents).values({ project_id: projectId,
    action: 'material_indexes.reconciled', payload: JSON.stringify({ retired, queued, legacyCopiesRetired: legacy.rows.length }) });
  return { retired, queued, legacyCopiesRetired: legacy.rows.length };
}
