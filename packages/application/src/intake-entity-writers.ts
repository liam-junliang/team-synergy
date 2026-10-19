import { and, eq, max } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { assertProjectAccess, type AccessDb } from './project-access.js';
import { createPublicCode } from './public-code.js';
import { insertAudit, now } from './task-service.js';
import { architectureText, normalizeArchitectureContent, type ArchitectureContent } from './architecture-document-content.js';

type Scope = { projectId: bigint; projectCode: string; principalId: bigint };
export async function intakeAudit(tx: AccessDb, scope: Scope, entityType: string, entityId: bigint, action: string, payload: Record<string, unknown>, to?: string) {
  await insertAudit(tx, toAuditEvent({ entity_type: entityType, entity_id: entityId, principal_id: scope.principalId,
    base_snapshot: 0, action, payload, ...(to ? { to } : {}) }, createPublicCode(), now()));
}
function required(value: string, code: string) { if (!value.trim()) throw new DomainError(code, '标题或正文不能为空'); return value.trim(); }
async function moduleInProject(tx: AccessDb, scope: Scope, id: bigint | null) {
  if (id === null) return null;
  const [module] = await tx.select().from(schema.projectModules).where(and(eq(schema.projectModules.id, id), eq(schema.projectModules.project_id, scope.projectId))).limit(1);
  if (!module) throw new DomainError('module_not_found', '功能模块不属于当前项目');
  return module;
}

