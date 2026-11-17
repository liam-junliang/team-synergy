import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateHostedUaGraph } from '../dist/code-analysis-semantic.js';
import { createSemanticModelClient, semanticCheckpointKey, semanticInferencePolicy } from '../dist/code-analysis-semantic-model.js';
import { semanticDigest, validateReducedFileBrief } from '../dist/code-analysis-semantic-source.js';
import { ARCHITECTURE_EVIDENCE_PROTOCOL, encodeArchitectureEvidence, encodeArchitectureRelatedPaths } from '../dist/code-analysis-semantic-architecture-wire.js';
import { materializeCodeSemanticAnalysis } from '@team-synergy/integrations';
import { validateCodeArtifact } from '@team-synergy/contracts';
import { overviewFixture, globalRuleReferenceFixture } from './overview-fixture.mjs';

function setup(t, files = 80) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-semantic-e2e-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-semantic-e2e-')); rmSync(root, { recursive: true, force: true }); });
  const sourceDirectory = path.join(root, 'source'), runDirectory = path.join(root, 'run'), cacheDirectory = path.join(root, 'cache');
  mkdirSync(path.join(sourceDirectory, 'src'), { recursive: true }); mkdirSync(runDirectory);
  const contents = { 'README.md': '# Semantic fixture\n\nDescribes a controlled demonstration.\n' };
  for (let index = 0; index < files; index++) contents[`src/file${String(index).padStart(3, '0')}.ts`] = Array.from({ length: index === 0 ? 1900 : 10 }, (_, line) => `export const flag_${index}_${line} = ${line};`).join('\n') + '\n';
  const snapshotFiles = Object.entries(contents).map(([name, content]) => { writeFileSync(path.join(sourceDirectory, name), content); return { path: name, sha256: semanticDigest(Buffer.from(content)), byte_count: Buffer.byteLength(content), line_count: content.split('\n').length }; }).sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = { snapshot_id: 'a'.repeat(64), manifest_sha256: semanticDigest(snapshotFiles), commit: 'b'.repeat(40), tree: 'c'.repeat(40), kind: 'commit', files: snapshotFiles, scope: ['.'], captured_at: new Date().toISOString(), exclusions: [] };
  const native = { nodes: [{ id: 'cg:a', provider: 'codegraph', native_id: 'a', kind: 'function', label: 'first', path: 'src/file000.ts', line_start: 1, line_end: 2, evidence_ids: [], verification: 'observed' }, { id: 'cg:b', provider: 'codegraph', native_id: 'b', kind: 'function', label: 'second', path: 'src/file001.ts', line_start: 1, line_end: 2, evidence_ids: [], verification: 'observed' }], edges: [{ id: 'cg-edge:1', source: 'cg:a', target: 'cg:b', provider: 'codegraph', type: 'calls', provenance: 'native', evidence_ids: [], verification: 'inferred' }], evidence: [], coverage: [] };
  for (const node of native.nodes) {
    const file = snapshotFiles.find(file => file.path === node.path);
    if (!file) continue;
    node.evidence_ids = ['e:' + node.id];
    native.evidence.push({ id: node.evidence_ids[0], path: node.path, line_start: node.line_start, line_end: node.line_end, sha256: file.sha256 });
  }
  writeFileSync(path.join(runDirectory, 'codegraph-projection.json'), JSON.stringify(native));
  writeFileSync(path.join(runDirectory, 'ua-import-map.json'), JSON.stringify({ importMap: { 'src/file000.ts': ['src/file001.ts'] } }));
  return { root, sourceDirectory, runDirectory, cacheDirectory, snapshot, native, repositoryName: 'Semantic fixture', config: { modelUrl: 'http://127.0.0.1:3425/v1', model: 'workbuddy/deepseek-v4.1-flash', apiKey: '', concurrency: 3 } };
}
const evidence = path => [{ path, line_start: 1, line_end: 1 }];
const rule = path => [{ description: 'Only the documented owner changes the controlled state; unsupported transitions are rejected.', evidence: evidence(path) }];
function modelResponse(value, model = 'deepseek-v4.1-flash', finish = 'stop') { return new Response(JSON.stringify({ model, choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] })); }
function mockModel(calls, options = {}) {
  let active = 0, maxActive = 0;
  const fetchImpl = async (_url, request) => {
    const prompt = JSON.parse(JSON.parse(request.body).messages[1].content), phase = prompt.analysis_phase;
    const architectureResponse = value => { assert.equal(prompt.evidence_protocol, ARCHITECTURE_EVIDENCE_PROTOCOL); assert.ok(prompt.output_schema); const encoded = encodeArchitectureEvidence(globalRuleReferenceFixture(value, prompt), prompt.evidence_catalog); return modelResponse(prompt.related_path_catalog ? encodeArchitectureRelatedPaths(encoded, prompt.related_path_catalog) : encoded); };
    calls.push({ phase, bytes: Buffer.byteLength(JSON.parse(request.body).messages[1].content), ...(phase === 'architecture-repair' ? { previous_sha256: prompt.previous_architecture_sha256 } : {}) });
    assert.ok(calls.at(-1).bytes <= 180000);
    active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 3)); active--;
    if (phase === 'files') {
      if (options.truncateAll || options.truncateMultiple && prompt.segments.length > 1) return modelResponse({ segments: [] }, 'deepseek-v4.1-flash', 'length');
      return modelResponse({ segments: prompt.segments.map(({ segment }) => ({ segment_id: segment.id, input_sha256: segment.input_sha256, summary: 'Defines numeric flags in this exact source portion.', responsibility: 'Publishes controlled state definitions.', behaviors: [{ description: 'The exported numeric state is initialized without running the tests.', evidence: [{ path: segment.path, line_start: segment.line_start, line_end: segment.line_start }] }], state_owners: ['Controlled flag state'], user_purposes: ['Read documented state'], dependencies: [], evidence: [{ path: segment.path, line_start: segment.line_start, line_end: segment.line_start }], unknowns: ['No runtime behavior was executed.'] })) });
    }
    if (phase === 'reduce') {
      const facts = prompt.facts, allEvidence = [...new Set(facts.flatMap(fact => fact.evidence_ids))];
      assert.equal(prompt.reduce_protocol, 'file-evidence-catalog-1.1.0'); assert.ok(prompt.evidence_catalog.length);
      assert.equal(prompt.output_schema.properties.summary.maxLength, 1200); assert.equal(prompt.output_schema.properties.dependencies.maxItems, 24);
      assert.equal(facts.some(fact => 'evidence' in fact), false);
      return modelResponse({ path: prompt.path, input_sha256: prompt.input_sha256, summary: 'Integrates every source portion into a single controlled-state file.', responsibility: 'Owns exported fixture state definitions.', behaviors: facts.flatMap(fact => fact.behaviors).slice(0, 20), state_owners: ['Controlled flag state'], user_purposes: ['Read documented state'], dependencies: [], evidence_ids: allEvidence, unknowns: ['No runtime behavior was executed.'] });
    }
    if (phase === 'consistency') return modelResponse({ files: prompt.files.map(file => ({ context_id: file.context_id, checked_claims: file.claims.map(claim => claim.id), findings: options.consistencyUncertain && file.path === 'src/file000.ts' ? [{ claim_id: 'summary', status: 'uncertain', replacement: '', reason: 'The resolved helper implementation is not established by caller arguments alone.', evidence_ids: file.caller.evidence_ids }] : [], unresolved_dependencies: [] })) });
    if (phase === 'architecture-source-select') return modelResponse({ selections: prompt.contexts.map(context => ({ context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, catalog_sha256: context.catalog_sha256, page_sha256: context.page_sha256, selected_definition_ids: context.candidates.slice(0, 8).map(candidate => candidate.definition_id), missing_reasons: context.candidates.length ? [] : ['No candidate implements this fixture statement.'] })) });
    if (phase === 'architecture-grounding') {
      const checks = prompt.contexts.map(context => {
      const ids = [...new Set([...context.guard_definition_ids, ...context.callee_definition_ids.slice(0, 1), ...(context.sources.find(source => source.definition_complete && source.source_kind === 'code') ? [context.sources.find(source => source.definition_complete && source.source_kind === 'code').id] : context.sources.slice(0, 1).map(source => source.id))])];
      return { context_id: context.context_id, claim_id: context.claim_id, text_sha256: context.text_sha256, status: options.groundingContradict && ids.length ? 'contradicted' : context.can_assert_supported && ids.length ? 'supported' : 'insufficient', reason: options.groundingContradict ? 'The complete operation and its guard contradict this narrative.' : 'Fixture review binds every unchanged assertion to its supplied complete definitions.', evidence_ids: ids };
      });
      return modelResponse({ checks: prompt.grounding_response_protocol === 'context-evidence-bindings-1.1.0' ? Object.fromEntries(checks.map(({ context_id, ...check }) => [context_id, check])) : checks });
    }
    if (phase === 'architecture-repair') return modelResponse({ patches: prompt.targets.map(target => ({ field: target.field, field_sha256: target.field_sha256, decision: 'replace', replacement_text: target.original_text, unknowns: [] })) });
    if (phase === 'architecture-reduce' && prompt.overview_protocol) return modelResponse(overviewFixture(prompt));
    if (phase === 'architecture-map' || phase === 'architecture-reduce') {
      const paths = phase === 'architecture-map' ? prompt.briefs.map(brief => brief.path) : [...new Set(prompt.proposals.flatMap(item => item.related_paths))];
      const anchors = paths.filter(file => /file00[01]\.ts$/.test(file)); if (!anchors.length) anchors.push(paths[0]);
      return architectureResponse({ proposals: [{ name: 'Controlled workflow ownership', responsibility: 'Separates state delivery from governance.', state_owners: ['Controlled state'], user_purposes: ['Deliver a valid state transition'], business_rules: anchors.flatMap(rule), evidence: anchors.flatMap(evidence), related_paths: paths, unknowns: ['Runtime execution was not observed.'] }] });
    }
    if (phase === 'architecture') {
      const first = 'src/file000.ts', second = 'src/file001.ts';
      return architectureResponse({ description: 'A controlled state workflow with separate governance and delivery.', languages: ['TypeScript'], frameworks: [], modules: [{ id: 'module:delivery', name: 'Delivery state', summary: 'Owns delivery state and only permits valid transitions.', state_owners: ['Delivery state'], user_purposes: ['Deliver a change'], business_rules: rule(first), evidence: evidence(first) }, { id: 'module:governance', name: 'Governance', summary: 'Owns verification gates and rejects unsupported changes.', state_owners: ['Verification gates'], user_purposes: ['Verify a change'], business_rules: rule(second), evidence: evidence(second) }], capabilities: [{ id: 'capability:deliver', name: 'Deliver state', summary: 'Changes controlled delivery state under explicit rules.', module_ids: ['module:delivery'], business_rules: rule(first), evidence: evidence(first) }, { id: 'capability:verify', name: 'Verify state', summary: 'Checks governance rules before accepting delivery.', module_ids: ['module:governance'], business_rules: rule(second), evidence: evidence(second) }], flows: [{ id: 'flow:verified-delivery', name: 'Verified delivery', summary: 'Delivery must pass a governance gate before acceptance.', business_rules: rule(first), steps: [{ capability_id: 'capability:deliver', description: 'Prepare a valid controlled state.', evidence: evidence(first) }, { capability_id: 'capability:verify', description: 'Reject unsupported transitions.', evidence: evidence(second) }], evidence: [...evidence(first), ...evidence(second)] }], relations: [], unknowns: ['Static analysis does not establish runtime success.'] });
    }
    if (phase === 'ownership') return modelResponse({ assignments: prompt.files.map(file => ({ path: file.path, module_id: file.path.endsWith('001.ts') || file.path.endsWith('.md') ? 'module:governance' : 'module:delivery', rationale: 'This file supports the documented state owner and user purpose.' })) });
    if (phase === 'tour') return modelResponse({ tour: ['file:README.md', 'module:delivery', 'capability:deliver', 'flow:verified-delivery', 'module:governance'].map((id, order) => ({ order, title: `Understand responsibility ${order + 1}`, description: 'Read the purpose, then follow state changes and the governance boundary.', nodeIds: [id] })) });
    if (phase === 'review') return architectureResponse({ findings: options.reviewFindings ?? [], unknowns: ['Semantic correctness requires an independent evaluation.'] });
    assert.fail(`Unhandled phase ${phase}`);
  };
  return { fetchImpl, maxActive: () => maxActive };
}

