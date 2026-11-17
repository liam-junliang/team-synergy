import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';
import type { IntakeQualityReport } from './intake-quality.js';

export const INTAKE_MAX_BYTES = 10 * 1024 * 1024;
export const INTAKE_SKILL_VERSION = '2.2.0';
export const IntakeKindSchema = z.enum(['module', 'feature', 'requirement_document', 'requirement', 'architecture']);
export type IntakeKind = z.infer<typeof IntakeKindSchema>;
export const IntakeProfileSchema = z.enum(['pilot', 'enterprise']);
export type IntakeProfile = z.infer<typeof IntakeProfileSchema>;
export const IntakeArtifactTypeSchema = z.enum([
  'charter', 'context', 'domain', 'requirements', 'nfr', 'architecture',
  'api_data', 'test_strategy', 'security', 'runbook', 'adr', 'onboarding', 'risk',
]);
export type IntakeArtifactType = z.infer<typeof IntakeArtifactTypeSchema>;
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
const text = z.string().trim().max(4000);
export const IntakeAcceptanceSchema = z.object({ id: key, text: text.min(1) }).strict();
export const IntakeSpecificationSchema = z.object({
  actor: text, trigger: text, preconditions: z.array(text).max(50), main_flow: z.array(text).max(100),
  exceptions: z.array(z.object({ condition: text, handling: text }).strict()).max(50),
  business_rules: z.array(text).max(100), state_changes: z.array(text).max(50), data_contracts: z.array(text).max(100),
}).strict();
export const IntakeVerificationPlanSchema = z.object({
  ac_id: key, method: z.enum(['manual', 'automated']), preconditions: text,
  steps: z.array(text).max(50), expected: text,
}).strict();
export const IntakeProductionSchema = z.object({
  version: z.literal('1.0'), scope_statement: z.string().trim().max(4000), discovery_status: z.enum(['partial', 'reviewed']),
  capabilities: z.array(z.object({
    key, title: z.string().trim().min(1).max(200), module_key: key.optional(), feature_key: key.optional(),
    disposition: z.enum(['included', 'excluded', 'unknown']), reason: text,
    requirement_keys: z.array(key).max(200), evidence: z.array(IntakeEvidenceSchema).max(100),
  }).strict()).max(500),
  conflicts: z.array(z.object({ key, summary: text.min(1), status: z.enum(['open', 'resolved']), resolution: text,
    evidence: z.array(IntakeEvidenceSchema).min(1).max(100) }).strict()).max(100),
}).strict();
export const IntakeItemSchema = z.object({
  key, kind: IntakeKindSchema, artifact_type: IntakeArtifactTypeSchema.optional(),
  title: z.string().trim().min(1).max(200), summary: z.string().max(2000),
  content_markdown: z.string().max(100000), module_key: key.optional(), feature_key: key.optional(), document_key: key.optional(),
  diagram_source: z.string().max(200000).optional(),
  evidence: z.array(IntakeEvidenceSchema).min(1).max(100),
  assessment: z.enum(['observed_in_code', 'documented', 'proposed', 'inferred', 'unknown']),
  acceptance_criteria: z.array(IntakeAcceptanceSchema).max(100).optional(),
  specification: IntakeSpecificationSchema.optional(),
  verification_plan: z.array(IntakeVerificationPlanSchema).max(200).optional(),
  tests: z.array(z.object({ path: sourcePath, name: z.string().min(1).max(500), status: z.enum(['defined', 'passed', 'failed', 'skipped', 'not_run']), note: z.string().max(2000).optional() }).strict()).max(100),
  gaps: z.array(z.string().max(2000)).max(50),
}).strict();
export const IntakeBundleSchema = z.object({
  schema_version: z.literal(1), project_code: PublicCodeSchema, repository_code: PublicCodeSchema.nullable(), namespace: key,
  profile: IntakeProfileSchema.default('pilot'),
  source: z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), dirty: z.boolean(), scope: z.array(z.string().refine(value => value === '.' || isIntakeSourcePath(value))).min(1).max(50),
    files: z.array(IntakeFileSchema).min(1).max(20000), manifest_sha256: hash, complete: z.boolean(), exclusions: z.array(z.string().max(1000)).max(200),
    analyzed_at: z.iso.datetime(), skill_version: z.string().min(1).max(100),
    mode: z.enum(['repository', 'materials', 'mixed']).optional(), include_untracked: z.boolean().optional(),
    inputs: z.array(z.object({ key, kind: z.enum(['code', 'document', 'team_note']), label: z.string().trim().min(1).max(200),
      prefix: z.string().refine(value => value === '.' || isIntakeSourcePath(value)), revision: z.string().max(200).optional(),
    }).strict()).min(1).max(50).optional(),
    production: IntakeProductionSchema.optional(),
  }).strict(), items: z.array(IntakeItemSchema).min(1).max(500),
}).strict().superRefine((bundle, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const files = new Map(bundle.source.files.map(file => [file.path, file.sha256]));
  const inputs = bundle.source.inputs;
  if (bundle.repository_code === null && bundle.source.mode !== 'materials') issue('A missing repository requires materials mode');
  if (bundle.source.mode === 'materials' && (bundle.repository_code !== null || bundle.source.commit !== null || bundle.source.dirty || bundle.source.include_untracked)) issue('Material sources cannot claim a repository or Git state');
  if ((bundle.source.mode || inputs) && (!bundle.source.mode || !inputs)) issue('Source mode and input provenance must be supplied together');
  if (inputs) {
    if (new Set(inputs.map(input => input.key)).size !== inputs.length) issue('Duplicate input key');
    const codeInputs = inputs.filter(input => input.kind === 'code');
    const materials = inputs.filter(input => input.kind !== 'code');
    if (codeInputs.length !== (bundle.source.mode === 'materials' ? 0 : 1)) issue('Source mode does not match code inputs');
    if ((bundle.source.mode === 'repository' && materials.length) || (bundle.source.mode !== 'repository' && !materials.length)) issue('Source mode does not match material inputs');
    if (codeInputs.some(input => input.prefix !== '.') || materials.some(input => input.prefix !== `materials/${input.key}`)) issue('Invalid input namespace');
    for (const file of bundle.source.files) {
      if (file.path.startsWith('materials/')) {
        if (!materials.some(input => file.path.startsWith(`${input.prefix}/`))) issue('File has no material provenance');
      } else if (!codeInputs.length) issue('Material file is outside its input namespace');
    }
  }
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
    if (item.artifact_type && !['requirement_document', 'architecture'].includes(item.kind)) issue(`Artifact type is only supported for documents: ${item.key}`);
    if (item.artifact_type === 'architecture' && item.kind !== 'architecture') issue(`Architecture artifact must use architecture kind: ${item.key}`);
    if (item.kind === 'architecture' && item.artifact_type && item.artifact_type !== 'architecture') issue(`Architecture kind requires architecture artifact type: ${item.key}`);
    if (['requirement_document', 'requirement'].includes(item.kind) && !item.content_markdown.trim()) issue(`Content is required: ${item.key}`);
    if (item.kind === 'requirement') {
      if (!item.module_key) issue('Requirement requires a module');
      for (const parentKey of [item.feature_key, item.document_key]) if (parentKey && items.get(parentKey)?.module_key !== item.module_key) issue(`Parent module mismatch: ${item.key}`);
    }
    if ((item.acceptance_criteria || item.specification || item.verification_plan) && !['requirement', 'requirement_document'].includes(item.kind)) issue(`Specification fields require a requirement or requirement document: ${item.key}`);
    const criteria = new Set(item.acceptance_criteria?.map(criterion => criterion.id));
    if (criteria.size !== (item.acceptance_criteria?.length ?? 0)) issue(`Duplicate acceptance criterion: ${item.key}`);
    for (const plan of item.verification_plan ?? []) if (!criteria.has(plan.ac_id)) issue(`Verification plan references missing acceptance criterion: ${item.key}`);
    if (inputs && item.assessment === 'observed_in_code' && !item.evidence.some(evidence => !evidence.path.startsWith('materials/'))) issue(`Code observation requires code evidence: ${item.key}`);
  }
  const production = bundle.source.production;
  if (production) {
    if (new Set(production.capabilities.map(capability => capability.key)).size !== production.capabilities.length) issue('Duplicate capability key');
    if (new Set(production.conflicts.map(conflict => conflict.key)).size !== production.conflicts.length) issue('Duplicate conflict key');
    for (const capability of production.capabilities) {
      if (capability.module_key && items.get(capability.module_key)?.kind !== 'module') issue(`Capability module is missing: ${capability.key}`);
      const feature = capability.feature_key && items.get(capability.feature_key);
      if (capability.feature_key && (!feature || feature.kind !== 'feature' || (capability.module_key && feature.module_key !== capability.module_key))) issue(`Capability feature is missing or belongs to another module: ${capability.key}`);
      if (new Set(capability.requirement_keys).size !== capability.requirement_keys.length) issue(`Duplicate capability requirement: ${capability.key}`);
      for (const ref of capability.requirement_keys) {
        const requirement = items.get(ref);
        if (requirement?.kind !== 'requirement' || (capability.module_key && requirement.module_key !== capability.module_key) || (capability.feature_key && requirement.feature_key !== capability.feature_key)) issue(`Capability requirement is missing or has inconsistent parents: ${capability.key}`);
      }
    }
    for (const record of [...production.capabilities, ...production.conflicts]) for (const evidence of record.evidence) if (files.get(evidence.path) !== evidence.sha256) issue(`Production evidence does not match source manifest: ${record.key}`);
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
export interface IntakeReviewInput { base_revision: number; decisions: IntakeDecision[]; profile?: IntakeProfile }
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
  code: string; project_code: string; repository_code: string | null; namespace: string; status: IntakeBatchStatus; revision: number;
  created_by: string; created_at: string; updated_at: string; item_count: number; applied_count: number; plan_hash: string | null;
  /** Null identifies historical rows whose original profile was not persisted. */
  profile: IntakeProfile | null;
}
export interface IntakeQualityGate {
  status: 'unknown' | 'blocked' | 'eligible' | 'stale'; blockers: number; warnings: number; needs_review: number; note: string;
}
export interface IntakeBatchDetail extends IntakeBatchSummary {
  source: IntakeBundle['source']; items: IntakeItemView[]; can_review: boolean; can_edit: boolean; stop_requested: boolean;
  targets: IntakeTarget[];
  quality_report: IntakeQualityReport | null; quality_rule_version: string | null; quality_gate: IntakeQualityGate;
  publication: { status: 'not_started' | 'in_progress' | 'partial' | 'completed'; created: number; bound: number; skipped: number; total: number };
  dossier: { required: number; present: number; missing: IntakeArtifactType[]; complete: boolean; published: number; bound: number; skipped: number; all_required_published: boolean; content_verified: false };
  approval: { status: 'not_requested'; note: string };
}
export interface IntakeList { can_submit: boolean; can_review: boolean; batches: IntakeBatchSummary[] }
export interface IntakeContext {
  project_code: string; repositories: Array<{ code: string; name: string }>; targets: IntakeTarget[];
  bindings: Array<{ repository_code: string | null; namespace: string; key: string; kind: IntakeKind; target_code: string }>; skill_version: string;
}

export const IntakeDecisionSchema = z.object({ key, action: z.enum(['create', 'bind', 'skip']), target_code: PublicCodeSchema.optional(), target_fingerprint: hash.optional() }).strict().superRefine((value, context) => {
  if (value.action === 'bind' ? !value.target_code || !value.target_fingerprint : value.target_code !== undefined || value.target_fingerprint !== undefined) context.addIssue({ code: 'custom', message: 'Only bind decisions require a target and its preview fingerprint' });
});
export const IntakeReviewSchema = z.object({ base_revision: z.number().int().positive(), decisions: z.array(IntakeDecisionSchema).min(1).max(500), profile: IntakeProfileSchema.optional() }).strict().refine(value => new Set(value.decisions.map(item => item.key)).size === value.decisions.length, 'Duplicate decision key');
export const IntakeApplySchema = z.object({ plan_hash: hash, idempotency_key: key }).strict();
export const IntakeSubmitSchema = z.object({ bundle: IntakeBundleSchema, idempotency_key: key }).strict();
export const IntakeReplaceSchema = z.object({ bundle: IntakeBundleSchema, base_revision: z.number().int().positive() }).strict();
export const IntakeStopSchema = z.object({ base_revision: z.number().int().positive() }).strict();
