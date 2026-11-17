import { CodeUaGraphSchema, type CodeArtifact, type CodeSnapshot, type CodeUaGraph } from '@team-synergy/contracts';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { createOverviewContext, overviewBytes, overviewFixedFloor, overviewLeafRules, prepareOverviewGlobalRequest, prepareOverviewRequest, reduceOverviewInputs, OVERVIEW_LAYER_RATIO, OVERVIEW_LIMITATIONS, OVERVIEW_PROTOCOL, type OverviewBundle, type OverviewInput, type OverviewUncertaintyAudit } from './code-analysis-semantic-overview.js';
import { type createSemanticModelClient, writeSemanticJson } from './code-analysis-semantic-model.js';
import { reviewSemanticArchitectureClaims, semanticSourceKind, type GroundingClaim } from './code-analysis-semantic-grounding.js';
import { selectArchitectureClaimSources } from './code-analysis-semantic-selector.js';
import { createArchitectureNativeRecoveryContext, type NativeRecoveryContext } from './code-analysis-semantic-reachability.js';
import { prepareArchitectureGroundingRepairs, applyArchitectureGroundingRepairs, ARCHITECTURE_SOURCE_DEFINITION_PREFIX, type ArchitectureFieldRetrievalAnchors } from './code-analysis-semantic-repair.js';
import { evidenceField, listField, requireSemanticValue, semanticDigest, semanticInvalid, strictObject, stringsField, textField, type FileBrief, type SemanticQuality, type SourceEvidence } from './code-analysis-semantic-source.js';
import { ARCHITECTURE_EVIDENCE_PROTOCOL, ARCHITECTURE_RELATION_TYPES, ARCHITECTURE_REQUEST_BUDGET, ARCHITECTURE_REVIEW_OUTPUT_SCHEMA, architectureEvidenceRequestBytes, architectureOwnershipOutputSchema, architectureProposalOutputSchema, architectureTourOutputSchema, assertArchitectureWireShape, budgetArchitectureEvidencePages, createArchitectureEvidenceRequest, createArchitectureProposalPathRequest, type ArchitectureWireShape } from './code-analysis-semantic-architecture-wire.js';

type Client = ReturnType<typeof createSemanticModelClient>;
export interface FileDependency { id: string; source: string; target: string; type: string; evidence: SourceEvidence[]; native_ids: string[]; count: number }
interface ArchitectureNode { id: string; name: string; summary: string; evidence: SourceEvidence[]; business_rules: { description: string; evidence: SourceEvidence[] }[] }
interface ArchitectureProposal { name: string; responsibility: string; state_owners: string[]; user_purposes: string[]; business_rules: { description: string; evidence: SourceEvidence[] }[]; evidence: SourceEvidence[]; related_paths: string[]; unknowns: string[] }
type GroundingReport = Awaited<ReturnType<typeof reviewSemanticArchitectureClaims>>;

/** Lookup recovery may replace only changed insufficient proofs. A known
 * contradiction and every unchanged witness survive without another model call. */