test('source contradiction permits bounded progressing repairs and blocks ownership, tour and publication when the narrative remains unchanged', async t => {
  const input = setup(t, 3), calls = [], model = mockModel(calls, { groundingContradict: true });
  await assert.rejects(generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl }), error => error.code === 'code_analysis_model_invalid' && error.details?.reason === 'global_grounding_conflict');
  assert.equal(calls.filter(call => call.phase === 'architecture').length, 1);
  assert.ok(calls.some(call => call.phase === 'architecture-repair'));
  assert.ok(new Set(calls.filter(call => call.phase === 'architecture-repair').map(call => call.previous_sha256)).size <= 3);
  assert.equal(calls.some(call => ['ownership', 'tour', 'review'].includes(call.phase)), false);
  const files = readdirSync(input.runDirectory);
  assert.ok(files.includes('semantic-global-grounding-0.json')); assert.ok(files.includes('semantic-global-grounding-1.json'));
  assert.equal(files.includes('semantic-graph.json'), false); assert.equal(files.includes('semantic-quality.json'), false);
  const rejected = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-global-grounding-1.json')));
  assert.ok(rejected.blocking.length); assert.ok(rejected.blocking.every(check => check.status === 'contradicted'));
});

test('full-source pipeline covers every file and byte, synthesizes shared modules and preserves public rules with bounded parallelism', async t => {
  const input = setup(t), calls = [], model = mockModel(calls), progress = [];
  const result = await generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl, onProgress: item => progress.push(item) });
  assert.equal(result.selectedFiles.length, 81); assert.equal(result.quality.full_source_coverage, true);
  assert.equal(result.quality.covered_bytes, input.snapshot.files.reduce((sum, file) => sum + file.byte_count, 0));
  assert.ok(result.quality.total_segments > result.selectedFiles.length); assert.equal(result.quality.completed_segments, result.quality.total_segments);
  assert.equal(result.graph.nodes.filter(node => node.type === 'file').length, 81); assert.equal(result.graph.nodes.filter(node => node.type === 'module').length, 2);
  const details = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-file-briefs.json')));
  for (const detail of details) {
    const node = result.graph.nodes.find(node => node.id === `file:${detail.path}`);
    assert.equal(node.summary, `${detail.responsibility}\n${detail.summary}`);
    assert.deepEqual(node.domainMeta.businessRules, [...detail.behaviors.map(rule => rule.description), ...detail.unknowns.map(unknown => `未知：${unknown}`)]);
    assert.deepEqual(node.domainMeta.crossDomainInteractions, detail.dependencies.map(item => `${item.type} ${item.target}: ${item.description} (${item.status})`));
  }
  assert.equal(result.graph.layers.length, 2); assert.equal(result.graph.tour.length, 5);
  assert.equal(new Set(result.graph.layers.flatMap(layer => layer.nodeIds)).size, result.graph.nodes.length);
  assert.equal(result.graph.nodes.some(node => /^b\d+:/.test(node.id)), false);
  assert.ok(result.graph.nodes.find(node => node.id === 'module:delivery').domainMeta.businessRules.some(text => text.includes('unsupported transitions')));
  const cross = result.quality.relation_evidence.find(edge => edge.source === 'module:delivery' && edge.target === 'module:governance');
  assert.equal(cross.basis, 'native_dependency'); assert.deepEqual(cross.native_ids, ['cg-edge:1']);
  assert.ok(model.maxActive() > 1 && model.maxActive() <= 3);
  for (const phase of ['files', 'reduce', 'consistency', 'architecture', 'tour', 'review']) assert.ok(progress.some(item => item.phase === phase));
  assert.equal(result.quality.semantic_correctness, 'requires_independent_evaluation');
  const artifact = { schema_version: 1, snapshot_id: input.snapshot.snapshot_id, nodes: [...input.native.nodes, ...result.graph.nodes.map(node => ({ id: `ua:${node.id}`, native_id: node.id, provider: 'ua', kind: node.type, label: node.name, summary: node.summary, ...(node.filePath ? { path: node.filePath } : {}), layer: result.graph.layers.find(layer => layer.nodeIds.includes(node.id))?.name, evidence_ids: [], verification: 'inferred' }))], edges: [...input.native.edges, ...result.graph.edges.map((edge, index) => ({ id: `ua-edge:${index}`, source: `ua:${edge.source}`, target: `ua:${edge.target}`, type: edge.type, provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' }))], evidence: structuredClone(input.native.evidence), coverage: [{ provider: 'ua', total_files: 81, analyzed_files: 81, limitations: [] }, { provider: 'codegraph', total_files: 81, analyzed_files: 2, limitations: [] }], ua_graph: result.graph, tour: result.graph.tour.map(step => ({ title: step.title, description: step.description, node_ids: step.nodeIds.map(id => `ua:${id}`) })), semantic_author: { kind: 'agent', model: 'deepseek-v4.1-flash', prompt_version: result.quality.prompt_version } };
  const published = materializeCodeSemanticAnalysis(artifact, input.snapshot, result.quality, result.plan);
  assert.equal(published.semantic_analysis.counts.total_files, 81);
  assert.deepEqual(validateCodeArtifact(published, input.snapshot), []);
  const cachedCalls = [], cachedModel = mockModel(cachedCalls);
  const repeated = await generateHostedUaGraph({ ...input, fetchImpl: cachedModel.fetchImpl });
  assert.equal(cachedCalls.length, 0); assert.equal(repeated.graph.nodes.length, result.graph.nodes.length); assert.ok(repeated.quality.cache_hits >= result.quality.total_segments);
  assert.ok(readdirSync(input.runDirectory).some(name => name.endsWith('.audit.json')));
});

test('checkpoint identity prevents snapshot, model, engine or source mixing and corrupted checkpoint content is rejected', async t => {
  const input = setup(t, 2), task = { segment: 'safe-source' };
  const base = { snapshotId: input.snapshot.snapshot_id, model: input.config.model, modelUrl: input.config.modelUrl, engineIdentity: 'engine-one' };
  const key = semanticCheckpointKey(base, task);
  for (const context of [{ ...base, snapshotId: 'f'.repeat(64) }, { ...base, model: 'other-model' }, { ...base, engineIdentity: 'engine-two' }]) assert.notEqual(semanticCheckpointKey(context, task), key);
  assert.notEqual(semanticCheckpointKey(base, { segment: 'other-source' }), key);
  assert.notEqual(semanticCheckpointKey(base, { phase: 'files', input: task, inference_policy: { max_tokens: 16000, thinking: { type: 'disabled' }, reasoning_effort: 'low' } }), semanticCheckpointKey(base, { phase: 'files', input: task, inference_policy: { max_tokens: 32768, thinking: { type: 'disabled' }, reasoning_effort: 'low' } }));
  const client = createSemanticModelClient({ config: input.config, snapshotId: base.snapshotId, engineIdentity: base.engineIdentity, cacheDirectory: input.cacheDirectory, runDirectory: input.runDirectory });
  client.save(task, { ok: true }, 'deepseek-v4.1-flash'); assert.equal(client.cache(task, value => value).value.ok, true);
  const file = path.join(input.cacheDirectory, `${key}.json`), value = JSON.parse(readFileSync(file)); value.output.ok = false; writeFileSync(file, JSON.stringify(value));
  assert.equal(client.cache(task, value => value), null);
});

test('host-only cache identity separates complete context bindings without changing Map or Reduce keys or provider prompts', async t => {
  const input = setup(t, 2), prompts = [], client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'engine', runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory, fetchImpl: async (_url, request) => {
    const prompt = JSON.parse(JSON.parse(request.body).messages[1].content); prompts.push(prompt); assert.equal('host_identity' in prompt, false); assert.equal('cacheIdentity' in prompt, false); return modelResponse({ accepted: true });
  } });
  for (const phase of ['files', 'reduce']) {
    const taskInput = { task: `Unchanged ${phase} request` }, task = { phase, input: taskInput, inference_policy: semanticInferencePolicy(phase) };
    await client.call({ phase, name: phase, input: taskInput, validate: value => value });
    assert.equal(client.cache(task, value => value).value.accepted, true);
  }
  const request = { phase: 'consistency', name: 'context-binding', input: { files: [{ context_id: 'C123' }] }, validate: value => value };
  await client.call({ ...request, cacheIdentity: [{ context_id: 'C123', input_sha256: 'a'.repeat(64) }] });
  const before = prompts.length;
  await client.call({ ...request, cacheIdentity: [{ context_id: 'C123', input_sha256: 'a'.repeat(64) }] }); assert.equal(prompts.length, before);
  await client.call({ ...request, cacheIdentity: [{ context_id: 'C123', input_sha256: 'b'.repeat(64) }] }); assert.equal(prompts.length, before + 1);
  assert.deepEqual(prompts.at(-1), prompts.at(-2));
});

test('critical Phase6 findings keep private review checkpoints and block graph publication', async t => {
  const input = setup(t, 2), calls = [], model = mockModel(calls, { reviewFindings: [{ severity: 'critical', scope: 'module:delivery', description: 'The claimed transition is contradicted by the supplied definition.', evidence: evidence('src/file000.ts') }] });
  await assert.rejects(generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl }), error => error.code === 'code_analysis_model_invalid' && error.details?.reason === 'critical_review');
  const review = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-review.json'), 'utf8'));
  assert.equal(review.findings[0].severity, 'critical'); assert.equal(readdirSync(input.runDirectory).includes('semantic-graph.json'), false); assert.equal(readdirSync(input.runDirectory).includes('semantic-quality.json'), false);
});

