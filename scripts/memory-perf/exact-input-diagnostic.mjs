// Controlled reproduction of the indexed fixture input; no memory database access.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { syntheticOpenVikingMemoryText } from './openviking.mjs';

const runtime = process.env.TSP_PILOT_RUNTIME ?? 'F:/workspace/team-knowledge-runtime';
const config = JSON.parse((await readFile(path.join(runtime, 'openviking/ov.conf'), 'utf8')).replace(/^\uFEFF/u, ''));
const dense = config.embedding.dense;
const endpoint = new URL(dense.api_base);
assert.ok(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
const input = syntheticOpenVikingMemoryText('20261111-perf-smoke-openviking-e', 27, true);
const inputHash = createHash('sha256').update(input).digest('hex');
assert.equal(inputHash, '16cc1963c9f3f5dd68f30ebfd6e0e1b0bdb058cdbbfabd23599988cb6e5412ff');
const cases = [
  { name: 'openai_exact_string', route: '/v1/embeddings', body: { input, encoding_format: 'float' } },
  { name: 'openai_exact_list_one', route: '/v1/embeddings', body: { input: [input], encoding_format: 'float' } },
  { name: 'openai_exact_list_four', route: '/v1/embeddings', body: { input: [input, input, input, input], encoding_format: 'float' } },
  { name: 'openai_exact_dimensions', route: '/v1/embeddings', body: { input, encoding_format: 'float', dimensions: 1024 } },
  { name: 'native_exact_string', route: '/api/embed', body: { input } },
  { name: 'native_exact_list_one', route: '/api/embed', body: { input: [input] } },
];
const report = { at: new Date().toISOString(), inputHash, inputChars: input.length, inputBytes: Buffer.byteLength(input),
  model: dense.model, databaseCalls: 0, diagnosticNotThroughput: true, cases: [] };
for (const item of cases) {
  const start = performance.now();
  const response = await fetch(new URL(item.route, endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: dense.model, ...item.body }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  const body = await response.text();
  const row = { name: item.name, status: response.status, elapsedMs: performance.now() - start,
    mentionsNaN: /NaN/u.test(body), mentionsFailedEncode: /failed to encode response/iu.test(body),
    mentionsUnsupportedValue: /json: unsupported value/iu.test(body) };
  if (response.ok) {
    const parsed = JSON.parse(body), vectors = parsed.embeddings ?? parsed.data?.map(row => row.embedding);
    row.validVectors = Array.isArray(vectors) && vectors.every(vector => vector.length === 1024 && vector.every(Number.isFinite));
    row.vectorCount = vectors?.length ?? 0;
  }
  report.cases.push(row);
}
const output = new URL('../../docs/experiments/memory-performance/20261111-perf-embedding-control-a/embedding-control/exact-openviking-input.json', import.meta.url);
await writeFile(output, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + '\n');