export function mergeArchitectureSourceRecovery(initial: GroundingReport, recovered: GroundingReport, changedIds: ReadonlySet<string>): GroundingReport {
  const originals = new Map(initial.checks.map(check => [check.id, check]));
  const replacements = new Map(recovered.checks.map(check => [check.id, check]));
  if (!changedIds.size || replacements.size !== recovered.checks.length || replacements.size !== changedIds.size || [...changedIds].some(id => {
    const before = originals.get(id), after = replacements.get(id);
    return !before || !after || before.status !== 'insufficient' || !initial.blocking.some(check => check.id === id) || before.text_sha256 !== after.text_sha256 || before.node_id !== after.node_id || before.field !== after.field || before.high_risk !== after.high_risk || before.requires_source_support !== after.requires_source_support;
  }) || recovered.blocking.some(check => !changedIds.has(check.id)) || recovered.feedback.some(check => !changedIds.has(check.id)) || recovered.dependencies.some(check => !changedIds.has(check.claim_id))) return semanticInvalid('source_recovery_merge_identity', false);
  const checks = initial.checks.map(check => replacements.get(check.id) ?? check);
  const merge = <T extends { id: string }>(before: T[], after: T[]) => [...before.filter(row => !changedIds.has(row.id)), ...after];
  const blocking = merge(initial.blocking, recovered.blocking), feedback = merge(initial.feedback, recovered.feedback);
  const dependencies = [...initial.dependencies.filter(row => !changedIds.has(row.claim_id)), ...recovered.dependencies];
  const statistics = { ...initial.statistics, supported: checks.filter(check => check.status === 'supported').length, contradicted: checks.filter(check => check.status === 'contradicted').length, insufficient: checks.filter(check => check.status === 'insufficient').length, blocking: blocking.length,
    retrieval_statistics_scope: 'initial_pass_with_separate_recovery_work', recovery_retrieval: recovered.statistics };
  return { checks, blocking, feedback, dependencies, statistics };
}
export interface Architecture {
  description: string; languages: string[]; frameworks: string[];
  modules: (ArchitectureNode & { state_owners: string[]; user_purposes: string[] })[];
  capabilities: (ArchitectureNode & { module_ids: string[] })[];
  flows: (ArchitectureNode & { steps: { capability_id: string; description: string; evidence: SourceEvidence[] }[] })[];
  relations: { source: string; target: string; type: string; description: string; evidence: SourceEvidence[] }[];
  unknowns: string[];
}
export function architectureGroundingClaims(architecture: Architecture, lineage: ReturnType<ReturnType<typeof prepareOverviewGlobalRequest>['lineage']>, withdrawnFields: ReadonlySet<string> = new Set(), declarationFields: ReadonlySet<string> = new Set(), fieldRetrievalAnchors: readonly ArchitectureFieldRetrievalAnchors[] = []): GroundingClaim[] {
  const claims: GroundingClaim[] = [];
  const retrievalByField = new Map(fieldRetrievalAnchors.map(entry => [entry.field, entry])), usedRetrievalFields = new Set<string>();
  if (retrievalByField.size !== fieldRetrievalAnchors.length) return semanticInvalid('architecture_retrieval_anchor_identity', false);
  const claim = (node_id: string, field: string, text: string, evidence: SourceEvidence[], scope_context: unknown, kind: GroundingClaim['kind'] = 'narrative', sourceDefinition = false) => {
    claims.push({ id: `GC-${semanticDigest({ node_id, field, text })}`, node_id, field, text, evidence: mergeSourceEvidenceRanges(evidence), kind, scope_context, ...(sourceDefinition ? { assertion_scope: 'source_definition' as const } : {}) });
  };
  const fieldClaims = (node_id: string, field: string, text: string, evidence: SourceEvidence[], context: Record<string, unknown>) => {
    if (withdrawnFields.has(field)) return;
    const retrieval = retrievalByField.get(field);
    if (retrieval) {
      if (retrieval.node_id !== node_id || retrieval.text_sha256 !== semanticDigest(text) || !Array.isArray(retrieval.anchors) || retrieval.anchors.some(anchor => typeof anchor.path !== 'string' || !anchor.path.trim())) return semanticInvalid('architecture_retrieval_anchor_identity', false);
      usedRetrievalFields.add(field);
    }
    // Full repair witnesses remain eligible for a fresh source lookup only.
    // Publication still receives support exclusively from the source verifier.
    const fieldEvidence = retrieval ? semanticEvidenceUnion(evidence, retrieval.anchors) : evidence;
    const sourceDefinition = declarationFields.has(field);
    let start = sourceDefinition && text.startsWith(ARCHITECTURE_SOURCE_DEFINITION_PREFIX) ? ARCHITECTURE_SOURCE_DEFINITION_PREFIX.length : 0;
    for (let offset = start; offset <= text.length; offset++) {
      if (offset < text.length && !'。！？\n'.includes(text[offset] as string)) continue;
      const end = offset < text.length ? offset + 1 : offset, span = text.slice(start, end);
      if (span.trim()) claim(node_id, `${field}:${start}-${end}`, span, fieldEvidence, { ...context, field, field_text: text, field_span: [start, end] }, 'narrative', sourceDefinition);
      start = end;
    }
  };
  const all = [...architecture.modules, ...architecture.capabilities, ...architecture.flows];
  fieldClaims('system', 'description', architecture.description, semanticEvidenceUnion(...all.map(node => node.evidence)), { project_overview: true });
  for (const [collection, nodes] of [['modules', architecture.modules], ['capabilities', architecture.capabilities], ['flows', architecture.flows]] as const) {
    for (const [index, node] of nodes.entries()) {
      const steps = 'steps' in node ? node.steps : [];
      const context = { node_id: node.id, name: node.name, collection };
      fieldClaims(node.id, `${collection}.${index}.summary`, node.summary, semanticEvidenceUnion(node.evidence, ...steps.map(step => step.evidence)), context);
      if ('state_owners' in node) {
        for (const [position, text] of node.state_owners.entries()) fieldClaims(node.id, `${collection}.${index}.state_owners.${position}`, text, node.evidence, context);
        for (const [position, text] of node.user_purposes.entries()) fieldClaims(node.id, `${collection}.${index}.user_purposes.${position}`, text, node.evidence, context);
      }
      for (const [position, step] of steps.entries()) fieldClaims(node.id, `${collection}.${index}.steps.${position}.description`, step.description, step.evidence, { ...context, capability_id: step.capability_id, capability_name: architecture.capabilities.find(item => item.id === step.capability_id)?.name });
    }
  }
  const checkedRules = new Set<string>();
  for (const rule of lineage) {
    const key = JSON.stringify([rule.parent_rule_id, rule.origin_scope_id]);
    if (checkedRules.has(key)) continue;
    checkedRules.add(key);
    claim(rule.node_id, `rule_application:${rule.parent_rule_id}:${rule.origin_scope_id}`, rule.description, rule.evidence, { parent_rule_id: rule.parent_rule_id, origin_scope_id: rule.origin_scope_id, original_scope: rule.origin_scope, displayed_with_immutable_scope: true, application_nodes: lineage.filter(item => item.parent_rule_id === rule.parent_rule_id && item.origin_scope_id === rule.origin_scope_id).map(item => item.node_id) }, 'rule_application', rule.evidence.length > 0 && rule.evidence.every(item => semanticSourceKind(item.path) !== 'code'));
  }
  for (const [index, relation] of architecture.relations.entries()) fieldClaims(`relation:${index}`, `relations.${index}.description`, relation.description, relation.evidence, {
    source: all.find(node => node.id === relation.source)?.name, target: all.find(node => node.id === relation.target)?.name, type: relation.type, description: relation.description,
  });
  if (usedRetrievalFields.size !== retrievalByField.size) return semanticInvalid('architecture_retrieval_anchor_identity', false);
  return claims;
}
export function semanticEvidenceUnion(...groups: SourceEvidence[][]): SourceEvidence[] {
  return [...new Map(groups.flat().map(item => [`${item.path}:${item.line_start}:${item.line_end}`, item])).values()];
}
/** Immutable exact line union. Never bridge an uncovered row or a file boundary. */
export function mergeSourceEvidenceRanges(evidence: readonly SourceEvidence[], invalidReason = 'source_evidence_range'): SourceEvidence[] {
  const sorted = evidence.map(item => {
    if (!Number.isSafeInteger(item.line_start) || !Number.isSafeInteger(item.line_end) || item.line_start < 1 || item.line_end < item.line_start) return semanticInvalid(invalidReason, false);
    return { ...item };
  }).sort((left, right) => left.path.localeCompare(right.path) || left.line_start - right.line_start || left.line_end - right.line_end);
  const compacted: SourceEvidence[] = [];
  for (const item of sorted) {
    const previous = compacted.at(-1);
    if (previous?.path === item.path && item.line_start <= previous.line_end + 1) previous.line_end = Math.max(previous.line_end, item.line_end);
    else compacted.push(item);
  }
  return compacted;
}
/** Publication normalization does not mutate the facts or model-input audits. */
export function compactPublishedNodeEvidence(evidence: readonly SourceEvidence[]): SourceEvidence[] {
  return mergeSourceEvidenceRanges(evidence, 'publication_evidence_range');
}
export function budgetGroups<T>(items: T[], budget = 65_000, maxItems = 60): T[][] {
  const result: T[][] = []; let group: T[] = [], size = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > budget) return semanticInvalid('reduce_item_budget', false);
    if (group.length && (size + bytes > budget || group.length >= maxItems)) { result.push(group); group = []; size = 0; }
    group.push(item); size += bytes;
  }
  if (group.length) result.push(group);
  return result;
}
export function nativeFileDependencies(snapshot: CodeSnapshot, native: Pick<CodeArtifact, 'nodes' | 'edges'>, importMap: unknown): FileDependency[] {
  const files = new Map(snapshot.files.map(file => [file.path, file])), nodes = new Map(native.nodes.map(node => [node.id, node]));
  const result = new Map<string, FileDependency>();
  function add(source: string, target: string, type: string, evidence: SourceEvidence[], nativeId?: string) {
    if (source === target || !files.has(source) || !files.has(target)) return;
    const key = semanticDigest([source, target, type]);
    const old = result.get(key);
    if (old) { old.count++; if (nativeId && old.native_ids.length < 3) { old.native_ids.push(nativeId); old.evidence = semanticEvidenceUnion(old.evidence, evidence); } }
    else result.set(key, { id: key, source, target, type, evidence, native_ids: nativeId ? [nativeId] : [], count: 1 });
  }
  for (const edge of native.edges) {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (!source?.path || !target?.path || !source.line_start || !source.line_end || !target.line_start || !target.line_end) continue;
    add(source.path, target.path, edge.type, [{ path: source.path, line_start: source.line_start, line_end: source.line_end }, { path: target.path, line_start: target.line_start, line_end: target.line_end }], edge.id);
  }
  if (importMap && typeof importMap === 'object') for (const [source, targets] of Object.entries(importMap)) {
    if (!Array.isArray(targets)) continue;
    const sourceFile = files.get(source);
    if (!sourceFile?.line_count) continue;
    for (const target of targets) if (typeof target === 'string') add(source, target, 'imports', [{ path: source, line_start: 1, line_end: sourceFile.line_count }]);
  }
  return [...result.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type));
}
const relationTypes = new Set<string>(ARCHITECTURE_RELATION_TYPES);
function architectureReferenceError(reason: string, at: string, expected: string, allowed_values?: string[]): never {
  return semanticInvalid(reason, true, [at], [{ path: at, rule: 'enum', expected, ...(allowed_values ? { allowed_values } : {}) }]);
}
function validateProposals(raw: unknown, options: { paths: Set<string>; maximumPaths: number; minimumProposals: number; unknowns: number; evidence: SourceEvidence[] }): ArchitectureProposal[] {
  const value = strictObject(raw, ['proposals']), rows = listField(value.proposals, 10, '$.proposals');
  if (rows.length < options.minimumProposals) return semanticInvalid('architecture_proposals', true, ['$.proposals'], [{ path: '$.proposals', rule: 'min_items', observed_count: rows.length, minimum: options.minimumProposals }]);
  return rows.map((item, index) => {
    const at = `$.proposals[${index}]`, proposal = strictObject(item, ['name', 'responsibility', 'state_owners', 'user_purposes', 'business_rules', 'evidence', 'related_paths', 'unknowns'], [], at);
    const related_paths = stringsField(proposal.related_paths, options.maximumPaths, `${at}.related_paths`);
    if (!options.minimumProposals && !related_paths.length || related_paths.some(file => !options.paths.has(file))) return architectureReferenceError('architecture_paths', `${at}.related_paths`, 'exact assignment paths supplied in this request, not citation/dependency paths', [...options.paths]);
    return { name: textField(proposal.name, 150, `${at}.name`), responsibility: textField(proposal.responsibility, 1200, `${at}.responsibility`), state_owners: stringsField(proposal.state_owners, 12, `${at}.state_owners`), user_purposes: stringsField(proposal.user_purposes, 12, `${at}.user_purposes`), business_rules: listField(proposal.business_rules, 20, `${at}.business_rules`).map((item, ruleIndex) => {
      const ruleAt = `${at}.business_rules[${ruleIndex}]`, rule = strictObject(item, ['description', 'evidence'], [], ruleAt); return { description: textField(rule.description, 500, `${ruleAt}.description`), evidence: evidenceField(rule.evidence, options.evidence) };
    }), evidence: evidenceField(proposal.evidence, options.evidence), related_paths, unknowns: stringsField(proposal.unknowns, options.unknowns, `${at}.unknowns`) };
  });
}
function validateProposalCoverage(result: ArchitectureProposal[], paths: Set<string>): ArchitectureProposal[] {
  const retained = new Set(result.flatMap(item => item.related_paths));
  if (retained.size !== paths.size || [...paths].some(file => !retained.has(file))) return semanticInvalid('architecture_paths_coverage', true, ['$.proposals[].related_paths'], [{ path: '$.proposals[].related_paths', rule: 'exact_items', expected: 'the exact union of input assignment paths', allowed_values: [...paths], observed_count: retained.size, minimum: paths.size, maximum: paths.size }]);
  return result;
}
export interface ArchitectureReducePartition {
  reason: 'output_truncated'; name: string; parent_input_sha256: string; proposal_hashes: string[];
  children: { name: string; proposal_hashes: string[]; related_paths: string[] }[];
}
/** A rejected partial response contributes nothing. Partition whole canonical proposals only. */
export async function reduceArchitectureProposalBatch<T extends { related_paths: string[] }>(items: T[], name: string, execute: (items: T[], name: string) => Promise<T[]>, onPartition: (partition: ArchitectureReducePartition) => void): Promise<T[]> {
  if (!items.length) return semanticInvalid('architecture_reduce_input', false);
  try { return await execute(items, name); }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'code_analysis_model_invalid' || error.details?.reason !== 'output_truncated' || items.length < 2) throw error;
    const middle = Math.ceil(items.length / 2), left = items.slice(0, middle), right = items.slice(middle), proposal_hashes = items.map(item => semanticDigest(item));
    if (semanticDigest([...left, ...right]) !== semanticDigest(items)) return semanticInvalid('architecture_partition_identity', false);
    onPartition({ reason: 'output_truncated', name, parent_input_sha256: semanticDigest(items), proposal_hashes,
      children: [{ name: `${name}-left`, proposal_hashes: left.map(item => semanticDigest(item)), related_paths: [...new Set(left.flatMap(item => item.related_paths))] }, { name: `${name}-right`, proposal_hashes: right.map(item => semanticDigest(item)), related_paths: [...new Set(right.flatMap(item => item.related_paths))] }] });
    // Preserve this outer worker slot. Child requests get fresh scoped AP/AE vocabularies.
    const leftResult = await reduceArchitectureProposalBatch(left, `${name}-left`, execute, onPartition);
    const rightResult = await reduceArchitectureProposalBatch(right, `${name}-right`, execute, onPartition), result = [...leftResult, ...rightResult];
    const expected = new Set(items.flatMap(item => item.related_paths)), retained = new Set(result.flatMap(item => item.related_paths));
    if (retained.size !== expected.size || [...expected].some(file => !retained.has(file))) return semanticInvalid('architecture_paths_coverage', false, ['$.proposals[].related_paths']);
    return result;
  }
}
export function validateArchitecture(value: unknown, allowed: SourceEvidence[]): Architecture {
  const output = strictObject(value, ['description', 'languages', 'frameworks', 'modules', 'capabilities', 'flows', 'relations', 'unknowns']);
  const idSet = new Set<string>();
  function node(value: unknown, prefix: string, extra: string[], at: string) {
    const row = strictObject(value, ['id', 'name', 'summary', 'evidence', 'business_rules', ...extra], [], at);
    if (typeof row.id !== 'string' || !new RegExp(`^${prefix}:[a-z][a-z0-9-]{0,79}$`).test(row.id) || idSet.has(row.id)) return architectureReferenceError('architecture_identity', `${at}.id`, `unique ${prefix}:[a-z][a-z0-9-]{0,79}`);
    idSet.add(row.id);
    const business_rules = listField(row.business_rules, 12).map(item => { const rule = strictObject(item, ['description', 'evidence']); return { description: textField(rule.description, 500), evidence: evidenceField(rule.evidence, allowed) }; });
    const supportCount = semanticEvidenceUnion(evidenceField(row.evidence, allowed), ...business_rules.map(rule => rule.evidence)).length;
    if (supportCount > 60) return semanticInvalid('architecture_evidence_budget', true, [`${at}.evidence_ids`, `${at}.business_rules`], [{ path: at, rule: 'max_items', expected: 'at most 60 distinct evidence IDs across node and business_rules', observed_count: supportCount, maximum: 60 }]);
    return { row, data: { id: row.id, name: textField(row.name, 150), summary: textField(row.summary, 1600), evidence: evidenceField(row.evidence, allowed), business_rules } };
  }
  const modules = listField(output.modules, 10).map((item, index) => { const { row, data } = node(item, 'module', ['state_owners', 'user_purposes'], `$.modules[${index}]`); return { ...data, state_owners: stringsField(row.state_owners, 12), user_purposes: stringsField(row.user_purposes, 12) }; });
  if (!modules.length) return semanticInvalid('architecture_modules');
  const moduleIds = new Set(modules.map(module => module.id));
  const capabilities = listField(output.capabilities, 24).map((item, index) => {
    const { row, data } = node(item, 'capability', ['module_ids'], `$.capabilities[${index}]`); const module_ids = stringsField(row.module_ids, 10);
    if (!module_ids.length || module_ids.some(id => !moduleIds.has(id))) return architectureReferenceError('architecture_references', `$.capabilities[${index}].module_ids`, 'IDs of returned modules', [...moduleIds]);
    return { ...data, module_ids };
  });
  if (!capabilities.length) return semanticInvalid('architecture_capabilities');
  const capabilityIds = new Set(capabilities.map(item => item.id));
  const flows = listField(output.flows, 12).map((item, index) => {
    const { row, data } = node(item, 'flow', ['steps'], `$.flows[${index}]`);
    const steps = listField(row.steps, 12).map((item, stepIndex) => { const step = strictObject(item, ['capability_id', 'description', 'evidence']); if (!capabilityIds.has(String(step.capability_id))) return architectureReferenceError('architecture_references', `$.flows[${index}].steps[${stepIndex}].capability_id`, 'an ID of a returned capability', [...capabilityIds]); return { capability_id: String(step.capability_id), description: textField(step.description, 800), evidence: evidenceField(step.evidence, allowed) }; });
    if (!steps.length) return semanticInvalid('architecture_flow');
    const supportCount = compactPublishedNodeEvidence(semanticEvidenceUnion(data.evidence, ...data.business_rules.map(rule => rule.evidence), ...steps.map(step => step.evidence))).length;
    if (supportCount > 100) return semanticInvalid('architecture_evidence_budget', true, [`$.flows[${index}].evidence_ids`, `$.flows[${index}].business_rules`, `$.flows[${index}].steps`], [{ path: `$.flows[${index}]`, rule: 'max_items', expected: 'at most 100 supports across flow base, business_rules and all steps after lossless same-file overlap/adjacency compaction', observed_count: supportCount, maximum: 100 }]);
    return { ...data, steps };
  });
  if (!flows.length) return semanticInvalid('architecture_flows');
  const relations = listField(output.relations, 80).map((item, index) => {
    const row = strictObject(item, ['source', 'target', 'type', 'description', 'evidence']);
    if (!idSet.has(String(row.source)) || !idSet.has(String(row.target)) || row.source === row.target || !relationTypes.has(String(row.type))) return architectureReferenceError('architecture_references', `$.relations[${index}]`, 'distinct source/target IDs of returned nodes and a permitted relation type');
    return { source: String(row.source), target: String(row.target), type: String(row.type), description: textField(row.description, 1200), evidence: evidenceField(row.evidence, allowed) };
  });
  return { description: textField(output.description, 3000), languages: stringsField(output.languages, 20), frameworks: stringsField(output.frameworks, 30), modules, capabilities, flows, relations, unknowns: stringsField(output.unknowns, 40) };
}
const architectureShape = {
  description: '系统实际目标、当前实现与未知边界', languages: ['TypeScript'], frameworks: ['实际证据中的框架'],
  modules: [{ id: 'module:stable-business-key', name: '按状态所有者和用户目的命名', summary: '职责和边界，不能仅按文件夹划分', state_owners: ['本模块掌管的状态事实'], user_purposes: ['用户完成的目的'], business_rules: [{ description: '具体正常/拒绝规则与状态归属', evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }], evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }],
  capabilities: [{ id: 'capability:stable-purpose-key', name: '用户能力', summary: '实际行为、限制、参与模块', module_ids: ['module:stable-business-key'], business_rules: [{ description: '角色、前置状态、拒绝条件与行为结果', evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }], evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }],
  flows: [{ id: 'flow:stable-flow-key', name: '跨模块业务流程', summary: '触发、状态变化和结果', business_rules: [], steps: [{ capability_id: 'capability:stable-purpose-key', description: '本步实际做什么', evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }], evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }],
  relations: [{ source: 'module:stable-business-key', target: 'capability:stable-purpose-key', type: 'depends_on', description: '有证据的关系推断，无法证明的关系不要生成', evidence: [{ path: '已提供路径', line_start: 1, line_end: 5 }] }], unknowns: ['尚缺证据的问题'],
};