test('source truncation partitions original segment identities without accepting truncated output or exceeding concurrency', async t => {
  const input = setup(t, 5), calls = [], model = mockModel(calls, { truncateMultiple: true });
  const result = await generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl });
  assert.equal(result.quality.completed_segments, result.quality.total_segments); assert.equal(result.quality.covered_bytes, result.plan.total_bytes);
  assert.ok(result.quality.statistics.source_partitions > 0); assert.ok(model.maxActive() <= 3);
  const partitions = readdirSync(input.runDirectory).filter(file => file.startsWith('semantic-source-partition-'));
  assert.ok(partitions.length);
  for (const file of partitions) { const record = JSON.parse(readFileSync(path.join(input.runDirectory, file))); assert.equal(record.accepted, false); assert.equal(record.reason, 'output_truncated'); assert.deepEqual(record.children.flat(), record.parent_segments); }
  for (const file of readdirSync(input.runDirectory).filter(file => file.endsWith('.audit.json'))) {
    const record = JSON.parse(readFileSync(path.join(input.runDirectory, file)));
    if (record.finish_reason === 'length') assert.equal(record.accepted, false);
  }
});

test('a truncated single source segment fails closed rather than fabricating completion', async t => {
  const input = setup(t, 2), calls = [], model = mockModel(calls, { truncateAll: true });
  await assert.rejects(generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl }), error => error.code === 'code_analysis_model_invalid' && error.details?.reason === 'output_truncated');
  assert.equal(readdirSync(input.runDirectory).includes('semantic-quality.json'), false);
  assert.equal(readdirSync(input.runDirectory).includes('semantic-graph.json'), false);
});

