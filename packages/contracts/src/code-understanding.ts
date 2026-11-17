import { z } from 'zod';
import { PublicCodeSchema } from './schemas.js';
import { isIntakeSourcePath } from './intake.js';

export const CODE_UNDERSTANDING_MAX_BYTES = 32 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(500).refine(value => !Array.from(value).some(character => character.charCodeAt(0) < 32), 'Invalid identifier');
const path = z.string().refine(isIntakeSourcePath, 'Expected a safe repository-relative path');
const note = z.string().max(4000);
export const CodePluginSchema = z.object({ plugin_id: z.enum(['ua', 'codegraph']), engine_version: z.string().min(1).max(80), adapter_version: z.string().min(1).max(80), protocol_version: z.literal(1), engine_digest: hash.optional() }).strict();
export const CodeSnapshotSchema = z.object({
  snapshot_id: hash, kind: z.enum(['commit', 'draft']), commit: z.string().regex(/^[a-f0-9]{40,64}$/), tree: z.string().regex(/^[a-f0-9]{40,64}$/),
  manifest_sha256: hash, captured_at: z.iso.datetime(), scope: z.array(z.string().max(500)).max(100), exclusions: z.array(z.string().max(500)).max(500),
  files: z.array(z.object({ path, sha256: hash, line_count: z.number().int().nonnegative(), byte_count: z.number().int().nonnegative() }).strict()).max(20000),
}).strict().superRefine((value, ctx) => { if (new Set(value.files.map(file => file.path)).size !== value.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source paths' }); });
export const CodeEvidenceSchema = z.object({ id: key, path, sha256: hash, line_start: z.number().int().positive(), line_end: z.number().int().positive(), snippet: z.string().max(1200).optional() }).strict();
export const CodeDomainMetaSchema = z.object({ entities: z.array(note).max(100).optional(), businessRules: z.array(note).max(100).optional(), userPurposes: z.array(note).max(100).optional(), unknowns: z.array(note).max(100).optional(), crossDomainInteractions: z.array(note).max(100).optional(), entryPoint: z.string().max(500).optional(), entryType: z.enum(['http', 'cli', 'event', 'cron', 'manual']).optional() }).strict();
export const CodeNodeSchema = z.object({ id: key, provider: z.enum(['ua', 'codegraph']), native_id: key, kind: z.string().min(1).max(80), label: z.string().min(1).max(300), summary: note.optional(), path: path.optional(), line_start: z.number().int().positive().optional(), line_end: z.number().int().positive().optional(), layer: z.string().max(200).optional(), evidence_ids: z.array(key).max(100), verification: z.enum(['observed', 'inferred', 'unresolved']), domain_meta: CodeDomainMetaSchema.optional() }).strict();
export const CodeEdgeSchema = z.object({ id: key, source: key, target: key, type: z.string().min(1).max(80), provider: z.enum(['ua', 'codegraph', 'bridge']), provenance: z.enum(['native', 'inferred', 'agent']), evidence_ids: z.array(key).max(100), verification: z.enum(['observed', 'inferred', 'unresolved']) }).strict();
/** UA 2.9.8 rendering contract. No passthrough metadata, article bodies or file contents. */
export const CodeUaGraphSchema = z.object({
  version: z.string().min(1).max(80), kind: z.literal('codebase').optional(),
  project: z.object({ name: z.string().min(1).max(300), languages: z.array(z.string().max(100)).max(100), frameworks: z.array(z.string().max(100)).max(100), description: note, analyzedAt: z.iso.datetime(), gitCommitHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) }).strict(),
  nodes: z.array(z.object({
    id: key, type: z.enum(['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource', 'domain', 'flow', 'step', 'article', 'entity', 'topic', 'claim', 'source', 'page', 'screen', 'component', 'componentSet', 'instance', 'token']),
    name: z.string().min(1).max(300), filePath: path.optional(), lineRange: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    summary: note, tags: z.array(z.string().max(100)).max(100), complexity: z.enum(['simple', 'moderate', 'complex']), languageNotes: note.optional(),
    domainMeta: CodeDomainMetaSchema.optional(),
  }).strict()).max(25000),
  edges: z.array(z.object({ source: key, target: key, type: z.enum(['imports', 'exports', 'contains', 'inherits', 'implements', 'calls', 'subscribes', 'publishes', 'middleware', 'reads_from', 'writes_to', 'transforms', 'validates', 'depends_on', 'tested_by', 'configures', 'related', 'similar_to', 'deploys', 'serves', 'provisions', 'triggers', 'migrates', 'documents', 'routes', 'defines_schema', 'contains_flow', 'flow_step', 'cross_domain', 'cites', 'contradicts', 'builds_on', 'exemplifies', 'categorized_under', 'authored_by', 'instance_of', 'variant_of', 'uses_token']), direction: z.enum(['forward', 'backward', 'bidirectional']), description: note.optional(), weight: z.number().min(0).max(1) }).strict()).max(100000),
  layers: z.array(z.object({ id: key, name: z.string().max(200), description: note, nodeIds: z.array(key).max(25000) }).strict()).max(500),
  tour: z.array(z.object({ order: z.number().int().nonnegative(), title: z.string().max(200), description: note, nodeIds: z.array(key).max(100), languageLesson: note.optional() }).strict()).max(100),
}).strict();
export type CodeUaGraph = z.infer<typeof CodeUaGraphSchema>;
const semanticCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CodeSemanticFileCoverageSchema = z.object({
  path, sha256: hash, total_bytes: semanticCount, covered_bytes: semanticCount,
  segments: z.array(z.object({ id: key, byte_start: semanticCount, byte_end: semanticCount, input_sha256: hash, completed: z.literal(true), line_start: semanticCount, line_end: semanticCount }).strict()).min(1).max(100000),
}).strict();
/** Runner input-processing and source attribution statements, not proof of model reasoning or correctness. */
export const CodeSemanticAnalysisSchema = z.object({
  protocol_version: z.literal(2), mode: z.literal('full'), snapshot_id: hash, manifest_sha256: hash, prompt_version: z.string().min(1).max(100),
  file_coverage: z.array(CodeSemanticFileCoverageSchema).max(20000),
  node_evidence: z.array(z.object({ node_id: key, evidence_ids: z.array(key).min(1).max(100) }).strict()).max(25000),
  relation_evidence: z.array(z.object({ edge_id: key, source: key, target: key, type: z.string().min(1).max(80), basis: z.enum(['native_dependency', 'semantic_inference']), evidence_ids: z.array(key).min(1).max(100), native_ids: z.array(key).max(100) }).strict()).max(100000),
  counts: z.object({ total_files: semanticCount, total_bytes: semanticCount, covered_bytes: semanticCount, total_segments: semanticCount, completed_segments: semanticCount, supported_nodes: semanticCount, supported_relations: semanticCount, native_dependency_relations: semanticCount, semantic_inference_relations: semanticCount, unresolved_items: semanticCount }).strict(),
  uncertainty: z.object({ semantic_correctness: z.literal('requires_independent_evaluation'), unresolved_items: semanticCount, limitations: z.array(note).max(20) }).strict(),
}).strict();
export type CodeSemanticAnalysis = z.infer<typeof CodeSemanticAnalysisSchema>;
/** Declared execution origins; retained cache responses are not relabelled as the current route. */
const semanticModel = z.string().min(1).max(200);
const CodeSemanticAuthorSchema = z.object({
  kind: z.literal('agent'), model: z.string().max(200).nullable(), prompt_version: z.string().max(100),
  provenance: z.object({
    requested_model: semanticModel,
    origins: z.array(z.object({ kind: z.enum(['cache', 'live']), requested_model: semanticModel, response_model: semanticModel, uses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).min(1).max(32),
    mixed_origins: z.boolean(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const provenance = value.provenance;
  if (!provenance) return;
  if (value.model !== provenance.requested_model) ctx.addIssue({ code: 'custom', message: 'Semantic author must identify the current requested model' });
  const identities = provenance.origins.map(origin => JSON.stringify([origin.kind, origin.requested_model, origin.response_model]));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: 'custom', message: 'Duplicate semantic execution origin' });
  if (provenance.mixed_origins !== (new Set(provenance.origins.map(origin => origin.requested_model)).size > 1)) ctx.addIssue({ code: 'custom', message: 'Mixed semantic origins must reflect distinct requested routes' });
  for (const origin of provenance.origins) {
    if (origin.kind === 'live' && origin.requested_model !== provenance.requested_model) ctx.addIssue({ code: 'custom', message: 'Live origin must use the current requested model' });
    if (origin.response_model !== origin.requested_model && origin.response_model !== origin.requested_model.split('/').at(-1)) ctx.addIssue({ code: 'custom', message: 'Response model must match its own requested origin' });
  }
});
export const CodeArtifactSchema = z.object({
  schema_version: z.literal(1), snapshot_id: hash, nodes: z.array(CodeNodeSchema).max(25000), edges: z.array(CodeEdgeSchema).max(100000), evidence: z.array(CodeEvidenceSchema).max(20000),
  tour: z.array(z.object({ title: z.string().max(200), description: note, node_ids: z.array(key).max(100) }).strict()).max(100),
  coverage: z.array(z.object({ provider: z.enum(['ua', 'codegraph']), analyzed_files: z.number().int().nonnegative(), total_files: z.number().int().nonnegative(), limitations: z.array(note).max(100) }).strict()).max(2),
  semantic_author: CodeSemanticAuthorSchema,
  ua_graph: CodeUaGraphSchema.optional(),
  semantic_analysis: CodeSemanticAnalysisSchema.optional(),
}).strict();
export const CodeRunStatusSchema = z.enum(['preparing', 'indexing', 'awaiting_agent', 'validating', 'uploading', 'succeeded', 'failed', 'cancelled']);
/** Hosted analysis always uses the registered repository's single configured main branch. */
export const CodeHostedAnalysisRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  repository_codes: z.array(PublicCodeSchema).min(1).max(50).optional(),
}).strict().refine(value => !value.repository_codes || new Set(value.repository_codes).size === value.repository_codes.length, 'Duplicate repositories');
export type CodeHostedAnalysisRequest = z.infer<typeof CodeHostedAnalysisRequestSchema>;
export interface CodeHostedAnalysisJobView {
  job_code: string; project_code: string; repository_code: string; repository_name: string;
  branch: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; run_code: string | null;
  error: string | null; created_at: string; updated_at: string; execution_metadata: Record<string, unknown> | null;
}
export const CodeRunRegisterSchema = z.object({ idempotency_key: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/), repository_code: PublicCodeSchema, workspace_code: PublicCodeSchema.optional(), requested_ref: z.string().min(1).max(300), kind: z.enum(['commit', 'draft']), plugins: z.array(CodePluginSchema).min(2).max(2) }).strict().refine(value => new Set(value.plugins.map(plugin => plugin.plugin_id)).size === 2, 'Both plugins are required');
export const CodeRunProgressSchema = z.object({ expected_revision: z.number().int().nonnegative(), status: CodeRunStatusSchema.exclude(['succeeded']), snapshot: CodeSnapshotSchema.optional(), message: z.string().max(500).optional() }).strict();
export const CodeRunPublishSchema = z.object({ expected_revision: z.number().int().nonnegative(), artifact: CodeArtifactSchema }).strict();
export const CodeViewComposeSchema = z.object({ base_view_code: PublicCodeSchema.nullable(), selections: z.array(z.object({ repository_code: PublicCodeSchema, run_code: PublicCodeSchema }).strict()).min(1).max(50) }).strict().refine(value => new Set(value.selections.map(item => item.repository_code)).size === value.selections.length, 'Duplicate repositories');
export const CodeViewSelectSchema = z.object({ expected_current: PublicCodeSchema.nullable() }).strict();
export const CodeGraphQuerySchema = z.object({ run_code: PublicCodeSchema.optional(), view_code: PublicCodeSchema.optional(), provider: z.enum(['ua', 'codegraph']).optional(), query: z.string().max(200).optional(), node_id: key.optional(), direction: z.enum(['in', 'out', 'both']).default('both'), offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().refine(value => !(value.run_code && value.view_code), 'Choose a run or a view').refine(value => !value.node_id || Boolean(value.run_code), 'Node lookup requires its analysis run');
export type CodeSnapshot = z.infer<typeof CodeSnapshotSchema>;
export type CodeArtifact = z.infer<typeof CodeArtifactSchema>;
export type CodeNode = z.infer<typeof CodeNodeSchema>;
export type CodeEdge = z.infer<typeof CodeEdgeSchema>;
export type CodePlugin = z.infer<typeof CodePluginSchema>;
export type CodeRunStatus = z.infer<typeof CodeRunStatusSchema>;
export type CodeRunRegister = z.infer<typeof CodeRunRegisterSchema>;
export type CodeRunProgress = z.infer<typeof CodeRunProgressSchema>;
export type CodeRunPublish = z.infer<typeof CodeRunPublishSchema>;
export type CodeViewCompose = z.infer<typeof CodeViewComposeSchema>;
export type CodeGraphQuery = z.infer<typeof CodeGraphQuerySchema>;
export interface CodeRunSummary { code: string; repository_code: string; requested_ref: string; kind: 'commit' | 'draft'; runner?: 'member_cli' | 'server_git'; status: CodeRunStatus; revision: number; plugins: CodePlugin[]; snapshot: (Omit<CodeSnapshot, 'files'> & { file_count: number }) | null; message: string | null; artifact_sha256: string | null; created_at: string; updated_at: string }
export interface CodeProjectView { code: string; kind: 'commit' | 'draft'; selections: { repository_code: string; run_code: string; snapshot_id: string }[]; created_at: string }
export interface CodeUnderstandingContext { repositories: { code: string; name: string; default_branch: string | null; status: string }[]; runs: CodeRunSummary[]; views: CodeProjectView[]; current_view: string | null; current_draft_view: string | null; can_write: boolean; truncated: boolean }
export type CodeGraphScope = { run_code: string; repository_code: string; snapshot_id: string };
export interface CodeGraphResult { source: 'published_projection'; runs: CodeRunSummary[]; view: CodeProjectView | null; nodes: (CodeNode & CodeGraphScope)[]; edges: (CodeEdge & CodeGraphScope)[]; evidence: (z.infer<typeof CodeEvidenceSchema> & CodeGraphScope)[]; tour: (CodeArtifact['tour'][number] & CodeGraphScope)[]; coverage: (CodeArtifact['coverage'][number] & CodeGraphScope)[]; total_nodes: number; offset: number; limit: number; truncated: boolean; capabilities: string[] }
export interface CodeUaMapResult { run: CodeRunSummary; graph: CodeUaGraph | null; projection: CodeGraphResult; metadata_complete: boolean; reader_profile?: 'legacy_split' | 'full_system' }

/** Known sensitive patterns, not a claim of complete secret detection. */
export function isCodePublicationSensitiveText(value: string): boolean {
  return /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(value)
    || /\\\\[^\s\\]+\\/.test(value)
    || /(?:^|[^A-Za-z0-9_./])\/(?:home|Users|workspace|tmp|var|etc|root|mnt|opt)\//.test(value)
    || /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
    || /\b(?:password|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i.test(value)
    || /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/.test(value);
}

export function hasCodePublicationSensitiveText(value: unknown): boolean {
  if (typeof value === 'string') return isCodePublicationSensitiveText(value);
  if (Array.isArray(value)) return value.some(hasCodePublicationSensitiveText);
  if (value && typeof value === 'object') return Object.values(value).some(hasCodePublicationSensitiveText);
  return false;
}

function validateUaGraph(artifact: CodeArtifact, snapshot: CodeSnapshot): string[] {
  const graph = artifact.ua_graph;
  if (!graph) return [];
  const issues: string[] = [], projected = artifact.nodes.filter(node => node.provider === 'ua');
  const byNative = new Map(projected.map(node => [node.native_id, node])), nativeIds = new Set(graph.nodes.map(node => node.id));
  const sourceFiles = new Map(snapshot.files.map(file => [file.path, file])), evidence = new Map(artifact.evidence.map(item => [item.id, item]));
  const firstLayerByNode = new Map<string, string>();
  for (const layer of graph.layers) for (const id of layer.nodeIds) if (!firstLayerByNode.has(id)) firstLayerByNode.set(id, layer.name);
  if (graph.project.gitCommitHash !== snapshot.commit) issues.push('UA metadata commit does not match snapshot');
  if (nativeIds.size !== graph.nodes.length || byNative.size !== projected.length || nativeIds.size !== byNative.size) issues.push('UA metadata node identity does not match projection');
  for (const native of graph.nodes) {
    const node = byNative.get(native.id), source = native.filePath ? sourceFiles.get(native.filePath) : undefined;
    if (!node || native.type !== node.kind || native.name !== node.label || native.summary !== (node.summary ?? '') || native.filePath !== node.path
      || native.lineRange?.[0] !== node.line_start || native.lineRange?.[1] !== node.line_end) issues.push('UA metadata node does not match projection');
    if (native.filePath && !source) issues.push('UA metadata path is outside snapshot');
    if (native.lineRange && (!source || native.lineRange[1] < native.lineRange[0] || native.lineRange[1] > source.line_count)) issues.push('UA metadata range is outside snapshot');
    if (native.filePath && source && node && !node.evidence_ids.some(id => {
      const item = evidence.get(id);
      return item !== undefined && item.path === native.filePath && item.sha256 === source.sha256 && item.line_start === (native.lineRange?.[0] ?? 1) && item.line_end === (native.lineRange?.[1] ?? source.line_count);
    })) issues.push('UA metadata source lacks matching evidence');
    if (node?.layer !== firstLayerByNode.get(native.id)) issues.push('UA metadata layer does not match projection');
    if (node?.domain_meta) {
      const projectedDomain = CodeDomainMetaSchema.safeParse(node.domain_meta), nativeDomain = CodeDomainMetaSchema.safeParse(native.domainMeta);
      if (!projectedDomain.success || !nativeDomain.success || JSON.stringify(projectedDomain.data) !== JSON.stringify(nativeDomain.data)) issues.push('UA domain metadata does not match projection');
    }
  }
  const relationKey = (source: string | undefined, target: string | undefined, type: string) => JSON.stringify([source, target, type]);
  const expected = new Map<string, number>(), actual = new Map<string, number>();
  const increment = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const edge of graph.edges) {
    if (!nativeIds.has(edge.source) || !nativeIds.has(edge.target)) issues.push('UA metadata edge references unknown node');
    const source = byNative.get(edge.source)?.id, target = byNative.get(edge.target)?.id;
    increment(expected, edge.direction === 'backward' ? relationKey(target, source, edge.type) : relationKey(source, target, edge.type));
    if (edge.direction === 'bidirectional') increment(expected, relationKey(target, source, edge.type));
  }
  for (const edge of artifact.edges.filter(edge => edge.provider === 'ua')) increment(actual, relationKey(edge.source, edge.target, edge.type));
  if (actual.size !== expected.size || [...expected].some(([key, count]) => actual.get(key) !== count)) issues.push('UA metadata edges do not match projection');
  if (new Set(graph.layers.map(layer => layer.id)).size !== graph.layers.length) issues.push('Duplicate UA metadata layers');
  for (const layer of graph.layers) if (layer.nodeIds.some(id => !nativeIds.has(id)) || new Set(layer.nodeIds).size !== layer.nodeIds.length) issues.push('UA metadata layer references invalid nodes');
  if (graph.tour.length !== artifact.tour.length || new Set(graph.tour.map(step => step.order)).size !== graph.tour.length) issues.push('UA metadata tour does not match projection');
  graph.tour.forEach((step, index) => {
    const target = artifact.tour[index];
    if (step.nodeIds.some(id => !nativeIds.has(id)) || !target || step.title !== target.title || step.description !== target.description
      || JSON.stringify(step.nodeIds.map(id => byNative.get(id)?.id)) !== JSON.stringify(target.node_ids)) issues.push('UA metadata tour does not match projection');
  });
  return issues;
}

function validateSemanticAnalysis(artifact: CodeArtifact, snapshot: CodeSnapshot): string[] {
  if (!artifact.semantic_analysis) return [];
  const checked = CodeSemanticAnalysisSchema.safeParse(artifact.semantic_analysis);
  if (!checked.success) return ['Semantic analysis report has an invalid shape'];
  const report = checked.data, errors: string[] = [], files = new Map(snapshot.files.map(file => [file.path, file]));
  const nodes = new Map(artifact.nodes.map(node => [node.id, node])), edges = new Map(artifact.edges.map(edge => [edge.id, edge]));
  const evidence = new Map(artifact.evidence.map(item => [item.id, item])), seenFiles = new Set<string>(), seenSegments = new Set<string>();
  let totalBytes = 0, totalSegments = 0;
  if (report.snapshot_id !== snapshot.snapshot_id || report.manifest_sha256 !== snapshot.manifest_sha256) errors.push('Semantic analysis report has a different snapshot');
  for (const coverage of report.file_coverage) {
    const file = files.get(coverage.path);
    if (!file || seenFiles.has(coverage.path) || coverage.sha256 !== file.sha256 || coverage.total_bytes !== file.byte_count || coverage.covered_bytes !== file.byte_count) errors.push('Semantic file coverage does not match snapshot');
    seenFiles.add(coverage.path);
    let end = 0, lastLine = file?.byte_count ? 1 : 0;
    for (const segment of coverage.segments) {
      if (seenSegments.has(segment.id) || segment.id !== `segment:${segment.input_sha256.slice(0, 32)}` || segment.byte_start !== end || segment.byte_end < segment.byte_start || (!file?.byte_count && coverage.segments.length !== 1) || (Boolean(file?.byte_count) && segment.byte_end === segment.byte_start)) errors.push('Semantic segment coverage contains a gap, overlap or invalid identity');
      if (segment.line_start !== lastLine || segment.line_end < segment.line_start || segment.line_end > (file?.line_count ?? 0) || (Boolean(file?.byte_count) && segment.line_start < 1)) errors.push('Semantic segment line coverage is outside snapshot');
      seenSegments.add(segment.id); end = segment.byte_end; lastLine = segment.line_end; totalSegments++;
    }
    if (!file || end !== file.byte_count || lastLine !== file.line_count) errors.push('Semantic segments do not cover the complete file');
    totalBytes += coverage.total_bytes;
  }
  if (seenFiles.size !== files.size || report.file_coverage.length !== files.size) errors.push('Semantic coverage must contain every snapshot file exactly once');
  const nodeSupport = new Map<string, string[]>(), relationSupport = new Set<string>();
  const validEvidence = (ids: string[]) => new Set(ids).size === ids.length && ids.every(id => evidence.has(id));
  for (const support of report.node_evidence) {
    const node = nodes.get(support.node_id);
    if (nodeSupport.has(support.node_id) || !node || node.provider !== 'ua' || !validEvidence(support.evidence_ids) || support.evidence_ids.some(id => !node.evidence_ids.includes(id))) errors.push('Semantic node support does not match published evidence');
    const source = node?.path ? files.get(node.path) : undefined;
    if (node && source?.byte_count && !support.evidence_ids.some(id => {
      const item = evidence.get(id);
      return item && item.path === source.path && item.line_start <= (node.line_end ?? source.line_count) && item.line_end >= (node.line_start ?? 1);
    })) errors.push('Semantic node support does not match its source location');
    nodeSupport.set(support.node_id, support.evidence_ids);
  }
  const overlaps = (ids: string[], node: CodeNode | undefined) => Boolean(node?.path && ids.some(id => {
    const item = evidence.get(id);
    return item && item.path === node.path && item.line_start <= (node.line_end ?? node.line_start ?? 0) && item.line_end >= (node.line_start ?? node.line_end ?? Number.MAX_SAFE_INTEGER);
  }));
  for (const support of report.relation_evidence) {
    const edge = edges.get(support.edge_id);
    if (relationSupport.has(support.edge_id) || !edge || edge.provider !== 'ua' || edge.source !== support.source || edge.target !== support.target || edge.type !== support.type || !validEvidence(support.evidence_ids) || support.evidence_ids.some(id => !edge.evidence_ids.includes(id))) errors.push('Semantic relation support does not match published evidence');
    relationSupport.add(support.edge_id);
    if (support.basis === 'semantic_inference' && support.native_ids.length) errors.push('Inferred semantic relations cannot claim native proof');
    if (support.basis === 'native_dependency' && (!support.native_ids.length || new Set(support.native_ids).size !== support.native_ids.length)) errors.push('Native semantic relations need distinct native dependencies');
    for (const id of support.native_ids) {
      const native = edges.get(id), source = native ? nodes.get(native.source) : undefined, target = native ? nodes.get(native.target) : undefined;
      if (!native || native.provider !== 'codegraph' || source?.provider !== 'codegraph' || target?.provider !== 'codegraph' || !overlaps(nodeSupport.get(support.source) ?? [], source) || !overlaps(nodeSupport.get(support.target) ?? [], target) || !overlaps(support.evidence_ids, source) || !overlaps(support.evidence_ids, target)) errors.push('Native semantic proof does not support the directed relation');
    }
  }
  const uaNodes = artifact.nodes.filter(node => node.provider === 'ua'), uaEdges = artifact.edges.filter(edge => edge.provider === 'ua');
  if (!artifact.ua_graph || uaNodes.some(node => !nodeSupport.has(node.id) && (!node.path || (files.get(node.path)?.byte_count ?? 0) > 0)) || uaEdges.some(edge => !relationSupport.has(edge.id))) errors.push('Full semantic graph has unsupported nodes or relations');
  const represented = new Set(uaNodes.map(node => node.path).filter(Boolean));
  if (snapshot.files.some(file => !represented.has(file.path))) errors.push('Full semantic graph does not represent every source file');
  const nativeCount = report.relation_evidence.filter(row => row.basis === 'native_dependency').length;
  const counts = { total_files: files.size, total_bytes: totalBytes, covered_bytes: totalBytes, total_segments: totalSegments, completed_segments: totalSegments, supported_nodes: nodeSupport.size, supported_relations: relationSupport.size, native_dependency_relations: nativeCount, semantic_inference_relations: report.relation_evidence.length - nativeCount, unresolved_items: report.uncertainty.unresolved_items };
  if (Object.entries(counts).some(([field, value]) => report.counts[field as keyof typeof counts] !== value)) errors.push('Semantic report counts do not match its evidence and coverage');
  return [...new Set(errors)];
}

/** Stable cross-reference validation shared by local Agent tooling and service publication. */
export function validateCodeArtifact(artifact: CodeArtifact, snapshot: CodeSnapshot): string[] {
  const errors: string[] = [], nodes = new Map(artifact.nodes.map(node => [node.id, node])), evidence = new Map(artifact.evidence.map(item => [item.id, item]));
  if (hasCodePublicationSensitiveText(artifact)) errors.push('Publication contains a local absolute path or known credential pattern');
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  if (artifact.snapshot_id !== snapshot.snapshot_id) errors.push('Snapshot mismatch');
  if (nodes.size !== artifact.nodes.length || evidence.size !== artifact.evidence.length || new Set(artifact.edges.map(edge => edge.id)).size !== artifact.edges.length) errors.push('Duplicate graph identifiers');
  for (const item of artifact.evidence) {
    const file = files.get(item.path);
    if (!file || file.sha256 !== item.sha256 || item.line_end < item.line_start || item.line_end > file.line_count) errors.push('Evidence is outside snapshot');
    // V1 publishes small excerpts only; complete files, even tiny ones, stay local.
    if (item.snippet !== undefined && (!file || (item.line_start === 1 && item.line_end >= file.line_count) || item.line_end - item.line_start >= 30 || item.snippet.split('\n').length > item.line_end - item.line_start + 1)) errors.push('Evidence excerpt exceeds its allowed range');
  }
  const snippets = new Map<string, { chars: number; lines: Set<number> }>();
  for (const item of artifact.evidence.filter(item => item.snippet !== undefined)) {
    const tally = snippets.get(item.path) ?? { chars: 0, lines: new Set<number>() };
    tally.chars += item.snippet?.length ?? 0;
    for (let line = item.line_start; line <= item.line_end; line++) tally.lines.add(line);
    snippets.set(item.path, tally);
  }
  for (const [filePath, tally] of snippets) if (tally.chars > 2400 || tally.lines.size >= (files.get(filePath)?.line_count ?? 0) || tally.lines.size > 60) errors.push('Cumulative excerpts exceed per-file budget');
  for (const node of artifact.nodes) {
    if (node.evidence_ids.some(id => !evidence.has(id))) errors.push('Unknown node evidence');
    const file = node.path ? files.get(node.path) : undefined;
    if (node.path && !file) errors.push('Node path is outside snapshot');
    if ((node.line_start !== undefined || node.line_end !== undefined) && (!file || node.line_start === undefined || node.line_end === undefined || node.line_end < node.line_start || node.line_end > file.line_count)) errors.push('Invalid node source range');
  }
  for (const edge of artifact.edges) if (!nodes.has(edge.source) || !nodes.has(edge.target) || edge.evidence_ids.some(id => !evidence.has(id)) || (edge.provider === 'bridge' && !edge.evidence_ids.length)) errors.push('Invalid edge endpoints or evidence');
  for (const step of artifact.tour) if (step.node_ids.some(id => !nodes.has(id))) errors.push('Unknown tour node');
  if (new Set(artifact.coverage.map(item => item.provider)).size !== 2 || artifact.coverage.some(item => item.total_files !== snapshot.files.length || item.analyzed_files > item.total_files)) errors.push('Both engine coverage records must match snapshot');
  errors.push(...validateUaGraph(artifact, snapshot));
  errors.push(...validateSemanticAnalysis(artifact, snapshot));
  return [...new Set(errors)];
}
