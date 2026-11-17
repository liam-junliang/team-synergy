// Opt-in offline audit. Stored evidence can establish identity/coverage, never model comprehension.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, inspectGraph } from './code-analysis-quality.mjs';

const hashJson = value => digest(JSON.stringify(value));
const hostDowngradeReason = '宿主未采用纠正建议：当前页所引证据未包含实际提供的完整被调用定义；原断言保留待确认，原建议与合法引用已保留于私有审计。';
const exactKeys = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const boundedText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const edgeKey = edge => `${edge.source}\0${edge.target}\0${edge.type}`;
const claimIds = brief => ['summary', 'responsibility', ...(brief.behaviors ?? []).map((_, i) => `behavior:${i}`), ...(brief.dependencies ?? []).map((_, i) => `dependency:${i}`), ...(brief.state_owners ?? []).map((_, i) => `state:${i}`), ...(brief.user_purposes ?? []).map((_, i) => `purpose:${i}`)];
const claimText = (brief, id) => {
  if (id === 'summary' || id === 'responsibility') return brief[id];
  const [kind, index] = id.split(':'), offset = Number(index);
  return kind === 'behavior' ? brief.behaviors?.[offset]?.description : kind === 'dependency' ? brief.dependencies?.[offset]?.description : kind === 'state' ? brief.state_owners?.[offset] : brief.user_purposes?.[offset];
};
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const publicText = node => strings({ name: node.name, summary: node.summary, domainMeta: node.domainMeta, languageNotes: node.languageNotes, tags: node.tags }).join('\n');

