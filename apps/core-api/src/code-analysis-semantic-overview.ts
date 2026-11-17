import type { CodeSnapshot } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { semanticDigest, semanticInvalid, type FileBrief, type SourceEvidence } from './code-analysis-semantic-source.js';
import { createArchitectureEvidenceRequest, GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA, wireList, wireObject, wireText, type ArchitectureWireShape } from './code-analysis-semantic-architecture-wire.js';

export const OVERVIEW_PROTOCOL = 'architecture-overview-1.1.0';
export const OVERVIEW_TEXT_BYTES = 8192;
export const OVERVIEW_CANONICAL_RESIDUAL_BYTES = 12 * 1024;
export const OVERVIEW_MINIMUM_SEMANTIC_BYTES = 8 * 1024;
export const OVERVIEW_RESIDUAL_RATIO = 0.35;
export const OVERVIEW_LAYER_RATIO = 0.6;
export const OVERVIEW_LIMITATIONS = [
  'Overview nodes contain core source inferences only. Complete behavior rules, dependencies, unknowns and source evidence remain in the file nodes.',
  'Preserving typed uncertainty and host ledger counts does not prove that every overview rule is semantically faithful or free of uncertainty laundering. Independent question and workflow evaluation is required.',
  'Selected overview and global business rules restore their original map text and complete supports through stable leaf references. This prevents new rule rewrites but does not establish correctness of the original map or free navigation summaries; independent source evaluation remains required.',
];
export const overviewBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export interface OverviewUncertaintyAudit { uncertain_claims: number; checks: { path: string; findings: { claim_id: string; status: string; replacement: string }[] }[] }
export interface OverviewCandidate { candidate_id: string; name: string; responsibility: string; state_owners: string[]; user_purposes: string[]; epistemic_status: string; detail_file_ids: number[]; evidence: SourceEvidence[] }
export interface OverviewLeafRule { parent_rule_id: string; description: string; source_epistemic_status: string; epistemic_status: string; evidence: SourceEvidence[] }
export interface OverviewRule extends OverviewLeafRule { candidate_ids: string[] }
export interface OverviewContract extends OverviewRule { counterparty: string }
export interface OverviewUnknown { description: string; detail_file_ids: number[]; evidence: SourceEvidence[] }
export interface OverviewBundle {
  kind: 'overview'; protocol: string; detail_index_ref: string; source_input_sha256: string; covered_file_ids: number[];
  uncertainty: { unknown_entries: number; unknown_file_ids: number[]; uncertain_claims: number | null; uncertain_file_ids: number[] };
  candidates: OverviewCandidate[]; shared_invariants: OverviewRule[]; boundary_contracts: OverviewContract[]; important_unknowns: OverviewUnknown[];
}
export interface OverviewMapProposal { related_paths: string[]; evidence: SourceEvidence[]; business_rules: { description: string; evidence: SourceEvidence[] }[] }
export type OverviewInput = OverviewMapProposal | OverviewBundle;
export function createOverviewContext(options: { snapshot: CodeSnapshot; briefs: FileBrief[]; uncertaintyAudit?: OverviewUncertaintyAudit }) {
  const files = [...options.snapshot.files].sort((a, b) => a.path.localeCompare(b.path)), byPath = new Map(files.map((file, id) => [file.path, id]));
  const briefMap = new Map(options.briefs.map(brief => [brief.path, brief])), uncertainByFile = new Map<string, number>();
  if (briefMap.size !== files.length || files.some(file => !briefMap.has(file.path))) return semanticInvalid('overview_detail_identity', false);
  if (options.uncertaintyAudit) {
    const claims = new Map<string, { path: string; findings: { status: string; replacement: string }[] }>();
    for (const check of options.uncertaintyAudit.checks) for (const finding of check.findings) {
      const key = JSON.stringify([check.path, finding.claim_id]), row = claims.get(key) ?? { path: check.path, findings: [] }; row.findings.push(finding); claims.set(key, row);
    }
    for (const { path, findings } of claims.values()) if (!(findings.every(finding => finding.status === 'corrected') && new Set(findings.map(finding => finding.replacement)).size === 1)) uncertainByFile.set(path, (uncertainByFile.get(path) ?? 0) + 1);
    if ([...uncertainByFile.values()].reduce((a, b) => a + b, 0) !== options.uncertaintyAudit.uncertain_claims) return semanticInvalid('overview_uncertainty_identity', false);
  }
  const ledger = files.map((file, id) => ({ file_id: id, path: file.path, sha256: file.sha256, detail_sha256: semanticDigest(briefMap.get(file.path)), unknown_entries: briefMap.get(file.path)?.unknowns.length ?? 0, uncertain_claims: options.uncertaintyAudit ? uncertainByFile.get(file.path) ?? 0 : null }));
  const indexRef = semanticDigest({ snapshot_id: options.snapshot.snapshot_id, ledger }), fileIndex = files.map((file, id) => [id, file.path] as [number, string]);
  function uncertainty(ids: number[]): OverviewBundle['uncertainty'] {
    const rows = ids.map(id => { const row = ledger[id]; if (!row) return semanticInvalid('overview_file_identity', false); return row; });
    return { unknown_entries: rows.reduce((n, row) => n + row.unknown_entries, 0), unknown_file_ids: rows.filter(row => row.unknown_entries > 0).map(row => row.file_id), uncertain_claims: options.uncertaintyAudit ? rows.reduce((n, row) => n + (row.uncertain_claims ?? 0), 0) : null, uncertain_file_ids: rows.filter(row => (row.uncertain_claims ?? 0) > 0).map(row => row.file_id) };
  }
  function fileIds(inputs: OverviewInput[]): number[] {
    const ids = inputs.flatMap(input => {
      if ('covered_file_ids' in input) { if (input.detail_index_ref !== indexRef || input.protocol !== OVERVIEW_PROTOCOL) return semanticInvalid('overview_detail_identity', false); return input.covered_file_ids; }
      return input.related_paths.map(file => { const id = byPath.get(file); if (id === undefined) return semanticInvalid('overview_file_identity', false); return id; });
    });
    if (ids.some(id => !Number.isSafeInteger(id) || !ledger[id])) return semanticInvalid('overview_file_identity', false);
    return [...new Set(ids)].sort((a, b) => a - b);
  }
  return { snapshotId: options.snapshot.snapshot_id, indexRef, fileIndex, ledger, detailHash: semanticDigest(options.briefs), fileIds, uncertainty,
    promptIndex: { detail_index_ref: indexRef, file_index: fileIndex, node_id_template: 'file:{path}', detail_scope: 'Full file summaries, behavior rules, dependencies, unknowns and source supports remain in file nodes. These details are not reproduced in this overview or available for tool reads during synthesis.', uncertainty: uncertainty(files.map((_, id) => id)) } };
}
export type OverviewContext = ReturnType<typeof createOverviewContext>;
const initialRuleStatus = (description: string): string => /^(?:待确认|未知|跨文件待确认)[：:]/u.test(description) ? 'uncertain' : 'source_inference';
/** A leaf's identity and original support order survive every overview level. */
export function overviewLeafRules(context: OverviewContext, inputs: OverviewInput[]): OverviewLeafRule[] {
  const entries = new Map<string, OverviewLeafRule>();
  const identity = (rule: Pick<OverviewLeafRule, 'description' | 'source_epistemic_status' | 'evidence'>) => `OR-${semanticDigest({ protocol: 'overview-leaf-rule-1.0.0', snapshot_id: context.snapshotId, detail_index_ref: context.indexRef, description: rule.description, source_epistemic_status: rule.source_epistemic_status, evidence: rule.evidence })}`;
  function add(rule: OverviewLeafRule) {
    if (!['source_inference', 'uncertain'].includes(rule.source_epistemic_status) || !['source_inference', 'uncertain'].includes(rule.epistemic_status)
      || rule.source_epistemic_status === 'uncertain' && rule.epistemic_status !== 'uncertain' || identity(rule) !== rule.parent_rule_id) return semanticInvalid('overview_rule_identity', false);
    const old = entries.get(rule.parent_rule_id);
    if (old && semanticDigest({ ...old, epistemic_status: undefined }) !== semanticDigest({ ...rule, epistemic_status: undefined })) return semanticInvalid('overview_rule_identity', false);
    entries.set(rule.parent_rule_id, { ...rule, epistemic_status: old?.epistemic_status === 'uncertain' ? 'uncertain' : rule.epistemic_status, evidence: rule.evidence.map(item => ({ ...item })) });
  }
  for (const input of inputs) {
    if ('covered_file_ids' in input) {
      context.fileIds([input]);
      for (const rule of [...input.shared_invariants, ...input.boundary_contracts]) add({ parent_rule_id: rule.parent_rule_id, description: rule.description, source_epistemic_status: rule.source_epistemic_status, epistemic_status: rule.epistemic_status, evidence: rule.evidence });
    } else for (const rule of input.business_rules) {
      const status = initialRuleStatus(rule.description), source = { description: rule.description, source_epistemic_status: status, evidence: rule.evidence };
      add({ ...source, parent_rule_id: identity(source), epistemic_status: status });
    }
  }
  return [...entries.values()].sort((a, b) => a.parent_rule_id.localeCompare(b.parent_rule_id));
}
function restoreOverviewRule(ref: { parent_rule_id: string; epistemic_status: string }, rules: readonly OverviewLeafRule[]): OverviewLeafRule {
  const source = rules.find(rule => rule.parent_rule_id === ref.parent_rule_id);
  if (!source) return semanticInvalid('overview_rule_reference', true, ['$.parent_rule_id'], [{ path: '$.parent_rule_id', rule: 'enum', allowed_values: rules.map(rule => rule.parent_rule_id) }]);
  if (source.epistemic_status === 'uncertain' && ref.epistemic_status !== 'uncertain') return semanticInvalid('overview_rule_uncertainty', true, ['$.epistemic_status'], [{ path: '$.epistemic_status', rule: 'enum', allowed_values: ['uncertain'] }]);
  return { ...source, epistemic_status: ref.epistemic_status, evidence: source.evidence.map(item => ({ ...item })) };
}
function ruleReferenceSchema(rules: readonly OverviewLeafRule[]) {
  return { parent_rule_id: wireText(100, rules.map(rule => rule.parent_rule_id)), epistemic_status: wireText(20, ['source_inference', 'uncertain']) };
}
/** Facts remain complete but repeated rules are represented by one host-owned catalog. */
function referencedInputs(context: OverviewContext, inputs: OverviewInput[]) {
  return inputs.map(input => {
    if ('covered_file_ids' in input) return { ...input, shared_invariants: input.shared_invariants.map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: rule.candidate_ids, epistemic_status: rule.epistemic_status })), boundary_contracts: input.boundary_contracts.map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: rule.candidate_ids, counterparty: rule.counterparty, epistemic_status: rule.epistemic_status })) };
    const { business_rules: _rules, ...rest } = input;
    return { ...rest, parent_rules: overviewLeafRules(context, [input]).map(rule => ({ parent_rule_id: rule.parent_rule_id, epistemic_status: rule.epistemic_status })) };
  });
}
export function overviewFixedFloor(context: OverviewContext, inputs: OverviewInput[]): number {
  const size = overviewBytes({ detail_index: context.promptIndex, covered_file_ids: context.fileIds(inputs) });
  if (size > 115000) return semanticInvalid('overview_irreducible_budget', false, ['$.detail_index'], [{ path: '$.host_fixed_floor_bytes', rule: 'max_length', observed_length: size, maximum: 115000 }]);
  return size;
}
export async function reduceOverviewInputs(context: OverviewContext, inputs: OverviewInput[], name: string, execute: (inputs: OverviewInput[], name: string) => Promise<OverviewBundle>, onPartition: (record: Record<string, unknown>) => void): Promise<OverviewBundle[]> {
  try { return [await execute(inputs, name)]; }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'code_analysis_model_invalid' || error.details?.reason !== 'output_truncated' || inputs.length < 2) throw error;
    const middle = Math.ceil(inputs.length / 2), left = inputs.slice(0, middle), right = inputs.slice(middle);
    if (semanticDigest([...left, ...right]) !== semanticDigest(inputs)) return semanticInvalid('overview_partition_identity', false);
    onPartition({ reason: 'output_truncated', name, inputs_sha256: semanticDigest(inputs), children: [{ name: `${name}-left`, input_hashes: left.map(input => semanticDigest(input)), covered_file_ids: context.fileIds(left) }, { name: `${name}-right`, input_hashes: right.map(input => semanticDigest(input)), covered_file_ids: context.fileIds(right) }] });
    const result = [...await reduceOverviewInputs(context, left, `${name}-left`, execute, onPartition), ...await reduceOverviewInputs(context, right, `${name}-right`, execute, onPartition)];
    if (JSON.stringify(context.fileIds(result)) !== JSON.stringify(context.fileIds(inputs))) return semanticInvalid('overview_coverage', false);
    return result;
  }
}
const candidates = ['C1', 'C2', 'C3', 'C4'], statuses = ['source_inference', 'uncertain'];
function overviewSchema(fileIds: string[], hasEvidence: boolean, rules: readonly OverviewLeafRule[]) {
  const refs = (minimum = 1) => wireList(2, wireText(100), minimum), detailRefs = () => wireList(4, wireText(100, fileIds), 1), candidateRefs = (maximum = 4) => wireList(maximum, wireText(2, candidates), 1);
  return wireObject({ covered_file_ids: wireList(fileIds.length, wireText(100, fileIds), fileIds.length),
    candidates: wireList(4, wireObject({ candidate_id: wireText(2, candidates), name: wireText(80), responsibility: wireText(200), state_owners: wireList(2, wireText(80)), user_purposes: wireList(2, wireText(80)), epistemic_status: wireText(20, statuses), detail_file_ids: detailRefs(), evidence_ids: refs(hasEvidence ? 1 : 0) }), 1),
    shared_invariants: wireList(6, wireObject({ ...ruleReferenceSchema(rules), candidate_ids: candidateRefs() })),
    boundary_contracts: wireList(4, wireObject({ ...ruleReferenceSchema(rules), counterparty: wireText(80), candidate_ids: candidateRefs(2) })),
    important_unknowns: wireList(4, wireObject({ description: wireText(200), detail_file_ids: detailRefs(), evidence_ids: refs(0) })),
  });
}
function humanTextBytes(value: unknown, key = ''): number {
  if (typeof value === 'string') return ['name', 'responsibility', 'description', 'counterparty', 'state_owners', 'user_purposes'].includes(key) ? Buffer.byteLength(value) : 0;
  if (Array.isArray(value)) return value.reduce((n, item) => n + humanTextBytes(item, key), 0);
  if (value && typeof value === 'object') return Object.entries(value).reduce((n, [name, item]) => n + humanTextBytes(item, name), 0);
  return 0;
}
export function prepareOverviewRequest(context: OverviewContext, inputs: OverviewInput[], scope: { name: string; depth: number }) {
  const covered = context.fileIds(inputs), sourceInputSha = semanticDigest(inputs), host: Omit<OverviewBundle, 'candidates' | 'shared_invariants' | 'boundary_contracts' | 'important_unknowns'> = { kind: 'overview', protocol: OVERVIEW_PROTOCOL, detail_index_ref: context.indexRef, source_input_sha256: sourceInputSha, covered_file_ids: covered, uncertainty: context.uncertainty(covered) };
  if (!inputs.length || !covered.length) return semanticInvalid('overview_empty_scope', false);
  const empty = { ...host, candidates: [], shared_invariants: [], boundary_contracts: [], important_unknowns: [] }, floorBytes = overviewBytes(empty), inputCanonicalBytes = overviewBytes({ ...empty, inputs });
  const maximumCanonicalBytes = Math.floor(floorBytes + Math.min(OVERVIEW_CANONICAL_RESIDUAL_BYTES, Math.max(OVERVIEW_MINIMUM_SEMANTIC_BYTES, OVERVIEW_RESIDUAL_RATIO * (inputCanonicalBytes - floorBytes))));
  const scopeHash = semanticDigest({ protocol: OVERVIEW_PROTOCOL, snapshot_id: context.snapshotId, index_ref: context.indexRef, ...scope, inputs }).slice(0, 16), catalog = covered.map(id => ({ id: `AP-${scopeHash}-${id}`, file_id: id, path: context.fileIndex[id]?.[1] as string }));
  const rules = overviewLeafRules(context, inputs), coveredIds = catalog.map(row => row.id), facts = { overview_protocol: OVERVIEW_PROTOCOL, input_level: scope.depth === 1 ? 'detailed-map-proposals' : 'overview-bundles', inputs: referencedInputs(context, inputs), leaf_rule_catalog: rules, detail_index_ref: context.indexRef, related_path_catalog: catalog, host_uncertainty: host.uncertainty,
    output_budget: { human_text_utf8_bytes: OVERVIEW_TEXT_BYTES, canonical_bytes_including_expanded_supports_and_metadata: maximumCanonicalBytes, host_fixed_floor_bytes: floorBytes, input_canonical_bytes: inputCanonicalBytes, residual_ratio: OVERVIEW_RESIDUAL_RATIO, minimum_semantic_residual_bytes: OVERVIEW_MINIMUM_SEMANTIC_BYTES } };
  // Only the caller-provided facts determine AE vocabulary, including valid foreign supports.
  const firstEvidence = ((): boolean => { const visit = (value: unknown): boolean => Array.isArray(value) ? value.some(visit) : Boolean(value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key === 'evidence' && Array.isArray(item) && item.length || visit(item))); return visit(inputs); })();
  const schema = overviewSchema(coveredIds, firstEvidence, rules), wire = createArchitectureEvidenceRequest({ task: '生成职责与导航概览，不能宣称概览列出所有细节。完整文件节点保留详细行为、未知和证据。全响应最多4职责候选、6条核心共享不变量、4条契约、4条重要未知。不变量与契约只选择本次leaf_rule_catalog的parent_rule_id，宿主逐字恢复原description及全部原证据；禁止返回或改写description/evidence_ids，禁止删例外、合并不同规则或自创触发条件。跨层仍选择同一叶父规则ID，不把上一层摘要当新规则。原uncertain只能保持uncertain，source_inference允许更保守为uncertain；预算不够就少选核心规则，不裁规则文本和证据。候选name/responsibility/state_owners/user_purposes及counterparty只描述职责、状态所有者、用户目的和导航，不能借这些自由文本新增业务规则或扩大动作条件。候选与重要未知最多2个AE；父规则全部支持由宿主恢复且计入text/canonical预算。covered_file_ids精确回显本页全部AP目录ID一次；候选detail_file_ids只作代表详情定位。AE可引用合法页外callee，AP仅当前文件归属，两者不能混用。candidate_ids只引用本响应真实返回的C1..C4，不同bundle的同名C编号不表示同一职责。只允许source_inference或uncertain，不可升级为已确认/已落实/测试已执行。host_uncertainty不能重报或清零，也不能把普通unknown泛化为整文件全部规则未知。严格遵守output_schema和完整恢复后的真实UTF8/canonical门；不能截字、伪造出处或隐藏冲突。', output_shape: { covered_file_ids: coveredIds, candidates: [{ candidate_id: 'C1', name: '业务职责', responsibility: '状态与用户目的的边界', state_owners: [], user_purposes: [], epistemic_status: firstEvidence ? 'source_inference' : 'uncertain', detail_file_ids: [coveredIds[0]], ...(firstEvidence ? { evidence: [] } : { evidence_ids: [] }) }], shared_invariants: [], boundary_contracts: [], important_unknowns: [] }, ...facts }, { snapshotId: context.snapshotId, phase: 'architecture-reduce', name: scope.name }, schema);
  function decode(value: unknown): OverviewBundle {
    const row = wire.decode(value, schema) as unknown as Omit<OverviewBundle, keyof typeof host> & { covered_file_ids: string[] }, received = row.covered_file_ids;
    if (new Set(received).size !== coveredIds.length || coveredIds.some(id => !received.includes(id))) return semanticInvalid('overview_coverage', true, ['$.covered_file_ids'], [{ path: '$.covered_file_ids', rule: 'exact_items', allowed_values: coveredIds, observed_count: new Set(received).size, minimum: coveredIds.length, maximum: coveredIds.length }]);
    const ids = (values: unknown): number[] => (values as string[]).map(id => { const entry = catalog.find(entry => entry.id === id); if (!entry) return semanticInvalid('overview_file_identity', true); return entry.file_id; });
    const actualCandidates = new Set(row.candidates.map(candidate => candidate.candidate_id));
    if (actualCandidates.size !== row.candidates.length) return semanticInvalid('overview_candidate_identity', true, ['$.candidates'], [{ path: '$.candidates', rule: 'unique_items', allowed_values: candidates }]);
    for (const item of [...row.shared_invariants, ...row.boundary_contracts]) if (new Set(item.candidate_ids).size !== item.candidate_ids.length || item.candidate_ids.some(id => !actualCandidates.has(id))) return semanticInvalid('overview_candidate_identity', true, ['$.shared_invariants', '$.boundary_contracts'], [{ path: '$.candidate_ids', rule: 'enum', allowed_values: [...actualCandidates] }]);
    if (!firstEvidence && row.candidates.some(candidate => candidate.epistemic_status !== 'uncertain')) return semanticInvalid('overview_empty_inference', true);
    const result: OverviewBundle = { ...host, candidates: row.candidates.map(candidate => ({ ...candidate, detail_file_ids: ids(candidate.detail_file_ids) })), shared_invariants: row.shared_invariants.map(ref => ({ ...restoreOverviewRule(ref, rules), candidate_ids: ref.candidate_ids })), boundary_contracts: row.boundary_contracts.map(ref => ({ ...restoreOverviewRule(ref, rules), candidate_ids: ref.candidate_ids, counterparty: ref.counterparty })), important_unknowns: row.important_unknowns.map(item => ({ ...item, detail_file_ids: ids(item.detail_file_ids) })) };
    const textBytes = humanTextBytes(result), canonicalBytes = overviewBytes(result);
    if (textBytes > OVERVIEW_TEXT_BYTES) return semanticInvalid('overview_text_budget', true, ['$.candidates', '$.shared_invariants', '$.boundary_contracts', '$.important_unknowns'], [{ path: '$.human_text_utf8_bytes', rule: 'max_length', observed_length: textBytes, maximum: OVERVIEW_TEXT_BYTES }]);
    if (canonicalBytes > maximumCanonicalBytes) return semanticInvalid('overview_convergence_budget', true, ['$.candidates', '$.shared_invariants', '$.boundary_contracts', '$.important_unknowns'], [{ path: '$.canonical_bytes_with_expanded_supports', rule: 'max_length', observed_length: canonicalBytes, maximum: maximumCanonicalBytes }]);
    return result;
  }
  return { ...wire, schema, decode, accounting: { inputCanonicalBytes, floorBytes, maximumCanonicalBytes }, covered };
}

