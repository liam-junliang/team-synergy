// Explicit, bounded model-only diagnostics. Importing never contacts a service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syntheticOpenVikingMemoryText } from './openviking.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const rounded = value => Math.round(value * 1e6) / 1e6;
export const BGE_DIGEST = '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab';
export const PUBLIC_NUMERICS_INPUTS = Object.freeze([
  { name: 'preset_resources', text: 'Resources scope. Independent knowledge and resource storage, not bound to specific account or Agent.' },
  { name: 'preset_user', text: "User scope. Stores user's long-term memory, persisted across sessions." },
  { name: 'synthetic_anchor', text: syntheticOpenVikingMemoryText('20261111-perf-smoke-openviking-e', 27, true) },
]);

export const PUBLIC_SEMANTIC_FIXTURES = Object.freeze({
  documents: [
    { id: 'payment_idempotency', text: '订单支付收到重复网关回调时，按业务订单号和支付流水号执行唯一约束。持久化成功后只发布一次履约事件，覆盖并发支付和下游发货幂等验证。' },
    { id: 'refund_review', text: '退款超过七天转人工审核的方案已经确认，但代码尚未实施。需求验收应检查超期分支、人工审核记录和客户通知，不能把方案确认标记为开发完成。' },
    { id: 'one_time_push', text: '一次任务中明确批准提交并推送，只授权当次约定的改动和目标分支。个人提交习惯可以长期记忆；下次没有明确授权时，执行远程推送前应再次确认。' },
    { id: 'wiki_incremental', text: '更新项目Wiki页面时只重建该页面的中文全文索引以及出链和反向链接。外部文件变动后允许完整同步，要求批量更新与重新同步得到相同的检索结果。' },
    { id: 'project_isolation', text: '项目公共知识必须按项目权限隔离，个人风格记忆归账号。跨项目复用通用经验时，不得泄露旧项目业务规则和敏感资料，检索应返回可核验的来源。' },
    { id: 'release_rollback', text: '发布发现回归问题时回滚到经过验证的构建，恢复之前的配置和数据库兼容版本。保留失败发布证据，重新执行登录权限、接口版本和上下游兼容验证。' },
  ],
  queries: [
    { id: 'duplicate_callback', expected: 'payment_idempotency', text: '支付渠道把同一笔到账通知发了两遍，怎样避免重复记账并确认仓库不会发两次货？' },
    { id: 'late_refund', expected: 'refund_review', text: '客户一周后申请退款，团队决定的处理方式是什么，这个决定是否意味着功能已经开发完成？' },
    { id: 'new_push_authorization', expected: 'one_time_push', text: '上次修复时用户让我们推送代码，这次新的修改能直接沿用上次授权上传远程仓库吗？' },
  ],
});

export function rankByCosine(documents, queryVector) {
  return documents.map(document => ({ id: document.id, cosine: cosine(document.vector, queryVector) }))
    .sort((a, b) => (b.cosine ?? -Infinity) - (a.cosine ?? -Infinity) || a.id.localeCompare(b.id));
}

export function vectorEvidence(vectors, expectedCount = 1, dimension = 1024) {
  const finite = Array.isArray(vectors) && vectors.length === expectedCount && vectors.every(vector =>
    Array.isArray(vector) && vector.length === dimension && vector.every(value => typeof value === 'number' && Number.isFinite(value)));
  const norms = finite ? vectors.map(vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))) : [];
  return { finiteVectors: finite, nonzeroVectors: finite && norms.every(norm => norm > 0),
    vectorCount: Array.isArray(vectors) ? vectors.length : null, expectedDimension: dimension,
    norms: norms.map(rounded) };
}

export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length ||
      [...left, ...right].some(value => typeof value !== 'number' || !Number.isFinite(value))) return null;
  let dot = 0, a = 0, b = 0;
  for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; a += left[i] ** 2; b += right[i] ** 2; }
  return a > 0 && b > 0 ? rounded(dot / Math.sqrt(a * b)) : null;
}