test('phase policies limit map thinking requests and preserve high-effort global architecture and review', () => {
  assert.deepEqual(semanticInferencePolicy('files'), { thinking: { type: 'disabled' }, reasoning_effort: 'low', max_tokens: 32768 });
  assert.equal(semanticInferencePolicy('reduce').reasoning_effort, 'low');
  assert.deepEqual(semanticInferencePolicy('architecture-reduce'), { thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 32768 });
  assert.equal(semanticInferencePolicy('reduce').max_tokens, 20000); assert.equal(semanticInferencePolicy('architecture-map').max_tokens, 20000);
  for (const phase of ['architecture', 'review']) { assert.equal(semanticInferencePolicy(phase).thinking.type, 'enabled'); assert.equal(semanticInferencePolicy(phase).reasoning_effort, 'high'); assert.ok(semanticInferencePolicy(phase).max_tokens >= 24000); }
});

test('global output budget invalidates only the old architecture checkpoint and preserves all upstream and review checkpoints', async t => {
  const input = setup(t, 2), sent = [];
  const client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'unchanged-engine', runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory, fetchImpl: async (_url, request) => {
    sent.push(JSON.parse(request.body)); return modelResponse({ from: 'new-global-output-budget' });
  } });
  const previous = {
    files: { thinking: { type: 'disabled' }, reasoning_effort: 'low', max_tokens: 32768 },
    segment: { thinking: { type: 'disabled' }, reasoning_effort: 'low', max_tokens: 32768 },
    ownership: { thinking: { type: 'disabled' }, reasoning_effort: 'low', max_tokens: 16000 },
    consistency: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32768 },
    'architecture-reduce': { thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 32768 },
    reduce: { thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 20000 },
    'architecture-map': { thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 20000 },
    tour: { thinking: { type: 'enabled' }, reasoning_effort: 'low', max_tokens: 20000 },
    review: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 24000 },
    architecture: { thinking: { type: 'enabled' }, reasoning_effort: 'high', max_tokens: 32000 },
  };
  for (const [phase, inference_policy] of Object.entries(previous)) {
    const request = { phase, name: phase, input: { task: `Same fixed ${phase} inputs` }, validate: value => value };
    client.save({ phase, input: request.input, inference_policy }, { from: `previous-${phase}` }, 'deepseek-v4.1-flash');
    const result = await client.call(request);
    assert.equal(result.cached, phase !== 'architecture', phase);
    assert.equal(result.value.from, phase === 'architecture' ? 'new-global-output-budget' : `previous-${phase}`);
  }
  assert.equal(sent.length, 1); assert.equal(sent[0].max_tokens, 65536);
  assert.deepEqual(sent[0].thinking, { type: 'enabled' }); assert.equal(sent[0].reasoning_effort, 'high');
  const auditFiles = readdirSync(input.runDirectory).filter(name => name.endsWith('.audit.json'));
  assert.equal(auditFiles.length, 1);
  const audit = JSON.parse(readFileSync(path.join(input.runDirectory, auditFiles[0])));
  assert.equal(audit.phase, 'architecture'); assert.equal(audit.inference_policy.max_tokens, 65536); assert.equal(audit.accepted, true);
});

