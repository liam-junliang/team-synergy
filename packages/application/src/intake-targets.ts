import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import type { IntakeKind, IntakeTarget } from '@team-synergy/contracts';
import type { AccessDb } from './project-access.js';

export function intakeHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v)).digest('hex');
}
export interface TargetRecord { id: bigint; target: IntakeTarget; moduleId?: bigint | null; featureId?: bigint | null; documentId?: bigint | null }
/** Project-scoped projection; fingerprints include every managed field, not just the body revision. */
export async function intakeTargets(db: AccessDb, projectId: bigint): Promise<TargetRecord[]> {
  const modules = await db.select().from(schema.projectModules).where(eq(schema.projectModules.project_id, projectId));
  const features = await db.select().from(schema.features).where(eq(schema.features.project_id, projectId));
  const documents = await db.select({ header: schema.requirementDocuments, revision: schema.requirementDocumentRevisions })
    .from(schema.requirementDocuments).innerJoin(schema.requirementDocumentRevisions, and(eq(schema.requirementDocumentRevisions.document_id, schema.requirementDocuments.id),
      eq(schema.requirementDocumentRevisions.revision, schema.requirementDocuments.current_revision))).where(eq(schema.requirementDocuments.project_id, projectId));
  const architectures = await db.select({ header: schema.architectureDocuments, revision: schema.architectureDocumentRevisions })
    .from(schema.architectureDocuments).innerJoin(schema.architectureDocumentRevisions, and(eq(schema.architectureDocumentRevisions.document_id, schema.architectureDocuments.id),
      eq(schema.architectureDocumentRevisions.revision, schema.architectureDocuments.current_revision))).where(eq(schema.architectureDocuments.project_id, projectId));
  const moduleMap = new Map(modules.map(row => [row.id, row]));
  const featureMap = new Map(features.map(row => [row.id, row]));
  const documentMap = new Map(documents.map(row => [row.header.id, row.header]));
  const requirements = modules.length || features.length || documents.length ? await db.select({ header: schema.requirements, revision: schema.requirementRevisions })
    .from(schema.requirements).innerJoin(schema.requirementRevisions, and(eq(schema.requirementRevisions.requirement_id, schema.requirements.id),
      eq(schema.requirementRevisions.revision, schema.requirements.current_revision))).where(and(ne(schema.requirements.state, 'deprecated'), or(
        modules.length ? inArray(schema.requirements.module_id, modules.map(row => row.id)) : undefined,
        features.length ? inArray(schema.requirements.feature_id, features.map(row => row.id)) : undefined,
        documents.length ? inArray(schema.requirements.document_id, documents.map(row => row.header.id)) : undefined))) : [];
  return [
    ...modules.filter(row => row.status === 'active').map(row => ({ id: row.id, target: { kind: 'module' as const, code: row.code, title: row.name,
      summary: row.description ?? '', content_markdown: row.description ?? '', fingerprint: intakeHash(row) } })),
    ...features.filter(row => row.status !== 'archived' && (!row.module_id || moduleMap.has(row.module_id))).map(row => ({ id: row.id, moduleId: row.module_id, target: {
      kind: 'feature' as const, code: row.code, title: row.title, module_code: row.module_id ? moduleMap.get(row.module_id)?.code ?? null : null,
      summary: row.goal ?? '', content_markdown: row.goal ?? '', fingerprint: intakeHash(row) } })),
    ...documents.filter(row => row.header.state === 'active' && (!row.header.module_id || moduleMap.has(row.header.module_id))).map(({ header, revision }) => ({ id: header.id, moduleId: header.module_id, target: {
      kind: 'requirement_document' as const, code: header.code, title: header.title, module_code: header.module_id ? moduleMap.get(header.module_id)?.code ?? null : null,
      summary: revision.summary, content_markdown: revision.content, fingerprint: intakeHash({ header, revision }) } })),
    ...architectures.map(({ header, revision }) => ({ id: header.id, target: { kind: 'architecture' as const, code: header.code, title: header.title,
      summary: header.summary, content_markdown: revision.notes_markdown,
      ...(revision.content_kind === 'mermaid' || revision.content_kind === 'drawio' ? { diagram: {
        content_kind: revision.content_kind, source_content: revision.source_content, preview_svg: revision.preview_svg,
      } } : {}), fingerprint: intakeHash({ header, revision }) } })),
    ...requirements.filter(({ header }) => (!header.module_id || moduleMap.has(header.module_id)) && (!header.feature_id || featureMap.has(header.feature_id)) && (!header.document_id || documentMap.has(header.document_id)))
      .map(({ header, revision }) => ({ id: header.id, moduleId: header.module_id, featureId: header.feature_id, documentId: header.document_id, target: {
        kind: 'requirement' as const, code: header.code, title: header.title, module_code: header.module_id ? moduleMap.get(header.module_id)?.code ?? null : null,
        summary: revision.summary ?? '', content_markdown: revision.summary ?? '', fingerprint: intakeHash({ header, revision }) } })),
  ];
}
export async function lockIntakeTarget(db: AccessDb, kind: IntakeKind, code: string) {
  // Revisions are immutable; locking the aggregate head keeps its fingerprint stable until the item commits.
  const table = { module: schema.projectModules, feature: schema.features, requirement_document: schema.requirementDocuments,
    requirement: schema.requirements, architecture: schema.architectureDocuments }[kind];
  await db.select({ id: table.id }).from(table).where(eq(table.code, code)).for('update');
}