/** Input is explicit so a stored report cannot silently substitute a different public graph. */
export function auditQuality({ artifact, report, consistency, snapshot, source, plan, facts, rawBriefs, briefs }) {
  const graph = artifact.ua_graph ?? artifact;
  assert(Array.isArray(graph.nodes) && Array.isArray(graph.edges), 'Artifact must contain ua_graph or be a UA graph');
  const checks = [], add = (id, issues, evidence = {}, available = true) => checks.push({ id, status: issues.length ? 'fail' : available ? 'pass' : 'unverified', issues, evidence });
  const manifest = new Map(snapshot.files.map(file => [file.path, file]));
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const paths = new Map(graph.nodes.filter(node => node.type === 'file').map(node => [node.filePath, node]));
  const text = graph.nodes.map(publicText).join('\n');
  const validRef = ref => {
    const file = manifest.get(ref?.path);
    return !!file && Number.isSafeInteger(ref.line_start) && Number.isSafeInteger(ref.line_end) && ref.line_start >= 1 && ref.line_end >= ref.line_start && ref.line_end <= file.line_count;
  };
  const mechanical = inspectGraph(graph, snapshot);
  const identities = [];
  if (!mechanical.commit_matches) identities.push('graph_commit_mismatch');
  if (artifact.ua_graph && artifact.snapshot_id !== snapshot.snapshot_id) identities.push('artifact_snapshot_mismatch');
  if (!report || report.snapshot_id !== snapshot.snapshot_id || report.manifest_sha256 !== snapshot.manifest_sha256) identities.push('report_source_identity_missing_or_mismatched');
  if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) identities.push('duplicate_node_ids');
  add('artifact_identity', identities, { graph_sha256: hashJson(graph), artifact_sha256: hashJson(artifact), report_sha256: report && hashJson(report), snapshot_id: snapshot.snapshot_id });
  add('published_file_coverage', [...mechanical.omitted_files.map(p => `missing:${p}`), ...mechanical.duplicate_file_paths.map(p => `duplicate:${p}`), ...mechanical.source_issues.map(i => `${i.reason}:${i.id}`), ...mechanical.dangling_edges.map(e => `dangling:${edgeKey(e)}`)], { represented: mechanical.unique_files, manifest: snapshot.files.length, note: 'File nodes are not proof that source bytes reached a model.' });

  const sourceBytes = new Map(), sourceIssues = [];
  if (source) for (const file of snapshot.files) {
    try {
      assert(file.path && !file.path.includes('\\') && !file.path.split('/').includes('..') && !path.isAbsolute(file.path));
      const target = path.resolve(source, file.path), relative = path.relative(path.resolve(source), target);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const bytes = readFileSync(target);
      if (bytes.length !== file.byte_count || digest(bytes) !== file.sha256) sourceIssues.push(`changed:${file.path}`);
      else sourceBytes.set(file.path, bytes);
    } catch { sourceIssues.push(`unreadable_or_unsafe:${file.path}`); }
  }
  add('fixed_source_bytes', sourceIssues, { independently_hashed_files: sourceBytes.size, manifest_files: snapshot.files.length }, !!source);

  const coverageIssues = [], segmentMap = new Map(), segmentFacts = new Map();
  for (const fact of facts ?? []) {
    const rows = segmentFacts.get(fact.segment_id) ?? []; rows.push(fact); segmentFacts.set(fact.segment_id, rows);
  }
  if (plan) {
    if (plan.snapshot_id !== snapshot.snapshot_id || plan.manifest_sha256 !== snapshot.manifest_sha256) coverageIssues.push('plan_source_identity_mismatch');
    for (const segment of plan.segments) {
      if (segmentMap.has(segment.id)) coverageIssues.push(`duplicate_segment:${segment.id}`);
      segmentMap.set(segment.id, segment);
      const file = manifest.get(segment.path), bytes = sourceBytes.get(segment.path);
      if (!file || file.sha256 !== segment.file_sha256) coverageIssues.push(`segment_source_mismatch:${segment.id}`);
      if (!Number.isSafeInteger(segment.byte_start) || !Number.isSafeInteger(segment.byte_end) || segment.byte_start < 0 || segment.byte_end < segment.byte_start || segment.byte_end > (file?.byte_count ?? -1)) coverageIssues.push(`invalid_byte_range:${segment.id}`);
      if (bytes) {
        const content = bytes.subarray(segment.byte_start, segment.byte_end);
        const lineStart = bytes.length ? 1 + bytes.subarray(0, segment.byte_start).filter(byte => byte === 10).length : 0;
        const lineEnd = lineStart + content.filter(byte => byte === 10).length;
        const identity = { path: segment.path, file_sha256: file.sha256, byte_start: segment.byte_start, byte_end: segment.byte_end, line_start: lineStart, line_end: lineEnd, content_sha256: digest(content) };
        if (segment.content_sha256 !== identity.content_sha256 || segment.input_sha256 !== hashJson(identity) || segment.id !== `segment:${segment.input_sha256.slice(0, 32)}` || segment.line_start !== lineStart || segment.line_end !== lineEnd) coverageIssues.push(`segment_input_identity_mismatch:${segment.id}`);
      }
      if (facts) {
        const accepted = segmentFacts.get(segment.id) ?? [];
        if (!accepted.length || accepted.some(f => f.input_sha256 !== segment.input_sha256)) coverageIssues.push(`missing_or_mismatched_fact:${segment.id}`);
        if (new Set(accepted.map(hashJson)).size > 1) coverageIssues.push(`conflicting_duplicate_facts:${segment.id}`);
      }
    }
    for (const file of snapshot.files) {
      const pieces = plan.segments.filter(s => s.path === file.path).sort((a, b) => a.byte_start - b.byte_start);
      let offset = 0;
      if (!pieces.length) coverageIssues.push(`unplanned:${file.path}`);
      for (const piece of pieces) { if (piece.byte_start !== offset) coverageIssues.push(`byte_gap_or_overlap:${file.path}:${offset}`); offset = piece.byte_end; }
      if (offset !== file.byte_count) coverageIssues.push(`incomplete_bytes:${file.path}`);
    }
    for (const id of segmentFacts.keys()) if (!segmentMap.has(id)) coverageIssues.push(`unknown_fact:${id}`);
    const batchedIds = (plan.batches ?? []).flat();
    if (batchedIds.length !== segmentMap.size || new Set(batchedIds).size !== segmentMap.size || batchedIds.some(id => !segmentMap.has(id))) coverageIssues.push('source_batch_segment_identity_mismatch');
    const reported = new Map((report?.file_coverage ?? []).map(row => [row.path, row]));
    if (reported.size !== snapshot.files.length || (report?.file_coverage ?? []).length !== snapshot.files.length) coverageIssues.push('report_file_coverage_count_mismatch');
    for (const file of snapshot.files) {
      const row = reported.get(file.path), pieces = plan.segments.filter(s => s.path === file.path);
      if (!row || row.sha256 !== file.sha256 || row.total_bytes !== file.byte_count || row.covered_bytes !== file.byte_count || row.segments.length !== pieces.length) { coverageIssues.push(`reported_file_mismatch:${file.path}`); continue; }
      for (const piece of pieces) {
        const declared = row.segments.filter(s => s.id === piece.id);
        if (declared.length !== 1 || !declared[0].completed || ['byte_start', 'byte_end', 'input_sha256', 'line_start', 'line_end'].some(k => declared[0][k] !== piece[k])) coverageIssues.push(`reported_segment_mismatch:${piece.id}`);
      }
    }
    const totalBytes = snapshot.files.reduce((n, file) => n + file.byte_count, 0);
    if (!report?.full_source_coverage || report.total_files !== snapshot.files.length || report.total_segments !== plan.segments.length || report.completed_segments !== plan.segments.length || report.total_bytes !== totalBytes || report.covered_bytes !== totalBytes) coverageIssues.push('report_coverage_totals_mismatch');
  }
  add('complete_segment_evidence', coverageIssues, { planned_segments: plan?.segments.length, stored_fact_identities: segmentFacts.size, independently_hashed_segments: plan && sourceBytes.size === snapshot.files.length ? plan.segments.length : 0, note: 'Pass proves contiguous manifest bytes and stored fact/input identities. It does not prove provider attention or understanding.' }, !!(plan && facts && source && !sourceIssues.length));

  const owners = new Map(), ownershipIssues = [];
  for (const row of report?.file_ownership ?? []) {
    const rows = owners.get(row.path) ?? []; rows.push(row.module_id); owners.set(row.path, rows);
    if (!manifest.has(row.path) || byId.get(row.module_id)?.type !== 'module' || !row.rationale) ownershipIssues.push(`invalid_owner_record:${row.path}`);
  }
  for (const file of snapshot.files) {
    const rows = owners.get(file.path) ?? [], node = paths.get(file.path);
    const containing = graph.edges.filter(edge => edge.type === 'contains' && edge.target === node?.id && byId.get(edge.source)?.type === 'module');
    const layers = graph.layers.filter(layer => layer.nodeIds.includes(node?.id));
    if (rows.length !== 1 || containing.length !== 1 || containing[0]?.source !== rows[0] || layers.length !== 1 || layers[0]?.id !== rows[0]) ownershipIssues.push(`owner_or_layer_not_single_and_consistent:${file.path}`);
  }
  add('global_primary_ownership', ownershipIssues, { ownership_records: (report?.file_ownership ?? []).length, manifest_files: snapshot.files.length }, !!report);

  const refIssues = [], nodeRefs = new Map((report?.node_evidence ?? []).map(row => [row.node_id, row.evidence]));
  const edgeRefs = new Map((report?.relation_evidence ?? []).map(row => [edgeKey(row), row]));
  if (nodeRefs.size !== (report?.node_evidence ?? []).length) refIssues.push('duplicate_node_evidence');
  for (const [id, refs] of nodeRefs) if (!byId.has(id) || !Array.isArray(refs) || refs.some(ref => !validRef(ref))) refIssues.push(`invalid_node_evidence:${id}`);
  for (const node of graph.nodes) {
    const emptyFile = node.type === 'file' && manifest.get(node.filePath)?.byte_count === 0;
    if (!nodeRefs.get(node.id)?.length && !emptyFile) refIssues.push(`missing_node_evidence:${node.id}`);
  }
  const publicEdges = new Set(graph.edges.map(edgeKey));
  if (edgeRefs.size !== (report?.relation_evidence ?? []).length) refIssues.push('duplicate_relation_evidence');
  const nativeEdges = artifact.ua_graph && Array.isArray(artifact.edges) ? new Set(artifact.edges.map(edge => edge.id)) : null;
  for (const [key, row] of edgeRefs) {
    const target = byId.get(row.target), emptyFileContainment = row.type === 'contains' && target?.type === 'file' && manifest.get(target.filePath)?.byte_count === 0;
    if (!publicEdges.has(key) || !Array.isArray(row.evidence) || !row.evidence.length && !emptyFileContainment || row.evidence?.some(ref => !validRef(ref)) || !['native_dependency', 'semantic_inference'].includes(row.basis) || row.basis === 'native_dependency' && !row.native_ids?.length) refIssues.push(`invalid_relation_evidence:${key}`);
    if (nativeEdges && (row.native_ids ?? []).some(id => !nativeEdges.has(id))) refIssues.push(`unknown_native_edge:${key}`);
  }
  for (const edge of graph.edges) if (!edgeRefs.has(edgeKey(edge))) refIssues.push(`missing_relation_evidence:${edgeKey(edge)}`);
  add('traceable_public_sources', refIssues, { public_nodes: graph.nodes.length, node_evidence_records: nodeRefs.size, public_edges: graph.edges.length, relation_evidence_records: edgeRefs.size, native_reference_ids_checked: !!nativeEdges, note: 'A valid location is necessary support, not proof that its text entails the claim.' }, !!report);

  const batches = new Map();
  for (const [index, ids] of (plan?.batches ?? []).entries()) for (const id of ids) {
    const segment = segmentMap.get(id); if (!segment) continue;
    const set = batches.get(segment.path) ?? new Set(); set.add(index); batches.set(segment.path, set);
  }
  const fileDependencies = graph.edges.filter(edge => byId.get(edge.source)?.type === 'file' && byId.get(edge.target)?.type === 'file' && ['imports', 'depends_on', 'calls', 'reads_from', 'writes_to', 'routes'].includes(edge.type));
  const crossModule = fileDependencies.filter(edge => owners.get(byId.get(edge.source).filePath)?.[0] !== owners.get(byId.get(edge.target).filePath)?.[0]);
  const crossBatch = fileDependencies.filter(edge => {
    const sourceBatches = batches.get(byId.get(edge.source).filePath), targetBatches = batches.get(byId.get(edge.target).filePath);
    return sourceBatches?.size && targetBatches?.size && ![...sourceBatches].some(index => targetBatches.has(index));
  });
  const moduleRelations = new Set(graph.edges.filter(edge => edge.type === 'depends_on').map(edge => `${edge.source}\0${edge.target}`));
  const missingModuleRelations = crossModule.filter(edge => !moduleRelations.has(`${owners.get(byId.get(edge.source).filePath)?.[0]}\0${owners.get(byId.get(edge.target).filePath)?.[0]}`)).map(edgeKey);
  add('cross_batch_module_projection', missingModuleRelations, { file_dependencies: fileDependencies.length, across_disjoint_source_batches: crossBatch.length, cross_module_file_dependencies: crossModule.length, native_cross_batch: crossBatch.filter(edge => edgeRefs.get(edgeKey(edge))?.basis === 'native_dependency').length, note: 'Counts show synthesis structure, not dependency completeness or valid runtime causality.' }, !!(plan && report));

  const consistencyIssues = [], checksByPath = new Map(), raw = new Map((rawBriefs ?? []).map(brief => [brief.path, brief])), final = new Map((briefs ?? []).map(brief => [brief.path, brief]));
  const hostProtocol = consistency?.verification_version === 'cross-file-claims-1.3.0';
  let hostDowngraded = 0;
  const privateProposals = [], privateProposalMatches = [], privatePublicationIssues = [];
  for (const row of consistency?.checks ?? []) {
    const rows = checksByPath.get(row.path) ?? []; rows.push(row); checksByPath.set(row.path, rows);
    if (!manifest.has(row.path) || !row.input_sha256 || !Array.isArray(row.checked_claims) || new Set(row.checked_claims).size !== row.checked_claims.length) consistencyIssues.push(`invalid_consistency_context:${row.path}`);
    if (raw.has(row.path)) { const expected = claimIds(raw.get(row.path)); if (expected.length !== row.checked_claims.length || expected.some(id => !row.checked_claims.includes(id))) consistencyIssues.push(`incomplete_claim_check:${row.path}`); }
    if (new Set((row.findings ?? []).map(finding => finding.claim_id)).size !== (row.findings ?? []).length) consistencyIssues.push(`duplicate_consistency_claim_finding:${row.path}`);
    if (hostProtocol && (!exactKeys(row, ['path', 'input_sha256', 'checked_claims', 'findings', 'unresolved_dependencies']) || !/^[a-f0-9]{64}$/.test(row.input_sha256) || !Array.isArray(row.unresolved_dependencies) || row.unresolved_dependencies.length > 12 || row.unresolved_dependencies.some(item => !boundedText(item, 800)))) consistencyIssues.push(`invalid_normalized_context_shape:${row.path}`);
    for (const finding of row.findings ?? []) {
      if (!row.checked_claims.includes(finding.claim_id) || !['corrected', 'uncertain'].includes(finding.status) || !finding.reason || finding.status === 'corrected' && !finding.replacement || !finding.evidence?.length || finding.evidence.some(ref => !validRef(ref))) consistencyIssues.push(`invalid_consistency_finding:${row.path}:${finding.claim_id}`);
      if (!hostProtocol) continue;
      if (!exactKeys(finding, ['claim_id', 'status', 'replacement', 'reason', 'evidence'], ['host_reason', 'original_proposal']) || !boundedText(finding.reason, 600) || finding.status === 'uncertain' && finding.replacement !== '' || finding.status === 'corrected' && !boundedText(finding.replacement, finding.claim_id === 'summary' ? 1200 : 800)) consistencyIssues.push(`invalid_normalized_finding_shape:${row.path}:${finding.claim_id}`);
      if (finding.host_reason === undefined && finding.original_proposal === undefined) continue;
      const proposal = finding.original_proposal;
      if (finding.host_reason === 'missing_complete_callee_definition') hostDowngraded++;
      if (finding.host_reason !== 'missing_complete_callee_definition' || finding.status !== 'uncertain' || finding.replacement !== '' || finding.reason !== hostDowngradeReason) consistencyIssues.push(`invalid_host_downgrade:${row.path}:${finding.claim_id}`);
      if (!exactKeys(proposal, ['status', 'replacement', 'reason', 'evidence_ids', 'evidence']) || proposal.status !== 'corrected' || !boundedText(proposal.replacement, finding.claim_id === 'summary' ? 1200 : 800) || !boundedText(proposal.reason, 600) || !Array.isArray(proposal.evidence_ids) || proposal.evidence_ids.length < 1 || proposal.evidence_ids.length > 20 || new Set(proposal.evidence_ids).size !== proposal.evidence_ids.length || proposal.evidence_ids.some(id => typeof id !== 'string' || !/^E\d{3,}$/.test(id) || Number(id.slice(1)) < 1) || !Array.isArray(proposal.evidence) || proposal.evidence.length !== proposal.evidence_ids.length || proposal.evidence.some(ref => !validRef(ref)) || hashJson(proposal.evidence) !== hashJson(finding.evidence)) consistencyIssues.push(`invalid_private_original_proposal:${row.path}:${finding.claim_id}`);
      if (proposal) privateProposals.push({ path: row.path, claim: finding.claim_id, proposal });
    }
  }
  if (consistency) {
    const supportedVersions = new Set(['cross-file-claims-1.0.0', 'cross-file-claims-1.1.0', 'cross-file-claims-1.2.0', 'cross-file-claims-1.3.0']);
    if (!supportedVersions.has(consistency.verification_version)) consistencyIssues.push('unsupported_consistency_version');
    const groupedPublication = new Set(['cross-file-claims-1.1.0', 'cross-file-claims-1.2.0', 'cross-file-claims-1.3.0']).has(consistency.verification_version);
    if (consistency.snapshot_id !== snapshot.snapshot_id || consistency.files_checked !== snapshot.files.length || consistency.contexts_checked !== consistency.checks.length || consistency.claims_checked !== consistency.checks.reduce((n, row) => n + row.checked_claims.length, 0)) consistencyIssues.push('consistency_identity_or_counts_mismatch');
    for (const file of snapshot.files) if (!checksByPath.has(file.path)) consistencyIssues.push(`unchecked_file:${file.path}`);
    if (new Set(consistency.checks.map(row => row.input_sha256)).size !== consistency.checks.length) consistencyIssues.push('duplicate_consistency_context_hash');
    if (rawBriefs && briefs) for (const file of snapshot.files) {
      const changes = (consistency.brief_changes ?? []).filter(row => row.path === file.path);
      if (changes.length !== 1 || !raw.has(file.path) || !final.has(file.path) || changes[0].before_sha256 !== hashJson(raw.get(file.path)) || changes[0].after_sha256 !== hashJson(final.get(file.path))) consistencyIssues.push(`brief_change_identity_mismatch:${file.path}`);
    }
    let corrected = 0, uncertain = 0;
    for (const [filePath, rows] of checksByPath) {
      const groups = new Map();
      for (const finding of rows.flatMap(row => row.findings ?? [])) { const found = groups.get(finding.claim_id) ?? []; found.push(finding); groups.set(finding.claim_id, found); }
      const publicNotes = new Map(), nodeText = paths.has(filePath) ? publicText(paths.get(filePath)) : '';
      for (const [claim, findings] of groups) {
        const corrections = [...new Set(findings.filter(f => f.status === 'corrected').map(f => f.replacement))];
        // Known grouped protocols keep mixed opinions uncertain, even with one replacement.
        const accepted = corrections.length === 1 && (!groupedPublication || findings.every(f => f.status === 'corrected'));
        if (accepted) corrected++; else uncertain++;
        const originalClaim = raw.has(filePath) ? claimText(raw.get(filePath), claim) : undefined;
        const uncertainText = originalClaim ? `待确认：${originalClaim}（跨文件依据尚未一致）` : '待确认';
        if (accepted ? !nodeText.includes(corrections[0]) : !nodeText.includes(uncertainText)) consistencyIssues.push(`unpublished_correction_or_uncertainty:${filePath}:${claim}`);
        if (hostProtocol && final.has(filePath) && (accepted || originalClaim) && claimText(final.get(filePath), claim) !== (accepted ? corrections[0] : uncertainText)) consistencyIssues.push(`incorrect_reconciled_claim_application:${filePath}:${claim}`);
        if (hostProtocol && !accepted && claim.startsWith('dependency:') && final.has(filePath) && final.get(filePath).dependencies?.[Number(claim.split(':')[1])]?.status !== 'unknown') consistencyIssues.push(`uncertain_dependency_not_unknown:${filePath}:${claim}`);
        const key = `${accepted ? 'corrected' : 'uncertain'}:${claim.split(':')[0]}`;
        const note = publicNotes.get(key) ?? { accepted, claims: [], reasons: new Set(), count: 0 };
        note.claims.push(claim); note.count += findings.length;
        for (const finding of findings) note.reasons.add(`${finding.status === 'corrected' ? accepted ? '已采纳纠正' : '未采纳纠正建议' : '待确认'}：${finding.reason}`);
        if (!accepted && corrections.length > 1) note.reasons.add('同一断言跨页出现不同纠正文本，未选择其中任意一份作为结论。');
        if (!accepted && findings.some(f => f.status === 'uncertain') && corrections.length) note.reasons.add('同一断言同时存在纠正建议和未确认意见，保留待确认。');
        publicNotes.set(key, note);
      }
      if (groupedPublication) {
        const reference = hashJson({ verification_version: consistency.verification_version, path: filePath, checks: rows });
        const published = paths.has(filePath) ? strings(paths.get(filePath).domainMeta?.businessRules) : [];
        const claimOrder = raw.has(filePath) ? claimIds(raw.get(filePath)) : rows[0].checked_claims;
        for (const note of publicNotes.values()) {
          const claimList = note.claims.sort((a, b) => claimOrder.indexOf(a) - claimOrder.indexOf(b)).join('、');
          const prefix = `${note.accepted ? '已修正的跨文件源码解释（仍是推断）' : '跨文件待确认'}：${claimList}，${note.count}条审查意见/${note.reasons.size}项不同理由。`;
          const candidates = published.filter(value => value.includes(prefix) && value.includes(`一致性审计引用：${reference}`));
          const visible = candidates.some(value => {
            const shown = [...note.reasons].filter(reason => value.includes(reason)).length;
            return shown >= Math.min(2, note.reasons.size) && (note.reasons.size <= 2 || value.includes(`另${note.reasons.size - 2}项理由完整保留于审计`));
          });
          if (!visible) consistencyIssues.push(`invalid_public_consistency_group:${filePath}:${claimList}`);
        }
        const unresolved = [...new Set(rows.flatMap(row => row.unresolved_dependencies ?? []))];
        if (unresolved.length && !published.some(value => value.includes(`跨文件依赖待确认共${unresolved.length}项：`) && value.includes(`一致性审计引用：${reference}`) && unresolved.filter(reason => value.includes(reason)).length >= Math.min(2, unresolved.length) && (unresolved.length <= 2 || value.includes(`另${unresolved.length - 2}项完整保留于审计`)))) consistencyIssues.push(`invalid_public_dependency_group:${filePath}`);
        for (const unknown of raw.get(filePath)?.unknowns ?? []) if (!nodeText.includes(unknown)) consistencyIssues.push(`original_unknown_removed:${filePath}:${unknown}`);
      }
    }
    if (consistency.corrected_claims !== corrected || consistency.uncertain_claims !== uncertain) consistencyIssues.push('finding_totals_mismatch');
    if (hostProtocol && (consistency.host_downgraded_findings !== hostDowngraded || consistency.applied_corrected_claims !== corrected)) consistencyIssues.push('host_downgrade_totals_mismatch');
    if (report?.statistics && ['files', 'claims', 'corrected_claims', 'uncertain_claims'].some(key => report.statistics[`consistency_${key}`] !== consistency[{ files: 'files_checked', claims: 'claims_checked', corrected_claims: 'corrected_claims', uncertain_claims: 'uncertain_claims' }[key]])) consistencyIssues.push('report_consistency_totals_mismatch');
    if (hostProtocol && (!report?.statistics || ['host_downgraded_findings', 'applied_corrected_claims'].some(key => report.statistics[`consistency_${key}`] !== consistency[key]))) consistencyIssues.push('report_host_downgrade_totals_mismatch');
    if (hostProtocol) {
      const surfaces = [JSON.stringify(artifact), JSON.stringify(report), briefs && JSON.stringify(briefs)].filter(Boolean);
      if (surfaces.some(value => value.includes('"original_proposal"'))) privatePublicationIssues.push('private_original_proposal_object_published');
      for (const { path: filePath, claim, proposal } of privateProposals) for (const key of ['replacement', 'reason']) {
        const value = proposal[key];
        if (typeof value !== 'string' || !value) continue;
        const checks = checksByPath.get(filePath), reference = hashJson({ verification_version: consistency.verification_version, path: filePath, checks });
        const scopedNotes = strings(paths.get(filePath)?.domainMeta?.businessRules).filter(note => note.includes(`一致性审计引用：${reference}`));
        const finalNotes = (final.get(filePath)?.unknowns ?? []).filter(note => note.includes(`一致性审计引用：${reference}`));
        const reportNotes = (report?.unresolved ?? []).filter(item => item.scope === `file:${filePath}` && item.description.includes(`一致性审计引用：${reference}`)).map(item => item.description);
        if ([...scopedNotes, ...finalNotes, ...reportNotes].some(note => note.includes(value))) privatePublicationIssues.push(`private_proposal_text_in_public_note:${filePath}:${claim}:${key}`);
        // A callee's independently sourced statement can equal the refused proposal.
        // Match presence is a provenance question, never automatic proof of adoption.
        for (const node of graph.nodes) if (publicText(node).includes(value)) privateProposalMatches.push({ proposal_file: filePath, claim, field: key, text_sha256: digest(value), node_id: node.id, existing_in_raw_file: strings(raw.get(node.filePath)).join('\n').includes(value) });
      }
      consistencyIssues.push(...privatePublicationIssues);
    }
  }
  add('consistency_accounting', consistencyIssues, { files_with_checks: checksByPath.size, claims_checked: consistency?.claims_checked, corrected_claims: consistency?.corrected_claims, applied_corrected_claims: consistency?.applied_corrected_claims, uncertain_claims: consistency?.uncertain_claims, host_downgraded_findings: consistency?.host_downgraded_findings, independently_counted_host_downgrades: hostDowngraded, brief_digests_verified: !!(rawBriefs && briefs), note: 'Accounting and propagated text do not independently establish callee semantics. Normalized proposal IDs/ranges cannot independently prove membership in the original page catalog or that complete definitions were supplied.' }, !!consistency);
  if (hostProtocol && privateProposals.length) add('private_proposal_reuse_evidence', privatePublicationIssues, { potential_matches: privateProposalMatches, note: 'A matching statement in another node may have independent source support. Confirm provenance manually; do not delete a legitimate fact or infer proposal adoption from text equality.' }, !privateProposalMatches.length);

  const unknowns = report?.unresolved ?? [];
  const unpublished = unknowns.filter(item => !text.includes(item.description));
  add('public_unknown_visibility', unpublished.map(item => `${item.scope}:${item.description}`), { recorded_unknowns: unknowns.length, exactly_visible_in_graph: unknowns.length - unpublished.length }, !!report);
  const testNodes = graph.nodes.filter(node => node.type === 'file' && /(?:^|[./_-])(?:tests?|spec)(?:[./_-]|$)/i.test(node.filePath ?? ''));
  const testExecutionCandidates = testNodes.flatMap(node => publicText(node).split('\n').filter(line => /执行通过|测试通过|已验证|all tests pass|tests? passed|verified at runtime/i.test(line) && !/未宣称|不能|不等于|不等同|not (?:executed|run|proof)|未执行|非执行/.test(line)).map(quote => ({ node_id: node.id, quote })));
  return { audit_version: 1, graph_sha256: hashJson(graph), benchmark_scope: 'This separate structural audit does not load, score or modify the frozen semantic benchmark.', checks,
    structural_status: checks.some(check => check.status === 'fail') ? 'fail' : checks.some(check => check.status === 'unverified') ? 'unverified' : 'pass',
    semantic_status: 'requires_independent_source_review',
    manual_gates: [
      { id: 'business_rules_and_definitions', status: 'unverified', instruction: 'Apply the frozen 12-question rubric to public explanations; verify normal/rejected states, caller vs callee data flow, module duties and cross-layer impact against original definition snippets.' },
      { id: 'tests_are_not_execution', status: 'unverified', candidates: testExecutionCandidates, instruction: 'Inspect candidate phrases in context and all sampled test/CI explanations. No candidate is not a semantic pass. Test declarations/assertions do not establish execution or pass results.' },
      { id: 'unknowns_are_meaningful', status: 'unverified', instruction: 'Review whether uncertainty is scoped accurately and prevents unsupported public rules; string visibility alone cannot establish this.' },
      { id: 'dependency_completeness', status: 'unverified', instruction: 'Trace independent UI/CLI → API → usecase → persistence workflows across modules. Native edge counts do not prove all business dependencies or runtime effects.' },
      ...(hostProtocol && hostDowngraded ? [{ id: 'host_proposal_catalog_scope', status: 'unverified', instruction: 'Verify private original_proposal evidence IDs against the original request page catalog. The normalized sidecar preserves resolved ranges but not that complete catalog; valid ID syntax/ranges alone cannot independently prove page membership or complete callee definitions.' }] : []),
      ...(privateProposalMatches.length ? [{ id: 'private_proposal_independent_reuse', status: 'unverified', instruction: 'Review each potential match against that node’s independent source evidence. Text copied from an existing callee fact is not proof that a downgraded caller claim was adopted; verify the specific caller claim remains uncertain and its public note contains no private proposal.' }] : []),
    ], limitations: ['This audit reads only explicitly supplied files and never invokes a model, network or business database.', 'Passing structural checks cannot substitute for the frozen semantic scorecard or prove model attention, enterprise correctness, runtime safety or completed tests.'] };
}

function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) { assert(args[i]?.startsWith('--') && args[i + 1], 'Use --name value'); options[args[i].slice(2)] = args[i + 1]; }
  for (const key of ['artifact', 'report', 'consistency', 'snapshot', 'out']) assert(options[key], `Use --${key} <path>`);
  const load = key => options[key] ? JSON.parse(readFileSync(options[key], 'utf8')) : undefined;
  const facts = options['facts-directory'] ? readdirSync(options['facts-directory']).filter(name => /^semantic-file-batch-[\w-]+\.json$/.test(name)).flatMap(name => JSON.parse(readFileSync(path.join(options['facts-directory'], name), 'utf8'))) : undefined;
  const result = auditQuality({ artifact: load('artifact'), report: load('report'), consistency: load('consistency'), snapshot: load('snapshot'), source: options.source, plan: load('plan'), facts, rawBriefs: load('raw-briefs'), briefs: load('briefs') });
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ structural_status: result.structural_status, semantic_status: result.semantic_status, checks: result.checks.map(({ id, status }) => ({ id, status })), out: path.resolve(options.out) }) + '\n');
  if (result.structural_status === 'fail') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
