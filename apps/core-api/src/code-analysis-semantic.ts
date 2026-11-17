import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CodeArtifact, CodeSnapshot } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { createSemanticModelClient, writeSemanticJson, type SemanticModelConfiguration, type SemanticModelProvenance } from './code-analysis-semantic-model.js';
import { budgetGroups, nativeFileDependencies, synthesizeSemanticArchitecture } from './code-analysis-semantic-architecture.js';
import { reconcileSemanticBriefs } from './code-analysis-semantic-consistency.js';
import { createSemanticEvidenceCatalog, FILE_REDUCE_OUTPUT_SCHEMA, objectRecord, requireSemanticValue, planSemanticSource, semanticDigest, semanticInvalid, SEMANTIC_PROMPT_VERSION, stopSemantic, validateReducedFileBrief, validateSegmentFacts, type FileBrief, type SegmentFact, type SemanticProgress, type SemanticQuality } from './code-analysis-semantic-source.js';

export type { SemanticProgress, SemanticQuality } from './code-analysis-semantic-source.js';
export { SEMANTIC_PROMPT_VERSION } from './code-analysis-semantic-source.js';
const segmentShape = { segment_id: '精确输入ID', input_sha256: '精确输入hash', summary: '本段真实职责与重要规则，最多约300字', responsibility: '本段在文件和系统中的作用', behaviors: [{ description: '具体正常或拒绝条件、角色权限、状态变化、输入输出与上下游影响；测试仅说明测试定义', evidence: [{ path: '精确输入路径', line_start: 1, line_end: 2 }] }], state_owners: ['本段拥有或修改的状态事实'], user_purposes: ['服务的用户目的'], dependencies: [{ target: '源码提到的依赖路径或外部名字', type: 'imports/calls/reads_from/writes_to/tested_by等', description: '依据与影响，不明确则标unknown', status: 'observed/inferred/unknown三者之一', evidence: [{ path: '精确输入路径', line_start: 1, line_end: 2 }] }], evidence: [{ path: '精确输入路径', line_start: 1, line_end: 2 }], unknowns: ['本段不能确认的问题；不能把未执行测试写成已通过'] };
export function semanticSegmentRequest(repository: string, commit: string, segments: unknown[]) {
  return { task: 'UA Phase2完整文件分析：逐字阅读每个text（均为固定源码完整连续分段），对每个segment恰好返回一条事实；ID与input_sha256必须逐字回显，不能漏掉困难输入。总结真实职责、关键正常/拒绝规则、状态所有者、用户目的和有证据的依赖。每个segment最多6条核心behavior和8条dependency，简明但保留关键约束。证据必须在当前segment的行范围内；大单行已按UTF8字节拆分，不能猜测未提供部分。超出本段的关系或文档期望均标unknown。输出顶层仅segments，不要代码或额外包装。', output_shape: { segments: [segmentShape] }, repository, commit, segments };
}
export function semanticFileReduceRequest(filePath: string, inputSha256: string, facts: (SegmentFact | FileBrief)[], catalog = createSemanticEvidenceCatalog(facts)) {
  return { reduce_protocol: 'file-evidence-catalog-1.1.0', task: 'UA文件归并：这些事实是同一固定文件各连续分段的解释，所有输入都必须合并考虑。产出一致职责、关键正常/拒绝/权限/状态规则、依赖与未知。禁止按首段代替全文件。证据只能返回evidence_catalog中的精确ID，不能自己写path/行号，不能把相邻或不相邻范围造为一个新范围；需要多处证据就列多个ID。每条行为和依赖均须选择相应原事实实际使用的证据ID，不能因已读完整文件就将任意范围当支持。输出严格为output_shape和output_schema：summary最多1200字符，responsibility最多800；behaviors最多20条、description最多800；dependencies最多24条、target最多500、type最多80、description最多500，status只能是observed/inferred/unknown。state_owners、user_purposes、unknowns各最多20个字符串，每个最多800字符。每处evidence_ids最多20个不重复精确ID，行为/依赖各至少1个，非空文件的顶层至少1个。顶层evidence_ids只支持summary和responsibility，不是全文件所有证据ID的并集；行为和依赖的其他依据保留在各自evidence_ids内。所有文本必须非空，长度按UTF-16代码单元计；合并重复内容保留关键约束和未知，不要机械拼接导致超限。各对象只允许schema列出的字段，path/input_sha256逐字回显。仅返回合法JSON：字符串内引号/换行须正确转义，数组元素之间必须逗号分隔，禁止注释、尾逗号、undefined和Markdown。', output_schema: FILE_REDUCE_OUTPUT_SCHEMA, output_shape: { path: filePath, input_sha256: inputSha256, summary: '全文件语义摘要', responsibility: '系统中的职责', behaviors: [{ description: '有依据的关键行为或拒绝规则', evidence_ids: ['E001'] }], state_owners: [], user_purposes: [], dependencies: [{ target: '依赖目标', type: '依赖类型', description: '实际依赖与限制', status: 'inferred', evidence_ids: ['E001'] }], evidence_ids: ['E001'], unknowns: [] }, path: filePath, input_sha256: inputSha256, evidence_catalog: catalog.entries, facts: catalog.facts };
}

