import type { CodeArtifact, CodeSnapshot } from '@team-synergy/contracts';
import type { GroundingClaim } from './code-analysis-semantic-grounding.js';
import { DomainError } from '@team-synergy/domain';
import { type createSemanticModelClient, semanticInferencePolicy, writeSemanticJson } from './code-analysis-semantic-model.js';
import { assertArchitectureWireShape, wireList, wireObject, wireText } from './code-analysis-semantic-architecture-wire.js';
import { objectRecord, semanticDigest, semanticInvalid, type SourceEvidence } from './code-analysis-semantic-source.js';
import { ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL, deriveNativeSourceAnchors, type NativeRecoveryCatalog, type NativeRecoveryContext, type NativeRecoveryMetadata, type NativeRecoveryPath, type NativeSourceContainerExclusion } from './code-analysis-semantic-reachability.js';
import path from 'node:path';

export const ARCHITECTURE_SOURCE_SELECTION_PROTOCOL = 'architecture-source-selection-1.1.0';
const PHASE = 'architecture-source-select', PAGE_BYTES = 125_000, MAX_CLAIMS = 8, MAX_SELECTED = 8;
type Client = ReturnType<typeof createSemanticModelClient>;
type Native = Pick<CodeArtifact, 'nodes' | 'edges'> & Partial<Pick<CodeArtifact, 'evidence'>>;
interface Candidate extends SourceEvidence { definition_id: string; definition_kind: string; label: string; file_sha256: string; source_kind: 'code' | 'test' | 'document'; retrieval_path?: NativeRecoveryPath }
type Exclusion = NativeSourceContainerExclusion;
interface Plan { claim: GroundingClaim; claim_sha256: string; text_sha256: string; evidence_sha256: string; catalog_sha256: string; candidates: Candidate[]; excluded_containers: Exclusion[]; eligible: Candidate[]; recovery?: NativeRecoveryMetadata; recovery_catalog?: NativeRecoveryCatalog; previous?: SelectedGroundingClaim; skip_recovery?: boolean }
interface SelectionContext {
  context_id: string; claim_id: string; node_id: string; field: string; kind: GroundingClaim['kind']; text: string; text_sha256: string;
  claim_sha256: string; evidence_sha256: string; catalog_sha256: string; page_sha256: string; scope_context?: unknown;
  assertion_scope?: GroundingClaim['assertion_scope']; page: number; pages: number; candidates: Candidate[];
  selection_recovery?: NativeRecoveryMetadata;
}
interface PageSelection { context_id: string; claim_id: string; text_sha256: string; catalog_sha256: string; page_sha256: string; selected_definition_ids: string[]; missing_reasons: string[] }
export interface SelectedGroundingClaim extends GroundingClaim {
  primary_definition_ids: string[]; selection_sha256: string; selection_catalog_sha256: string; selection_claim_sha256: string;
  selected_source_evidence: SourceEvidence[];
  selection_recovery?: NativeRecoveryMetadata;
}
export interface ArchitectureSourceRecoveryOptions { context: NativeRecoveryContext; previous: SelectedGroundingClaim[] }
export interface ArchitectureClaimSourceSelection {
  claim_id: string; claim_sha256: string; text_sha256: string; catalog_sha256: string; selection_sha256: string;
  original_claim: GroundingClaim; candidates: Candidate[]; excluded_containers: Exclusion[];
  selected_definition_ids: string[]; selected_source_evidence: SourceEvidence[]; selected_evidence: SourceEvidence[]; missing_reasons: string[]; pages: PageSelection[];
  selection_recovery?: NativeRecoveryMetadata; recovery_catalog?: NativeRecoveryCatalog; recovery_skipped?: boolean;
  recovery_unchanged?: boolean; effective_selection_sha256?: string;
}
const sourceKind = (file: string): Candidate['source_kind'] => /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|\.)|\.(?:test|spec)\./iu.test(file) ? 'test' : /\.(?:md|mdx|rst|txt|ya?ml|json|toml)$/iu.test(file) ? 'document' : 'code';
const bytes = (input: unknown) => Buffer.byteLength(JSON.stringify(input));
const normalizedChoices = (ids: string[], evidence: SourceEvidence[]) => ({ primary_definition_ids: [...ids].sort(), selected_source_evidence: evidence.map(range => ({ path: range.path, line_start: range.line_start, line_end: range.line_end })).sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end) });
/** The catalog preimage is retained in the private selector ledger; the verifier
 * independently rechecks the chosen IDs and complete bodies against the snapshot. */