test('only global architecture gets a longer request deadline and its timeout is never transport-retried or cached', async t => {
  const input = setup(t, 2), deadlines = [], timeoutSignals = [], sent = [];
  let expire = false;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController(); deadlines.push(milliseconds); timeoutSignals.push(controller); return controller.signal;
  });
  const client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'engine', runDirectory: input.runDirectory, cacheDirectory: input.cacheDirectory, fetchImpl: async (_url, request) => {
    sent.push(request); assert.equal(request.signal, timeoutSignals.at(-1).signal);
    if (expire) { timeoutSignals.at(-1).abort(new DOMException('Request deadline elapsed', 'TimeoutError')); throw request.signal.reason; }
    return modelResponse({ complete: true });
  } });
  for (const phase of ['files', 'segment', 'ownership', 'reduce', 'consistency', 'architecture-map', 'architecture-reduce', 'tour', 'review', 'architecture']) {
    await client.call({ phase, name: phase, input: { phase }, useCache: false, validate: value => value });
    assert.equal(deadlines.at(-1), phase === 'architecture' ? 480_000 : 240_000, phase);
  }
  expire = true;
  const before = sent.length;
  await assert.rejects(client.call({ phase: 'architecture', name: 'expired', input: { task: 'Deadline failure' }, validate: value => value }), { code: 'code_analysis_model_failed' });
  assert.equal(sent.length, before + 1); assert.equal(deadlines.at(-1), 480_000);
  assert.equal(client.cacheRequest({ phase: 'architecture', input: { task: 'Deadline failure' }, validate: value => value }), null);
  const failed = readdirSync(input.runDirectory).filter(name => name.endsWith('.audit.json')).map(name => JSON.parse(readFileSync(path.join(input.runDirectory, name)))).filter(audit => !audit.accepted);
  assert.equal(failed.length, 1); assert.equal(failed[0].transport_attempts, 1); assert.equal(failed[0].failure.reason, 'transport_or_timeout');
});

