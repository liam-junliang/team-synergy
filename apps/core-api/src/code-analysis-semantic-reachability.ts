import { isIntakeSourcePath, type CodeArtifact, type CodeSnapshot } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { semanticDigest, semanticInvalid, type SourceEvidence } from './code-analysis-semantic-source.js';

export const ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL = 'architecture-native-call-recovery-1.0.0';
const MAX_DEPTH = 2, MAX_ADDITIONAL = 256;
const declarationKinds = new Set(['function', 'method', 'class', 'interface', 'enum', 'type', 'type_alias', 'variable', 'constant']);
type Native = Pick<CodeArtifact, 'nodes' | 'edges'> & Partial<Pick<CodeArtifact, 'evidence'>>;
interface Anchor extends SourceEvidence { definition_id: string; definition_kind: string }
export interface NativeSourceContainerExclusion { definition_id: string; reason: 'outer_container_of_narrow_operation'; nested_definition_ids: string[] }
export interface NativeRecoveryDefinition extends Anchor { label: string; file_sha256: string; node_sha256: string; evidence_sha256: string }
export interface NativeRecoveryPath { definition_id: string; depth: number; anchor_definition_id: string; edge_ids: string[] }
export interface NativeRecoveryMetadata { protocol: typeof ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL; catalog_sha256: string }
export interface NativeRecoveryCatalog {
  protocol: typeof ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL;
  snapshot_id: string; manifest_sha256: string; native_projection_sha256: string;
  original_evidence: SourceEvidence[]; original_evidence_sha256: string;
  max_depth: number; max_additional_definitions: number;
  anchor_definition_ids: string[]; excluded_containers: NativeSourceContainerExclusion[];
  eligible_definition_ids: string[];
  reachable_definitions: (NativeRecoveryDefinition & { retrieval_path: NativeRecoveryPath })[];
  traversed_edges: CodeArtifact['edges'];
  unavailable: { edge_id: string; source: string; target: string; reason: 'target_absent' | 'target_not_snapshot_definition' }[];
  depth_frontier: { edge_id: string; source: string; target: string; reason: 'depth_limit' }[];
  catalog_sha256: string;
}
export interface NativeRecoveryContext {
  readonly snapshot_id: string; readonly manifest_sha256: string; readonly native_projection_sha256: string;
  catalog(evidence: SourceEvidence[]): NativeRecoveryCatalog;
}
const overlaps = (a: SourceEvidence, b: SourceEvidence) => a.path === b.path && a.line_start <= b.line_end && b.line_start <= a.line_end;
const contains = (a: SourceEvidence, b: SourceEvidence) => a.path === b.path && a.line_start <= b.line_start && a.line_end >= b.line_end;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Shared original-anchor policy; recovery must not use a different excerpt rule. */
export function deriveNativeSourceAnchors<T extends Anchor>(definitions: readonly T[], evidence: readonly SourceEvidence[]) {
  const candidates = definitions.filter(node => evidence.some(range => overlaps(range, node))), excluded_containers: NativeSourceContainerExclusion[] = [];
  for (const candidate of candidates) {
    const ranges = evidence.filter(range => overlaps(range, candidate));
    const nested = candidates.filter(other => other.definition_id !== candidate.definition_id && ['function', 'method'].includes(other.definition_kind) && contains(candidate, other) && (candidate.line_start < other.line_start || candidate.line_end > other.line_end));
    if (nested.length && ranges.every(range => contains(candidate, range) && (range.line_start > candidate.line_start || range.line_end < candidate.line_end) && nested.some(other => contains(other, range)))) excluded_containers.push({ definition_id: candidate.definition_id, reason: 'outer_container_of_narrow_operation', nested_definition_ids: nested.filter(other => ranges.some(range => contains(other, range))).map(other => other.definition_id).sort() });
  }
  const excluded = new Set(excluded_containers.map(row => row.definition_id));
  return { candidates, excluded_containers, eligible: candidates.filter(candidate => !excluded.has(candidate.definition_id)) };
}

