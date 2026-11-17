import { schema } from '@team-synergy/persistence';
import type { AccessDb } from './project-access.js';
import { eq } from 'drizzle-orm';
import { reconcileProjectMaterialIndexes } from './project-material-index.js';

/** Maintain only derived directory metadata in the native document transaction. */
export async function enqueueProjectDocumentMemory(tx: AccessDb, revisionId: bigint): Promise<void> {
  const [row] = await tx.select({ projectId: schema.projectDocuments.project_id }).from(schema.projectDocumentRevisions)
    .innerJoin(schema.projectDocuments, eq(schema.projectDocuments.id, schema.projectDocumentRevisions.document_id))
    .where(eq(schema.projectDocumentRevisions.id, revisionId)).limit(1);
  if (row) await reconcileProjectMaterialIndexes(tx, row.projectId);
}
