import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BGE_DIGEST, PUBLIC_NUMERICS_INPUTS, PUBLIC_SEMANTIC_FIXTURES, cosine, rankByCosine,
  runEmbeddingNumericsDiagnostic, runEmbeddingSemanticCompatibilityDiagnostic, vectorEvidence } from './embedding-numerics-diagnostic.mjs';

test('numeric evidence rejects nonfinite, wrong-dimensional and zero vectors', () => {
  assert.equal(vectorEvidence([[1, NaN]], 1, 2).finiteVectors, false);
  assert.equal(vectorEvidence([[1, null]], 1, 2).finiteVectors, false);
  assert.equal(vectorEvidence([[1]], 1, 2).finiteVectors, false);
  assert.equal(vectorEvidence([[0, 0]], 1, 2).nonzeroVectors, false);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([0, 0], [1, 0]), null);
  assert.equal(rankByCosine([{ id: 'irrelevant', vector: [0, 1] }, { id: 'relevant', vector: [1, 0] }], [1, 0])[0].id, 'relevant');
});

test('cross-instance semantic check verifies weights, execution placement, known sources and rank without persisting vectors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsp-embedding-semantic-'));
  try {
    let wrongCpuPlacement = false;
    const fetchImpl = async (raw, init) => {
      const url = new URL(raw), body = init.body ? JSON.parse(init.body) : null;
      let value;
      if (url.pathname === '/api/tags') value = { models: [{ name: 'bge-m3:latest', digest: BGE_DIGEST }] };
      else if (url.pathname === '/api/show') value = { modelfile: 'FROM D:\\models\\blobs\\sha256-' + 'a'.repeat(64), model_info: { 'bert.embedding_length': 1024 } };
      else if (url.pathname === '/api/ps') value = { models: [{ name: 'bge-m3:latest', digest: BGE_DIGEST,
        size_vram: url.port === '11435' && !wrongCpuPlacement ? 0 : 1200000000 }] };
      else {
        assert.ok(['/api/embed', '/v1/embeddings'].includes(url.pathname));
        if (url.pathname === '/api/embed') assert.equal(body.truncate, false);
        else assert.equal(body.encoding_format, 'float');
        assert.equal(body.input.length, 9);
        const source = [...PUBLIC_SEMANTIC_FIXTURES.documents, ...PUBLIC_SEMANTIC_FIXTURES.queries];
        assert.deepEqual(body.input, source.map(item => item.text));
        const embeddings = source.map((_, i) => Array.from({ length: 1024 }, (_, k) => k === (i < 6 ? i : i - 6) ? 1 : 0));
        value = url.pathname === '/api/embed' ? { embeddings, prompt_eval_count: 400 } : { data: embeddings.map(embedding => ({ embedding })), usage: { prompt_tokens: 400 } };
      }
      return new Response(JSON.stringify(value));
    };
    const report = await runEmbeddingSemanticCompatibilityDiagnostic({ outputDir: directory, fetchImpl });
    assert.equal(report.compatibleOnFocusedFixtures, true);
    assert.equal(report.executionPlacementVerified, true);
    assert.equal(report.sameWeightBlobVerified, true);
    assert.equal(report.queries.length, 3);
    assert.ok(report.queries.every(query => query.top1Agree && query.bothTop1Expected && query.fullRankOrderAgree));
    assert.ok(report.vectorComparisons.every(item => item.cosine === 1));
    const stored = await readFile(path.join(directory, 'semantic-compatibility.json'), 'utf8');
    assert.ok(!stored.includes(PUBLIC_SEMANTIC_FIXTURES.documents[0].text));
    assert.ok(!stored.includes('"embeddings"'));
    wrongCpuPlacement = true;
    const misplaced = await runEmbeddingSemanticCompatibilityDiagnostic({ outputDir: path.join(directory, 'wrong-placement'), fetchImpl });
    assert.equal(misplaced.executionPlacementVerified, false);
    assert.equal(misplaced.compatibleOnFocusedFixtures, false);
    wrongCpuPlacement = false;
    const openai = await runEmbeddingSemanticCompatibilityDiagnostic({ outputDir: path.join(directory, 'openai'), fetchImpl,
      models: report.models.map(model => ({ ...model, endpoint: '/v1/embeddings' })) });
    assert.equal(openai.compatibleOnFocusedFixtures, true);
    assert.ok(openai.rows.every(row => row.endpoint === '/v1/embeddings' && row.server.promptEvalCount === 400));
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(), 'tsp-embedding-semantic-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('same-input diagnostic persists numeric evidence without vectors or response errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsp-embedding-numerics-'));
  try {
    const calls = [];
    const fetchImpl = async (raw, init) => {
      const route = new URL(raw).pathname, body = init.body ? JSON.parse(init.body) : null;
      calls.push({ route, body });
      let value;
      if (route === '/api/version') value = { version: '0.14.2' };
      else if (route === '/api/tags') value = { models: [{ name: 'bge-m3:latest', digest: BGE_DIGEST }] };
      else if (route === '/api/ps') value = { models: [{ name: 'bge-m3:latest', digest: BGE_DIGEST, size_vram: 0 }] };
      else {
        assert.ok(['/api/embed', '/v1/embeddings'].includes(route));
        if (route === '/api/embed') assert.equal(body.truncate, false);
        else assert.equal(body.encoding_format, 'float');
        assert.ok(PUBLIC_NUMERICS_INPUTS.some(input => input.text === body.input));
        if (!Object.hasOwn(body.options, 'num_gpu') && body.input === PUBLIC_NUMERICS_INPUTS[0].text) {
          return new Response(JSON.stringify({ error: 'failed to encode response: json: unsupported value: NaN private-error' }), { status: 500 });
        }
        const vector = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0);
        value = route === '/api/embed' ? { embeddings: [vector], prompt_eval_count: 10 } : { data: [{ embedding: vector }], usage: { prompt_tokens: 10 } };
      }
      return new Response(JSON.stringify(value));
    };
    const report = await runEmbeddingNumericsDiagnostic({ outputDir: directory, fetchImpl,
      settings: [{ name: 'native_default', options: {} }, { name: 'cpu', options: { num_gpu: 0 } }] });
    assert.deepEqual(report.allInputsFiniteBySetting, { native_default: false, cpu: true });
    assert.equal(report.rows[0].nanSerializationFailure, true);
    assert.equal(report.comparisons.find(row => row.input === 'preset_user').cosine, 1);
    assert.equal(report.comparisons.find(row => row.input === 'preset_user').samePromptEvalCount, true);
    assert.equal(calls.filter(call => call.route === '/api/embed').length, 6);
    const stored = await readFile(path.join(directory, 'embedding-numerics.json'), 'utf8');
    assert.ok(!stored.includes('private-error'));
    assert.ok(!stored.includes(PUBLIC_NUMERICS_INPUTS[0].text));
    assert.ok(!stored.includes('"embeddings"'));
    const openai = await runEmbeddingNumericsDiagnostic({ outputDir: path.join(directory, 'openai'), fetchImpl,
      settings: [{ name: 'openai_options', endpoint: '/v1/embeddings', options: { num_gpu: 0 } }] });
    assert.equal(openai.allInputsFiniteBySetting.openai_options, true);
    assert.ok(openai.rows.every(row => row.endpoint === '/v1/embeddings' && row.server.promptEvalCount === 10));
    await assert.rejects(runEmbeddingNumericsDiagnostic({ outputDir: directory, baseUrl: 'https://example.org' }));
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(), 'tsp-embedding-numerics-')));
    await rm(directory, { recursive: true, force: true });
  }
});