/**
 * One immutable host context per verified run, never a cache indexed by cg IDs.
 * The runner's index/snapshot/engine checks remain a prerequisite: a projection
 * has no intrinsic snapshot header. Static call edges locate candidates only.
 * Actual file bytes, complete bodies, guards and semantic verdicts stay with the
 * grounder. Neither this context nor an eligible ID approves an assertion.
 */
export function createArchitectureNativeRecoveryContext(input: { snapshot: CodeSnapshot; native: Native }): NativeRecoveryContext {
  if (!hash(input.snapshot.snapshot_id) || !hash(input.snapshot.manifest_sha256) || !Array.isArray(input.native.evidence)) return semanticInvalid('architecture_native_recovery_identity', false);
  const snapshot = structuredClone(input.snapshot), native = structuredClone(input.native);
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  if (files.size !== snapshot.files.length || snapshot.files.some(file => !isIntakeSourcePath(file.path) || !hash(file.sha256) || !Number.isSafeInteger(file.line_count) || file.line_count < 0 || !Number.isSafeInteger(file.byte_count) || file.byte_count < 0)) return semanticInvalid('architecture_native_recovery_manifest', false);
  const validateRange = (range: SourceEvidence) => {
    const file = files.get(range.path);
    if (!file || !Number.isSafeInteger(range.line_start) || !Number.isSafeInteger(range.line_end) || range.line_start < 1 || range.line_end < range.line_start || range.line_end > file.line_count) return semanticInvalid('architecture_native_recovery_range', false);
    return file;
  };
  const witnesses = new Map<string, CodeArtifact['evidence'][number]>();
  for (const evidence of native.evidence ?? []) {
    if (!evidence.id || witnesses.has(evidence.id)) return semanticInvalid('architecture_native_recovery_evidence_identity', false);
    if (evidence.sha256 !== validateRange(evidence).sha256) return semanticInvalid('architecture_native_recovery_source_sha', false);
    witnesses.set(evidence.id, evidence);
  }
  const rawNodes = new Map<string, CodeArtifact['nodes'][number]>(), definitions = new Map<string, NativeRecoveryDefinition>();
  for (const node of native.nodes) {
    if (!node.id || rawNodes.has(node.id)) return semanticInvalid('architecture_native_recovery_node_identity', false);
    rawNodes.set(node.id, node);
    if (node.provider !== 'codegraph' || !declarationKinds.has(node.kind) || !node.path) continue;
    const range = { path: node.path, line_start: node.line_start as number, line_end: node.line_end as number }, file = validateRange(range);
    const evidence = node.evidence_ids.map(id => witnesses.get(id));
    if (node.verification !== 'observed' || !evidence.length || new Set(node.evidence_ids).size !== evidence.length || evidence.some(item => !item || item.path !== range.path || item.line_start !== range.line_start || item.line_end !== range.line_end || item.sha256 !== file.sha256)) return semanticInvalid('architecture_native_recovery_node_evidence', false);
    definitions.set(node.id, { definition_id: node.id, definition_kind: node.kind, label: node.label, ...range, file_sha256: file.sha256, node_sha256: semanticDigest(node), evidence_sha256: semanticDigest(evidence) });
  }
  const sortedDefinitions = [...definitions.values()].sort((a, b) => (a.line_end - a.line_start) - (b.line_end - b.line_start) || a.path.localeCompare(b.path) || a.line_start - b.line_start || a.definition_id.localeCompare(b.definition_id));
  const edgeIds = new Set<string>(), outgoing = new Map<string, CodeArtifact['edges']>();
  for (const edge of native.edges) {
    if (!edge.id || edgeIds.has(edge.id)) return semanticInvalid('architecture_native_recovery_edge_identity', false);
    edgeIds.add(edge.id);
    if (edge.provider !== 'codegraph' || edge.provenance !== 'native' || edge.type !== 'calls') continue;
    const rows = outgoing.get(edge.source) ?? []; rows.push(edge); outgoing.set(edge.source, rows);
  }
  for (const rows of outgoing.values()) rows.sort((a, b) => compare(a.id, b.id) || compare(a.target, b.target));
  const native_projection_sha256 = semanticDigest({ nodes: native.nodes, edges: native.edges, evidence: native.evidence });
  const catalogCache = new Map<string, NativeRecoveryCatalog>();
  const context: NativeRecoveryContext = {
    snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, native_projection_sha256,
    catalog(evidence) {
      if (!Array.isArray(evidence)) return semanticInvalid('architecture_native_recovery_original_evidence', false);
      for (const range of evidence) validateRange(range);
      const original_evidence_sha256 = semanticDigest(evidence), cached = catalogCache.get(original_evidence_sha256);
      if (cached) return structuredClone(cached);
      const anchors = deriveNativeSourceAnchors(sortedDefinitions, evidence), anchor_definition_ids = anchors.eligible.map(node => node.definition_id).sort(compare);
      const visited = new Map<string, NativeRecoveryPath>(anchor_definition_ids.map(id => [id, { definition_id: id, depth: 0, anchor_definition_id: id, edge_ids: [] }]));
      const queue = [...visited.values()], traversed = new Map<string, CodeArtifact['edges'][number]>();
      const unavailable: NativeRecoveryCatalog['unavailable'] = [], depth_frontier: NativeRecoveryCatalog['depth_frontier'] = [];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor] as NativeRecoveryPath;
        for (const edge of outgoing.get(current.definition_id) ?? []) {
          if (current.depth === MAX_DEPTH) {
            if (!visited.has(edge.target)) depth_frontier.push({ edge_id: edge.id, source: edge.source, target: edge.target, reason: 'depth_limit' });
            continue;
          }
          traversed.set(edge.id, edge);
          if (!definitions.has(edge.target)) { unavailable.push({ edge_id: edge.id, source: edge.source, target: edge.target, reason: rawNodes.has(edge.target) ? 'target_not_snapshot_definition' : 'target_absent' }); continue; }
          if (visited.has(edge.target)) continue;
          const path = { definition_id: edge.target, depth: current.depth + 1, anchor_definition_id: current.anchor_definition_id, edge_ids: [...current.edge_ids, edge.id] };
          visited.set(edge.target, path); queue.push(path);
        }
      }
      const additional = [...visited.values()].filter(row => row.depth > 0).sort((a, b) => compare(a.definition_id, b.definition_id));
      if (additional.length > MAX_ADDITIONAL) throw new DomainError('code_analysis_model_invalid', '原生调用检索超出明确预算，未返回截断候选', { reason: 'architecture_native_recovery_overflow', repairable: false, max_additional_definitions: MAX_ADDITIONAL, actual_additional_definitions: additional.length, additional_definition_ids: additional.map(row => row.definition_id), withheld_catalog: true });
      const reachable_definitions = additional.map(retrieval_path => ({ ...definitions.get(retrieval_path.definition_id) as NativeRecoveryDefinition, retrieval_path }));
      const ledger: Omit<NativeRecoveryCatalog, 'catalog_sha256'> = { protocol: ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL, snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, native_projection_sha256, original_evidence: structuredClone(evidence), original_evidence_sha256, max_depth: MAX_DEPTH, max_additional_definitions: MAX_ADDITIONAL, anchor_definition_ids, excluded_containers: anchors.excluded_containers, eligible_definition_ids: [...visited.keys()].sort(compare), reachable_definitions, traversed_edges: [...traversed.values()].sort((a, b) => compare(a.id, b.id)), unavailable: unavailable.sort((a, b) => compare(a.edge_id, b.edge_id)), depth_frontier: depth_frontier.sort((a, b) => compare(a.edge_id, b.edge_id)) };
      const result: NativeRecoveryCatalog = { ...ledger, catalog_sha256: semanticDigest(ledger) };
      catalogCache.set(original_evidence_sha256, result); return structuredClone(result);
    },
  };
  return Object.freeze(context);
}
