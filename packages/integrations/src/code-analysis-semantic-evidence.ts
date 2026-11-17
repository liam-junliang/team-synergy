import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '@team-synergy/domain';
import { CODE_UNDERSTANDING_MAX_BYTES, CodeArtifactSchema, CodeSemanticAnalysisSchema, CodeSemanticFileCoverageSchema, validateCodeArtifact, type CodeArtifact, type CodeNode, type CodeSemanticAnalysis, type CodeSnapshot } from '@team-synergy/contracts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/), key = z.string().min(1).max(500);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const supportSchema = z.object({ path: z.string().min(1).max(500), line_start: z.number().int().positive(), line_end: z.number().int().positive() }).strict();
const qualitySchema = z.object({
  protocol_version: z.literal(2), snapshot_id: hash, manifest_sha256: hash, prompt_version: z.string().min(1).max(100), full_source_coverage: z.literal(true),
  total_files: count, total_segments: count, completed_segments: count, total_bytes: count, covered_bytes: count,
  file_coverage: z.array(CodeSemanticFileCoverageSchema).max(20000),
  node_evidence: z.array(z.object({ node_id: key, evidence: z.array(supportSchema).max(100) }).strict()).max(25000),
  relation_evidence: z.array(z.object({ source: key, target: key, type: z.string().min(1).max(80), basis: z.enum(['native_dependency', 'semantic_inference']), evidence: z.array(supportSchema).min(1).max(100), native_ids: z.array(key).max(100).optional() }).strict()).max(100000),
  unresolved: z.array(z.object({ scope: z.string(), description: z.string() }).strict()).max(100000),
});
const trustedPlanSchema = z.object({
  snapshot_id: hash, manifest_sha256: hash,
  segments: z.array(z.object({ id: key, path: z.string(), file_sha256: hash, input_sha256: hash, byte_start: count, byte_end: count, line_start: count, line_end: count })).max(100000),
});
/** Supplied directly by the source-verified runner plan, independently of model/quality output. */
export interface TrustedCodeSemanticPlan {
  snapshot_id: string; manifest_sha256: string;
  segments: readonly { id: string; path: string; file_sha256: string; input_sha256: string; byte_start: number; byte_end: number; line_start: number; line_end: number }[];
}
type Support = z.infer<typeof supportSchema>;
const invalid = (reason: string): never => { throw new DomainError('code_semantic_evidence_invalid', `Semantic source attribution is invalid: ${reason}`); };
const relationKey = (source: string, target: string, type: string) => JSON.stringify([source, target, type]);