test('warning Phase6 findings remain public uncertainty and increment mechanical unresolved counts', async t => {
  const input = setup(t, 2), calls = [], description = 'The downstream contract needs independent confirmation.';
  const model = mockModel(calls, { reviewFindings: [{ severity: 'warning', scope: 'module:delivery', description, evidence: evidence('src/file000.ts') }] });
  const result = await generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl });
  const module = result.graph.nodes.find(node => node.id === 'module:delivery');
  assert.ok(module.domainMeta.businessRules.some(rule => rule.includes(description))); assert.match(module.languageNotes, /待确认/);
  assert.ok(result.quality.unresolved.some(item => item.scope === module.id && item.description.includes(description)));
  assert.equal(result.quality.statistics.review_warnings, 1); assert.equal(result.quality.statistics.review_critical, 0);
  assert.ok(result.quality.node_evidence.find(item => item.node_id === module.id).evidence.some(item => item.path === 'src/file000.ts'));
});

test('unresolved caller/callee assertions remain explicit uncertainty in the published file node', async t => {
  const input = setup(t, 2), calls = [], model = mockModel(calls, { consistencyUncertain: true });
  const result = await generateHostedUaGraph({ ...input, fetchImpl: model.fetchImpl });
  const file = result.graph.nodes.find(node => node.id === 'file:src/file000.ts');
  assert.match(file.summary, /待确认/); assert.ok(file.domainMeta.businessRules.some(rule => rule.includes('caller arguments alone')));
  assert.ok(result.quality.unresolved.some(item => item.description.includes('caller arguments alone'))); assert.equal(result.quality.statistics.consistency_uncertain_claims, 1);
  const before = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-file-briefs.raw.json'))).find(brief => brief.path === 'src/file000.ts');
  assert.equal(before.summary.includes('待确认'), false);
  const details = JSON.parse(readFileSync(path.join(input.runDirectory, 'semantic-file-briefs.json'))), unknowns = details.reduce((n, detail) => n + detail.unknowns.length, 0);
  for (const node of result.graph.nodes.filter(node => ['module', 'domain', 'flow'].includes(node.type))) {
    assert.ok(node.summary.includes(`${unknowns}条未知条目`)); assert.match(node.summary, /1条未确定断言/); assert.match(node.summary, /不等于已确认共识、已落实事实或测试通过/); assert.match(node.summary, /file:/);
    assert.ok(node.domainMeta.businessRules.every(rule => rule.startsWith('源码推断（适用范围：Controlled workflow ownership；Separates state delivery from governance.）：')));
  }
  assert.ok(result.quality.overview_limitations.some(note => note.includes('does not prove')));
});

