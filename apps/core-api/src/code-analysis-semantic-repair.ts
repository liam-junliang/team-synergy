import type { GroundingClaim } from './code-analysis-semantic-grounding.js';
import type { OverviewGlobalRuleLineage } from './code-analysis-semantic-overview.js';
import { assertArchitectureWireShape, wireList, wireObject, wireText } from './code-analysis-semantic-architecture-wire.js';
import { objectRecord, semanticDigest, semanticInvalid, type SemanticSchemaIssue, type SourceEvidence } from './code-analysis-semantic-source.js';

export const ARCHITECTURE_FIELD_REPAIR_PROTOCOL = 'architecture-grounded-field-repair-1.4.0';
const WITHDRAWN_FIELD_PLACEHOLDER = '本节点提供相关源码详情的阅读入口。';
export const ARCHITECTURE_SOURCE_DEFINITION_PREFIX = '【来源定义，未声称实际执行】';
interface Rule { description: string; evidence: SourceEvidence[] }
interface Node { id: string; summary: string; business_rules: Rule[]; state_owners?: string[]; user_purposes?: string[]; steps?: { description: string }[] }
interface Architecture { description: string; modules: Node[]; capabilities: Node[]; flows: Node[]; relations: { description: string }[]; unknowns: string[] }
interface Witness extends SourceEvidence { id: string; file_sha256: string; text_sha256: string; text: string }
export interface RepairFeedback { id: string; node_id: string; field: string; text_sha256: string; status: string; reason: string; evidence: SourceEvidence[]; context_ids: string[]; snapshot_id?: string; sources?: Witness[]; source_scope?: 'source_definition'; source_disclosure?: string; missing_guard_definitions?: string[]; source_contexts?: unknown[] }
interface Audit { node_id: string; field: string; claim_ids: string[]; description: string; actor?: 'host_budget_retraction' }
interface Target { field: string; node_id: string; original_text: string; field_sha256: string; max_length: number; declaredScope: boolean; blocked_claims: { id: string; field: string; text: string; text_sha256: string; status: string; reason: string; evidence: SourceEvidence[]; context_ids: string[]; private_audit_index: number; witness_source_ids: string[]; source_scope?: 'source_definition'; source_disclosure?: string; missing_guard_definitions: string[]; source_contexts: unknown[] }[]; context: unknown; sources: Witness[] }
export interface DecodedArchitectureFieldRepair { field: string; node_id: string; field_sha256: string; previous_sha256: string; decision: 'replace' | 'withdraw'; replacement_text: string; unknowns: string[]; audit: Audit[]; assertion_scope?: 'source_definition'; retrieval_anchors?: SourceEvidence[] }
/** Host-derived locations for the current exact field, never approved support. */
export interface ArchitectureFieldRetrievalAnchors { field: string; node_id: string; text_sha256: string; anchors: SourceEvidence[] }
export interface ArchitectureRuleWithdrawal { previous_sha256: string; parent_rule_id: string; origin_scope_id: string; claim: GroundingClaim; feedback: RepairFeedback; applications: { node_id: string; rule_index: number }[] }
export interface ArchitectureSpanWithdrawal { actor: 'host_budget_retraction'; previous_sha256: string; field: string; node_id: string; field_sha256: string; request_bytes: number; assertion_scope?: 'source_definition'; private_audit: { feedback_sha256: string; ref: string }; spans: { start: number; end: number; text: string; text_sha256: string; feedback: RepairFeedback }[] }
const fail = (reason: string): never => semanticInvalid('architecture_field_repair_' + reason, false);
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const damagedNarrative = (text: string): boolean => /\uFFFD|[\uD800-\uDFFF]/u.test(text);
function retrievalAnchors(ranges: readonly SourceEvidence[]): SourceEvidence[] {
  if (!Array.isArray(ranges)) return fail('retrieval_identity');
  const anchors = new Map<string, SourceEvidence>();
  for (const range of ranges) {
    if (!objectRecord(range) || typeof range.path !== 'string' || !range.path.trim() || typeof range.line_start !== 'number' || typeof range.line_end !== 'number' || !Number.isSafeInteger(range.line_start) || !Number.isSafeInteger(range.line_end) || range.line_start < 1 || range.line_end < range.line_start) return fail('retrieval_identity');
    const anchor = { path: range.path, line_start: range.line_start, line_end: range.line_end };
    anchors.set(JSON.stringify(anchor), anchor);
  }
  return [...anchors.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line_start - right.line_start || left.line_end - right.line_end);
}
function location(architecture: Architecture, field: string) {
  if (field === 'description') return { object: architecture, key: 'description', node_id: 'system', max: 3000 };
  const match = field.match(/^(modules|capabilities|flows|relations)\.(0|[1-9]\d*)\.(summary|description|state_owners|user_purposes|steps)(?:\.(0|[1-9]\d*)(?:\.(description))?)?$/u);
  if (!match) return fail('field');
  const collection = match[1] as 'modules' | 'capabilities' | 'flows' | 'relations', index = Number(match[2]), attribute = match[3], item = architecture[collection][index];
  if (!Number.isSafeInteger(index) || !item) return fail('field');
  const node_id = collection === 'relations' ? `relation:${index}` : (item as Node).id;
  if (attribute === 'summary' && collection !== 'relations' && match[4] === undefined) return { object: item, key: 'summary', node_id, max: 1600 };
  if (attribute === 'description' && collection === 'relations' && match[4] === undefined) return { object: item, key: 'description', node_id, max: 1200 };
  const position = Number(match[4]);
  if (collection === 'modules' && ['state_owners', 'user_purposes'].includes(attribute as string) && match[4] !== undefined && !match[5]) {
    const array = (item as Node)[attribute as 'state_owners' | 'user_purposes']; if (!array || typeof array[position] !== 'string') return fail('field');
    return { object: array, key: position, node_id, max: 800 };
  }
  if (collection === 'flows' && attribute === 'steps' && match[5] === 'description') {
    const step = (item as Node).steps?.[position]; if (!step) return fail('field'); return { object: step, key: 'description', node_id, max: 800 };
  }
  return fail('field');
}
function fieldText(architecture: Architecture, field: string) {
  const at = location(architecture, field), value = (at.object as unknown as Record<string | number, unknown>)[at.key];
  if (typeof value !== 'string' || !value.trim() || value.length > at.max) return fail('original_text');
  return { ...at, value };
}
function auditFor(claim: GroundingClaim, feedback: Pick<RepairFeedback, 'reason'>, node_id = claim.node_id): Audit {
  const description = `原表述已撤回并保留待确认：${claim.text}\n来源核验：${feedback.reason}`;
  if (description.length > 4000) return fail('audit_budget');
  return { node_id, field: claim.field, claim_ids: [claim.id], description };
}
function retractSpans(withdrawal: ArchitectureSpanWithdrawal, original: string): string {
  if (withdrawal.actor !== 'host_budget_retraction' || !Number.isSafeInteger(withdrawal.request_bytes) || withdrawal.request_bytes <= 179_000 || !withdrawal.spans.length || semanticDigest(original) !== withdrawal.field_sha256 || withdrawal.assertion_scope !== undefined && withdrawal.assertion_scope !== 'source_definition') return fail('span_binding');
  let cursor = 0, retained = ''; const claims = new Set<string>();
  for (const span of [...withdrawal.spans].sort((left, right) => left.start - right.start)) {
    const block = span.feedback;
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < cursor || span.end <= span.start || span.end > original.length || original.slice(span.start, span.end) !== span.text || semanticDigest(span.text) !== span.text_sha256 || block.text_sha256 !== span.text_sha256 || block.status !== 'insufficient' || !block.reason.trim() || block.node_id !== withdrawal.node_id || block.field !== `${withdrawal.field}:${span.start}-${span.end}` || claims.has(block.id)) return fail('span_binding');
    claims.add(block.id); retained += original.slice(cursor, span.start); cursor = span.end;
  }
  return retained + original.slice(cursor);
}
function requestFor(targets: Target[], previous_sha256: string, feedback_sha256: string, feedbackRef: string) {
  const sources = new Map<string, Witness>();
  for (const target of targets) for (const source of target.sources) { const old = sources.get(source.id); if (old && semanticDigest(old) !== semanticDigest(source)) return fail('source_collision'); sources.set(source.id, source); }
  const schema = wireObject({ patches: wireList(targets.length, wireObject({ field: wireText(500, targets.map(target => target.field)), field_sha256: wireText(64, targets.map(target => target.field_sha256)), decision: wireText(8, ['replace', 'withdraw']), replacement_text: { type: 'string', minLength: 0, maxLength: Math.max(...targets.map(target => target.max_length)) }, unknowns: wireList(2, wireText(400)) }), targets.length) });
  const input = { repair_protocol: ARCHITECTURE_FIELD_REPAIR_PROTOCOL, previous_architecture_sha256: previous_sha256,
    task: '仅修订列出的原字段，这是一次受限修正波次。每个field精确返回一次并回显field_sha256；不可改变字段、节点、次序、证据、角色或任何未列出的内容。source_catalog保留contradicted和insufficient项实际提供的完整来源正文；每个字段只能依据其blocked_claims[].witness_source_ids所列正文，不能借用共享目录中其他字段的来源。正文存在只提供修正依据，不代表批准原断言，也不能扩展为外部事实。优先保留准确、有用的源码职责总结；文档只说明文档声明，工作流定义只说明流程定义，测试只说明测试定义，均不证明实际执行、实现或运行成功。declaredScope=true仅允许描述所给来源定义本身，由宿主添加来源限定前缀；replacement_text只包含可由所给源码支持的事实、定义、条件与动作。本次取证的证据缺项、未展开边界、未验证运行等局限只放入unknowns，例如“本页未提供”、“未证明运行”、“未展开”，不得混入replacement_text；源码中可见的拒绝条件等否定事实仍须准确保留。replacement_text必须返回不含宿主限定前缀的原始事实文字，不得自加取证免责声明，也不得返回assertion_scope。完整见证包含条件分支时，应同时检查提前返回、幂等处理、输入缺失及回退路径，区分每个分支的实际动作与结果；不能把正常路径上的某个动作概括为所有成功返回都保证完成该动作。missing_guard_definitions和source_contexts中缺失守卫或不完整闭包仍然有效，不能因存在完整正文就推断未提供的守卫、权限或外部保证。没有提供正文的insufficient项及私有审计引用不能用来推断替换事实；只能保留已有且未被阻断的窄范围内容。decision必须明确为replace或withdraw：replace仅用于有依据的修正，replacement_text非空并遵守该字段max_length；确实没有足够依据保留字段内容时使用withdraw，replacement_text必须严格为空字符串，由宿主撤回原字段事实并生成中性的源码阅读入口。不能靠返回导航句或“待确认”字样隐式表示撤回，也不能把被拒绝的肯定事实加上限定词继续保留。未知写入unknowns，每字段最多2条、每条400字符；完整原字段、全部被阻断表述和原因由宿主审计保留。禁止返回新增证据或规则、执行动作、批准结论或删除未列出的内容。所有未被宿主明确撤回的修正字段都会按原源码再次核验。',
    private_audit: { feedback_sha256, ref: feedbackRef, meaning: 'Each private_audit_index and context_ids bind the full immutable feedback, source bodies and validation ledgers. Unprovided evidence cannot authorize a replacement fact.' },
    targets: targets.map(({ sources: _sources, ...target }) => target), source_catalog: [...sources.values()], output_schema: schema };
  input.task = 'declaredScope=false的字段保持实现事实范围，不能因其中部分blocked_claims.source_scope=source_definition就把整个字段改成来源定义范围。混合字段中只有文档或测试依据的声明应移入unknowns，明确标为来源说明及实现尚未核实，不得继续放在replacement_text；正文只保留实现源码支持的窄范围事实、条件与动作。declaredScope=true时仍可描述来源定义，并由宿主添加限定。逐项核对每个赋值目标及其对应右值、字面常量、参数位置与事务边界；不同目标的不同值不能合并成共享同一右值，事务外查询不能表述为事务内查询。' + input.task;
  function decode(raw: unknown): DecodedArchitectureFieldRepair[] {
    assertArchitectureWireShape(raw, schema); const seen = new Set<string>();
    const patches = (raw as { patches: { field: string; field_sha256: string; decision: 'replace' | 'withdraw'; replacement_text: string; unknowns: string[] }[] }).patches;
    return patches.map((patch, index) => {
      const target = targets.find(item => item.field === patch.field);
      if (!target) return fail('response_identity'); // The strict host field enum already excludes foreign fields.
      const at = `$.patches[${index}]`, issues: SemanticSchemaIssue[] = [];
      if (seen.has(patch.field)) issues.push({ path: `${at}.field`, rule: 'unique_items', expected: 'each exact host target field once', allowed_values: targets.filter(item => !seen.has(item.field)).map(item => item.field) });
      if (patch.field_sha256 !== target.field_sha256) issues.push({ path: `${at}.field_sha256`, rule: 'enum', allowed_values: [target.field_sha256] });
      if (patch.replacement_text.length > target.max_length) issues.push({ path: `${at}.replacement_text`, rule: 'max_length', observed_length: patch.replacement_text.length, maximum: target.max_length });
      if (patch.replacement_text.startsWith(ARCHITECTURE_SOURCE_DEFINITION_PREFIX)) issues.push({ path: `${at}.replacement_text`, rule: 'enum', expected: 'raw narrative text without the host-owned source-definition prefix' });
      if (patch.decision === 'withdraw' && patch.replacement_text !== '') issues.push({ path: `${at}.replacement_text`, rule: 'max_length', observed_length: patch.replacement_text.length, maximum: 0 });
      if (patch.decision === 'replace' && !patch.replacement_text.trim()) issues.push({ path: `${at}.replacement_text`, rule: 'non_empty', observed_length: 0, minimum: 1 });
      if (issues.length) return semanticInvalid('architecture_field_repair_response_identity', true, issues.map(issue => issue.path), issues);
      const damagedPath = damagedNarrative(patch.replacement_text) ? `$.patches[${index}].replacement_text` : patch.unknowns.findIndex(damagedNarrative);
      if (damagedPath !== -1) {
        const fieldPath = typeof damagedPath === 'string' ? damagedPath : `$.patches[${index}].unknowns[${damagedPath}]`;
        return semanticInvalid('narrative_text_integrity', true, [fieldPath], [{ path: fieldPath, rule: 'type', expected: 'well-formed Unicode narrative without replacement characters or unpaired surrogates' }]);
      }
      seen.add(patch.field);
      const declaration = target.declaredScope && patch.decision === 'replace';
      const anchors = patch.decision === 'replace' ? retrievalAnchors(target.sources.filter(source => target.blocked_claims.some(block => block.witness_source_ids.includes(source.id)))) : [];
      return { ...structuredClone(patch), replacement_text: (declaration ? ARCHITECTURE_SOURCE_DEFINITION_PREFIX : '') + patch.replacement_text, ...(declaration ? { assertion_scope: 'source_definition' as const } : {}), ...(anchors.length ? { retrieval_anchors: anchors } : {}), node_id: target.node_id, previous_sha256, audit: target.blocked_claims.map(block => auditFor({ id: block.id, node_id: target.node_id, field: block.field, text: block.text, kind: 'narrative', evidence: [] }, block)) };
    });
  }
  return { name: `field-repair-${semanticDigest(targets.map(target => [target.field, target.field_sha256])).slice(0, 16)}`, input, decode, byteLength: size({ analysis_phase: 'architecture-repair', ...input }) };
}