export async function runEmbeddingNumericsDiagnostic({ outputDir, baseUrl = 'http://127.0.0.1:11434', fetchImpl = fetch,
  timeoutMs = 30000, maxDurationMs = 180000,
  settings = [{ name: 'native_default', options: {} }, { name: 'cpu', options: { num_gpu: 0 } },
    { name: 'gpu_batch128', options: { num_batch: 128 } }, { name: 'gpu_batch64', options: { num_batch: 64 } }],
} = {}) {
  const url = new URL(baseUrl);
  assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Only a local Ollama root is allowed');
  assert.ok(outputDir && path.isAbsolute(outputDir), 'Use an absolute artifact directory');
  assert.ok(settings.length > 0 && settings.length <= 6 && settings.every(item => /^[a-zA-Z0-9_-]+$/u.test(item.name) &&
    (!item.endpoint || ['/api/embed', '/v1/embeddings'].includes(item.endpoint)) &&
    Object.entries(item.options).every(([key, value]) => ['num_gpu', 'num_batch'].includes(key) && Number.isSafeInteger(value) && value >= 0)), 'Use bounded numerical options');
  const report = { schema: 'embedding-numerics-diagnostic/v1', startedAt: new Date().toISOString(),
    model: 'bge-m3', expectedModelDigest: BGE_DIGEST, modelDimension: 1024, databaseCalls: 0,
    publicSyntheticInputsOnly: true, vectorsPersisted: false, requestsAreSerial: true,
    nativeTruncateFalseRequested: true, openaiTruncateOption: 'not exposed; short fixtures and token counts are compared',
    settings, inputs: PUBLIC_NUMERICS_INPUTS.map(input => ({ name: input.name, sha256: sha(input.text), bytes: Buffer.byteLength(input.text) })),
    references: [
      'https://raw.githubusercontent.com/ollama/ollama/v0.14.2/api/types.go#L542-L575',
      'https://docs.ollama.com/api/embed',
    ], rows: [], loadedModelSnapshots: [], comparisons: [],
    limitations: ['Tiny numerical diagnostic, not a throughput benchmark. Load and runner-reallocation time are included and reported separately when available.',
      'Same weights and dimensions alone do not prove retrieval equivalence; cosine on previously finite inputs is only a compatibility check.',
      'Runtime options can reload a runner, but this script never changes persisted model parameters, aliases, deployment files or service configuration.'] };
  const save = async () => { await mkdir(outputDir, { recursive: true }); await writeFile(path.join(outputDir, 'embedding-numerics.json'), JSON.stringify(report, null, 2)); };
  const request = async (route, body) => {
    const response = await fetchImpl(url.origin + route, { method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, data, nanSerializationFailure: /NaN/u.test(text) && /(?:encode|unsupported value)/u.test(text) };
  };
  const snapshots = async setting => {
    const response = await request('/api/ps');
    report.loadedModelSnapshots.push({ setting, at: new Date().toISOString(), status: response.status,
      models: (response.data?.models ?? []).filter(model => model.name === 'bge-m3:latest' || model.name === 'bge-m3').map(model => ({
        name: model.name, digest: model.digest, sizeBytes: model.size, vramBytes: model.size_vram, contextLength: model.context_length })) });
  };
  const vectors = new Map(); const began = performance.now();
  try {
    const [version, tags] = await Promise.all([request('/api/version'), request('/api/tags')]);
    report.ollamaVersion = version.data?.version;
    const model = tags.data?.models?.find(item => item.name === 'bge-m3:latest' || item.name === 'bge-m3');
    report.actualModelDigest = model?.digest;
    assert.equal(model?.digest, BGE_DIGEST, 'The pinned model digest must match');
    await snapshots('before'); await save();
    for (const setting of settings) {
      for (const input of PUBLIC_NUMERICS_INPUTS) {
        if (performance.now() - began >= maxDurationMs) { report.truncated = true; break; }
        const at = new Date().toISOString(), start = performance.now();
        const row = { setting: setting.name, input: input.name, inputHash: sha(input.text), at };
        try {
          const endpoint = setting.endpoint ?? '/api/embed';
          const response = await request(endpoint, { model: 'bge-m3', input: input.text, options: setting.options,
            ...(endpoint === '/api/embed' ? { truncate: false } : { encoding_format: 'float' }) });
          const returnedVectors = endpoint === '/api/embed' ? response.data?.embeddings : response.data?.data?.map(row => row.embedding);
          Object.assign(row, { status: response.status, elapsedMs: rounded(performance.now() - start),
            endpoint, nanSerializationFailure: response.nanSerializationFailure, ...vectorEvidence(returnedVectors),
            server: { totalDurationNs: response.data?.total_duration ?? null, loadDurationNs: response.data?.load_duration ?? null,
              promptEvalCount: response.data?.prompt_eval_count ?? response.data?.usage?.prompt_tokens ?? null } });
          if (row.finiteVectors && row.nonzeroVectors) vectors.set(setting.name + ':' + input.name, returnedVectors[0]);
        } catch (error) { Object.assign(row, { elapsedMs: rounded(performance.now() - start),
          requestFailure: ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'request_failed', finiteVectors: false }); }
        report.rows.push(row); await save();
      }
      await snapshots(setting.name); await save();
      if (report.truncated) break;
    }
    for (const input of PUBLIC_NUMERICS_INPUTS) {
      for (const setting of settings.filter(item => item.name !== 'cpu')) {
        const base = vectors.get('cpu:' + input.name), candidate = vectors.get(setting.name + ':' + input.name);
        const cpuRow = report.rows.find(row => row.setting === 'cpu' && row.input === input.name);
        const row = report.rows.find(row => row.setting === setting.name && row.input === input.name);
        report.comparisons.push({ input: input.name, reference: 'cpu', candidate: setting.name, cosine: cosine(base, candidate),
          samePromptEvalCount: Number.isInteger(cpuRow?.server?.promptEvalCount) && Number.isInteger(row?.server?.promptEvalCount) ?
            cpuRow.server.promptEvalCount === row.server.promptEvalCount : null });
      }
    }
    report.allInputsFiniteBySetting = Object.fromEntries(settings.map(setting => [setting.name,
      PUBLIC_NUMERICS_INPUTS.every(input => report.rows.some(row => row.setting === setting.name && row.input === input.name && row.status === 200 && row.finiteVectors && row.nonzeroVectors))]));
  } catch (error) { report.failure = { name: ['AssertionError', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'diagnostic_failed' }; }
  finally { report.endedAt = new Date().toISOString(); report.elapsedMs = rounded(performance.now() - began); await save(); }
  return report;
}

/** Run only in a root-coordinated model window after the CPU service is ready. */
export async function runEmbeddingSemanticCompatibilityDiagnostic({ outputDir, fetchImpl = fetch, timeoutMs = 45000,
  models = [{ name: 'gpu_reference', model: 'bge-m3', baseUrl: 'http://127.0.0.1:11434', options: { num_gpu: 99 }, expectedDevice: 'gpu' },
    { name: 'cpu_instance', model: 'bge-m3', baseUrl: 'http://127.0.0.1:11435', options: {}, expectedDevice: 'cpu' }],
} = {}) {
  assert.ok(outputDir && path.isAbsolute(outputDir));
  assert.equal(models.length, 2, 'Compare exactly two execution configurations');
  const origins = models.map(model => {
    const url = new URL(model.baseUrl);
    assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
    assert.match(model.name, /^[a-zA-Z0-9_-]{1,64}$/u);
    assert.match(model.model, /^[a-zA-Z0-9_.:/-]{1,100}$/u);
    assert.ok(!model.endpoint || ['/api/embed', '/v1/embeddings'].includes(model.endpoint));
    return url.origin;
  });
  const fixtures = [...PUBLIC_SEMANTIC_FIXTURES.documents, ...PUBLIC_SEMANTIC_FIXTURES.queries];
  const report = { schema: 'embedding-semantic-compatibility/v1', startedAt: new Date().toISOString(),
    modelDimension: 1024, databaseCalls: 0, publicSyntheticInputsOnly: true, vectorsPersisted: false,
    nativeTruncateFalseRequested: true, openaiTruncateOption: 'not exposed; short fixtures and token counts are compared',
    fixtures: fixtures.map(item => ({ id: item.id, expected: item.expected, sha256: sha(item.text), bytes: Buffer.byteLength(item.text) })),
    models, modelMetadata: [], rows: [], loadedModelSnapshots: [], vectorComparisons: [], queries: [],
    limitation: 'Six documents and three queries are a focused compatibility check, not a general retrieval-quality or throughput benchmark.' };
  const save = async () => { await mkdir(outputDir, { recursive: true }); await writeFile(path.join(outputDir, 'semantic-compatibility.json'), JSON.stringify(report, null, 2)); };
  const request = async (origin, route, body) => {
    const response = await fetchImpl(origin + route, { method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, data, nanSerializationFailure: /NaN/u.test(text) && /(?:encode|unsupported value)/u.test(text) };
  };
  const vectors = new Map();
  try {
    for (const [i, model] of models.entries()) {
      const [tags, show] = await Promise.all([request(origins[i], '/api/tags'), request(origins[i], '/api/show', { model: model.model })]);
      const metadata = tags.data?.models?.find(item => item.name === model.model || item.name === model.model + ':latest');
      const from = /^FROM\s+(.+)$/mu.exec(show.data?.modelfile ?? '')?.[1] ?? '';
      const weightBlobSha256 = /sha256[-:]([a-f0-9]{64})/u.exec(from)?.[1] ?? null;
      report.modelMetadata.push({ configuration: model.name, manifestDigest: metadata?.digest ?? null, weightBlobSha256,
        embeddingDimensions: Object.entries(show.data?.model_info ?? {}).filter(([key]) => key.endsWith('.embedding_length')).map(([, value]) => value),
        cpuParameterInModel: /(?:^|\n)\s*num_gpu\s+0(?:\s|$)/u.test(show.data?.parameters ?? '') });
      assert.equal(tags.status, 200); assert.equal(show.status, 200); assert.ok(metadata && weightBlobSha256, 'Models and exact weight blobs must be identifiable');
    }
    assert.ok(report.modelMetadata.every(model => model.manifestDigest === BGE_DIGEST), 'Both instances must serve the pinned BGE model');
    assert.equal(report.modelMetadata[0].weightBlobSha256, report.modelMetadata[1].weightBlobSha256, 'Compare identical weight blobs');
    report.sameWeightBlobVerified = true; await save();
    for (const [i, model] of models.entries()) {
      const began = performance.now();
      const endpoint = model.endpoint ?? '/api/embed';
      const response = await request(origins[i], endpoint, { model: model.model, input: fixtures.map(item => item.text),
        ...(endpoint === '/api/embed' ? { options: model.options, truncate: false } : { encoding_format: 'float' }) });
      const returnedVectors = endpoint === '/api/embed' ? response.data?.embeddings : response.data?.data?.map(item => item.embedding);
      const numeric = vectorEvidence(returnedVectors, fixtures.length);
      report.rows.push({ configuration: model.name, at: new Date().toISOString(), status: response.status,
        endpoint, truncateFalseRequested: endpoint === '/api/embed', elapsedMs: rounded(performance.now() - began),
        nanSerializationFailure: response.nanSerializationFailure, ...numeric,
        server: { promptEvalCount: response.data?.prompt_eval_count ?? response.data?.usage?.prompt_tokens ?? null,
          totalDurationNs: response.data?.total_duration ?? null, loadDurationNs: response.data?.load_duration ?? null } });
      if (numeric.finiteVectors && numeric.nonzeroVectors) vectors.set(model.name, returnedVectors);
      const ps = await request(origins[i], '/api/ps');
      report.loadedModelSnapshots.push({ afterConfiguration: model.name, at: new Date().toISOString(), status: ps.status,
        models: (ps.data?.models ?? []).filter(item => models.some(candidate => item.name === candidate.model || item.name === candidate.model + ':latest'))
          .map(item => ({ name: item.name, digest: item.digest, vramBytes: item.size_vram, sizeBytes: item.size, contextLength: item.context_length })) });
      await save();
    }
    const [left, right] = models.map(model => vectors.get(model.name));
    if (left && right) {
      report.vectorComparisons = fixtures.map((item, i) => ({ id: item.id, cosine: cosine(left[i], right[i]) }));
      for (const [queryIndex, query] of PUBLIC_SEMANTIC_FIXTURES.queries.entries()) {
        const rankings = Object.fromEntries(models.map(model => {
          const matrix = vectors.get(model.name);
          return [model.name, rankByCosine(PUBLIC_SEMANTIC_FIXTURES.documents.map((item, i) => ({ id: item.id, vector: matrix[i] })), matrix[PUBLIC_SEMANTIC_FIXTURES.documents.length + queryIndex])];
        }));
        const [a, b] = models.map(model => rankings[model.name]);
        report.queries.push({ id: query.id, expected: query.expected, rankings,
          top1Agree: a[0].id === b[0].id, bothTop1Expected: a[0].id === query.expected && b[0].id === query.expected,
          fullRankOrderAgree: a.map(item => item.id).join('|') === b.map(item => item.id).join('|'),
          maxPairwiseScoreDelta: rounded(Math.max(...a.map(item => Math.abs(item.cosine - b.find(other => other.id === item.id).cosine)))) });
      }
    }
    report.executionPlacementVerified = models.every(model => {
      const snapshot = report.loadedModelSnapshots.find(item => item.afterConfiguration === model.name);
      const loaded = snapshot?.models.find(item => item.name === model.model || item.name === model.model + ':latest');
      return loaded?.digest === BGE_DIGEST && Number.isFinite(loaded?.vramBytes) &&
        (model.expectedDevice === 'cpu' ? loaded.vramBytes === 0 : model.expectedDevice === 'gpu' && loaded.vramBytes > 0);
    });
    report.compatibleOnFocusedFixtures = report.executionPlacementVerified && Boolean(left && right) && report.queries.length === 3 &&
      report.queries.every(query => query.top1Agree && query.bothTop1Expected) && report.vectorComparisons.every(item => item.cosine >= 0.99);
  } catch (error) { report.failure = { name: ['AssertionError', 'TimeoutError', 'TypeError'].includes(error.name) ? error.name : 'diagnostic_failed' };
    report.compatibleOnFocusedFixtures = false; }
  finally { report.endedAt = new Date().toISOString(); await save(); }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--run', 'Real model calls require --run and an absolute output directory');
  assert.ok(process.argv[3] && path.isAbsolute(process.argv[3]), 'An absolute output directory is required');
  const result = await runEmbeddingNumericsDiagnostic({ outputDir: process.argv[3] });
  console.log(JSON.stringify({ path: path.join(process.argv[3], 'embedding-numerics.json'),
    allInputsFiniteBySetting: result.allInputsFiniteBySetting, truncated: result.truncated ?? false, failure: result.failure ?? null }));
}
