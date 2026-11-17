import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import type { CodeArtifact, CodeSnapshot } from '@team-synergy/contracts';
import { type createSemanticModelClient, writeSemanticJson } from './code-analysis-semantic-model.js';
import { budgetGroups, mergeSourceEvidenceRanges, semanticEvidenceUnion, type FileDependency } from './code-analysis-semantic-architecture.js';
import { listField, requireSemanticValue, semanticDigest, semanticInvalid, strictObject, stringsField, textField, type FileBrief, type SourceEvidence } from './code-analysis-semantic-source.js';

const VERIFICATION_VERSION = 'cross-file-claims-1.3.0';
const highRisk = /principal|identit|auth|permission|role|lease|revision|transaction|optimistic|credential|atomic|owner|state|身份|主体|权限|角色|租约|修订|事务|版本|鉴权|认证|原子|状态|并发|撤销|令牌/i;
interface Claim { id: string; text: string }
interface Snippet extends SourceEvidence { file_sha256: string; input_sha256: string; text: string; defines: string[]; definition_complete: boolean }
interface Context {
  path: string; input_sha256: string; caller: FileBrief; claims: Claim[];
  callees: { path: string; sha256: string; summary: string; responsibility: string; behaviors: FileBrief['behaviors']; dependencies: FileBrief['dependencies']; evidence: SourceEvidence[]; unknowns: string[] }[];
  sources: Snippet[]; resolved_dependencies: { source: string; target: string; type: string; native_ids: string[] }[];
}
interface Finding {
  claim_id: string; status: 'corrected' | 'uncertain'; replacement: string; reason: string; evidence: SourceEvidence[];
  host_reason?: 'missing_complete_callee_definition';
  original_proposal?: { status: 'corrected'; replacement: string; reason: string; evidence_ids: string[]; evidence: SourceEvidence[] };
}
interface Checked { path: string; input_sha256: string; checked_claims: string[]; findings: Finding[]; unresolved_dependencies: string[] }
function claimsOf(brief: FileBrief): Claim[] {
  return [{ id: 'summary', text: brief.summary }, { id: 'responsibility', text: brief.responsibility }, ...brief.behaviors.map((item, index) => ({ id: `behavior:${index}`, text: item.description })), ...brief.dependencies.map((item, index) => ({ id: `dependency:${index}`, text: item.description })), ...brief.state_owners.map((text, index) => ({ id: `state:${index}`, text })), ...brief.user_purposes.map((text, index) => ({ id: `purpose:${index}`, text }))];
}
function allEvidence(brief: FileBrief) { return semanticEvidenceUnion(brief.evidence, ...brief.behaviors.map(item => item.evidence), ...brief.dependencies.map(item => item.evidence)); }
function relatedName(claim: string, name: string) { return name.length > 2 && name.length < 150 && claim.includes(name); }