export async function synthesizeSemanticArchitecture(options: { snapshot: CodeSnapshot; briefs: FileBrief[]; dependencies: FileDependency[]; repositoryName: string; runDirectory: string; uncertaintyAudit?: OverviewUncertaintyAudit; grounding?: { sourceDirectory: string; native: Pick<CodeArtifact, 'nodes' | 'edges'> }; client: Client; onPhase: (phase: 'architecture' | 'tour' | 'review', completed: number, total: number) => Promise<void>; parallel: <T, R>(items: T[], action: (item: T, index: number) => Promise<R>) => Promise<R[]> }) {
  const filesByPath = new Map(options.snapshot.files.map(file => [file.path, file]));
  const prepare = (phase: string, name: string, request: Record<string, unknown> & { task: string; output_shape: unknown }, schema: ArchitectureWireShape) => createArchitectureEvidenceRequest(request, { snapshotId: options.snapshot.snapshot_id, phase, name }, schema);
  async function evidenceCall<T>(phase: string, name: string, request: Record<string, unknown> & { task: string; output_shape: unknown }, schema: ArchitectureWireShape, validate: (value: unknown, evidence: SourceEvidence[]) => T) {
    const wire = prepare(phase, name, request, schema);
    if (architectureEvidenceRequestBytes(wire, phase) > ARCHITECTURE_REQUEST_BUDGET) return semanticInvalid('architecture_input_budget', false);
    return options.client.call({ phase, name, input: wire.input, validate: raw => validate(wire.decode(raw, schema), wire.evidence) });
  }
  async function proposalCall(phase: string, name: string, request: Record<string, unknown> & { task: string; output_shape: unknown }, oldSchema: ArchitectureWireShape, paths: Set<string>, maximumPaths: number, unknowns: number, minimumProposals: number) {
    const legacy = prepare(phase, name, request, oldSchema);
    const validate = (raw: unknown, evidence: SourceEvidence[]) => validateProposalCoverage(validateProposals(raw, { paths, maximumPaths, minimumProposals, unknowns, evidence }), paths);
    const cached = options.client.cacheRequest({ phase, input: legacy.input, validate: raw => validate(legacy.decode(raw, oldSchema), legacy.evidence) });
    if (cached) return cached;
    const wire = createArchitectureProposalPathRequest(request, { snapshotId: options.snapshot.snapshot_id, phase, name }, { paths: [...paths], maximumPaths, unknowns });
    if (architectureEvidenceRequestBytes(wire, phase) > ARCHITECTURE_REQUEST_BUDGET) return semanticInvalid('architecture_input_budget', false);
    return options.client.call({ phase, name, input: wire.input, validate: raw => validate(wire.decode(raw), wire.evidence) });
  }
  const mapSchema = architectureProposalOutputSchema({ relatedPaths: 45, unknowns: 12, requireProposal: false });
  const mapRequest = (briefs: FileBrief[]) => {
    const paths = new Set(briefs.map(brief => brief.path));
    const dependencies = options.dependencies.filter(dependency => paths.has(dependency.source)).map(dependency => ({ source: dependency.source, target: dependency.target, type: dependency.type, count: dependency.count }));
    return { task: 'UA Phase4前置系统综合：这些完整文件事实来自已逐段阅读的固定源码。发现状态所有者、用户目的、业务边界和跨文件关系，提出可合并的模块与能力候选，不按目录机械分组。必须保留关键正常规则、拒绝条件、权限和上下游影响，不能只留下模块简介。测试仅是定义。不要创建最终分层或批次模块；提供证据与不能确认的点。所有文件（含配置、测试、资料）必须在本次综合中考虑。', output_shape: { proposals: [{ name: '候选业务模块', responsibility: '状态与职责边界', state_owners: ['状态事实'], user_purposes: ['目的'], business_rules: [{ description: '关键正常/拒绝规则', evidence: [{ path: '当前brief路径', line_start: 1, line_end: 1 }] }], evidence: [{ path: '当前brief路径', line_start: 1, line_end: 1 }], related_paths: ['当前brief路径'], unknowns: ['未知'] }] }, repository: options.repositoryName, briefs, native_dependencies: dependencies };
  };
  const briefPages = budgetArchitectureEvidencePages(budgetGroups(options.briefs, 65_000, 45), briefs => createArchitectureProposalPathRequest(mapRequest(briefs), { snapshotId: options.snapshot.snapshot_id, phase: 'architecture-map', name: 'budget' }, { paths: briefs.map(brief => brief.path), maximumPaths: 45, unknowns: 12 }), 'architecture-map');
  await options.onPhase('architecture', 0, briefPages.length + 1);
  let mapsDone = 0;
  const proposals = await options.parallel(briefPages, async (briefs, index) => {
    const paths = new Set(briefs.map(brief => brief.path)), request = mapRequest(briefs);
    if (briefs.every(brief => filesByPath.get(brief.path)?.byte_count === 0)) {
      await options.onPhase('architecture', ++mapsDone, briefPages.length + 1);
      return [{ name: 'observed-empty 文件范围', responsibility: '固定快照确认这些文件为空；仅记录结构范围，没有可分析的源码行为、状态或业务规则。', state_owners: [], user_purposes: [], business_rules: [], evidence: [], related_paths: [...paths], unknowns: ['observed-empty：没有可引用的源码行，不能作为业务结论的证据。'] }];
    }
    const response = await proposalCall('architecture-map', `page-${index}`, request, mapSchema, paths, 45, 12, 0);
    await options.onPhase('architecture', ++mapsDone, briefPages.length + 1); return response.value;
  });
  // File details remain unchanged below. Overview bundles deliberately abstract low-level rules.
  const overviewContext = createOverviewContext({ snapshot: options.snapshot, briefs: options.briefs, uncertaintyAudit: options.uncertaintyAudit });
  const detailHashBefore = semanticDigest(options.briefs), initialInputs: OverviewInput[] = proposals.flat();
  let overviewBundles: OverviewBundle[] | null = null, reductionDepth = 0, reducePartitions = 0;
  writeSemanticJson(path.join(options.runDirectory, 'overview-detail-index.json'), { protocol: OVERVIEW_PROTOCOL, snapshot_id: options.snapshot.snapshot_id, detail_index_ref: overviewContext.indexRef, file_node_template: 'file:{path}', ledger: overviewContext.ledger, detail_sha256: detailHashBefore });
  writeSemanticJson(path.join(options.runDirectory, 'overview-leaf-rules.json'), { protocol: OVERVIEW_PROTOCOL, snapshot_id: options.snapshot.snapshot_id, rules: overviewLeafRules(overviewContext, initialInputs) });
  const currentInputs = (): OverviewInput[] => overviewBundles ?? initialInputs;
  const canonicalBytes = (inputs: OverviewInput[]) => overviewBytes({ detail_index: overviewContext.promptIndex, inputs });
  const fixedLayerFloor = overviewFixedFloor(overviewContext, initialInputs);
  const globalRequest = () => ({ task: 'UA Phase4全局系统架构：输入是核心架构概览或原map候选，低级行为、依赖、未知与完整出处另保留在每个file节点；不能宣称本次概览包含或重读过全部详情，也没有工具访问详情。统一状态所有者、用户目的、核心共享不变量与跨模块契约，建立3到10个全局模块（小项目可少于3）、真实用户capabilities和跨模块flows，不按批次或目录拼模块。用稳定语义英文id；各bundle的C1..C4仅为局部引用，同编号不表示同一职责。关键正常/拒绝条件、角色/状态与上下游边界应有核心概括或明确重要待确认；所有规则仍是源码推断，不等于团队已确认、实际已落实或测试已执行。host未决ledger是可信的细节统计，不可清零，但也不能因文件含普通unknown就把所有事实一律降级。只允许提供的真实证据；不清楚则记unknown，不制造依赖。每个flow自身、business_rules和全部steps出处无损合并同文件重叠或相邻范围后最多100，必要时按业务语义拆flow，不裁引用。严格返回output_shape。', output_shape: architectureShape, repository: options.repositoryName, overview_protocol: OVERVIEW_PROTOCOL, detail_index: overviewContext.promptIndex, ...(overviewBundles ? { overview_bundles: overviewBundles } : { detailed_map_proposals: initialInputs }), static_dependency_count: options.dependencies.length });
  const prepareGlobal = () => prepareOverviewGlobalRequest(overviewContext, currentInputs(), globalRequest(), { name: 'system' }, initialInputs);
  const needsReduction = () => canonicalBytes(currentInputs()) > 115_000 || architectureEvidenceRequestBytes(prepareGlobal(), 'architecture') > ARCHITECTURE_REQUEST_BUDGET;
  while (needsReduction()) {
    if (++reductionDepth > 4) return semanticInvalid('overview_depth_budget', false);
    const inputs = currentInputs(), inputBytes = canonicalBytes(inputs);
    const pages = budgetArchitectureEvidencePages(budgetGroups(inputs, 70_000, 30), items => prepareOverviewRequest(overviewContext, items, { name: 'budget', depth: reductionDepth }), 'architecture-reduce');
    overviewBundles = (await options.parallel(pages, (items, index) => reduceOverviewInputs(overviewContext, items, `overview-${reductionDepth}-${index}`, async (child, name) => {
      const wire = prepareOverviewRequest(overviewContext, child, { name, depth: reductionDepth });
      if (architectureEvidenceRequestBytes(wire, 'architecture-reduce') > ARCHITECTURE_REQUEST_BUDGET) return semanticInvalid('overview_input_budget', false);
      return (await options.client.call({ phase: 'architecture-reduce', name, input: wire.input, validate: wire.decode })).value;
    }, partition => { reducePartitions++; writeSemanticJson(path.join(options.runDirectory, `semantic-overview-partition-${semanticDigest(partition).slice(0, 24)}.json`), partition); }))).flat();
    if (JSON.stringify(overviewContext.fileIds(overviewBundles)) !== JSON.stringify(overviewContext.fileIds(initialInputs))) return semanticInvalid('overview_coverage', false);
    const outputBytes = canonicalBytes(overviewBundles), ratio = Math.max(0, outputBytes - fixedLayerFloor) / Math.max(1, inputBytes - fixedLayerFloor);
    writeSemanticJson(path.join(options.runDirectory, `semantic-overview-layer-${reductionDepth}.json`), { protocol: OVERVIEW_PROTOCOL, depth: reductionDepth, groups: pages.length, input_items: inputs.length, output_bundles: overviewBundles.length, input_canonical_bytes: inputBytes, output_canonical_bytes: outputBytes, fixed_host_floor_bytes: fixedLayerFloor, residual_ratio: ratio, covered_files: overviewContext.fileIds(overviewBundles).length, file_details_sha256: detailHashBefore, semantics: 'overview only; full rules and unknowns remain in file nodes' });
    if (needsReduction() && ratio > OVERVIEW_LAYER_RATIO) return semanticInvalid('overview_layer_not_converged', false, ['overview_bundles'], [{ path: '$.canonical_bytes', rule: 'max_length', observed_length: outputBytes, maximum: Math.floor(fixedLayerFloor + OVERVIEW_LAYER_RATIO * (inputBytes - fixedLayerFloor)) }]);
  }
  if (semanticDigest(options.briefs) !== detailHashBefore) return semanticInvalid('overview_detail_identity', false);
  let architecture: Architecture | undefined, globalRuleLineage: ReturnType<ReturnType<typeof prepareOverviewGlobalRequest>['lineage']> = [];
  const groundingReports: Awaited<ReturnType<typeof reviewSemanticArchitectureClaims>>[] = [];
  const repairUnknowns: { node_id: string; field: string; description: string }[] = [];
  const withdrawnFields = new Set<string>();
  const declarationFields = new Set<string>();
  let fieldRetrievalAnchors: ArchitectureFieldRetrievalAnchors[] = [];
  let withdrawnRuleOrigins = 0;
  let recoveryContext: NativeRecoveryContext | undefined;
  const blockedTargets = (checks: typeof groundingReports[number]['blocking']) => new Set(checks.map(check => check.field.startsWith('rule_application:') ? check.field : check.field.replace(/:\d+-\d+$/u, ''))).size;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!attempt) {
      const globalWire = prepareGlobal();
      if (Buffer.byteLength(JSON.stringify(globalWire.input)) > 179_000) return semanticInvalid('global_grounding_repair_budget', false);
      const synthesized = await options.client.call({ phase: 'architecture', name: 'system', input: globalWire.input, validate: raw => validateArchitecture(globalWire.decode(raw), globalWire.evidence) });
      architecture = synthesized.value;
      globalRuleLineage = globalWire.lineage();
    } else {
      const previous = requireSemanticValue(architecture), checked = requireSemanticValue(groundingReports.at(-1));
      if (attempt > 1 && blockedTargets(checked.blocking) >= blockedTargets(requireSemanticValue(groundingReports.at(-2)).blocking)) return semanticInvalid('global_grounding_conflict', false);
      const plan = prepareArchitectureGroundingRepairs(previous, architectureGroundingClaims(previous, globalRuleLineage, withdrawnFields, declarationFields, fieldRetrievalAnchors), checked.feedback, globalRuleLineage, { feedbackRef: `semantic-global-grounding-${attempt - 1}.json#/feedback` });
      writeSemanticJson(path.join(options.runDirectory, `semantic-global-repair-plan-${attempt}.json`), { previous_sha256: plan.previous_sha256, statistics: plan.statistics, requests: plan.requests.map(request => ({ name: request.name, input: request.input })), withdrawn_rule_claims: plan.withdrawn_rule_claims, span_withdrawals: plan.span_withdrawals });
      let repaired = 0;
      const patches = (await options.parallel(plan.requests, async request => {
        const result = await options.client.call({ phase: 'architecture-repair', name: request.name, input: request.input, maxTokens: 32768, validate: request.decode });
        await options.onPhase('review', ++repaired, plan.requests.length);
        return result.value;
      })).flat();
      const applied = applyArchitectureGroundingRepairs(previous, patches, globalRuleLineage, plan.withdrawn_rule_claims, plan.span_withdrawals, fieldRetrievalAnchors);
      withdrawnRuleOrigins += plan.withdrawn_rule_claims.length;
      architecture = validateArchitecture(applied.architecture, prepareGlobal().evidence);
      fieldRetrievalAnchors = applied.field_retrieval_anchors;
      globalRuleLineage = applied.lineage;
      repairUnknowns.push(...applied.unknownsAudit);
      for (const patch of patches) declarationFields.delete(patch.field);
      for (const item of plan.span_withdrawals) declarationFields.delete(item.field);
      for (const item of applied.declaration_fields) declarationFields.add(item.field);
      for (const item of applied.withdrawn_fields) withdrawnFields.add(item.field);
      writeSemanticJson(path.join(options.runDirectory, `semantic-global-repair-result-${attempt}.json`), { previous_sha256: plan.previous_sha256, architecture_sha256: semanticDigest(architecture), patches, withdrawn_rule_claims: plan.withdrawn_rule_claims, withdrawn_fields: [...withdrawnFields], declaration_fields: [...declarationFields], field_retrieval_anchors: fieldRetrievalAnchors, host_span_withdrawals: applied.host_span_withdrawals, unknowns: applied.unknownsAudit });
    }
    if (!options.grounding) break;
    const obligations = architectureGroundingClaims(architecture, globalRuleLineage, withdrawnFields, declarationFields, fieldRetrievalAnchors);
    writeSemanticJson(path.join(options.runDirectory, `semantic-global-obligations-${attempt}.json`), { snapshot_id: options.snapshot.snapshot_id, architecture_sha256: semanticDigest(architecture), claims: obligations });
    const selected = await selectArchitectureClaimSources({ snapshot: options.snapshot, native: options.grounding.native, claims: obligations, client: options.client, parallel: options.parallel, runDirectory: options.runDirectory, onProgress: (completed, total) => options.onPhase('review', completed, total) });
    writeSemanticJson(path.join(options.runDirectory, `semantic-global-source-selections-${attempt}.json`), selected);
    let checked = await reviewSemanticArchitectureClaims({ snapshot: options.snapshot, ...options.grounding, claims: selected.claims, client: options.client, parallel: options.parallel, runDirectory: options.runDirectory, onProgress: (completed, total) => options.onPhase('review', completed, total) });
    if (checked.blocking.some(item => item.status === 'insufficient')) {
      // A failed lookup is not evidence that the narrative is wrong. Try only
      // bounded native calls from the immutable anchors before rewriting text.
      recoveryContext ??= createArchitectureNativeRecoveryContext({ snapshot: options.snapshot, native: options.grounding.native });
      const blockedIds = new Set(checked.blocking.filter(item => item.status === 'insufficient').map(item => item.id));
      const recovered = await selectArchitectureClaimSources({ snapshot: options.snapshot, native: options.grounding.native, claims: obligations.filter(claim => blockedIds.has(claim.id)), client: options.client, parallel: options.parallel, runDirectory: options.runDirectory, recovery: { context: recoveryContext, previous: selected.claims.filter(claim => blockedIds.has(claim.id)) }, onProgress: (completed, total) => options.onPhase('review', completed, total) });
      const replacements = new Map(recovered.claims.map(claim => [claim.id, claim]));
      const effective = selected.claims.map(claim => replacements.get(claim.id) ?? claim);
      const changed = effective.filter((claim, index) => semanticDigest(claim) !== semanticDigest(selected.claims[index]));
      writeSemanticJson(path.join(options.runDirectory, `semantic-global-source-recovery-${attempt}.json`), { initial_selection_ref: `semantic-global-source-selections-${attempt}.json`, changed_claims: changed.map(claim => claim.id), ...recovered });
      if (changed.length) {
        writeSemanticJson(path.join(options.runDirectory, `semantic-global-grounding-${attempt}-before-recovery.json`), checked);
        writeSemanticJson(path.join(options.runDirectory, `semantic-global-effective-selections-${attempt}.json`), { initial_selection_ref: `semantic-global-source-selections-${attempt}.json`, recovery_selection_ref: `semantic-global-source-recovery-${attempt}.json`, claims: effective });
        const recoveredReport = await reviewSemanticArchitectureClaims({ snapshot: options.snapshot, ...options.grounding, claims: changed, client: options.client, parallel: options.parallel, runDirectory: options.runDirectory, onProgress: (completed, total) => options.onPhase('review', completed, total) });
        checked = mergeArchitectureSourceRecovery(checked, recoveredReport, new Set(changed.map(claim => claim.id)));
      }
    }
    groundingReports.push(checked);
    writeSemanticJson(path.join(options.runDirectory, `semantic-global-grounding-${attempt}.json`), checked);
    if (!checked.blocking.length) break;
    if (attempt === 3) return semanticInvalid('global_grounding_conflict', false);
  }
  if (!architecture || options.grounding && !groundingReports.length) return semanticInvalid('global_grounding_required', false);
  writeSemanticJson(path.join(options.runDirectory, 'semantic-global-rule-lineage.json'), { protocol: 'architecture-global-leaf-rules-1.1.0', snapshot_id: options.snapshot.snapshot_id, detail_index_ref: overviewContext.indexRef, rules: globalRuleLineage });
  await options.onPhase('architecture', briefPages.length + 1, briefPages.length + 1);
  const assignmentPages = budgetGroups(options.briefs.map(brief => ({ path: brief.path, summary: brief.summary, responsibility: brief.responsibility, state_owners: brief.state_owners, user_purposes: brief.user_purposes })), 65_000, 55);
  let assigned = 0;
  await options.onPhase('architecture', 0, assignmentPages.length);
  const ownership = (await options.parallel(assignmentPages, async (files, index) => {
    const schema = architectureOwnershipOutputSchema(files.length, architecture.modules.map(module => module.id), files.map(file => file.path));
    const response = await options.client.call({ phase: 'ownership', name: `ownership-${index}`, input: { task: '为每个文件选择恰好一个主责业务模块。以职责、状态所有者和用户目的判断，不能只看路径。配置/测试/文档归属于它支撑的模块。不得跳过文件、生成新模块或多重主责。path必须是本页files的精确路径，每条恰好出现一次。', architecture_protocol: ARCHITECTURE_EVIDENCE_PROTOCOL, output_schema: schema, output_shape: { assignments: [{ path: '精确输入路径', module_id: '精确module id', rationale: '具体职责理由' }] }, modules: architecture.modules, files }, validate: raw => {
      assertArchitectureWireShape(raw, schema);
      const value = strictObject(raw, ['assignments']), rows = listField(value.assignments, files.length);
      if (rows.length !== files.length) return semanticInvalid('ownership_coverage', true, ['$.assignments'], [{ path: '$.assignments', rule: 'exact_items', observed_count: rows.length, minimum: files.length, maximum: files.length, allowed_values: files.map(file => file.path) }]);
      const found = new Set<string>(), modules = new Set(architecture.modules.map(module => module.id));
      return rows.map((item, index) => { const row = strictObject(item, ['path', 'module_id', 'rationale']); if (!files.some(file => file.path === row.path) || found.has(String(row.path))) return architectureReferenceError('ownership_identity', `$.assignments[${index}].path`, 'each exact files path once'); if (!modules.has(String(row.module_id))) return architectureReferenceError('ownership_identity', `$.assignments[${index}].module_id`, 'a supplied module ID', [...modules]); found.add(String(row.path)); return { path: String(row.path), module_id: String(row.module_id), rationale: textField(row.rationale, 500) }; });
    } }); await options.onPhase('architecture', ++assigned, assignmentPages.length); return response.value;
  })).flat();
  const owner = new Map(ownership.map(item => [item.path, item.module_id])), nodeEvidence = new Map<string, SourceEvidence[]>();
  const nodes: CodeUaGraph['nodes'] = options.briefs.map(brief => {
    const file = requireSemanticValue(filesByPath.get(brief.path));
    const evidence = semanticEvidenceUnion(file.line_count ? [{ path: brief.path, line_start: 1, line_end: file.line_count }] : [], brief.evidence);
    nodeEvidence.set(`file:${brief.path}`, evidence);
    return { id: `file:${brief.path}`, type: 'file', name: brief.path, filePath: brief.path, summary: `${brief.responsibility}\n${brief.summary}`, domainMeta: { entities: brief.state_owners, userPurposes: brief.user_purposes, unknowns: brief.unknowns, businessRules: [...brief.behaviors.map(item => item.description), ...brief.unknowns.map(item => `未知：${item}`)], crossDomainInteractions: brief.dependencies.map(item => `${item.type} ${item.target}: ${item.description} (${item.status})`) }, languageNotes: '完整源码分段理解；规则仍是源码解释，测试只分析定义，未宣称实际执行。', tags: ['完整源码已分段分析', /(?:test|spec)/i.test(brief.path) ? '测试定义未执行' : '源码理解'], complexity: 'moderate' };
  });
  for (const module of architecture.modules) { nodes.push({ id: module.id, type: 'module', name: module.name, summary: module.summary, tags: ['全局系统模块'], domainMeta: { entities: module.state_owners, userPurposes: module.user_purposes, businessRules: module.business_rules.map(rule => rule.description), crossDomainInteractions: architecture.relations.filter(relation => relation.source === module.id || relation.target === module.id).map(relation => relation.description) }, complexity: 'complex' }); nodeEvidence.set(module.id, semanticEvidenceUnion(module.evidence, ...module.business_rules.map(rule => rule.evidence))); }
  for (const capability of architecture.capabilities) { nodes.push({ id: capability.id, type: 'domain', name: capability.name, summary: capability.summary, tags: ['用户能力', '源码推断'], domainMeta: { businessRules: capability.business_rules.map(rule => rule.description), crossDomainInteractions: architecture.relations.filter(relation => relation.source === capability.id || relation.target === capability.id).map(relation => relation.description) }, complexity: 'moderate' }); nodeEvidence.set(capability.id, semanticEvidenceUnion(capability.evidence, ...capability.business_rules.map(rule => rule.evidence))); }
  for (const flow of architecture.flows) { nodes.push({ id: flow.id, type: 'flow', name: flow.name, summary: flow.summary, tags: ['业务流程', '源码推断'], domainMeta: { businessRules: flow.business_rules.map(rule => rule.description), crossDomainInteractions: flow.steps.map(step => step.description) }, complexity: 'complex' }); nodeEvidence.set(flow.id, semanticEvidenceUnion(flow.evidence, ...flow.business_rules.map(rule => rule.evidence), ...flow.steps.map(step => step.evidence))); }
  for (const check of groundingReports.at(-1)?.checks ?? []) {
    const existing = nodeEvidence.get(check.node_id);
    if (existing && check.status === 'supported') nodeEvidence.set(check.node_id, semanticEvidenceUnion(existing, check.evidence));
  }
  const ledger = overviewContext.promptIndex.uncertainty;
  for (const node of nodes.filter(node => ['module', 'domain', 'flow'].includes(node.type))) {
    const moduleIds = node.type === 'module' ? [node.id] : node.type === 'domain' ? architecture.capabilities.find(capability => capability.id === node.id)?.module_ids ?? [] : architecture.flows.find(flow => flow.id === node.id)?.steps.flatMap(step => architecture.capabilities.find(capability => capability.id === step.capability_id)?.module_ids ?? []) ?? [];
    const detailNodes = options.briefs.filter(brief => moduleIds.includes(owner.get(brief.path) ?? '')).slice(0, 3).map(brief => `file:${brief.path}`);
    const notice = `【概览／源码推断】不等于已确认共识、已落实事实或测试通过。全项目可信详情账本：${ledger.unknown_entries}条未知条目；${ledger.uncertain_claims === null ? '未提供计数（不可视为0）' : `${ledger.uncertain_claims}条`}未确定断言。${detailNodes.length ? `代表性完整详情入口：${detailNodes.join('、')}。` : '完整详情请查本项目file节点索引。'}账本保留不证明逐规则语义无误，仍需独立核验。`;
    node.summary += `\n\n${notice}`; node.languageNotes = notice;
    if (node.domainMeta?.businessRules) node.domainMeta.businessRules = node.domainMeta.businessRules.map((rule, ruleIndex) => {
      const source = globalRuleLineage.find(item => item.node_id === node.id && item.rule_index === ruleIndex);
      const definitionOnly = source && source.evidence.length > 0 && source.evidence.every(item => semanticSourceKind(item.path) !== 'code');
      return `${source?.epistemic_status === 'uncertain' ? '待确认／' : ''}${definitionOnly ? ARCHITECTURE_SOURCE_DEFINITION_PREFIX : ''}源码推断（适用范围：${source ? `${source.origin_scope.name}；${source.origin_scope.responsibility}` : '未提供范围，不可泛化'}）：${rule}`;
    });
  }
  const edges: CodeUaGraph['edges'] = [], relationEvidence: SemanticQuality['relation_evidence'] = [], edgeKeys = new Map<string, number>();
  function edge(source: string, target: string, type: string, description: string, evidence: SourceEvidence[], native_ids: string[] = []) {
    const key = `${source}\0${target}\0${type}`, found = edgeKeys.get(key);
    if (found !== undefined) { const saved = requireSemanticValue(relationEvidence[found]); saved.evidence = compactPublishedNodeEvidence(semanticEvidenceUnion(saved.evidence, evidence)); if (native_ids.length) { saved.basis = 'native_dependency'; saved.native_ids = [...new Set([...(saved.native_ids ?? []), ...native_ids])].slice(0, 3); } return; }
    edgeKeys.set(key, edges.length);
    edges.push({ source, target, type: type as CodeUaGraph['edges'][number]['type'], direction: 'forward', weight: type === 'contains' ? 1 : 0.6, description });
    relationEvidence.push({ source, target, type, evidence: compactPublishedNodeEvidence(evidence), basis: native_ids.length ? 'native_dependency' : 'semantic_inference', ...(native_ids.length ? { native_ids } : {}) });
  }
  for (const brief of options.briefs) edge(requireSemanticValue(owner.get(brief.path)), `file:${brief.path}`, 'contains', requireSemanticValue(ownership.find(item => item.path === brief.path)).rationale, requireSemanticValue(nodeEvidence.get(`file:${brief.path}`)));
  for (const capability of architecture.capabilities) for (const module of capability.module_ids) edge(module, capability.id, 'serves', '模块支撑该用户能力（源码综合推断）', capability.evidence);
  for (const [flowIndex, flow] of architecture.flows.entries()) for (const [index, step] of flow.steps.entries()) {
    if (!withdrawnFields.has(`flows.${flowIndex}.steps.${index}.description`)) edge(flow.id, step.capability_id, 'flow_step', `${index + 1}. ${step.description}`, step.evidence);
  }
  for (const [index, relation] of architecture.relations.entries()) {
    if (!withdrawnFields.has(`relations.${index}.description`)) edge(relation.source, relation.target, relation.type, relation.description, relation.evidence);
  }
  const moduleDependencies = new Set<string>();
  for (const dependency of options.dependencies) {
    edge(`file:${dependency.source}`, `file:${dependency.target}`, dependency.type === 'imports' ? 'imports' : 'depends_on', `原生静态${dependency.type}关系，${dependency.count}处；不等同运行时验证。`, dependency.evidence, dependency.native_ids);
    const source = requireSemanticValue(owner.get(dependency.source)), target = requireSemanticValue(owner.get(dependency.target));
    const key = `${source}:${target}`;
    if (source === target || moduleDependencies.has(key)) continue;
    moduleDependencies.add(key);
    edge(source, target, 'depends_on', '跨模块依赖来自原生静态关系，运行时影响待验证。', dependency.evidence, dependency.native_ids);
    // Only representative native endpoints, not every owned file, are added to a module's support budget.
    if (dependency.native_ids.length) {
      nodeEvidence.set(source, semanticEvidenceUnion(nodeEvidence.get(source) ?? [], dependency.evidence.filter(item => item.path === dependency.source)));
      nodeEvidence.set(target, semanticEvidenceUnion(nodeEvidence.get(target) ?? [], dependency.evidence.filter(item => item.path === dependency.target)));
    }
  }
  const primaryLayer = new Map<string, string>(ownership.map(item => [`file:${item.path}`, item.module_id]));
  for (const module of architecture.modules) primaryLayer.set(module.id, module.id);
  for (const capability of architecture.capabilities) primaryLayer.set(capability.id, requireSemanticValue(capability.module_ids[0]));
  for (const flow of architecture.flows) primaryLayer.set(flow.id, requireSemanticValue(primaryLayer.get(requireSemanticValue(flow.steps[0]).capability_id)));
  const layers = architecture.modules.map(module => ({ id: module.id, name: module.name, description: module.summary, nodeIds: nodes.filter(node => primaryLayer.get(node.id) === module.id).map(node => node.id) }));
  const tourCandidates = architecture.modules.flatMap(module => options.briefs.filter(brief => owner.get(brief.path) === module.id && /\.(?:md|json|ya?ml|toml|sql)$/.test(brief.path)).slice(0, 2)).map(brief => ({ id: `file:${brief.path}`, summary: brief.summary }));
  const tourIds = nodes.map(node => node.id), tourSchema = architectureTourOutputSchema(tourIds);
  await options.onPhase('tour', 0, 1);
  const tour = await options.client.call({ phase: 'tour', name: 'global-tour', input: { task: 'UA Phase5：生成一个贯穿整个系统的渐进导览，5到12步，从项目目标/配置入口开始，再到核心状态与业务流程，最后到测试定义/限制。必须使用全局模块和真实跨模块流程，不按源码批次拼接。每步给出为何先看这里和下一步关系，order从0连续递增，nodeIds非空且只使用提供的id；至少包含一个资料/配置停靠点（如果存在）。阅读测试不能说执行通过。', architecture_protocol: ARCHITECTURE_EVIDENCE_PROTOCOL, output_schema: tourSchema, output_shape: { tour: [{ order: 0, title: '导览标题', description: '实际职责与递进缘由', nodeIds: ['有效id'] }] }, architecture, non_code_candidates: tourCandidates }, validate: raw => {
    assertArchitectureWireShape(raw, tourSchema);
    const value = strictObject(raw, ['tour']), ids = new Set(tourIds);
    const steps = listField(value.tour, 12);
    const result = steps.map((item, index) => { const step = strictObject(item, ['order', 'title', 'description', 'nodeIds']), nodeIds = stringsField(step.nodeIds, 15); if (step.order !== index) return semanticInvalid('tour_references', true, [`$.tour[${index}].order`], [{ path: `$.tour[${index}].order`, rule: 'enum', expected: `exact order ${index}` }]); if (nodeIds.some(id => !ids.has(id))) return architectureReferenceError('tour_references', `$.tour[${index}].nodeIds`, 'IDs from the supplied architecture or non_code_candidates', tourIds); return { order: index, title: textField(step.title, 160), description: textField(step.description, 2000), nodeIds }; });
    if (tourCandidates.length && !result.some(step => step.nodeIds.some(id => tourCandidates.some(item => item.id === id)))) return architectureReferenceError('tour_non_code', '$.tour[].nodeIds', 'at least one supplied non_code_candidates ID', tourCandidates.map(item => item.id));
    return result;
  } });
  await options.onPhase('tour', 1, 1);
  const graph = CodeUaGraphSchema.parse({ version: '1.0.0', kind: 'codebase', project: { name: options.repositoryName, languages: architecture.languages, frameworks: architecture.frameworks, description: architecture.description, analyzedAt: new Date().toISOString(), gitCommitHash: options.snapshot.commit }, nodes, edges, layers, tour: tour.value });
  await options.onPhase('review', 0, 1);
  const reviewed = await evidenceCall('review', 'global-review', { task: 'UA Phase6：审查这份已完成逐段阅读和系统综合的全局图。找职责冲突、证据不足的业务解释、跨模块流程断点、测试被误当已运行、文档期望被误当落实等问题。source_basis是宿主提供的来源限定：source_definition只说明配置、文档、测试或源码中的定义，不宣称实际执行；撤回字段尚未形成综合结论。必须报告因此造成的信息损失和流程断点，不能把占位说明当成完整成果，也不能把明确限定的定义误判为已运行承诺。不要宣称语义正确率或自我通过；以具体证据记录finding或unknown。不凭空增加需求，不更改已验证图。scope为现有节点ID或system。最终独立质量评估由另一位审查者完成。', output_shape: { findings: [{ severity: 'warning|critical', scope: '有效node id或system', description: '具体问题', evidence: [{ path: '有效证据路径', line_start: 1, line_end: 2 }] }], unknowns: ['缺少外部证据的限制'] }, architecture, source_basis: { definition_fields: [...declarationFields], definition_rules: globalRuleLineage.filter(rule => rule.evidence.length > 0 && rule.evidence.every(item => semanticSourceKind(item.path) !== 'code')).map(rule => ({ node_id: rule.node_id, rule_index: rule.rule_index, parent_rule_id: rule.parent_rule_id, origin_scope_id: rule.origin_scope_id })), definition_qualification: ARCHITECTURE_SOURCE_DEFINITION_PREFIX, withdrawn_fields: [...withdrawnFields] }, ownership_counts: architecture.modules.map(module => ({ module_id: module.id, files: ownership.filter(item => item.module_id === module.id).length })), native_cross_module_relations: relationEvidence.filter(item => item.source.startsWith('module:') && item.target.startsWith('module:')), coverage: { files: options.briefs.length, missing_primary_owner: 0 } }, ARCHITECTURE_REVIEW_OUTPUT_SCHEMA, (raw, evidence) => {
    const value = strictObject(raw, ['findings', 'unknowns']); return { findings: listField(value.findings, 30).map((item, index) => { const finding = strictObject(item, ['severity', 'scope', 'description', 'evidence']); if (finding.scope !== 'system' && !nodes.some(node => node.id === finding.scope)) return architectureReferenceError('review_scope', `$.findings[${index}].scope`, 'an existing node ID or system'); return { severity: String(finding.severity), scope: textField(finding.scope, 500), description: textField(finding.description, 1200), evidence: evidenceField(finding.evidence, evidence) }; }), unknowns: stringsField(value.unknowns, 30) };
  });
  writeSemanticJson(path.join(options.runDirectory, 'semantic-review.json'), reviewed.value);
  if (reviewed.value.findings.some(finding => finding.severity === 'critical')) return semanticInvalid('critical_review', false, ['review.findings']);
  const warnings = reviewed.value.findings.filter(finding => finding.severity === 'warning');
  for (const node of graph.nodes) {
    const applicable = warnings.filter(finding => finding.scope === node.id || finding.scope === 'system' && node.type === 'module');
    if (!applicable.length) continue;
    // Keep warnings visible in the published graph with their real references. They are
    // uncertainty statements, never new verified business rules or fabricated support.
    node.domainMeta ??= {};
    node.domainMeta.businessRules = [...(node.domainMeta.businessRules ?? []), ...applicable.map(finding => `审查待确认：${finding.description}`)];
    nodeEvidence.set(node.id, semanticEvidenceUnion(nodeEvidence.get(node.id) ?? [], ...applicable.map(finding => finding.evidence)));
    node.languageNotes = [node.languageNotes, '存在有来源的语义审查待确认项；不能把这份源码解释视为已验证业务结论。'].filter(Boolean).join('\n');
  }
  const overviewRoot = graph.nodes.find(node => node.type === 'module');
  if (overviewRoot) {
    overviewRoot.domainMeta ??= {};
    overviewRoot.domainMeta.unknowns = [...new Set([...architecture.unknowns, ...reviewed.value.unknowns])];
    overviewRoot.languageNotes = [overviewRoot.languageNotes, '本节点的未决事项同时保留全局综合与审查的完整未知记录。'].filter(Boolean).join('\n');
  }
  const groundingUnknowns = [...(groundingReports.at(-1)?.checks.filter(check => check.status === 'insufficient').map(check => ({ scope: check.node_id, description: `源码核验待确认（${check.field}）：${check.reason}` })) ?? []), ...repairUnknowns.map(item => ({ scope: item.node_id, description: item.description }))];
  for (const item of groundingUnknowns) {
    const relation = /^relation:(\d+)$/u.exec(item.scope);
    const relatedNode = relation ? architecture.relations[Number(relation[1])]?.source : item.scope;
    const node = graph.nodes.find(node => node.id === relatedNode) ?? overviewRoot;
    if (node) { node.domainMeta ??= {}; node.domainMeta.unknowns = [...new Set([...(node.domainMeta.unknowns ?? []), item.description])]; }
  }
  const checkedGraph = CodeUaGraphSchema.parse(graph);
  await options.onPhase('review', 1, 1);
  const node_evidence = [...nodeEvidence].map(([node_id, evidence]) => ({ node_id, evidence: compactPublishedNodeEvidence(evidence) }));
  const rangesBefore = [...nodeEvidence.values()].reduce((sum, evidence) => sum + evidence.length, 0), rangesAfter = node_evidence.reduce((sum, item) => sum + item.evidence.length, 0);
  return { graph: checkedGraph, relation_evidence: relationEvidence, node_evidence, ownership, review: reviewed.value, unknowns: architecture.unknowns, groundingUnknowns, limitations: [...OVERVIEW_LIMITATIONS], statistics: { modules: architecture.modules.length, capabilities: architecture.capabilities.length, flows: architecture.flows.length, native_file_dependencies: options.dependencies.length, native_cross_module_dependencies: moduleDependencies.size, architecture_reduce_partitions: reducePartitions, overview_depth: reductionDepth, overview_bundles: overviewBundles?.length ?? 0, global_grounding_attempts: groundingReports.length, global_grounding_claims: groundingReports.at(-1)?.checks.length ?? 0, global_grounding_blocking: groundingReports.at(-1)?.blocking.length ?? 0, withdrawn_narrative_fields: withdrawnFields.size, withdrawn_rule_origins: withdrawnRuleOrigins, review_warnings: warnings.length, review_critical: 0, node_support_ranges_before_compaction: rangesBefore, node_support_ranges_after_compaction: rangesAfter, node_support_ranges_compacted: rangesBefore - rangesAfter } };
}