/** Plans one bounded wave. It never requests a model, changes a fact or edits a source. */
export function prepareArchitectureGroundingRepairs(previous: Architecture, claims: readonly GroundingClaim[], feedback: readonly RepairFeedback[], lineage: readonly OverviewGlobalRuleLineage[], options: { feedbackRef?: string } = {}) {
  const feedbackRef = options.feedbackRef ?? 'semantic-global-grounding-0.json#/feedback';
  if (!/^semantic-global-grounding-[0-3]\.json#\/feedback$/u.test(feedbackRef)) return fail('audit_reference');
  const previous_sha256 = semanticDigest(previous), feedback_sha256 = semanticDigest(feedback), byId = new Map(claims.map(claim => [claim.id, claim]));
  if (byId.size !== claims.length) return fail('claim_identity');
  const seen = new Set<string>(), targets = new Map<string, Target>(), withdrawn_rule_claims: ArchitectureRuleWithdrawal[] = [];
  for (const [private_audit_index, original] of feedback.entries()) {
    const claim = byId.get(original.id);
    if (!claim || seen.has(original.id) || original.node_id !== claim.node_id || original.field !== claim.field || original.text_sha256 !== semanticDigest(claim.text) || !['contradicted', 'insufficient'].includes(original.status) || !original.reason.trim()) return fail('claim_identity');
    seen.add(original.id); const block = structuredClone(original);
    if (claim.kind === 'rule_application') {
      const context = claim.scope_context;
      if (!objectRecord(context) || typeof context.parent_rule_id !== 'string' || typeof context.origin_scope_id !== 'string') return fail('rule_identity');
      const applications = lineage.filter(rule => rule.parent_rule_id === context.parent_rule_id && rule.origin_scope_id === context.origin_scope_id);
      if (!applications.length || applications.some(rule => rule.description !== claim.text) || claim.field !== `rule_application:${context.parent_rule_id}:${context.origin_scope_id}`) return fail('rule_identity');
      withdrawn_rule_claims.push({ previous_sha256, parent_rule_id: context.parent_rule_id, origin_scope_id: context.origin_scope_id, claim: structuredClone(claim), feedback: block, applications: applications.map(rule => ({ node_id: rule.node_id, rule_index: rule.rule_index })) });
      continue;
    }
    const scope = objectRecord(claim.scope_context) ? claim.scope_context : {}, fallback = claim.field.replace(/:\d+-\d+$/u, ''), field = typeof scope.field === 'string' ? scope.field : fallback;
    if (field !== fallback) return fail('field');
    const at = fieldText(previous, field), span = claim.field.slice(field.length).match(/^:(\d+)-(\d+)$/u);
    if (at.node_id !== claim.node_id || scope.field_text !== undefined && scope.field_text !== at.value || !span || at.value.slice(Number(span[1]), Number(span[2])) !== claim.text) return fail('field_binding');
    if (scope.field_span !== undefined && semanticDigest(scope.field_span) !== semanticDigest([Number(span[1]), Number(span[2])])) return fail('field_binding');
    const target = targets.get(field) ?? { field, node_id: at.node_id, original_text: at.value, field_sha256: semanticDigest(at.value), max_length: at.max, declaredScope: false, blocked_claims: [], context: Object.fromEntries(Object.entries(scope).filter(([key]) => !['field', 'field_text', 'field_span'].includes(key))), sources: [] };
    const witnesses = block.sources ?? [];
    for (const source of witnesses) if (typeof source.text !== 'string' || semanticDigest(source.text) !== source.text_sha256) return fail('source_identity');
    target.sources.push(...structuredClone(witnesses));
    target.blocked_claims.push({ id: claim.id, field: claim.field, text: claim.text, text_sha256: block.text_sha256, status: block.status, reason: block.reason, evidence: structuredClone(block.evidence), context_ids: [...block.context_ids], private_audit_index, witness_source_ids: witnesses.map(source => source.id), ...(block.source_scope ? { source_scope: block.source_scope } : {}), ...(block.source_disclosure ? { source_disclosure: block.source_disclosure } : {}), missing_guard_definitions: [...(block.missing_guard_definitions ?? [])], source_contexts: structuredClone(block.source_contexts ?? []) });
    targets.set(field, target);
  }
  const requests: ReturnType<typeof requestFor>[] = [], span_withdrawals: ArchitectureSpanWithdrawal[] = []; let group: Target[] = [];
  for (const target of targets.values()) {
    target.declaredScope = target.blocked_claims.length > 0 && target.blocked_claims.every(block => block.source_scope === 'source_definition' && block.witness_source_ids.length > 0);
    if (target.declaredScope) target.max_length -= ARCHITECTURE_SOURCE_DEFINITION_PREFIX.length;
    const single = requestFor([target], previous_sha256, feedback_sha256, feedbackRef);
    if (single.byteLength > 179_000) {
      if (target.blocked_claims.some(block => block.status !== 'insufficient')) return fail('request_budget');
      const spans = target.blocked_claims.map(block => {
        const span = block.field.slice(target.field.length).match(/^:(\d+)-(\d+)$/u), original = feedback[block.private_audit_index];
        if (!span || !original) return fail('span_binding');
        return { start: Number(span[1]), end: Number(span[2]), text: block.text, text_sha256: block.text_sha256, feedback: structuredClone(original) };
      });
      const withdrawal: ArchitectureSpanWithdrawal = { actor: 'host_budget_retraction', previous_sha256, field: target.field, node_id: target.node_id, field_sha256: target.field_sha256, request_bytes: single.byteLength, ...(target.declaredScope ? { assertion_scope: 'source_definition' as const } : {}), private_audit: { feedback_sha256, ref: feedbackRef }, spans };
      retractSpans(withdrawal, target.original_text); span_withdrawals.push(withdrawal); continue;
    }
    if (group.length && (group.length >= 8 || requestFor([...group, target], previous_sha256, feedback_sha256, feedbackRef).byteLength > 120_000)) { requests.push(requestFor(group, previous_sha256, feedback_sha256, feedbackRef)); group = []; }
    group.push(target);
  }
  if (group.length) requests.push(requestFor(group, previous_sha256, feedback_sha256, feedbackRef));
  return { requests, withdrawn_rule_claims, span_withdrawals, previous_sha256, feedback_sha256, statistics: { blocking_claims: feedback.length, writable_fields: targets.size, rule_withdrawals: withdrawn_rule_claims.length, host_span_withdrawals: span_withdrawals.reduce((sum, item) => sum + item.spans.length, 0), requests: requests.length, request_bytes: requests.map(request => request.byteLength), max_request_bytes: Math.max(0, ...requests.map(request => request.byteLength)) } };
}

/** Applies only validated field replacements and exact host-owned rule removals. */
export function applyArchitectureGroundingRepairs<T extends Architecture>(previous: T, patches: readonly DecodedArchitectureFieldRepair[], lineage: readonly OverviewGlobalRuleLineage[], withdrawals: readonly ArchitectureRuleWithdrawal[], spanWithdrawals: readonly ArchitectureSpanWithdrawal[] = [], fieldRetrievalAnchors: readonly ArchitectureFieldRetrievalAnchors[] = []) {
  const digest = semanticDigest(previous);
  if ([...patches, ...withdrawals, ...spanWithdrawals].some(item => item.previous_sha256 !== digest)) return fail('stale_architecture');
  const architecture = structuredClone(previous), fields = new Set<string>(), unknownsAudit: Audit[] = [], withdrawn_fields: { field: string; node_id: string }[] = [], declaration_fields: { field: string; node_id: string; assertion_scope: 'source_definition' }[] = [];
  const retainedAnchors = new Map<string, ArchitectureFieldRetrievalAnchors>();
  for (const entry of fieldRetrievalAnchors) {
    const at = fieldText(previous, entry.field);
    if (retainedAnchors.has(entry.field) || at.node_id !== entry.node_id || semanticDigest(at.value) !== entry.text_sha256) return fail('retrieval_identity');
    retainedAnchors.set(entry.field, { field: entry.field, node_id: entry.node_id, text_sha256: entry.text_sha256, anchors: retrievalAnchors(entry.anchors) });
  }
  for (const patch of patches) {
    const at = fieldText(architecture, patch.field);
    if (fields.has(patch.field) || at.node_id !== patch.node_id || semanticDigest(at.value) !== patch.field_sha256 || !['replace', 'withdraw'].includes(patch.decision) || patch.replacement_text.length > at.max || (patch.decision === 'withdraw' ? patch.replacement_text !== '' : !patch.replacement_text.trim())) return fail('patch_binding');
    if (damagedNarrative(patch.replacement_text) || patch.unknowns.some(damagedNarrative)) return fail('text_integrity');
    if (patch.assertion_scope !== undefined && (patch.assertion_scope !== 'source_definition' || patch.decision !== 'replace' || !patch.replacement_text.startsWith(ARCHITECTURE_SOURCE_DEFINITION_PREFIX))) return fail('patch_binding');
    const anchors = retrievalAnchors(patch.retrieval_anchors ?? []);
    if (patch.decision === 'withdraw' && anchors.length) return fail('retrieval_identity');
    retainedAnchors.delete(patch.field);
    if (anchors.length) retainedAnchors.set(patch.field, { field: patch.field, node_id: patch.node_id, text_sha256: semanticDigest(patch.replacement_text), anchors });
    fields.add(patch.field); (at.object as unknown as Record<string | number, unknown>)[at.key] = patch.decision === 'withdraw' ? WITHDRAWN_FIELD_PLACEHOLDER : patch.replacement_text; unknownsAudit.push(...structuredClone(patch.audit), ...patch.unknowns.map(description => ({ node_id: patch.node_id, field: patch.field, claim_ids: [] as string[], description })));
    if (patch.decision === 'withdraw') { withdrawn_fields.push({ field: patch.field, node_id: patch.node_id }); unknownsAudit.push({ node_id: patch.node_id, field: patch.field, claim_ids: patch.audit.flatMap(item => item.claim_ids), description: `原字段事实已整体撤回，以下原文仅供溯源并保留待确认：${at.value}` }); }
    if (patch.assertion_scope === 'source_definition') declaration_fields.push({ field: patch.field, node_id: patch.node_id, assertion_scope: patch.assertion_scope });
  }
  for (const withdrawal of spanWithdrawals) {
    const at = fieldText(architecture, withdrawal.field);
    if (fields.has(withdrawal.field) || at.node_id !== withdrawal.node_id) return fail('span_binding');
    const priorAnchors = retainedAnchors.get(withdrawal.field);
    retainedAnchors.delete(withdrawal.field);
    fields.add(withdrawal.field); let retained = retractSpans(withdrawal, at.value);
    const content = retained.startsWith(ARCHITECTURE_SOURCE_DEFINITION_PREFIX) ? retained.slice(ARCHITECTURE_SOURCE_DEFINITION_PREFIX.length) : retained;
    if (!content.trim()) { retained = WITHDRAWN_FIELD_PLACEHOLDER; withdrawn_fields.push({ field: withdrawal.field, node_id: withdrawal.node_id }); }
    else if (withdrawal.assertion_scope === 'source_definition') {
      if (!retained.startsWith(ARCHITECTURE_SOURCE_DEFINITION_PREFIX)) retained = ARCHITECTURE_SOURCE_DEFINITION_PREFIX + retained;
      declaration_fields.push({ field: withdrawal.field, node_id: withdrawal.node_id, assertion_scope: 'source_definition' });
    }
    if (retained.length > at.max) return fail('span_binding');
    // Surviving facts retain their navigation locations under the host's new text identity.
    if (content.trim() && priorAnchors) retainedAnchors.set(withdrawal.field, { ...priorAnchors, text_sha256: semanticDigest(retained) });
    (at.object as unknown as Record<string | number, unknown>)[at.key] = retained;
    for (const span of withdrawal.spans) {
      const audit = auditFor({ id: span.feedback.id, node_id: withdrawal.node_id, field: span.feedback.field, text: span.text, kind: 'narrative', evidence: span.feedback.evidence }, span.feedback);
      audit.description = '宿主因完整来源超过修正请求预算而撤回此未证实表述；保留内容仍须再次核验。\n' + audit.description;
      if (audit.description.length > 4000) return fail('audit_budget');
      unknownsAudit.push({ ...audit, actor: withdrawal.actor });
    }
  }
  const removals = new Map<string, Set<number>>(), seen = new Set<string>(), nodes = [...architecture.modules, ...architecture.capabilities, ...architecture.flows];
  for (const withdrawal of withdrawals) {
    const key = JSON.stringify([withdrawal.parent_rule_id, withdrawal.origin_scope_id]); if (seen.has(key)) return fail('rule_identity'); seen.add(key);
    const actual = lineage.filter(rule => rule.parent_rule_id === withdrawal.parent_rule_id && rule.origin_scope_id === withdrawal.origin_scope_id);
    if (semanticDigest(actual.map(rule => ({ node_id: rule.node_id, rule_index: rule.rule_index }))) !== semanticDigest(withdrawal.applications)) return fail('rule_identity');
    for (const rule of actual) {
      const node = nodes.find(node => node.id === rule.node_id), original = node?.business_rules[rule.rule_index];
      if (!original || original.description !== withdrawal.claim.text || original.description !== rule.description || semanticDigest(original.evidence) !== semanticDigest(rule.evidence)) return fail('rule_identity');
      const indices = removals.get(rule.node_id) ?? new Set<number>(); indices.add(rule.rule_index); removals.set(rule.node_id, indices); unknownsAudit.push(auditFor(withdrawal.claim, withdrawal.feedback, rule.node_id));
    }
  }
  for (const node of nodes) node.business_rules = node.business_rules.filter((_, index) => !removals.get(node.id)?.has(index));
  const retained = lineage.filter(rule => !removals.get(rule.node_id)?.has(rule.rule_index)).map(rule => ({ ...structuredClone(rule), rule_index: rule.rule_index - [...(removals.get(rule.node_id) ?? [])].filter(index => index < rule.rule_index).length }));
  return { architecture, lineage: retained, unknownsAudit, withdrawn_fields, declaration_fields, host_span_withdrawals: structuredClone(spanWithdrawals), field_retrieval_anchors: [...retainedAnchors.values()] };
}