function contextEvidenceCatalog(context: Context) {
  const ranges = semanticEvidenceUnion(allEvidence(context.caller), ...context.callees.map(callee => callee.evidence), context.sources)
    .map(({ path, line_start, line_end }) => ({ path, line_start, line_end }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line_start - right.line_start || left.line_end - right.line_end);
  return ranges.map((range, index) => ({ id: `E${String(index + 1).padStart(3, '0')}`, ...range }));
}
function consistencyWireContext(context: Context, context_id: string) {
  const catalog = contextEvidenceCatalog(context);
  const ids = (ranges: SourceEvidence[]) => ranges.map(range => requireSemanticValue(catalog.find(entry => entry.path === range.path && entry.line_start === range.line_start && entry.line_end === range.line_end)).id);
  const fact = (value: Context['callees'][number] | FileBrief) => ({ path: value.path, summary: value.summary, responsibility: value.responsibility,
    behaviors: value.behaviors.map(behavior => ({ description: behavior.description, evidence_ids: ids(behavior.evidence) })),
    dependencies: value.dependencies.map(dependency => ({ target: dependency.target, type: dependency.type, description: dependency.description, status: dependency.status, evidence_ids: ids(dependency.evidence) })),
    evidence_ids: ids(value.evidence), unknowns: value.unknowns,
    ...('state_owners' in value ? { state_owners: value.state_owners, user_purposes: value.user_purposes } : {}),
  });
  const definitions = context.sources.filter(source => source.path !== context.path && source.definition_complete && source.defines.length > 0 && context.callees.some(callee => callee.path === source.path));
  return { context_id, path: context.path, caller: fact(context.caller), claims: context.claims.map(claim => ({ ...claim, corrected_requires_definition: highRisk.test(claim.text) || context.resolved_dependencies.length > 0 })),
    callees: context.callees.map(fact), sources: context.sources.map(source => ({ evidence_id: requireSemanticValue(ids([source])[0]), path: source.path, line_start: source.line_start, line_end: source.line_end, text: source.text, defines: source.defines, definition_complete: source.definition_complete })),
    resolved_dependencies: context.resolved_dependencies, evidence_catalog: catalog, complete_callee_definition_ids: [...new Set(ids(definitions))],
  };
}

/** Caller argument syntax never establishes callee implementation semantics. All brief claims
 * are reconsidered against resolved dependencies; risky helper assertions get definition bytes. */
export async function reconcileSemanticBriefs(options: {
  snapshot: CodeSnapshot; sourceDirectory: string; runDirectory: string; briefs: FileBrief[];
  dependencies: FileDependency[]; native: Pick<CodeArtifact, 'nodes' | 'edges'>;
  client: ReturnType<typeof createSemanticModelClient>; parallel: <T, R>(items: T[], action: (item: T, index: number) => Promise<R>) => Promise<R[]>;
  onProgress: (completed: number, total: number) => Promise<void>;
}) {
  const byPath = new Map(options.briefs.map(brief => [brief.path, brief])), snapshotFiles = new Map(options.snapshot.files.map(file => [file.path, file]));
  const texts = new Map<string, string[]>();
  function linesFor(filePath: string): string[] {
    const existing = texts.get(filePath); if (existing) return existing;
    const file = requireSemanticValue(snapshotFiles.get(filePath)), bytes = readFileSync(path.join(options.sourceDirectory, filePath));
    if (bytes.length !== file.byte_count || semanticDigest(bytes) !== file.sha256) return semanticInvalid('consistency_source_changed', false);
    const lines = bytes.toString('utf8').split('\n'); texts.set(filePath, lines); return lines;
  }
  function sourceRanges(filePath: string, start: number, end: number, defines: string[] = [], exactDefinition = true): Snippet[] {
    const file = requireSemanticValue(snapshotFiles.get(filePath)); if (!file.line_count) return [];
    const lines = linesFor(filePath), result: Snippet[] = []; let lineStart = start, rows: string[] = [], bytes = 0;
    for (let index = start - 1; index < Math.min(end, file.line_count); index++) {
      const text = lines[index] ?? '', size = Buffer.byteLength(text + '\n');
      if (size > 16_000) {
        // Oversized single-line definitions remain available through the complete-source
        // facts. Do not invent a partial string as a full implementation proof.
        if (rows.length) { const content = rows.join('\n'); result.push({ path: filePath, line_start: lineStart, line_end: index, file_sha256: file.sha256, input_sha256: semanticDigest(content), text: content, defines, definition_complete: false }); rows = []; bytes = 0; }
        lineStart = index + 2; continue;
      }
      if (rows.length && bytes + size > 16_000) { const content = rows.join('\n'); result.push({ path: filePath, line_start: lineStart, line_end: index, file_sha256: file.sha256, input_sha256: semanticDigest(content), text: content, defines, definition_complete: false }); rows = []; bytes = 0; lineStart = index + 1; }
      rows.push(text); bytes += size;
    }
    if (rows.length) { const content = rows.join('\n'); result.push({ path: filePath, line_start: lineStart, line_end: Math.min(end, file.line_count), file_sha256: file.sha256, input_sha256: semanticDigest(content), text: content, defines, definition_complete: false }); }
    // A partial declaration/body or a generic file-context fallback is useful context,
    // but must never be promoted into proof of the complete callee implementation.
    if (exactDefinition && defines.length && result.length === 1 && result[0]?.line_start === start && result[0]?.line_end === end) requireSemanticValue(result[0]).definition_complete = true;
    return result;
  }
  const contexts: Context[] = [];
  for (const brief of options.briefs) {
    const claims = claimsOf(brief), risky = claims.filter(claim => highRisk.test(claim.text));
    const outgoing = options.dependencies.filter(dependency => dependency.source === brief.path);
    const calleePaths = [...new Set(outgoing.map(dependency => dependency.target))];
    const ownRanges = risky.length ? mergeSourceEvidenceRanges(allEvidence(brief)).flatMap(item => sourceRanges(item.path, item.line_start, item.line_end)) : [];
    const neighborhoods = calleePaths.map(filePath => {
      const callee = requireSemanticValue(byPath.get(filePath));
      const nativeNodes = new Map(options.native.nodes.map(node => [node.id, node]));
      const directCalleeIds = new Set(options.native.edges.filter(edge => nativeNodes.get(edge.source)?.path === brief.path && nativeNodes.get(edge.target)?.path === filePath).map(edge => edge.target));
      const matchingDefinitions = options.native.nodes.filter(node => node.path === filePath && ['function', 'method', 'class'].includes(node.kind) && node.line_start && node.line_end && (risky.some(claim => relatedName(claim.text, node.label)) || risky.length > 0 && directCalleeIds.has(node.id)));
      const sources = matchingDefinitions.flatMap(node => sourceRanges(filePath, node.line_start ?? 1, node.line_end ?? 1, [node.label]));
      // A resolved import plus an explicit function declaration still offers definition
      // evidence when the native index cannot resolve its call edge. This is syntax
      // location, not an invented semantic interpretation of the declaration.
      if (!sources.length && risky.length) {
        const lines = linesFor(filePath);
        const names = [...new Set(risky.flatMap(claim => claim.text.match(/[A-Za-z_$][\w$]{2,}/g) ?? []))];
        const declaredNames = names.filter(name => lines.some(line => new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${name.replace(/[$]/g, '\\$')}\\b`).test(line)));
        if (declaredNames.length) sources.push(...sourceRanges(filePath, 1, requireSemanticValue(snapshotFiles.get(filePath)).line_count, declaredNames, false));
      }
      return { callee: { path: callee.path, sha256: callee.sha256, summary: callee.summary, responsibility: callee.responsibility, behaviors: callee.behaviors, dependencies: callee.dependencies, evidence: allEvidence(callee), unknowns: callee.unknowns }, sources };
    });
    const pagedNeighborhoods = neighborhoods.flatMap(item => {
      if (Buffer.byteLength(JSON.stringify(item)) <= 75_000) return [item];
      const factBytes = Buffer.byteLength(JSON.stringify(item.callee));
      return budgetGroups(item.sources, Math.max(16_500, 70_000 - factBytes), 20).map(sources => ({ callee: item.callee, sources }));
    });
    const parts = pagedNeighborhoods.length ? budgetGroups(pagedNeighborhoods, 75_000, 12) : [[]];
    for (const neighbors of parts) {
      const sources = [...ownRanges, ...neighbors.flatMap(item => item.sources)];
      const sourceGroups = sources.length ? budgetGroups(sources, 50_000, 30) : [[]];
      for (const sourceGroup of sourceGroups) {
        const context = { path: brief.path, caller: brief, claims, callees: neighbors.map(item => item.callee), sources: sourceGroup, resolved_dependencies: outgoing.filter(dependency => neighbors.some(item => item.callee.path === dependency.target)).map(dependency => ({ source: dependency.source, target: dependency.target, type: dependency.type, native_ids: dependency.native_ids })) };
        contexts.push({ ...context, input_sha256: semanticDigest({ verification_version: VERIFICATION_VERSION, ...context }) });
      }
    }
  }
  // Multiple callers share a request when their complete dependency contexts fit; no
  // global prefix slicing and no unbounded caller fanout in a single provider request.
  const contextIds = new Map<Context, string>(), bindings = new Map<string, Context>();
  for (const context of contexts) {
    const context_id = `C${context.input_sha256.slice(0, 16)}`;
    // A short wire identity is accepted only through this complete, canonical host binding.
    if (bindings.has(context_id)) return semanticInvalid('consistency_context_collision', false);
    contextIds.set(context, context_id); bindings.set(context_id, context);
  }
  const wireContexts = contexts.map(context => consistencyWireContext(context, requireSemanticValue(contextIds.get(context))));
  const groups = budgetGroups(wireContexts, 140_000, 4);
  await options.onProgress(0, groups.length); let finished = 0;
  const splits: { group: number; reason: string; context_ids: string[]; children: string[][]; host_bindings: { context_id: string; input_sha256: string }[] }[] = [];
  async function executeGroup(files: typeof wireContexts, index: number): Promise<Checked[]> {
    const allowedContexts = files.map(file => file.context_id);
    const request = { phase: 'consistency', name: `consistency-${index}`,
      cacheIdentity: files.map(file => ({ context_id: file.context_id, input_sha256: requireSemanticValue(bindings.get(file.context_id)).input_sha256 })),
      input: { verification_version: VERIFICATION_VERSION,
        task: '跨文件事实一致性核验。对每个context的每条claim核对，checked_claims完整回显。只回显context_id作为身份，不要返回path或任何hash。同一路径的不同context不能合并。调用参数透传不证明被调用函数读取或采用参数，真实定义源码优先于待核事实。所有引用仅用该context evidence_catalog中的精确evidence_ids，不能自写path/行号，不能借同批其他context的目录。每条finding最多20个不重复ID、至少1个。claims标corrected_requires_definition时，corrected必须至少引用一个complete_callee_definition_ids：只有当前页实际提供的完整callee定义可支撑纠正，caller传参行或callee宽泛摘要不能代替定义。没有完整定义则uncertain、replacement为空；不可凭缺少某callee就判原claim错误，无法核对的问题放unresolved_dependencies。checked_claims精确覆盖该context全部claim ID且无重复，findings最多每claim一条；status仅corrected或uncertain，replacement仅corrected时非空且summary最多1200字符、其他claim最多800，reason非空最多600字符。unresolved_dependencies最多12条，每条非空最多800字符。只允许output_shape字段，不复述凭证/测试路径字面值，只返回合法JSON。',
        output_shape: { files: [{ context_id: '精确输入context_id', checked_claims: ['精确claim ID'], findings: [{ claim_id: '精确claim ID', status: 'uncertain', replacement: '', reason: '有依据的核验理由或当前不能确认的原因', evidence_ids: ['当前context的精确证据ID'] }], unresolved_dependencies: [] }] }, files }, validate: (raw: unknown): Checked[] => {
      const value = strictObject(raw, ['files']), results = listField(value.files, files.length, '$.files'), seen = new Set<string>();
      if (results.length !== files.length) return semanticInvalid('consistency_coverage', true, ['$.files'], [{ path: '$.files', rule: 'exact_items', observed_count: results.length, minimum: files.length, maximum: files.length, allowed_values: allowedContexts }]);
      return results.map((item, resultIndex) => {
        const rowPath = `$.files[${resultIndex}]`, row = strictObject(item, ['context_id', 'checked_claims', 'findings', 'unresolved_dependencies'], [], rowPath);
        const wire = files.find(file => file.context_id === row.context_id);
        if (!wire) return semanticInvalid('consistency_identity', true, [`${rowPath}.context_id`], [{ path: `${rowPath}.context_id`, rule: 'enum', allowed_values: allowedContexts }]);
        if (seen.has(wire.context_id)) return semanticInvalid('consistency_identity', true, [`${rowPath}.context_id`], [{ path: `${rowPath}.context_id`, rule: 'unique_items', allowed_values: allowedContexts }]);
        seen.add(wire.context_id);
        const context = requireSemanticValue(bindings.get(wire.context_id));
        const checked_claims = stringsField(row.checked_claims, 100, `${rowPath}.checked_claims`), expected = context.claims.map(claim => claim.id);
        if (checked_claims.length !== expected.length || new Set(checked_claims).size !== expected.length || expected.some(id => !checked_claims.includes(id))) return semanticInvalid('consistency_claim_coverage', true, [`${rowPath}.checked_claims`], [{ path: `${rowPath}.checked_claims`, rule: 'exact_items', observed_count: checked_claims.length, minimum: expected.length, maximum: expected.length, allowed_values: expected }]);
        const findings = listField(row.findings, expected.length, `${rowPath}.findings`).map((item, findingIndex) => {
          const findingPath = `${rowPath}.findings[${findingIndex}]`, finding = strictObject(item, ['claim_id', 'status', 'replacement', 'reason', 'evidence_ids'], [], findingPath);
          const claim = context.claims.find(claim => claim.id === finding.claim_id);
          if (!claim) return semanticInvalid('consistency_finding', true, [`${findingPath}.claim_id`], [{ path: `${findingPath}.claim_id`, rule: 'enum', allowed_values: expected }]);
          if (typeof finding.status !== 'string' || !['corrected', 'uncertain'].includes(finding.status)) return semanticInvalid('consistency_finding', true, [`${findingPath}.status`], [{ path: `${findingPath}.status`, rule: 'enum', allowed_values: ['corrected', 'uncertain'] }]);
          if (typeof finding.replacement !== 'string') return semanticInvalid('schema', true, [`${findingPath}.replacement`], [{ path: `${findingPath}.replacement`, rule: 'type', expected: 'string', observed_type: typeof finding.replacement }]);
          const idsPath = `${findingPath}.evidence_ids`, rawIds = listField(finding.evidence_ids, 20, idsPath), allowedIds = wire.evidence_catalog.map(entry => entry.id);
          if (!rawIds.length || rawIds.some(id => typeof id !== 'string' || !allowedIds.includes(id))) return semanticInvalid('consistency_evidence_catalog', true, [idsPath], [{ path: idsPath, rule: 'enum', allowed_values: allowedIds }, { path: idsPath, rule: 'min_items', observed_count: rawIds.length, minimum: 1 }]);
          if (new Set(rawIds).size !== rawIds.length) return semanticInvalid('consistency_evidence_catalog', true, [idsPath], [{ path: idsPath, rule: 'unique_items', allowed_values: allowedIds }]);
          const evidence_ids = rawIds as string[], evidence = evidence_ids.map(id => { const entry = requireSemanticValue(wire.evidence_catalog.find(entry => entry.id === id)); return { path: entry.path, line_start: entry.line_start, line_end: entry.line_end }; });
          const replacement = finding.status === 'corrected' ? textField(finding.replacement, claim.id === 'summary' ? 1200 : 800, `${findingPath}.replacement`) : '';
          const reason = textField(finding.reason, 600, `${findingPath}.reason`);
          const requiresDefinition = highRisk.test(claim.text) || context.resolved_dependencies.length > 0 || evidence.some(item => item.path !== context.path);
          if (finding.status === 'corrected' && requiresDefinition && !evidence_ids.some(id => wire.complete_callee_definition_ids.includes(id))) {
            return { claim_id: claim.id, status: 'uncertain' as const, replacement: '', reason: '宿主未采用纠正建议：当前页所引证据未包含实际提供的完整被调用定义；原断言保留待确认，原建议与合法引用已保留于私有审计。', evidence,
              host_reason: 'missing_complete_callee_definition' as const, original_proposal: { status: 'corrected' as const, replacement, reason, evidence_ids, evidence } };
          }
          return { claim_id: claim.id, status: finding.status as Finding['status'], replacement, reason, evidence };
        });
        if (new Set(findings.map(finding => finding.claim_id)).size !== findings.length) return semanticInvalid('consistency_duplicate_claim', true, [`${rowPath}.findings`], [{ path: `${rowPath}.findings`, rule: 'unique_items', allowed_values: expected }]);
        return { path: context.path, input_sha256: context.input_sha256, checked_claims, findings, unresolved_dependencies: stringsField(row.unresolved_dependencies, 12, `${rowPath}.unresolved_dependencies`) };
      });
    } };
    // Preserve the original 1.3 request byte-for-byte for strict, read-only cache lookup.
    const previous = options.client.cacheRequest(request);
    if (previous) return previous.value;
    const concrete = { ...request, input: { ...request.input,
      coverage_protocol: 'concrete-context-coverage-1.0.0',
      coverage_constraints: { exact_count: files.length, allowed_context_ids: allowedContexts, checked_claims: files.map(file => ({ context_id: file.context_id, exact_count: file.claims.length, allowed_claim_ids: file.claims.map(claim => claim.id) })) },
      output_shape: { files: files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: [], unresolved_dependencies: [] })) },
      coverage_instruction: 'output_shape已逐一列出本请求全部实际context_id及各自完整checked_claims。必须保留每一项，files数量严格等于exact_count；即使path相同也不能合并。逐项独立核对所有claim，再填写有依据的findings或当前不能核对的unresolved_dependencies，不要机械照抄空findings跳过核验。不要增加、删除或改写身份和claim ID。',
    } };
    const previousConcrete = options.client.cacheRequest(concrete);
    if (previousConcrete) return previousConcrete.value;
    const complete = { ...concrete, input: { ...concrete.input,
      coverage_protocol: 'concrete-context-coverage-1.1.0',
      finding_item_schema: { type: 'object', additionalProperties: false, required: ['claim_id', 'status', 'replacement', 'reason', 'evidence_ids'],
        properties: {
          claim_id: { type: 'string', enum: [...new Set(files.flatMap(file => file.claims.map(claim => claim.id)))] },
          status: { type: 'string', enum: ['corrected', 'uncertain'] }, replacement: { type: 'string', maxLength: 1200 },
          reason: { type: 'string', minLength: 1, maxLength: 600 },
          evidence_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string' } },
        },
        allOf: [
          { if: { properties: { claim_id: { const: 'summary' } }, required: ['claim_id'] }, then: { properties: { replacement: { maxLength: 1200 } } }, else: { properties: { replacement: { maxLength: 800 } } } },
          { if: { properties: { status: { const: 'uncertain' } }, required: ['status'] }, then: { properties: { replacement: { const: '' } } }, else: { properties: { replacement: { minLength: 1 } } } },
        ],
      },
      finding_context_constraints: files.map(file => ({ context_id: file.context_id, max_findings: file.claims.length, unique_claim_ids: true, allowed_claim_ids: file.claims.map(claim => claim.id), allowed_evidence_ids: file.evidence_catalog.map(entry => entry.id), complete_callee_definition_ids: file.complete_callee_definition_ids })),
      finding_contract_instruction: 'output_shape中的findings空数组只是待填写的位置，finding_item_schema定义每一条实际finding的完整结构。每条必须且只能包含claim_id、status、replacement、reason、evidence_ids五个字段；不得返回host_reason、original_proposal或其他字段。严格采用当前context对应finding_context_constraints允许的claim和证据ID，不可借用同批其他context的目录。每个claim最多一条finding；reason及corrected replacement必须有非空内容，uncertain replacement必须为空字符串。',
    } };
    try { return (await options.client.call(complete)).value; }
    catch (error) {
      const producerReasons = ['consistency_coverage', 'consistency_claim_coverage', 'consistency_identity', 'output_json', 'schema', 'output_truncated'];
      if (!(error instanceof DomainError) || error.code !== 'code_analysis_model_invalid' || !producerReasons.includes(String(error.details?.reason)) || files.length <= 1) throw error;
      const middle = Math.floor(files.length / 2), children = [files.slice(0, middle), files.slice(middle)];
      const split = { group: index, reason: String(error.details?.reason), context_ids: allowedContexts, children: children.map(child => child.map(file => file.context_id)), host_bindings: request.cacheIdentity };
      splits.push(split); writeSemanticJson(path.join(options.runDirectory, `semantic-consistency-split-${semanticDigest(split).slice(0, 24)}.json`), split);
      // Await children in order inside this existing worker slot; never multiply concurrency.
      const left = await executeGroup(requireSemanticValue(children[0]), index), right = await executeGroup(requireSemanticValue(children[1]), index), combined = [...left, ...right];
      const expected = files.map(file => requireSemanticValue(bindings.get(file.context_id)).input_sha256), actual = combined.map(check => check.input_sha256);
      if (actual.length !== expected.length || new Set(actual).size !== expected.length || expected.some(identity => !actual.includes(identity))) return semanticInvalid('consistency_file_coverage', false);
      return combined;
    }
  }
  const responses: Checked[] = (await options.parallel(groups, async (files, index) => {
    const result = await executeGroup(files, index); await options.onProgress(++finished, groups.length); return result;
  })).flat();
  let corrected = 0, uncertain = 0;
  const reconciled = options.briefs.map(original => {
    const checks = responses.filter(check => check.path === original.path), brief: FileBrief = JSON.parse(JSON.stringify(original));
    if (!checks.length) return semanticInvalid('consistency_file_coverage', false);
    const auditReference = semanticDigest({ verification_version: VERIFICATION_VERSION, path: original.path, checks });
    const notes = new Map<string, { accepted: boolean; claims: Set<string>; reasons: Set<string>; findings: number }>();
    for (const claim of claimsOf(original)) {
      const findings = checks.flatMap(check => check.findings).filter(finding => finding.claim_id === claim.id);
      if (!findings.length) continue;
      const corrections = findings.filter(finding => finding.status === 'corrected');
      const unique = [...new Map(corrections.map(finding => [finding.replacement, finding])).values()];
      const accepted = unique.length === 1 && findings.every(finding => finding.status === 'corrected') ? unique[0] : undefined;
      const replacement = accepted ? accepted.replacement : `待确认：${claim.text}（跨文件依据尚未一致）`;
      if (accepted) corrected++; else uncertain++;
      if (claim.id === 'summary') brief.summary = replacement;
      else if (claim.id === 'responsibility') brief.responsibility = replacement;
      else {
        const [kind, offset] = claim.id.split(':'), index = Number(offset);
        if (kind === 'behavior') requireSemanticValue(brief.behaviors[index]).description = replacement;
        else if (kind === 'dependency') { const dependency = requireSemanticValue(brief.dependencies[index]); dependency.description = replacement; if (!accepted) dependency.status = 'unknown'; }
        else if (kind === 'state') brief.state_owners[index] = replacement;
        else if (kind === 'purpose') brief.user_purposes[index] = replacement;
      }
      const support = semanticEvidenceUnion(...findings.map(finding => finding.evidence));
      brief.evidence = semanticEvidenceUnion(brief.evidence, support);
      if (claim.id.startsWith('behavior:')) { const behavior = requireSemanticValue(brief.behaviors[Number(claim.id.split(':')[1])]); behavior.evidence = semanticEvidenceUnion(behavior.evidence, support); }
      const category = claim.id.split(':')[0] ?? claim.id, noteKey = `${accepted ? 'corrected' : 'uncertain'}:${category}`;
      const note = notes.get(noteKey) ?? { accepted: Boolean(accepted), claims: new Set<string>(), reasons: new Set<string>(), findings: 0 };
      note.claims.add(claim.id); note.findings += findings.length;
      for (const finding of findings) note.reasons.add(`${finding.status === 'corrected' ? accepted ? '已采纳纠正' : '未采纳纠正建议' : '待确认'}：${finding.reason}`);
      if (!accepted && unique.length > 1) note.reasons.add('同一断言跨页出现不同纠正文本，未选择其中任意一份作为结论。');
      if (!accepted && findings.some(finding => finding.status === 'uncertain') && corrections.length) note.reasons.add('同一断言同时存在纠正建议和未确认意见，保留待确认。');
      notes.set(noteKey, note);
    }
    const publicNotes = [...notes.values()].map(note => {
      const reasons = [...note.reasons], examples = reasons.slice(0, 2);
      return `${note.accepted ? '已修正的跨文件源码解释（仍是推断）' : '跨文件待确认'}：${[...note.claims].join('、')}，${note.findings}条审查意见/${reasons.length}项不同理由。${examples.join('；')}${reasons.length > examples.length ? `；另${reasons.length - examples.length}项理由完整保留于审计` : ''}。一致性审计引用：${auditReference}。`;
    });
    const unresolved = [...new Set(checks.flatMap(check => check.unresolved_dependencies))];
    if (unresolved.length) {
      const examples = unresolved.slice(0, 2);
      publicNotes.push(`跨文件依赖待确认共${unresolved.length}项：${examples.join('；')}${unresolved.length > examples.length ? `；另${unresolved.length - examples.length}项完整保留于审计` : ''}。一致性审计引用：${auditReference}。`);
    }
    // There are at most six claim categories × two outcomes, plus one dependency note.
    // Keep every original unknown, and make any summarized reasons/counts auditable.
    brief.unknowns = [...new Set([...brief.unknowns, ...publicNotes])];
    if (brief.unknowns.length > 40 || brief.unknowns.some(note => note.length > 4000)) return semanticInvalid('consistency_public_budget', false);
    brief.input_sha256 = semanticDigest({ original: original.input_sha256, verification_version: VERIFICATION_VERSION, checks });
    return brief;
  });
  const audit = { verification_version: VERIFICATION_VERSION, coverage_protocol: 'concrete-context-coverage-1.1.0', producer_splits: splits.length, splits, snapshot_id: options.snapshot.snapshot_id, files_checked: reconciled.length, contexts_checked: contexts.length, claims_checked: responses.reduce((sum, check) => sum + check.checked_claims.length, 0), corrected_claims: corrected, applied_corrected_claims: corrected, uncertain_claims: uncertain, host_downgraded_findings: responses.flatMap(check => check.findings).filter(finding => finding.host_reason === 'missing_complete_callee_definition').length, checks: responses, brief_changes: options.briefs.map((original, index) => ({ path: original.path, before_sha256: semanticDigest(original), after_sha256: semanticDigest(reconciled[index]) })) };
  writeSemanticJson(path.join(options.runDirectory, 'semantic-consistency.json'), audit);
  return { briefs: reconciled, audit };
}
