import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';

export const INTAKE_MAX_BYTES = 10 * 1024 * 1024;
export const INTAKE_SKILL_VERSION = '1.0.0';
export const IntakeKindSchema = z.enum(['module', 'feature', 'requirement_document', 'requirement', 'architecture']);
export type IntakeKind = z.infer<typeof IntakeKindSchema>;
const key = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export function isIntakeSourcePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !/[\\:]/.test(value) && !value.startsWith('/')
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
    && !value.split('/').some(segment => /^(?:\.git|node_modules|\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(segment))
    && !/\.(?:pem|key|p12|pfx)$/i.test(value);
}
const sourcePath = z.string().refine(isIntakeSourcePath, 'Expected a safe repository-relative source path');
export const IntakeFileSchema = z.object({ path: sourcePath, sha256: hash }).strict();
export const IntakeEvidenceSchema = z.object({ path: sourcePath, sha256: hash, line_start: z.number().int().positive(), line_end: z.number().int().positive(), symbol: z.string().max(300).optional() }).strict().refine(value => value.line_end >= value.line_start, 'Invalid evidence range');
export const IntakeItemSchema = z.object({
  key, kind: IntakeKindSchema, title: z.string().trim().min(1).max(200), summary: z.string().max(2000),
  content_markdown: z.string().max(100000), module_key: key.optional(), feature_key: key.optional(), document_key: key.optional(),
  diagram_source: z.string().max(200000).optional(),
  evidence: z.array(IntakeEvidenceSchema).min(1).max(100),
  assessment: z.enum(['observed_in_code', 'inferred', 'unknown']),
  tests: z.array(z.object({ path: sourcePath, name: z.string().min(1).max(500), status: z.enum(['defined', 'passed', 'failed', 'skipped', 'not_run']), note: z.string().max(2000).optional() }).strict()).max(100),
  gaps: z.array(z.string().max(2000)).max(50),
}).strict();
export const IntakeBundleSchema = z.object({
  schema_version: z.literal(1), project_code: PublicCodeSchema, repository_code: PublicCodeSchema, namespace: key,
  source: z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean(), scope: z.array(z.string().refine(value => value === '.' || isIntakeSourcePath(value))).min(1).max(50),
    files: z.array(IntakeFileSchema).min(1).max(20000), manifest_sha256: hash, complete: z.boolean(), exclusions: z.array(z.string().max(1000)).max(200),
    analyzed_at: z.iso.datetime(), skill_version: z.string().min(1).max(100),
  }).strict(), items: z.array(IntakeItemSchema).min(1).max(500),
}).strict().superRefine((bundle, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const files = new Map(bundle.source.files.map(file => [file.path, file.sha256]));
  if (files.size !== bundle.source.files.length) issue('Duplicate source file');
  for (const file of bundle.source.files) if (!bundle.source.scope.some(scope => scope === '.' || file.path === scope || file.path.startsWith(`${scope}/`))) issue('Source file is outside the declared scan scope');
  const items = new Map(bundle.items.map(item => [item.key, item]));
  if (items.size !== bundle.items.length) issue('Duplicate candidate key');
  for (const item of bundle.items) {
    for (const evidence of item.evidence) if (files.get(evidence.path) !== evidence.sha256) issue(`Evidence does not match source manifest: ${item.key}`);
    for (const test of item.tests) if (!files.has(test.path)) issue(`Test is absent from source manifest: ${item.key}`);
    for (const [field, kind] of [['module_key', 'module'], ['feature_key', 'feature'], ['document_key', 'requirement_document']] as const) {
      const target = item[field];
      if (target && (items.get(target)?.kind !== kind || target === item.key)) issue(`Invalid ${field}: ${item.key}`);
    }
    if (item.kind === 'module' && (item.module_key || item.feature_key || item.document_key)) issue('Modules cannot have candidate parents');
    if (item.kind === 'feature' && (!item.module_key || item.feature_key || item.document_key)) issue('Feature requires only a module parent');
    if (item.kind === 'requirement_document' && (!item.module_key || item.feature_key || item.document_key)) issue('Requirement document requires only a module parent');
    if (item.kind === 'architecture' && (item.module_key || item.feature_key || item.document_key || !item.diagram_source?.trim())) issue('Architecture requires Mermaid source and no candidate parents');
    if (item.kind !== 'architecture' && item.diagram_source !== undefined) issue('Diagram source is only supported for architecture');
    if (['requirement_document', 'requirement'].includes(item.kind) && !item.content_markdown.trim()) issue(`Content is required: ${item.key}`);
    if (item.kind === 'requirement') {
      if (!item.module_key) issue('Requirement requires a module');
      for (const parentKey of [item.feature_key, item.document_key]) if (parentKey && items.get(parentKey)?.module_key !== item.module_key) issue(`Parent module mismatch: ${item.key}`);
    }
  }
  const content = JSON.stringify(bundle);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|https?:\/\/[^\s"/]+:[^\s"/]+@/i.test(content)) issue('Potential credential in candidate package');
});
export type IntakeBundle = z.infer<typeof IntakeBundleSchema>;
export type IntakeItem = z.infer<typeof IntakeItemSchema>;
/** SHA-256 of this UTF-8 string. Paths sorted by JS ordinal comparison, never locale sort. */
export function intakeManifestText(files: Array<{ path: string; sha256: string }>): string {
  return [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => `${file.path}\0${file.sha256}\n`).join('');
}
export type IntakeDecision = { key: string; action: 'create' | 'bind' | 'skip'; target_code?: string; target_fingerprint?: string };
export interface IntakeReviewInput { base_revision: number; decisions: IntakeDecision[] }
export interface IntakeApplyInput { plan_hash: string; idempotency_key: string }
export interface IntakeTarget {
  kind: IntakeKind; code: string; title: string; fingerprint: string; module_code?: string | null; summary?: string; content_markdown?: string;
  diagram?: { content_kind: 'mermaid' | 'drawio'; source_content: string; preview_svg: string | null };
}
export interface IntakeItemView {
  item: IntakeItem; decision: IntakeDecision | null; status: 'pending' | 'applied' | 'bound' | 'skipped' | 'failed' | 'blocked';
  target_code: string | null; error: string | null; existing_binding: IntakeTarget | null;
}
export type IntakeBatchStatus = 'draft' | 'ready' | 'applying' | 'applied' | 'partial' | 'cancelled' | 'stopped';
export interface IntakeBatchSummary {
  code: string; project_code: string; repository_code: string; namespace: string; status: IntakeBatchStatus; revision: number;
  created_by: string; created_at: string; updated_at: string; item_count: number; applied_count: number; plan_hash: string | null;
}
export interface IntakeBatchDetail extends IntakeBatchSummary {
  source: IntakeBundle['source']; items: IntakeItemView[]; can_review: boolean; can_edit: boolean; stop_requested: boolean;
  targets: IntakeTarget[];
}
export interface IntakeList { can_submit: boolean; can_review: boolean; batches: IntakeBatchSummary[] }
export interface IntakeContext {
  project_code: string; repositories: Array<{ code: string; name: string }>; targets: IntakeTarget[];
  bindings: Array<{ repository_code: string; namespace: string; key: string; kind: IntakeKind; target_code: string }>; skill_version: string;
}

export const IntakeDecisionSchema = z.object({ key, action: z.enum(['create', 'bind', 'skip']), target_code: PublicCodeSchema.optional(), target_fingerprint: hash.optional() }).strict().superRefine((value, context) => {
  if (value.action === 'bind' ? !value.target_code || !value.target_fingerprint : value.target_code !== undefined || value.target_fingerprint !== undefined) context.addIssue({ code: 'custom', message: 'Only bind decisions require a target and its preview fingerprint' });
});
export const IntakeReviewSchema = z.object({ base_revision: z.number().int().positive(), decisions: z.array(IntakeDecisionSchema).min(1).max(500) }).strict().refine(value => new Set(value.decisions.map(item => item.key)).size === value.decisions.length, 'Duplicate decision key');
export const IntakeApplySchema = z.object({ plan_hash: hash, idempotency_key: key }).strict();
export const IntakeSubmitSchema = z.object({ bundle: IntakeBundleSchema, idempotency_key: key }).strict();
export const IntakeReplaceSchema = z.object({ bundle: IntakeBundleSchema, base_revision: z.number().int().positive() }).strict();
export const IntakeStopSchema = z.object({ base_revision: z.number().int().positive() }).strict();