/** Shared create writers: callers own the transaction and system-folder initialization. */
export async function writeProjectModule(tx: AccessDb, scope: Scope, input: { name: string; description?: string | null; sortOrder?: number; status?: 'active' | 'archived' }) {
  await assertProjectAccess(tx, scope.projectId, scope.principalId, 'manage');
  const name = required(input.name, 'module_name_required');
  const [last] = await tx.select({ value: max(schema.projectModules.sort_order) }).from(schema.projectModules).where(eq(schema.projectModules.project_id, scope.projectId));
  const timestamp = now();
  const [row] = await tx.insert(schema.projectModules).values({ code: createPublicCode(), project_id: scope.projectId,
    name, description: input.description?.trim() || null, sort_order: input.sortOrder ?? (last?.value ?? -1) + 1,
    status: input.status ?? 'active', created_at: timestamp, updated_at: timestamp }).returning();
  if (!row) throw new DomainError('internal_error', '功能模块创建失败');
  await intakeAudit(tx, scope, 'project_module', row.id, 'project_module.created', { project_code: scope.projectCode, name });
  return row;
}
export async function writeFeature(tx: AccessDb, scope: Scope, input: { title: string; goal?: string | null; moduleId?: bigint | null;
  milestoneId?: bigint | null; milestoneCode?: string | null; startDate?: string | null; endDate?: string | null; status?: 'active' | 'delivered' | 'archived' }) {
  await assertProjectAccess(tx, scope.projectId, scope.principalId, 'manage');
  const module = await moduleInProject(tx, scope, input.moduleId ?? null);
  const title = required(input.title, 'feature_title_required');
  const [last] = await tx.select({ value: max(schema.features.sort_order) }).from(schema.features).where(eq(schema.features.project_id, scope.projectId));
  const [row] = await tx.insert(schema.features).values({ code: createPublicCode(), project_id: scope.projectId, title,
    goal: input.goal?.trim() || null, module_id: input.moduleId ?? null, milestone_id: input.milestoneId ?? null,
    start_date: input.startDate ?? null, end_date: input.endDate ?? null, sort_order: (last?.value ?? -1) + 1, status: input.status ?? 'active' }).returning();
  if (!row) throw new DomainError('internal_error', 'Feature 创建失败');
  await intakeAudit(tx, scope, 'feature', row.id, 'feature.created', { title, project_code: scope.projectCode, module_code: module?.code ?? null,
    milestone_code: input.milestoneCode ?? null, start_date: row.start_date, end_date: row.end_date, status: row.status });
  return row;
}
export async function writeRequirementDocument(tx: AccessDb, scope: Scope, input: { moduleId: bigint; moduleKey: string; title: string; summary: string; content: string; keywords: string[] }) {
  await assertProjectAccess(tx, scope.projectId, scope.principalId, 'write');
  const module = await moduleInProject(tx, scope, input.moduleId);
  const title = required(input.title, 'requirement_document_title_required');
  const summary = required(input.summary, 'requirement_document_summary_required');
  const content = required(input.content.replace(/\r\n/g, '\n'), 'requirement_document_content_required');
  const timestamp = now();
  const [document] = await tx.insert(schema.requirementDocuments).values({ code: createPublicCode(), project_id: scope.projectId,
    module_id: input.moduleId, module_key: input.moduleKey, title, state: 'active', current_revision: 1,
    owner_principal_id: scope.principalId, created_at: timestamp, updated_at: timestamp }).returning();
  if (!document) throw new DomainError('internal_error', '需求文档创建失败');
  const [revision] = await tx.insert(schema.requirementDocumentRevisions).values({ code: createPublicCode(), document_id: document.id,
    revision: 1, summary, content, keywords: JSON.stringify(input.keywords), change_summary: '创建需求文档', created_by: scope.principalId, created_at: timestamp }).returning();
  if (!revision) throw new DomainError('internal_error', '需求文档修订创建失败');
  await intakeAudit(tx, scope, 'requirement_document', document.id, 'requirement_document.created', { project_code: scope.projectCode,
    module_code: module?.code, module_key: input.moduleKey, title, revision: 1 }, 'active');
  return { document, revision };
}
export async function writeRequirement(tx: AccessDb, scope: Scope, input: { moduleId: bigint | null; featureId: bigint | null; documentId: bigint | null;
  title: string; body: string; acceptanceCriteria: unknown[]; openQuestions: string[] }) {
  await assertProjectAccess(tx, scope.projectId, scope.principalId, 'write');
  const module = await moduleInProject(tx, scope, input.moduleId);
  const [feature] = input.featureId === null ? [] : await tx.select().from(schema.features).where(eq(schema.features.id, input.featureId)).limit(1);
  const [document] = input.documentId === null ? [] : await tx.select().from(schema.requirementDocuments).where(eq(schema.requirementDocuments.id, input.documentId)).limit(1);
  if (input.featureId !== null && (!feature || feature.project_id !== scope.projectId)) throw new DomainError('feature_not_found', 'Feature 不属于当前项目');
  if (input.documentId !== null && (!document || document.project_id !== scope.projectId)) throw new DomainError('requirement_document_not_found', '需求文档不属于当前项目');
  if (!module && !feature && !document) throw new DomainError('requirement_scope_required', '需求必须关联有效项目上下文');
  if (module && ((feature?.module_id && feature.module_id !== module.id) || (document?.module_id && document.module_id !== module.id))) throw new DomainError('requirement_binding_mismatch', '需求关联的模块不一致');
  const title = required(input.title, 'requirement_title_required'), body = required(input.body, 'requirement_body_required');
  const [requirement] = await tx.insert(schema.requirements).values({ code: createPublicCode(), feature_id: input.featureId, module_id: input.moduleId,
    document_id: input.documentId, title, current_revision: 1, state: 'draft', owner_principal_id: scope.principalId }).returning();
  if (!requirement) throw new DomainError('internal_error', '需求创建失败');
  const [revision] = await tx.insert(schema.requirementRevisions).values({ code: createPublicCode(), requirement_id: requirement.id, revision: 1,
    summary: body, acceptance_criteria: JSON.stringify(input.acceptanceCriteria), open_questions: JSON.stringify(input.openQuestions), created_at: now() }).returning();
  if (!revision) throw new DomainError('internal_error', '需求版本创建失败');
  await intakeAudit(tx, scope, 'requirement', requirement.id, 'requirement.created', { feature_code: feature?.code ?? null, module_code: module?.code ?? null,
    document_code: document?.code ?? null, title, revision: 1 }, 'draft');
  return { requirement, revision };
}
export async function writeArchitecture(tx: AccessDb, scope: Scope, input: { title: string; summary: string; content: ArchitectureContent }) {
  await assertProjectAccess(tx, scope.projectId, scope.principalId, 'write');
  const title = architectureText(input.title, '标题', 512, true), summary = architectureText(input.summary, '摘要', 4096);
  const content = normalizeArchitectureContent({ contentKind: input.content.content_kind, sourceContent: input.content.source_content,
    notesMarkdown: input.content.notes_markdown, previewSvg: input.content.preview_svg });
  const timestamp = now();
  const [row] = await tx.insert(schema.architectureDocuments).values({ code: createPublicCode(), project_id: scope.projectId, title, summary,
    content_kind: content.content_kind, current_revision: 1, owner_principal_id: scope.principalId, created_at: timestamp, updated_at: timestamp }).returning();
  if (!row) throw new DomainError('internal_error', '创建架构资料失败');
  await tx.insert(schema.architectureDocumentRevisions).values({ code: createPublicCode(), document_id: row.id, revision: 1,
    title, summary, ...content, change_summary: '初始版本', created_by: scope.principalId, created_at: timestamp });
  await intakeAudit(tx, scope, 'architecture_document', row.id, 'architecture_document.created', { document_code: row.code, revision: 1, content_kind: content.content_kind });
  return row;
}
