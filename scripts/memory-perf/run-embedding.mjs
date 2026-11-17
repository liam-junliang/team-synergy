// Attribution control: same local BGE model, synthetic inputs, no memory-store calls.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { measurePhase } from './common.mjs';
import { loadJson, startObserver, discoverWindowsTargets } from './observe.mjs';
import { syntheticTencentDocument } from './tencent.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = process.env.TSP_PILOT_RUNTIME ?? 'F:/workspace/team-knowledge-runtime';
const profile = await loadJson(path.join(runtime, 'tencent/deployment.json'));
const ov = await loadJson(path.join(runtime, 'openviking/deployment.json'));
const gateway = await loadJson(path.join(runtime, 'tencent/gateway.json'));
const model = gateway.memory.embedding.model, dimensions = gateway.memory.embedding.dimensions;
const base = new URL(gateway.memory.embedding.baseUrl);
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && !base.username && !base.password && !base.search);
const runId = process.argv[2] ?? 'embedding-' + randomBytes(5).toString('hex');
assert.match(runId, /^[a-z0-9-]{8,48}$/iu);
const outputDir = path.join(root, 'docs/experiments/memory-performance', runId, 'embedding-control');
await mkdir(outputDir, { recursive: true });
const listeners = await discoverWindowsTargets([Number(new URL(profile.coreBaseUrl).port), Number(new URL(profile.knowledgeBaseUrl).port), Number(new URL(ov.baseUrl).port)]);
const report = { engine: 'embedding-control', runId, startedAt: new Date().toISOString(), accepted: false,
  model, dimensions, databaseCalls: 0, chatGenerationCalls: 0, phases: [], modelDurations: [],
  limitations: ['Independent request distributions are not subtractable SQL spans.',
    'Ollama total_duration includes scheduling and service overhead; it is not pure GPU execution.',
    'Native /api/embed and OpenAI /v1/embeddings use different response envelopes.',
    'Synthetic document lengths approximate Core workload; this is not token-identical to every Core request.'] };
const fingerprint = async file => createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(path.join(outputDir, 'environment.json'), JSON.stringify({ engine: report.engine, runId,
  capturedAt: report.startedAt, host: { logicalProcessors: os.cpus().length, cpu: os.cpus()[0].model, totalMemoryBytes: os.totalmem() },
  listeners, model, dimensions, codeHashes: { 'run-embedding.mjs': await fingerprint(fileURLToPath(import.meta.url)),
    'common.mjs': await fingerprint(new URL('./common.mjs', import.meta.url)) } }, null, 2));
const observer = await startObserver({ outputDir, pids: listeners.map(row => row.OwningProcess),
  logs: [path.join(runtime, 'tencent/logs/core.log'), path.join(runtime, 'openviking/server.stdout.log')] });
const phaseHook = async event => { await observer.phaseHook(event); if (event.state === 'end') process.stdout.write(JSON.stringify(event) + '\n'); };
let ordinal = 0;
try {
  for (let round = 1; round <= 2; round++) for (const concurrency of round === 1 ? [1, 4, 16] : [16, 4, 1]) {
    for (const wire of ['native', 'openai_float']) {
      const phase = await measurePhase({ engine: report.engine, name: 'embedding_document_' + wire, concurrency, samples: 48, round,
        phaseHook, metadata: { model, dimensions, databaseCalls: 0 }, operation: async (_index, _worker, { warmup }) => {
          const input = syntheticTencentDocument(runId, 0, ordinal++, 1);
          const url = wire === 'native' ? new URL('/api/embed', base) : new URL('/v1/embeddings', base);
          const body = wire === 'native' ? { model, input } : { model, input, encoding_format: 'float' };
          const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
          if (!response.ok) throw Object.assign(Error('embedding_control_failed'), { status: response.status });
          const value = await response.json();
          const vector = wire === 'native' ? value.embeddings?.[0] : value.data?.[0]?.embedding;
          assert.ok(Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite), 'Invalid embedding dimensions or values');
          report.modelDurations.push({ wire, round, concurrency, warmup, inputChars: input.length, inputBytes: Buffer.byteLength(input),
            totalMs: Number.isFinite(value.total_duration) ? value.total_duration / 1e6 : null,
            loadMs: Number.isFinite(value.load_duration) ? value.load_duration / 1e6 : null,
            promptTokens: value.prompt_eval_count ?? value.usage?.prompt_tokens ?? null,
            vectorHash: createHash('sha256').update(JSON.stringify(vector)).digest('hex') });
          return { status: response.status, bytes: Buffer.byteLength(input), verified: true };
        } });
      report.phases.push(phase);
      await writeFile(path.join(outputDir, 'embedding-control.json'), JSON.stringify(report, null, 2));
      if (phase.summary.failed || phase.summary.truncated) throw Error('Control phase failed');
    }
  }
  // One explicit wire-format diagnostic; it has no storage side effect and is
  // excluded from successful throughput/error-rate measurements above.
  const response = await fetch(new URL('/v1/embeddings', base), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: '隔离诊断：验证模型接口的编码格式支持。', encoding_format: 'base64' }),
    signal: AbortSignal.timeout(30000), redirect: 'error' });
  const body = await response.text();
  report.base64WireDiagnostic = { status: response.status, rejected: !response.ok,
    mentionsEncodingFormat: /encoding_format/iu.test(body), mentionsUnsupported: /unsupported/iu.test(body),
    mentionsBase64: /base64/iu.test(body), excludedFromThroughput: true };
  report.accepted = true;
} catch (error) { report.failure = { code: 'embedding_control_failed', status: Number.isInteger(error.status) ? error.status : null }; }
finally {
  report.endedAt = new Date().toISOString();
  await writeFile(path.join(outputDir, 'embedding-control.json'), JSON.stringify(report, null, 2));
  await observer.stop();
}
process.stdout.write(JSON.stringify({ engine: report.engine, runId, accepted: report.accepted, phases: report.phases.length,
  base64WireDiagnostic: report.base64WireDiagnostic }) + '\n');
if (!report.accepted) process.exitCode = 1;