function selectionDigest(snapshot_id: string, plan: Plan, primary_definition_ids: string[], selected_source_evidence: SourceEvidence[]): string {
  if (plan.recovery) return semanticDigest({ protocol: 'architecture-primary-selection-1.2.0', snapshot_id, claim_id: plan.claim.id, text_sha256: plan.text_sha256, claim_sha256: plan.claim_sha256, catalog_sha256: plan.catalog_sha256, primary_definition_ids: [...primary_definition_ids].sort(), selected_source_evidence: [...selected_source_evidence].sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end), selection_recovery: plan.recovery });
  return semanticDigest({ protocol: 'architecture-primary-selection-1.1.0', snapshot_id, claim_id: plan.claim.id, text_sha256: plan.text_sha256, claim_sha256: plan.claim_sha256, catalog_sha256: plan.catalog_sha256, primary_definition_ids: [...primary_definition_ids].sort(), selected_source_evidence: [...selected_source_evidence].sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end) });
}
function planClaims(snapshot: CodeSnapshot, native: Native, claims: GroundingClaim[], recovery?: ArchitectureSourceRecoveryOptions): Plan[] {
  if (recovery && (recovery.context.snapshot_id !== snapshot.snapshot_id || recovery.context.manifest_sha256 !== snapshot.manifest_sha256 || recovery.context.native_projection_sha256 !== semanticDigest({ nodes: native.nodes, edges: native.edges, evidence: native.evidence }) || new Set(recovery.previous.map(item => item.id)).size !== recovery.previous.length)) return semanticInvalid('architecture_source_recovery_context_identity', false);
  const files = new Map(snapshot.files.map(file => [file.path, file])), seenNative = new Set<string>();
  const definitions: Candidate[] = [];
  for (const node of native.nodes) {
    if (seenNative.has(node.id)) return semanticInvalid('architecture_source_selection_native_identity', false);
    seenNative.add(node.id);
    if (node.provider !== 'codegraph' || !['function', 'method', 'class', 'interface', 'enum', 'type', 'type_alias', 'variable', 'constant'].includes(node.kind) || !node.path) continue;
    const file = files.get(node.path);
    if (!file || !Number.isSafeInteger(node.line_start) || !Number.isSafeInteger(node.line_end) || (node.line_start as number) < 1 || (node.line_end as number) < (node.line_start as number) || (node.line_end as number) > file.line_count) return semanticInvalid('architecture_source_selection_native_range', false);
    definitions.push({ definition_id: node.id, definition_kind: node.kind, label: node.label, path: node.path, line_start: node.line_start as number, line_end: node.line_end as number, file_sha256: file.sha256, source_kind: sourceKind(node.path) });
  }
  definitions.sort((a, b) => (a.line_end - a.line_start) - (b.line_end - b.line_start) || a.path.localeCompare(b.path) || a.line_start - b.line_start || a.definition_id.localeCompare(b.definition_id));
  const seenClaims = new Set<string>();
  return claims.map(original => {
    if (!original.id || seenClaims.has(original.id) || !original.node_id || !original.field || !original.text.trim() || !['narrative', 'rule_application'].includes(original.kind) || original.assertion_scope !== undefined && original.assertion_scope !== 'source_definition') return semanticInvalid('architecture_source_selection_claim_identity', false);
    seenClaims.add(original.id);
    const claim = structuredClone(original);
    for (const range of claim.evidence) {
      const file = files.get(range.path);
      if (!file || !Number.isSafeInteger(range.line_start) || !Number.isSafeInteger(range.line_end) || range.line_start < 1 || range.line_end < range.line_start || range.line_end > file.line_count) return semanticInvalid('architecture_source_selection_source_range', false);
    }
    const { candidates: nativeCandidates, excluded_containers } = deriveNativeSourceAnchors(definitions, claim.evidence);
    const references = new Map<string, Candidate>();
    for (const range of claim.evidence) {
      const file_sha256 = files.get(range.path)?.sha256 as string;
      const definition_id = 'ER-' + semanticDigest({ protocol: 'architecture-reference-source-1.0.0', snapshot_id: snapshot.snapshot_id, path: range.path, line_start: range.line_start, line_end: range.line_end, file_sha256 });
      if (seenNative.has(definition_id)) return semanticInvalid('architecture_source_selection_native_identity', false);
      references.set(definition_id, { definition_id, definition_kind: 'source_reference', label: `Original ${sourceKind(range.path)} reference ${range.path}:${range.line_start}-${range.line_end}`, path: range.path, line_start: range.line_start, line_end: range.line_end, file_sha256, source_kind: sourceKind(range.path) });
    }
    const candidates = [...nativeCandidates, ...[...references.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end)];
    const excluded = new Set(excluded_containers.map(row => row.definition_id)), eligible = candidates.filter(candidate => !excluded.has(candidate.definition_id));
    const claim_sha256 = semanticDigest(claim), text_sha256 = semanticDigest(claim.text), evidence_sha256 = semanticDigest(claim.evidence.map(range => ({ ...range, file_sha256: files.get(range.path)?.sha256 })));
    const catalog_sha256 = semanticDigest({ protocol: ARCHITECTURE_SOURCE_SELECTION_PROTOCOL, snapshot_id: snapshot.snapshot_id, claim_sha256, evidence_sha256, candidates, excluded_containers });
    const plan: Plan = { claim, claim_sha256, text_sha256, evidence_sha256, catalog_sha256, candidates, excluded_containers, eligible };
    if (!recovery) return plan;
    const previous = recovery.previous.find(item => item.id === claim.id);
    if (!previous) return semanticInvalid('architecture_source_recovery_previous_identity', false);
    const { primary_definition_ids: _previousIds, selected_source_evidence: _previousEvidence, selection_sha256: _previousHash, selection_catalog_sha256: _previousCatalog, selection_claim_sha256: _previousClaimHash, selection_recovery: _previousRecovery, ...previousOriginal } = previous;
    if (previous.selection_claim_sha256 !== claim_sha256 || semanticDigest(previousOriginal) !== claim_sha256 || !Array.isArray(previous.primary_definition_ids) || !Array.isArray(previous.selected_source_evidence)) return semanticInvalid('architecture_source_recovery_previous_identity', false);
    const catalog = recovery.context.catalog(claim.evidence);
    plan.previous = structuredClone(previous); plan.recovery_catalog = catalog;
    if (!catalog.reachable_definitions.length) { plan.skip_recovery = true; return plan; }
    const extra = catalog.reachable_definitions.filter(node => !eligible.some(candidate => candidate.definition_id === node.definition_id)).map(node => ({ definition_id: node.definition_id, definition_kind: node.definition_kind, label: node.label, path: node.path, line_start: node.line_start, line_end: node.line_end, file_sha256: node.file_sha256, source_kind: sourceKind(node.path), retrieval_path: node.retrieval_path }));
    if (!extra.length) { plan.skip_recovery = true; return plan; }
    const candidateIds = new Set(candidates.map(candidate => candidate.definition_id));
    plan.candidates = [...candidates, ...extra.filter(candidate => !candidateIds.has(candidate.definition_id))]; plan.eligible = [...eligible, ...extra];
    plan.recovery = { protocol: ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL, catalog_sha256: catalog.catalog_sha256 };
    plan.catalog_sha256 = semanticDigest({ protocol: ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL, snapshot_id: snapshot.snapshot_id, claim_sha256, evidence_sha256, candidates: plan.candidates, excluded_containers, recovery_catalog_sha256: catalog.catalog_sha256 });
    return plan;
  });
}
function context(plan: Plan, candidates: Candidate[], page: number, pages: number): SelectionContext {
  const page_sha256 = semanticDigest(candidates), identity = { protocol: plan.recovery ? ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL : ARCHITECTURE_SOURCE_SELECTION_PROTOCOL, claim_sha256: plan.claim_sha256, catalog_sha256: plan.catalog_sha256, page_sha256, page, pages };
  const scope = plan.claim.scope_context;
  // The original paragraph stays hash-bound in the private claim. Retrieval
  // targets only the atomic text, rather than unrelated sibling operations.
  const scope_context = objectRecord(scope) ? Object.fromEntries(Object.entries(scope).filter(([key]) => key !== 'field_text')) : scope;
  return { context_id: `AS-${semanticDigest(identity)}`, claim_id: plan.claim.id, node_id: plan.claim.node_id, field: plan.claim.field, kind: plan.claim.kind, text: plan.claim.text, text_sha256: plan.text_sha256,
    claim_sha256: plan.claim_sha256, evidence_sha256: plan.evidence_sha256, catalog_sha256: plan.catalog_sha256, page_sha256, ...(scope_context === undefined ? {} : { scope_context: structuredClone(scope_context) }), ...(plan.claim.assertion_scope ? { assertion_scope: plan.claim.assertion_scope } : {}), page, pages, candidates, ...(plan.recovery ? { selection_recovery: plan.recovery } : {}) };
}
function requestFor(snapshotId: string, contexts: SelectionContext[]) {
  const schema = wireObject({ selections: wireList(contexts.length, wireObject({ context_id: wireText(100, contexts.map(row => row.context_id)), claim_id: wireText(500, contexts.map(row => row.claim_id)), text_sha256: wireText(64, contexts.map(row => row.text_sha256)), catalog_sha256: wireText(64, contexts.map(row => row.catalog_sha256)), page_sha256: wireText(64, contexts.map(row => row.page_sha256)), selected_definition_ids: wireList(MAX_SELECTED, wireText(500, [...new Set(contexts.flatMap(row => row.candidates.map(candidate => candidate.definition_id)))])), missing_reasons: wireList(8, wireText(400)) }), contexts.length) });
  const input = { selector_protocol: ARCHITECTURE_SOURCE_SELECTION_PROTOCOL, snapshot_id: snapshotId,
    task: '这是源码位置检索，不是事实校验。context.text是唯一待定位的原子陈述，scope_context只用于消歧，不能把整段字段或同模块其他操作当成检索目标。保持每条原claim文字、作用域和所有身份不变，从当前candidate页中选择最多8个最直接的来源ID。优先选择实际操作的完整原生定义；如果具体操作未被单独索引，包含其原始引用的最小完整外层工厂也是合法检索容器，不能只因它是工厂而排除。definition_kind=source_reference表示精确的原始引用范围，选它只能补充定位配置、类型、测试、文档或未索引片段，不能冒充完整操作定义；有直接原生定义时避免重复选择不相关的宽范围源码引用。其他definition_kind记录原生定义种类；接口、类型、枚举、常量和变量只能定位其可见声明，不能凭名称推断运行时语义。assertion_scope=source_definition时仅定位要核验的可见定义。不能按文件名猜实现，不能把同页其他claim的候选借来使用，不能批准/否定claim、提出替换说明或创造新规则。测试/资料候选只能帮助定位，不能作为运行时行为已落实或测试已通过的证明。完整catalog可能拆为多页；只判断当前页相关位置，不假装见到其他页。每个context精确返回一次并回显claim_id/text_sha256/catalog_sha256/page_sha256。没有足够候选时selected_definition_ids为空且missing_reasons非空，不强行选择或隐瞒缺失。只返回output_schema中的检索结果。',
    contexts, output_schema: schema };
  if (contexts.some(context => context.selection_recovery)) { input.selector_protocol = ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL; input.task += ' 当前是针对既有阻断项的有界原生调用恢复检索。retrieval_path仅记录宿主从原始锚点沿原生调用边找到候选的路径，不证明调用实际执行，不扩大事实断言或免除必要守卫；仍只定位context.text，不把所有可达定义当成证明。'; }
  return { input, schema, byteLength: bytes({ analysis_phase: PHASE, ...input }) };
}
function candidatePages(snapshotId: string, plan: Plan): SelectionContext[] {
  if (plan.skip_recovery || !plan.eligible.length) return [];
  const split = (candidates: Candidate[]): Candidate[][] => {
    // Reserve the widest possible page counters before choosing immutable cuts.
    if (requestFor(snapshotId, [context(plan, candidates, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]).byteLength <= PAGE_BYTES) return [candidates];
    if (candidates.length < 2) return semanticInvalid('architecture_source_selection_input_budget', false);
    const middle = Math.ceil(candidates.length / 2); return [...split(candidates.slice(0, middle)), ...split(candidates.slice(middle))];
  };
  const partitions = split(plan.eligible);
  if (semanticDigest(partitions.flat()) !== semanticDigest(plan.eligible)) return semanticInvalid('architecture_source_selection_catalog_coverage', false);
  return partitions.map((candidates, index) => context(plan, candidates, index + 1, partitions.length));
}
function selectionPages(snapshotId: string, contexts: SelectionContext[]): SelectionContext[][] {
  const pages: SelectionContext[][] = []; let current: SelectionContext[] = [];
  for (const row of contexts) {
    if (current.length && (current.length >= MAX_CLAIMS || current.some(item => item.claim_id === row.claim_id) || requestFor(snapshotId, [...current, row]).byteLength > PAGE_BYTES)) { pages.push(current); current = []; }
    if (requestFor(snapshotId, [row]).byteLength > PAGE_BYTES) return semanticInvalid('architecture_source_selection_input_budget', false);
    current.push(row);
  }
  if (current.length) pages.push(current);
  return pages;
}
function validateSelection(value: unknown, contexts: SelectionContext[], schema: ReturnType<typeof requestFor>['schema']): PageSelection[] {
  assertArchitectureWireShape(value, schema);
  const rows = (value as { selections: PageSelection[] }).selections, seen = new Set<string>();
  for (const row of rows) {
    const original = contexts.find(item => item.context_id === row.context_id);
    if (!original || seen.has(row.context_id) || row.claim_id !== original.claim_id || row.text_sha256 !== original.text_sha256 || row.catalog_sha256 !== original.catalog_sha256 || row.page_sha256 !== original.page_sha256) return semanticInvalid('architecture_source_selection_response_identity', true, ['$.selections']);
    seen.add(row.context_id);
    const allowed = new Set(original.candidates.map(candidate => candidate.definition_id));
    if (new Set(row.selected_definition_ids).size !== row.selected_definition_ids.length || row.selected_definition_ids.some(id => !allowed.has(id))) return semanticInvalid('architecture_source_selection_definition_identity', true, ['$.selections[].selected_definition_ids']);
    if (!row.selected_definition_ids.length && !row.missing_reasons.length) return semanticInvalid('architecture_source_selection_missing_reason', true, ['$.selections[].missing_reasons']);
  }
  if (seen.size !== contexts.length) return semanticInvalid('architecture_source_selection_response_coverage', true, ['$.selections']);
  return structuredClone(rows);
}

/** Pure capacity planning: no model, source-file read, cache access or writes. */
export function prepareArchitectureClaimSourceSelection(options: { snapshot: CodeSnapshot; native: Native; claims: GroundingClaim[]; recovery?: ArchitectureSourceRecoveryOptions }) {
  const plans = planClaims(options.snapshot, options.native, options.claims, options.recovery), contexts = plans.flatMap(plan => candidatePages(options.snapshot.snapshot_id, plan)), pages = selectionPages(options.snapshot.snapshot_id, contexts);
  const request_bytes = pages.map(items => requestFor(options.snapshot.snapshot_id, items).byteLength);
  return { plans, contexts, pages, statistics: { claims: plans.length, original_candidates: plans.reduce((n, plan) => n + plan.candidates.length, 0), eligible_candidates: plans.reduce((n, plan) => n + plan.eligible.length, 0), excluded_containers: plans.reduce((n, plan) => n + plan.excluded_containers.length, 0), catalog_pages: contexts.length, requests: pages.length, request_bytes, total_request_bytes: request_bytes.reduce((n, value) => n + value, 0), max_request_bytes: Math.max(0, ...request_bytes), ...(options.recovery ? { recovery_skipped_no_additional: plans.filter(plan => plan.skip_recovery).length, recovery_additional_definitions: plans.reduce((n, plan) => n + (plan.recovery_catalog?.reachable_definitions.length ?? 0), 0) } : {}) } };
}

/** Retrieves bounded candidate definitions only. Selection is never semantic proof. */
export async function selectArchitectureClaimSources(options: { snapshot: CodeSnapshot; native: Native; claims: GroundingClaim[]; client: Client; parallel: <T, R>(items: T[], action: (item: T, index: number) => Promise<R>) => Promise<R[]>; onProgress?: (completed: number, total: number) => Promise<void>; runDirectory?: string; recovery?: ArchitectureSourceRecoveryOptions }) {
  const { plans, contexts, pages, statistics: planning } = prepareArchitectureClaimSourceSelection(options);
  let completed = 0, cachedRequests = 0, contextsCached = 0, contextsEvaluated = 0, concreteCached = 0, concreteEvaluated = 0;
  const partitions: { reason: 'output_truncated'; request_sha256: string; context_ids: string[]; children: string[][] }[] = [];
  const singleton = (item: SelectionContext) => requestFor(options.snapshot.snapshot_id, [item]);
  await options.onProgress?.(0, pages.length);
  async function selectGroup(items: SelectionContext[], name: string): Promise<{ rows: PageSelection[]; cached: boolean }> {
    const request = requestFor(options.snapshot.snapshot_id, items);
    const result = await options.client.call({ phase: PHASE, name, input: request.input, maxTokens: 16000, validate: raw => validateSelection(raw, items, request.schema) }).catch(async error => {
      // A length-stopped response contributes no rows. Retry complete contexts
      // without changing their candidate pages or multiplying concurrency.
      if (items.length < 2 || !(error instanceof DomainError) || error.code !== 'code_analysis_model_invalid' || error.details?.reason !== 'output_truncated') throw error;
      const middle = Math.ceil(items.length / 2), left = items.slice(0, middle), right = items.slice(middle);
      partitions.push({ reason: 'output_truncated', request_sha256: semanticDigest({ analysis_phase: PHASE, ...request.input }), context_ids: items.map(item => item.context_id), children: [left, right].map(child => child.map(item => item.context_id)) });
      if (options.runDirectory) writeSemanticJson(path.join(options.runDirectory, `semantic-source-selection-partition-${semanticDigest(options.claims).slice(0, 24)}.json`), { snapshot_id: options.snapshot.snapshot_id, partitions });
      const first = await selectGroup(left, name + '-left'), second = await selectGroup(right, name + '-right');
      return { partitionedRows: [...first.rows, ...second.rows], cached: first.cached && second.cached };
    });
    if ('partitionedRows' in result) return { rows: result.partitionedRows, cached: result.cached };
    if (result.cached) { concreteCached++; contextsCached += items.length; } else { concreteEvaluated++; contextsEvaluated += items.length; }
    // Validate the complete response before deriving any raw singleton row.
    // Each checkpoint retains the actual requested and response model origin.
    for (const item of items) {
      const row = result.value.find(row => row.context_id === item.context_id);
      if (!row) return semanticInvalid('architecture_source_selection_response_coverage', false);
      const request = singleton(item), raw = { selections: [row] };
      validateSelection(raw, [item], request.schema);
      options.client.save?.({ phase: PHASE, input: request.input, inference_policy: { ...semanticInferencePolicy(PHASE), max_tokens: 16000 } }, raw, result.model, result.originModel);
    }
    return { rows: result.value, cached: result.cached === true };
  }
  const selectedPages = (await options.parallel(pages, async (items, index) => {
    const rows: PageSelection[] = [], misses: SelectionContext[] = [];
    for (const item of items) {
      const request = singleton(item);
      const cached = options.client.cacheRequest?.({ phase: PHASE, input: request.input, maxTokens: 16000, validate: raw => validateSelection(raw, [item], request.schema) });
      if (cached) { contextsCached++; rows.push(...cached.value); } else misses.push(item);
    }
    // With no singleton hits, this is the identical original group request, so
    // complete existing group caches remain usable and seed finer checkpoints.
    const result = misses.length ? await selectGroup(misses, `source-selection-${index}`) : { rows: [], cached: true };
    if (result.cached) cachedRequests++;
    await options.onProgress?.(++completed, pages.length); return [...rows, ...result.rows];
  })).flat();
  const selections: ArchitectureClaimSourceSelection[] = plans.map(plan => {
    if (plan.skip_recovery) {
      const previous = plan.previous as SelectedGroundingClaim;
      const ranges = previous.primary_definition_ids.map(id => { const node = options.native.nodes.find(node => node.id === id); if (!node?.path) return semanticInvalid('architecture_source_recovery_previous_identity', false); return { path: node.path, line_start: node.line_start as number, line_end: node.line_end as number }; });
      return { claim_id: plan.claim.id, claim_sha256: plan.claim_sha256, text_sha256: plan.text_sha256, catalog_sha256: previous.selection_catalog_sha256, selection_sha256: previous.selection_sha256, original_claim: structuredClone(plan.claim), candidates: structuredClone(plan.candidates), excluded_containers: structuredClone(plan.excluded_containers), selected_definition_ids: [...previous.primary_definition_ids], selected_source_evidence: structuredClone(previous.selected_source_evidence), selected_evidence: [...ranges, ...structuredClone(previous.selected_source_evidence)], missing_reasons: [], pages: [], ...(previous.selection_recovery ? { selection_recovery: structuredClone(previous.selection_recovery) } : {}), recovery_catalog: plan.recovery_catalog, recovery_skipped: true };
    }
    const rows = selectedPages.filter(row => row.claim_id === plan.claim.id), expected = contexts.filter(row => row.claim_id === plan.claim.id);
    if (rows.length !== expected.length || rows.some(row => !expected.some(item => item.context_id === row.context_id))) return semanticInvalid('architecture_source_selection_response_coverage', false);
    const selected_ids = [...new Set(rows.flatMap(row => row.selected_definition_ids))].sort();
    if (selected_ids.length > MAX_SELECTED) return semanticInvalid('architecture_source_selection_ambiguous', false);
    const selected_candidates = selected_ids.map(id => {
      const candidate = plan.eligible.find(item => item.definition_id === id); if (!candidate) return semanticInvalid('architecture_source_selection_definition_identity', false);
      return candidate;
    });
    const selected_definition_ids = selected_candidates.filter(candidate => candidate.definition_kind !== 'source_reference').map(candidate => candidate.definition_id);
    const evidence = (candidate: Candidate): SourceEvidence => ({ path: candidate.path, line_start: candidate.line_start, line_end: candidate.line_end });
    const selected_source_evidence = selected_candidates.filter(candidate => candidate.definition_kind === 'source_reference').map(evidence).sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end);
    const selected_evidence = [...new Map(selected_candidates.map(candidate => { const range = evidence(candidate); return [JSON.stringify(range), range]; })).values()];
    // A larger navigation catalog need not change the actual proof inputs.
    // Keep its attempted identity in this audit while retaining the prior claim.
    const unchanged = plan.recovery && plan.previous && semanticDigest(normalizedChoices(selected_definition_ids, selected_source_evidence)) === semanticDigest(normalizedChoices(plan.previous.primary_definition_ids, plan.previous.selected_source_evidence));
    return { claim_id: plan.claim.id, claim_sha256: plan.claim_sha256, text_sha256: plan.text_sha256, catalog_sha256: plan.catalog_sha256, selection_sha256: selectionDigest(options.snapshot.snapshot_id, plan, selected_definition_ids, selected_source_evidence), original_claim: structuredClone(plan.claim), candidates: structuredClone(plan.candidates), excluded_containers: structuredClone(plan.excluded_containers), selected_definition_ids, selected_source_evidence, selected_evidence, missing_reasons: rows.length ? [...new Set(rows.flatMap(row => row.missing_reasons))] : ['No eligible source candidate overlaps the original source evidence.'], pages: structuredClone(rows), ...(plan.recovery ? { selection_recovery: plan.recovery, recovery_catalog: plan.recovery_catalog } : {}), ...(unchanged ? { recovery_unchanged: true, effective_selection_sha256: plan.previous?.selection_sha256 } : {}) };
  });
  const claims: SelectedGroundingClaim[] = plans.map((plan, index) => {
    const selection = selections[index] as ArchitectureClaimSourceSelection;
    if (plan.skip_recovery || selection.recovery_unchanged) return structuredClone(plan.previous as SelectedGroundingClaim);
    return { ...structuredClone(plan.claim), primary_definition_ids: [...selection.selected_definition_ids], selected_source_evidence: structuredClone(selection.selected_source_evidence), selection_sha256: selection.selection_sha256, selection_catalog_sha256: plan.catalog_sha256, selection_claim_sha256: plan.claim_sha256, ...(plan.recovery ? { selection_recovery: plan.recovery } : {}) };
  });
  const statistics = { ...planning, cached_requests: cachedRequests, contexts_cached: contextsCached, contexts_evaluated: contextsEvaluated, concrete_cached_groups: concreteCached, concrete_evaluated_groups: concreteEvaluated, output_truncation_partitions: partitions.length, selected_definitions: selections.reduce((n, selection) => n + selection.selected_definition_ids.length, 0), selected_references: selections.reduce((n, selection) => n + selection.selected_source_evidence.length, 0), empty_selections: selections.filter(selection => !selection.selected_definition_ids.length && !selection.selected_source_evidence.length).length, ...(options.recovery ? { recovery_unchanged_selections: selections.filter(selection => selection.recovery_unchanged).length } : {}) };
  if (options.runDirectory) writeSemanticJson(path.join(options.runDirectory, 'semantic-source-selections.json'), { protocol: options.recovery ? ARCHITECTURE_NATIVE_CALL_RECOVERY_PROTOCOL : ARCHITECTURE_SOURCE_SELECTION_PROTOCOL, snapshot_id: options.snapshot.snapshot_id, semantics: 'Retrieval locations only; no claim has been approved or rewritten. Actual body/guard verification is required.', statistics, selections });
  return { claims, statistics, selections };
}