export interface OverviewGlobalOriginScope {
  name: string; responsibility: string; state_owners: string[]; user_purposes: string[];
  related_paths: string[]; source_file_ids: number[]; evidence: SourceEvidence[];
}
export interface OverviewGlobalRuleLineage extends OverviewLeafRule { node_id: string; rule_index: number; origin_scope_id: string; origin_scope: OverviewGlobalOriginScope }
interface OverviewGlobalScopeEntry extends OverviewGlobalOriginScope { parent_rule_id: string; origin_scope_id: string }
function originatingRuleScopes(context: OverviewContext, inputs: OverviewInput[], rules: readonly OverviewLeafRule[]): OverviewGlobalScopeEntry[] {
  const retained = new Set(rules.map(rule => rule.parent_rule_id)), entries = new Map<string, OverviewGlobalScopeEntry>();
  const fileIds = new Map(context.fileIndex.map(([id, file]) => [file, id]));
  const text = (value: unknown): string => typeof value === 'string' && value.trim() ? value : semanticInvalid('global_origin_scope_identity', false);
  const texts = (value: unknown): string[] => Array.isArray(value) ? value.map(text) : semanticInvalid('global_origin_scope_identity', false);
  for (const input of inputs) {
    // Compressed candidates cannot recover an original operation boundary.
    if ('covered_file_ids' in input) return semanticInvalid('global_origin_scope_required', false);
    context.fileIds([input]);
    const source = input as OverviewMapProposal & Record<string, unknown>;
    const original = { name: text(source.name), responsibility: text(source.responsibility), state_owners: texts(source.state_owners), user_purposes: texts(source.user_purposes), related_paths: [...new Set(source.related_paths)].sort() };
    for (const rule of overviewLeafRules(context, [input])) {
      if (!retained.has(rule.parent_rule_id)) continue;
      const origin_scope: OverviewGlobalOriginScope = { ...original, source_file_ids: [...new Set(rule.evidence.map(item => {
        const id = fileIds.get(item.path); return id === undefined ? semanticInvalid('global_origin_scope_identity', false) : id;
      }))].sort((a, b) => a - b), evidence: rule.evidence.map(item => ({ ...item })) };
      const origin_scope_id = `OS-${semanticDigest({ protocol: 'global-origin-scope-1.0.0', snapshot_id: context.snapshotId, detail_index_ref: context.indexRef, origin_scope })}`;
      entries.set(JSON.stringify([rule.parent_rule_id, origin_scope_id]), { parent_rule_id: rule.parent_rule_id, origin_scope_id, ...origin_scope });
    }
  }
  if (rules.some(rule => ![...entries.values()].some(entry => entry.parent_rule_id === rule.parent_rule_id))) return semanticInvalid('global_origin_scope_required', false);
  return [...entries.values()].sort((a, b) => a.parent_rule_id.localeCompare(b.parent_rule_id) || a.origin_scope_id.localeCompare(b.origin_scope_id));
}
/** Only this global request changes: map/source/consistency wire contracts are untouched. */
export function prepareOverviewGlobalRequest(context: OverviewContext, inputs: OverviewInput[], request: Record<string, unknown> & { task: string; output_shape: unknown }, scope: { name: string }, originalInputs: OverviewInput[] = inputs) {
  const rules = overviewLeafRules(context, inputs), origins = originatingRuleScopes(context, originalInputs, rules);
  // Keep the host bindings private: changing the displayed request catalog cannot
  // replace a source scope or the context later returned to the renderer.
  const originPairs = new Map(origins.map(entry => [JSON.stringify([entry.parent_rule_id, entry.origin_scope_id]), structuredClone(entry)]));
  const scopeIds = [...new Set(origins.map(entry => entry.origin_scope_id))];
  function referenceShape(shape: ArchitectureWireShape): ArchitectureWireShape {
    if (shape.type === 'array') return { ...shape, items: referenceShape(shape.items) };
    if (shape.type !== 'object') return shape;
    return { ...shape, properties: Object.fromEntries(Object.entries(shape.properties).map(([key, value]) => [key, key === 'business_rules' ? wireList(12, wireObject({ ...ruleReferenceSchema(rules), origin_scope_id: wireText(100, scopeIds) })) : referenceShape(value)])) };
  }
  function example(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(example);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'business_rules' ? rules.slice(0, 1).map(rule => ({ parent_rule_id: rule.parent_rule_id, origin_scope_id: origins.find(entry => entry.parent_rule_id === rule.parent_rule_id)?.origin_scope_id, epistemic_status: rule.epistemic_status })) : example(child)]));
  }
  const schema = referenceShape(GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA), facts = { ...request, output_shape: example(request.output_shape), global_rule_protocol: 'architecture-global-leaf-rules-1.1.0', leaf_rule_catalog: rules, global_scope_catalog: structuredClone(origins),
    ...(Object.hasOwn(request, 'overview_bundles') ? { overview_bundles: referencedInputs(context, inputs) } : { detailed_map_proposals: referencedInputs(context, inputs) }),
    rule_constraints: '所有module/capability/flow的business_rules只返回parent_rule_id、origin_scope_id与epistemic_status；parent与scope必须是global_scope_catalog中同一行的有效配对。只能继承原操作、原用途和原作用域内的谓词，不能因为规则出现在某个模块下就概括为该模块所有动作。global_scope_catalog的原name/responsibility/state_owners/user_purposes/related_paths与出处都是不可改写的来源上下文，不得把某条窄范围操作规则移作全局权限或通用前置条件。不能自由返回description/evidence_ids或origin_scope上下文、合并改写或删例外；宿主逐字恢复原谓词、完整原证据与原作用域。原uncertain不得升级，source_inference可更保守为uncertain。summary、flow step、relation description只用于有事实依据的职责与导航，不得扩大触发条件、赋予隐含角色权限或编造执行者。预算不足就少选核心规则，完整详情与未知仍在file节点及可信未知账本。' };
  const wire = createArchitectureEvidenceRequest(facts, { snapshotId: context.snapshotId, phase: 'architecture', name: scope.name }, schema);
  let lineage: OverviewGlobalRuleLineage[] = [];
  function decode(value: unknown): unknown {
    lineage = [];
    const decoded = wire.decode(value, schema), restoredLineage: OverviewGlobalRuleLineage[] = [];
    function restore(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(restore);
      if (!value || typeof value !== 'object') return value;
      const row = value as Record<string, unknown>;
      return Object.fromEntries(Object.entries(row).map(([key, child]) => {
        if (key !== 'business_rules') return [key, restore(child)];
        const restored = (child as { parent_rule_id: string; origin_scope_id: string; epistemic_status: string }[]).map((ref, rule_index) => {
          const source = restoreOverviewRule(ref, rules);
          const origin = originPairs.get(JSON.stringify([ref.parent_rule_id, ref.origin_scope_id]));
          if (!origin) return semanticInvalid('global_origin_scope_reference', true, ['$.business_rules[].origin_scope_id'], [{ path: '$.business_rules[].origin_scope_id', rule: 'enum', allowed_values: origins.filter(entry => entry.parent_rule_id === ref.parent_rule_id).map(entry => entry.origin_scope_id) }]);
          const { parent_rule_id: _parent, origin_scope_id, ...origin_scope } = origin;
          restoredLineage.push({ ...source, node_id: String(row.id), rule_index, origin_scope_id, origin_scope: structuredClone(origin_scope) });
          return { description: source.description, evidence: source.evidence.map(item => ({ ...item })) };
        });
        return [key, restored];
      }));
    }
    const restored = restore(decoded); lineage = restoredLineage; return restored;
  }
  return { ...wire, schema, decode, lineage: () => structuredClone(lineage) };
}