test('model identity and completion remain strict, audit hides arbitrary provider text, and sensitive interpretations get one repair', async t => {
  for (const mode of ['model', 'finish', 'sensitive', 'json']) {
    const input = setup(t, 2), marker = 'untrusted-provider-private-12345'; let calls = 0;
    const client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'engine', runDirectory: input.runDirectory, fetchImpl: async () => { calls++; if (mode === 'json' && calls === 1) return new Response(JSON.stringify({ model: 'deepseek-v4.1-flash', choices: [{ finish_reason: 'stop', message: { content: '{"unfinished":[1 2]}' } }] })); return modelResponse(mode === 'sensitive' && calls === 1 ? { summary: 'password = "unsafe-test-literal"' } : { summary: 'Describes a credential fixture without its literal value.' }, mode === 'model' ? marker : 'deepseek-v4.1-flash', mode === 'finish' ? marker : 'stop'); } });
    const run = () => client.call({ phase: mode, name: mode, input: { task: 'Interpret supplied evidence.' }, validate: value => value });
    if (['sensitive', 'json'].includes(mode)) { await run(); assert.equal(calls, 2); }
    else { await assert.rejects(run(), { code: 'code_analysis_model_invalid' }); assert.equal(calls, 1); }
    for (const file of readdirSync(input.runDirectory).filter(file => file.endsWith('.audit.json'))) assert.equal(readFileSync(path.join(input.runDirectory, file), 'utf8').includes(marker), false);
  }
});

