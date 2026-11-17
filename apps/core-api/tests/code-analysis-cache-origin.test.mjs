import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeArtifactSchema } from '@team-synergy/contracts';
import { createSemanticModelClient, semanticCheckpointKey, semanticInferencePolicy, validateSemanticCacheOriginModels, writeSemanticCheckpoint } from '../dist/code-analysis-semantic-model.js';
import { semanticDigest, SEMANTIC_PROMPT_VERSION } from '../dist/code-analysis-semantic-source.js';

const CN = 'workbuddy/deepseek-v4.1-flash', SG = 'workbuddy-ai/deepseek-v4.1-flash-sg';
const endpoint = 'http://127.0.0.1:3425/v1';
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-cache-origin-')), cacheDirectory = path.join(root, 'cache'), runDirectory = path.join(root, 'run');
  mkdirSync(cacheDirectory); mkdirSync(runDirectory);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('tsp-cache-origin-')); rmSync(root, { recursive: true, force: true }); });
  const options = { snapshotId: 'a'.repeat(64), engineIdentity: 'b'.repeat(64), cacheDirectory, runDirectory };
  const request = { phase: 'consistency', name: 'fixture', input: { verification_version: 'cross-file-claims-1.3.0', files: [{ context_id: 'C123', source_sha256: 'c'.repeat(64) }] }, cacheIdentity: [{ context_id: 'C123', input_sha256: 'd'.repeat(64) }], validate: value => { assert.deepEqual(Object.keys(value), ['summary']); assert.equal(typeof value.summary, 'string'); return value; } };
  const task = { phase: request.phase, input: request.input, inference_policy: semanticInferencePolicy(request.phase), host_identity: request.cacheIdentity };
  const make = (model = SG, cacheOriginModels, additions = {}) => createSemanticModelClient({ ...options, config: { modelUrl: endpoint, model, apiKey: '', ...(cacheOriginModels === undefined ? {} : { cacheOriginModels }) }, fetchImpl: async () => assert.fail('No live provider request was expected'), ...additions });
  const context = model => ({ snapshotId: options.snapshotId, model, modelUrl: endpoint, engineIdentity: options.engineIdentity });
  return { ...options, root, request, task, make, context };
}
const response = (value, model = SG) => new Response(JSON.stringify({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));

test('old model cache reuse is opt-in, preserves its record model and origin key, and current route has priority', t => {
  const input = fixture(t), old = input.make(CN), original = { summary: 'A verified cached interpretation.' };
  old.save(input.task, original, 'deepseek-v4.1-flash');
  const cnKey = semanticCheckpointKey(input.context(CN), input.task), sgKey = semanticCheckpointKey(input.context(SG), input.task), before = readFileSync(path.join(input.cacheDirectory, cnKey + '.json'), 'utf8');
  assert.equal(input.make().cacheRequest(input.request), null);
  const current = input.make(SG, [CN]), cached = current.cacheRequest(input.request);
  assert.equal(cached.model, 'deepseek-v4.1-flash'); assert.equal(cached.originModel, CN); assert.deepEqual(cached.value, original);
  assert.equal(existsSync(path.join(input.cacheDirectory, sgKey + '.json')), false); assert.equal(readFileSync(path.join(input.cacheDirectory, cnKey + '.json'), 'utf8'), before);
  assert.deepEqual(current.metrics().provenance, { requested_model: SG, origins: [{ kind: 'cache', requested_model: CN, response_model: 'deepseek-v4.1-flash', uses: 1 }], mixed_origins: false });
  const derived = { phase: 'segment', input: { segment: 'derived-from-the-same-validated-batch' } };
  current.save(derived, cached.value, cached.model, cached.originModel);
  assert.ok(existsSync(path.join(input.cacheDirectory, semanticCheckpointKey(input.context(CN), derived) + '.json')));
  assert.equal(existsSync(path.join(input.cacheDirectory, semanticCheckpointKey(input.context(SG), derived) + '.json')), false);
  assert.throws(() => current.save(derived, original, cached.model), { code: 'code_analysis_cache_origin_invalid' });
  input.make().save(input.task, { summary: 'Current route wins.' }, SG);
  const preferred = current.cacheRequest(input.request); assert.equal(preferred.originModel, SG); assert.equal(preferred.model, SG); assert.equal(preferred.value.summary, 'Current route wins.');
});

test('fallback keeps every source, engine, endpoint, prompt, task, host identity and policy hash boundary', t => {
  const input = fixture(t); input.make(CN).save(input.task, { summary: 'A valid source-bound interpretation.' }, CN);
  const oldKey = semanticCheckpointKey(input.context(CN), input.task);
  assert.equal(oldKey, semanticDigest({ snapshot_id: input.snapshotId, model: CN, endpoint_sha256: semanticDigest(endpoint), engine_identity: input.engineIdentity, prompt_version: SEMANTIC_PROMPT_VERSION, inference_policy: input.task.inference_policy, input_sha256: semanticDigest(input.task) }));
  for (const additions of [{ snapshotId: 'e'.repeat(64) }, { engineIdentity: 'f'.repeat(64) }, { config: { modelUrl: 'http://127.0.0.1:3426/v1', model: SG, apiKey: '', cacheOriginModels: [CN] } }]) assert.equal(input.make(SG, [CN], additions).cacheRequest(input.request), null);
  const current = input.make(SG, [CN]);
  for (const request of [{ ...input.request, input: { ...input.request.input, verification_version: 'different-prompt' } }, { ...input.request, cacheIdentity: [{ context_id: 'C123', input_sha256: 'e'.repeat(64) }] }, { ...input.request, maxTokens: 16000 }, { ...input.request, phase: 'files' }]) assert.equal(current.cacheRequest(request), null);
  assert.ok(current.cacheRequest(input.request));
});

test('trusted origin still requires original record identity, output digest, source safety and the full strict phase validator', t => {
  for (const mode of ['record-model', 'digest', 'sensitive', 'source-safety', 'shape']) {
    const input = fixture(t), key = semanticCheckpointKey(input.context(CN), input.task);
    const raw = mode === 'sensitive' ? { summary: 'password = "unsafe-test-literal"' } : mode === 'shape' ? { wrong: true } : { summary: 'A normal interpretation.' };
    writeSemanticCheckpoint(input.cacheDirectory, key, raw, mode === 'record-model' ? 'unrelated-route/model' : CN);
    if (mode === 'digest') { const file = path.join(input.cacheDirectory, key + '.json'), parsed = JSON.parse(readFileSync(file)); parsed.output_sha256 = '0'.repeat(64); writeFileSync(file, JSON.stringify(parsed)); }
    const current = input.make(SG, [CN], mode === 'source-safety' ? { validateOutputSafety: () => { throw Error('Full source cannot become prose'); } } : {});
    assert.equal(current.cacheRequest(input.request), null); assert.equal(current.metrics().provenance.origins.length, 0);
  }
});

test('cache allowlist never permits a legacy or unrelated live response model', async t => {
  for (const returnedModel of [CN, 'deepseek-v4.1-flash', 'unrelated/model']) {
    const input = fixture(t); let calls = 0;
    const current = input.make(SG, [CN], { fetchImpl: async () => { calls++; return response({ summary: 'An untrusted live response.' }, returnedModel); } });
    await assert.rejects(current.call(input.request), error => error.code === 'code_analysis_model_invalid' && error.details.reason === 'model_identity');
    assert.equal(calls, 1); assert.equal(readdirSync(input.cacheDirectory).length, 0); assert.equal(current.metrics().provenance.origins.length, 0);
  }
});

test('mixed provenance names current requested route, retained CN responses and actual SG responses without relabelling', async t => {
  const input = fixture(t); input.make(CN).save(input.task, { summary: 'Retained CN interpretation.' }, CN);
  const current = input.make(SG, [CN], { fetchImpl: async () => response({ summary: 'New SG interpretation.' }) });
  assert.equal(current.cacheRequest(input.request).originModel, CN);
  const live = await current.call({ ...input.request, input: { task: 'New semantic work.' } }); assert.equal(live.originModel, SG); assert.equal(live.model, SG);
  const provenance = current.metrics().provenance;
  assert.deepEqual(provenance, { requested_model: SG, origins: [{ kind: 'cache', requested_model: CN, response_model: CN, uses: 1 }, { kind: 'live', requested_model: SG, response_model: SG, uses: 1 }], mixed_origins: true });
  assert.ok(CodeArtifactSchema.safeParse({ schema_version: 1, snapshot_id: input.snapshotId, nodes: [], edges: [], evidence: [], tour: [], coverage: [], semantic_author: { kind: 'agent', model: SG, prompt_version: SEMANTIC_PROMPT_VERSION, provenance } }).success);
});

test('cache origins are explicit model IDs with a bounded administrator-owned allowlist', () => {
  assert.deepEqual(validateSemanticCacheOriginModels(undefined, SG), []); assert.deepEqual(validateSemanticCacheOriginModels([SG, CN, CN], SG), [CN]);
  for (const input of [['*'], ['model\nother'], ['model with spaces'], ['member@model'], Array.from({ length: 9 }, (_, index) => `route/model-${index}`)]) assert.throws(() => validateSemanticCacheOriginModels(input, SG), { code: 'code_analysis_not_configured' });
});