export async function generateHostedUaGraph(input: { snapshot: CodeSnapshot; sourceDirectory: string; runDirectory: string; repositoryName: string; config: SemanticModelConfiguration; signal?: AbortSignal; fetchImpl?: typeof fetch; cacheDirectory?: string; engineIdentity?: string; onProgress?: (progress: SemanticProgress) => Promise<void> | void }) {
  const controller = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const concurrency = input.config.concurrency ?? 3;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) return semanticInvalid('concurrency_configuration', false);
  const plan = planSemanticSource(input.snapshot, input.sourceDirectory);
  writeSemanticJson(path.join(input.runDirectory, 'semantic-source-plan.json'), { ...plan, segments: plan.segments.map(({ text: _text, ...segment }) => segment), batches: plan.batches.map(batch => batch.map(segment => segment.id)) });
  const native = JSON.parse(readFileSync(path.join(input.runDirectory, 'codegraph-projection.json'), 'utf8')) as Pick<CodeArtifact, 'nodes' | 'edges'>;
  const uaImports = JSON.parse(readFileSync(path.join(input.runDirectory, 'ua-import-map.json'), 'utf8')) as { importMap?: unknown };
  const dependencyMap = objectRecord(uaImports.importMap) ? uaImports.importMap : {};
  const dependencies = nativeFileDependencies(input.snapshot, native, dependencyMap);
  const sourceCopies = input.snapshot.files.filter(file => file.byte_count >= 16 && file.byte_count < 16_000).map(file => readFileSync(path.join(input.sourceDirectory, file.path), 'utf8').trim()).filter(text => text.length >= 16);
  function sourceSafety(value: unknown): void {
    if (typeof value === 'string') { if (sourceCopies.some(source => value.includes(source))) semanticInvalid('complete_source_in_explanation'); }
    else if (Array.isArray(value)) value.forEach(sourceSafety);
    else if (objectRecord(value)) Object.values(value).forEach(sourceSafety);
  }
  const client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: input.engineIdentity ?? semanticDigest({ native, imports: dependencyMap }), runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory, signal, fetchImpl: input.fetchImpl, validateOutputSafety: sourceSafety });
  let cachedSegments = 0;
  const facts = new Map<string, SegmentFact>();
  const completedFiles = () => input.snapshot.files.filter(file => plan.segments.filter(segment => segment.path === file.path).every(segment => facts.has(segment.id))).length;
  async function progress(phase: SemanticProgress['phase'], completed: number, total: number) {
    stopSemantic(signal);
    await input.onProgress?.({ phase, completed, total, completed_segments: facts.size, total_segments: plan.segments.length, cached_segments: cachedSegments, completed_files: completedFiles(), total_files: plan.total_files });
  }
  async function parallel<T, R>(items: T[], action: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const output: R[] = new Array(items.length); let next = 0, failure: unknown;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !failure) {
        const index = next++;
        try { stopSemantic(signal); output[index] = await action(requireSemanticValue(items[index]), index); }
        catch (error) { failure ??= error; controller.abort(); }
      }
    });
    // Never leave paid requests or checkpoint writes running after a failed sibling.
    await Promise.allSettled(workers);
    if (failure) throw failure;
    return output;
  }
  const segmentTasks = new Map(plan.segments.map(segment => {
    const hints = native.nodes.filter(node => node.path === segment.path && (node.line_end ?? 0) >= segment.line_start && (node.line_start ?? Infinity) <= segment.line_end).map(node => ({ name: node.label, kind: node.kind, line_start: node.line_start, line_end: node.line_end }));
    return [segment.id, { phase: 'segment', input: { segment, native_symbols: hints, imports: dependencyMap[segment.path] ?? [] } }];
  }));
  await progress('files', 0, plan.segments.length);
  for (const segment of plan.segments) {
    const task = requireSemanticValue(segmentTasks.get(segment.id));
    const cached = client.cache(task, value => requireSemanticValue(validateSegmentFacts({ segments: [value] }, [segment])[0]));
    if (cached) { facts.set(segment.id, cached.value); cachedSegments++; }
  }
  await progress('files', facts.size, plan.segments.length);
  const pending = plan.batches.map(batch => batch.filter(segment => !facts.has(segment.id))).filter(batch => batch.length);
  let sourcePartitions = 0;
  async function analyzeSourceBatch(segments: typeof plan.segments, name: string): Promise<void> {
    const segmentsInput = segments.map(segment => requireSemanticValue(segmentTasks.get(segment.id)).input);
    let response: Awaited<ReturnType<typeof client.call<SegmentFact[]>>>;
    try { response = await client.call({ phase: 'files', name, useCache: false, input: semanticSegmentRequest(input.repositoryName, input.snapshot.commit, segmentsInput), validate: value => validateSegmentFacts(value, segments) }); }
    catch (error) {
      // The truncated body is never parsed, repaired or cached. Retry the same complete
      // source segments in smaller groups, preserving their trusted byte identities.
      if (!(error instanceof DomainError) || error.details?.reason !== 'output_truncated' || segments.length < 2) throw error;
      const middle = Math.ceil(segments.length / 2), children = [segments.slice(0, middle), segments.slice(middle)];
      sourcePartitions++;
      writeSemanticJson(path.join(input.runDirectory, `semantic-source-partition-${semanticDigest(segments.map(segment => segment.id)).slice(0, 24)}.json`), { reason: 'output_truncated', accepted: false, parent_segments: segments.map(segment => segment.id), children: children.map(group => group.map(segment => segment.id)) });
      // Sequential recursion keeps total provider concurrency bounded by the outer pool.
      await analyzeSourceBatch(children[0] ?? [], `${name}-left`);
      await analyzeSourceBatch(children[1] ?? [], `${name}-right`);
      return;
    }
    for (const fact of response.value) { facts.set(fact.segment_id, fact); client.save(requireSemanticValue(segmentTasks.get(fact.segment_id)), fact, response.model, response.originModel); }
    writeSemanticJson(path.join(input.runDirectory, `semantic-file-batch-${name}.json`), response.value);
    await progress('files', facts.size, plan.segments.length);
  }
  await parallel(pending, (segments, index) => analyzeSourceBatch(segments, `source-${index + 1}`));
  if (facts.size !== plan.segments.length) return semanticInvalid('full_source_coverage', false);
  const fileInputs = input.snapshot.files.map(file => ({ file, facts: plan.segments.filter(segment => segment.path === file.path).map(segment => requireSemanticValue(facts.get(segment.id))) }));
  await progress('reduce', 0, fileInputs.length); let reducedFiles = 0;
  const rawBriefs = await parallel(fileInputs, async ({ file, facts: sourceFacts }) => {
    const input_sha256 = semanticDigest({ path: file.path, sha256: file.sha256, facts: sourceFacts });
    const segment_ids = sourceFacts.map(fact => fact.segment_id);
    let brief: FileBrief;
    if (sourceFacts.length === 1) {
      const fact = requireSemanticValue(sourceFacts[0]);
      brief = { ...fact, path: file.path, sha256: file.sha256, input_sha256, segment_ids };
    } else {
      let parts: (SegmentFact | FileBrief)[] = sourceFacts;
      for (let depth = 0; ; depth++) {
        if (depth > 6) return semanticInvalid('file_reduce_budget', false);
        const groups = budgetGroups(parts, 65_000, 12);
        const reduced: FileBrief[] = [];
        for (const [index, group] of groups.entries()) {
          const catalog = createSemanticEvidenceCatalog(group);
          const response = await client.call({ phase: 'reduce', name: `${semanticDigest(file.path).slice(0, 16)}-${depth}-${index}`, input: semanticFileReduceRequest(file.path, input_sha256, group, catalog), validate: value => validateReducedFileBrief(value, { file, input_sha256, segment_ids }, catalog) });
          reduced.push(response.value);
        }
        if (reduced.length === 1) { brief = requireSemanticValue(reduced[0]); break; }
        parts = reduced;
      }
    }
    await progress('reduce', ++reducedFiles, fileInputs.length); return brief;
  });
  writeSemanticJson(path.join(input.runDirectory, 'semantic-file-briefs.raw.json'), rawBriefs);
  const consistency = await reconcileSemanticBriefs({ snapshot: input.snapshot, sourceDirectory: input.sourceDirectory, runDirectory: input.runDirectory, briefs: rawBriefs, dependencies, native, client, parallel, onProgress: (completed, total) => progress('consistency', completed, total) });
  const briefs = consistency.briefs;
  writeSemanticJson(path.join(input.runDirectory, 'semantic-file-briefs.json'), briefs);
  const synthesized = await synthesizeSemanticArchitecture({ snapshot: input.snapshot, briefs, dependencies, repositoryName: input.repositoryName, runDirectory: input.runDirectory, uncertaintyAudit: consistency.audit, grounding: { sourceDirectory: input.sourceDirectory, native }, client, parallel, onPhase: progress });
  const file_coverage = input.snapshot.files.map(file => {
    const segments = plan.segments.filter(segment => segment.path === file.path).map(segment => ({ id: segment.id, byte_start: segment.byte_start, byte_end: segment.byte_end, input_sha256: segment.input_sha256, completed: facts.has(segment.id), line_start: segment.line_start, line_end: segment.line_end }));
    return { path: file.path, sha256: file.sha256, total_bytes: file.byte_count, covered_bytes: segments.filter(segment => segment.completed).reduce((sum, segment) => sum + segment.byte_end - segment.byte_start, 0), segments };
  });
  const metrics = client.metrics();
  const quality: SemanticQuality & { model_provenance: SemanticModelProvenance; overview_limitations: string[] } = {
    overview_limitations: synthesized.limitations,
    model_provenance: metrics.provenance,
    protocol_version: 2, snapshot_id: input.snapshot.snapshot_id, manifest_sha256: input.snapshot.manifest_sha256, prompt_version: SEMANTIC_PROMPT_VERSION,
    full_source_coverage: true, total_files: plan.total_files, total_segments: plan.segments.length, completed_segments: facts.size, total_bytes: plan.total_bytes, covered_bytes: file_coverage.reduce((sum, file) => sum + file.covered_bytes, 0), file_coverage,
    node_evidence: synthesized.node_evidence, relation_evidence: synthesized.relation_evidence,
    unresolved: [...briefs.flatMap(brief => brief.unknowns.map(description => ({ scope: `file:${brief.path}`, description }))), ...synthesized.unknowns.map(description => ({ scope: 'system', description })), ...synthesized.review.unknowns.map(description => ({ scope: 'review', description })), ...synthesized.groundingUnknowns, ...synthesized.review.findings.map(finding => ({ scope: finding.scope, description: `审查待确认：${finding.description}` })), ...input.snapshot.files.filter(file => !file.byte_count).map(file => ({ scope: `file:${file.path}`, description: 'observed-empty：文件为空，无可声明的源码行或执行行为。' }))],
    statistics: { ...synthesized.statistics, full_file_briefs: briefs.length, model_calls: metrics.calls, cache_hits: metrics.cacheHits, source_batches: plan.batches.length, source_partitions: sourcePartitions, consistency_files: consistency.audit.files_checked, consistency_claims: consistency.audit.claims_checked, consistency_corrected_claims: consistency.audit.corrected_claims, consistency_applied_corrected_claims: consistency.audit.applied_corrected_claims, consistency_host_downgraded_findings: consistency.audit.host_downgraded_findings, consistency_uncertain_claims: consistency.audit.uncertain_claims, native_indexed_nodes: native.nodes.length, native_indexed_edges: native.edges.length },
    phases: ['UA Phase2 complete segment analysis', 'complete-file semantic reduction', 'cross-file claims and callee-definition reconciliation', 'UA Phase4 global architecture and ownership', 'Scoped architecture claims, operation retrieval and complete-source grounding', 'UA Phase5 global tour', 'UA Phase6 graph review'], review: synthesized.review, semantic_correctness: 'requires_independent_evaluation', model_audits: metrics.audits, cache_hits: metrics.cacheHits, file_ownership: synthesized.ownership,
  };
  writeSemanticJson(path.join(input.runDirectory, 'semantic-quality.json'), quality);
  writeSemanticJson(path.join(input.runDirectory, 'semantic-graph.json'), synthesized.graph);
  return { graph: synthesized.graph, models: metrics.models, modelProvenance: metrics.provenance, selectedFiles: input.snapshot.files.map(file => file.path), quality, plan };
}