/** Materializes only validated source ranges, never source text or model-supplied hashes. */
export function materializeCodeSemanticAnalysis(artifact: CodeArtifact, snapshot: CodeSnapshot, quality: unknown, trustedPlan: TrustedCodeSemanticPlan): CodeArtifact {
  const checked = qualitySchema.safeParse(quality);
  if (!checked.success) return invalid('quality contract');
  const checkedPlan = trustedPlanSchema.safeParse(trustedPlan);
  if (!checkedPlan.success) return invalid('trusted source plan is required');
  const input = checked.data;
  const plan = checkedPlan.data;
  if (input.snapshot_id !== snapshot.snapshot_id || input.manifest_sha256 !== snapshot.manifest_sha256 || plan.snapshot_id !== snapshot.snapshot_id || plan.manifest_sha256 !== snapshot.manifest_sha256) return invalid('snapshot identity');
  const expected = new Map(plan.segments.map(segment => [segment.id, segment]));
  const supplied = input.file_coverage.flatMap(file => file.segments.map(segment => ({ id: segment.id, path: file.path, file_sha256: file.sha256, input_sha256: segment.input_sha256, byte_start: segment.byte_start, byte_end: segment.byte_end, line_start: segment.line_start, line_end: segment.line_end })));
  if (expected.size !== plan.segments.length || supplied.length !== expected.size || new Set(supplied.map(segment => segment.id)).size !== expected.size || supplied.some(segment => {
    const original = expected.get(segment.id);
    return !original || Object.keys(segment).some(field => segment[field as keyof typeof segment] !== original[field as keyof typeof original]);
  })) return invalid('segment identity or layout differs from trusted source plan');
  const output = structuredClone(artifact), graph = output.ua_graph;
  if (!graph) return invalid('native UA graph is required');
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  const nodes = new Map(output.nodes.map(node => [node.id, node])), nativeNodes = new Map(output.nodes.filter(node => node.provider === 'ua').map(node => [node.native_id, node]));
  const edges = new Map(output.edges.map(edge => [edge.id, edge])), evidence = new Map(output.evidence.map(item => [item.id, item]));
  for (const native of graph.nodes) {
    const node = nativeNodes.get(native.id);
    if (node && native.domainMeta) node.domain_meta = structuredClone(native.domainMeta);
  }
  const nodeSupport = new Map<string, string[]>(), relationSupport = new Map<string, CodeSemanticAnalysis['relation_evidence'][number]>();
  const attach = (ranges: Support[]): string[] => [...new Set(ranges.map(range => {
    const file = files.get(range.path);
    if (!file || range.line_end < range.line_start || range.line_end > file.line_count) return invalid('source range outside snapshot');
    const location = { path: file.path, sha256: file.sha256, line_start: range.line_start, line_end: range.line_end };
    const id = `semantic-e:${digest(location)}`;
    const existing = evidence.get(id);
    if (existing && digest({ path: existing.path, sha256: existing.sha256, line_start: existing.line_start, line_end: existing.line_end }) !== digest(location)) return invalid('source evidence identifier collision');
    if (!existing) { const item = { id, ...location }; output.evidence.push(item); evidence.set(id, item); }
    return id;
  }))].sort();
  for (const support of input.node_evidence) {
    const node = nativeNodes.get(support.node_id);
    if (!node || nodeSupport.has(node.id)) return invalid('unknown or duplicate UA node');
    const ids = attach(support.evidence);
    if (!ids.length && (!node.path || files.get(node.path)?.byte_count !== 0)) return invalid('node evidence is required');
    const source = node.path ? files.get(node.path) : undefined;
    if (source?.byte_count && !support.evidence.some(range => range.path === source.path && range.line_start <= (node.line_end ?? source.line_count) && range.line_end >= (node.line_start ?? 1))) return invalid('node evidence does not support its source location');
    node.evidence_ids = [...new Set([...node.evidence_ids, ...ids])];
    if (ids.length) nodeSupport.set(node.id, ids);
  }
  const overlaps = (ids: string[], node: CodeNode | undefined) => Boolean(node?.path && ids.some(id => {
    const range = evidence.get(id);
    return range && range.path === node.path && range.line_start <= (node.line_end ?? node.line_start ?? 0) && range.line_end >= (node.line_start ?? node.line_end ?? Number.MAX_SAFE_INTEGER);
  }));
  const nativeSupports = (id: string, source: string, target: string, ids: string[]) => {
    const edge = edges.get(id), from = edge ? nodes.get(edge.source) : undefined, to = edge ? nodes.get(edge.target) : undefined;
    return Boolean(edge?.provider === 'codegraph' && from?.provider === 'codegraph' && to?.provider === 'codegraph' && overlaps(nodeSupport.get(source) ?? [], from) && overlaps(nodeSupport.get(target) ?? [], to) && overlaps(ids, from) && overlaps(ids, to));
  };
  const seenRelations = new Set<string>();
  let downgraded = 0;
  for (const support of input.relation_evidence) {
    const rawKey = relationKey(support.source, support.target, support.type);
    if (seenRelations.has(rawKey)) return invalid('duplicate UA relation');
    seenRelations.add(rawKey);
    const nativeRelations = graph.edges.filter(edge => relationKey(edge.source, edge.target, edge.type) === rawKey);
    const from = nativeNodes.get(support.source), to = nativeNodes.get(support.target);
    if (!from || !to || !nativeRelations.length) return invalid('unknown UA relation');
    const ids = attach(support.evidence), requestedNative = [...new Set(support.native_ids ?? [])];
    if (requestedNative.some(id => edges.get(id)?.provider !== 'codegraph')) return invalid('unknown native dependency');
    if (support.basis === 'semantic_inference' && requestedNative.length) return invalid('inference cannot claim native dependencies');
    const normalized = new Set<string>();
    for (const relation of nativeRelations) {
      const pair: [string, string] = relation.direction === 'backward' ? [to.id, from.id] : [from.id, to.id];
      normalized.add(relationKey(pair[0], pair[1], relation.type));
      if (relation.direction === 'bidirectional') normalized.add(relationKey(pair[1], pair[0], relation.type));
    }
    const matched = output.edges.filter(edge => edge.provider === 'ua' && normalized.has(relationKey(edge.source, edge.target, edge.type)));
    if (!matched.length) return invalid('UA relation has no published projection');
    const usedNative = new Set<string>();
    for (const edge of matched) {
      if (relationSupport.has(edge.id)) return invalid('ambiguous UA relation attribution');
      const nativeIds = requestedNative.filter(id => nativeSupports(id, edge.source, edge.target, ids));
      if (requestedNative.length && !nativeIds.length) return invalid('native dependency does not support this direction');
      for (const id of nativeIds) usedNative.add(id);
      const basis = support.basis === 'native_dependency' && nativeIds.length ? 'native_dependency' : 'semantic_inference';
      if (support.basis === 'native_dependency' && !nativeIds.length) downgraded++;
      edge.evidence_ids = [...new Set([...edge.evidence_ids, ...ids])];
      relationSupport.set(edge.id, { edge_id: edge.id, source: edge.source, target: edge.target, type: edge.type, basis, evidence_ids: ids, native_ids: nativeIds });
    }
    if (requestedNative.some(id => !usedNative.has(id))) return invalid('unrelated native dependency');
  }
  const coverage = [...input.file_coverage].sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = coverage.reduce((sum, file) => sum + file.total_bytes, 0), segmentCount = coverage.reduce((sum, file) => sum + file.segments.length, 0);
  if (input.total_files !== coverage.length || input.total_bytes !== totalBytes || input.covered_bytes !== totalBytes || input.total_segments !== segmentCount || input.completed_segments !== segmentCount) return invalid('coverage totals');
  const relations = [...relationSupport.values()].sort((a, b) => a.edge_id.localeCompare(b.edge_id)), nativeCount = relations.filter(row => row.basis === 'native_dependency').length;
  output.semantic_analysis = CodeSemanticAnalysisSchema.parse({
    protocol_version: 2, mode: 'full', snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, prompt_version: input.prompt_version,
    file_coverage: coverage, node_evidence: [...nodeSupport].map(([node_id, evidence_ids]) => ({ node_id, evidence_ids })).sort((a, b) => a.node_id.localeCompare(b.node_id)), relation_evidence: relations,
    counts: { total_files: coverage.length, total_bytes: totalBytes, covered_bytes: totalBytes, total_segments: segmentCount, completed_segments: segmentCount, supported_nodes: nodeSupport.size, supported_relations: relations.length, native_dependency_relations: nativeCount, semantic_inference_relations: relations.length - nativeCount, unresolved_items: input.unresolved.length },
    uncertainty: { semantic_correctness: 'requires_independent_evaluation', unresolved_items: input.unresolved.length, limitations: ['Complete byte coverage records processed inputs, not semantic correctness.', 'The report is a trusted runner input-processing statement; stored digests do not prove model reasoning.', 'Semantic interpretations remain inferences and require independent evaluation.', ...(downgraded ? [`${downgraded} relations without native dependency identifiers remain semantic inferences.`] : [])] },
  });
  const validated = CodeArtifactSchema.safeParse(output);
  if (!validated.success) return invalid('publication limits or evidence contract');
  const issues = validateCodeArtifact(validated.data, snapshot);
  if (issues.length) return invalid(issues.join('; '));
  if (Buffer.byteLength(JSON.stringify(validated.data)) > CODE_UNDERSTANDING_MAX_BYTES) return invalid('publication byte budget');
  return validated.data;
}