test('reduce bounded repair receives exact safe shape violations and never stores rejected response text', async t => {
  for (const alwaysInvalid of [false, true]) {
    const input = setup(t, 2), marker = 'untrusted-property-42', prompts = [];
    mkdirSync(input.cacheDirectory);
    const wire = { path: 'a.ts', input_sha256: 'a'.repeat(64), summary: 'A guarded state.', responsibility: 'Owns state.', behaviors: [], state_owners: [], user_purposes: [], dependencies: [], evidence_ids: ['E001'], unknowns: [] };
    const invalid = { ...wire, summary: 'x'.repeat(1201), state_owners: Array(21).fill('owner'), [marker]: 'untrusted-value-42' };
    const context = { file: { path: wire.path, sha256: 'b'.repeat(64), byte_count: 100 }, input_sha256: wire.input_sha256, segment_ids: ['one'] }, catalog = { entries: [{ id: 'E001', path: wire.path, line_start: 1, line_end: 1 }], facts: [] };
    const client = createSemanticModelClient({ config: input.config, snapshotId: input.snapshot.snapshot_id, engineIdentity: 'engine', cacheDirectory: input.cacheDirectory, runDirectory: input.runDirectory, fetchImpl: async (_url, request) => {
      const prompt = JSON.parse(JSON.parse(request.body).messages[1].content); prompts.push(prompt);
      if (prompts.length === 2) {
        assert.ok(prompt.correction.fields.includes('$.summary'));
        assert.ok(prompt.correction.constraints.some(issue => issue.path === '$.summary' && issue.rule === 'max_length' && issue.observed_length === 1201 && issue.maximum === 1200));
        assert.ok(prompt.correction.constraints.some(issue => issue.path === '$.state_owners' && issue.observed_count === 21 && issue.maximum === 20));
        assert.equal(JSON.stringify(prompt.correction).includes(marker), false);
      }
      return modelResponse(prompts.length === 1 || alwaysInvalid ? invalid : wire);
    } });
    const run = () => client.call({ phase: 'reduce', name: 'schema-regression', input: { task: 'Merge supplied validated facts.' }, validate: value => validateReducedFileBrief(value, context, catalog) });
    if (alwaysInvalid) { await assert.rejects(run(), error => error.details.reason === 'schema'); assert.equal(readdirSync(input.cacheDirectory).length, 0); }
    else { assert.equal((await run()).value.summary, wire.summary); assert.equal(readdirSync(input.cacheDirectory).length, 1); }
    assert.equal(prompts.length, 2);
    for (const file of readdirSync(input.runDirectory).filter(file => file.endsWith('.audit.json'))) {
      const audit = readFileSync(path.join(input.runDirectory, file), 'utf8'); assert.equal(audit.includes(marker), false); assert.equal(audit.includes('untrusted-value-42'), false); assert.equal(audit.includes('x'.repeat(1201)), false);
    }
  }
});
