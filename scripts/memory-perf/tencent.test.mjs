import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectTencentCoreRows, createTencentPerfClient, syntheticTencentDocument, tencentPhaseSafetyStop } from './tencent.mjs';

const config = { token: 'fixture-private-token', serviceId: 'fixture-service',
  knowledgeBaseUrl: 'http://127.0.0.1:8424/v2', coreBaseUrl: 'http://127.0.0.1:8420/v2' };

test('Tencent client uses the existing scoped wire contract and preserves response timing', async () => {
  let request;
  const call = createTencentPerfClient(config, { fetchImpl: async (url, init) => {
    request = { url, init };
    return Response.json({ code: 0, data: { accepted_ids: ['synthetic-id'] } }, { status: 200 });
  } });
  const result = await call('core', 'add', { session_id: 'synthetic-session', task_id: 'synthetic-task', messages: [] });
  assert.equal(request.url, config.coreBaseUrl + '/conversation/add');
  assert.equal(request.init.headers['x-tdai-service-id'], config.serviceId);
  assert.equal(request.init.headers['x-tdai-session-id'], 'synthetic-session');
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(result.data, { accepted_ids: ['synthetic-id'] });
  assert.ok(result.elapsedMs >= 0);
  assert.ok(!JSON.stringify(result).includes(config.token));
});

test('HTTP and engine failures retain status but never persist upstream error bodies', async () => {
  const body = 'Bearer secret-from-server-body';
  const http = createTencentPerfClient(config, { fetchImpl: async () => new Response(body, { status: 503 }) });
  await assert.rejects(http('wiki', 'get', { wiki_id: 'synthetic' }), error => {
    assert.equal(error.status, 503); assert.equal(error.safeCode, 'http_503');
    assert.ok(!String(error).includes(body)); return true;
  });
  const envelope = createTencentPerfClient(config, { fetchImpl: async () => Response.json({ code: 4291, message: body }, { status: 200 }) });
  await assert.rejects(envelope('core', 'search', { query: 'synthetic' }), error => {
    assert.equal(error.status, 200); assert.equal(error.safeCode, 'engine_4291');
    assert.ok(!String(error).includes(body)); return true;
  });
});

test('only explicit cleanup reads may interpret HTTP 404 as missing', async () => {
  const call = createTencentPerfClient(config, { fetchImpl: async () => new Response('', { status: 404 }) });
  const readback = await call('wiki', 'get', { wiki_id: 'synthetic' }, { allowMissing: true });
  assert.equal(readback.status, 404); assert.equal(readback.data, null);
  await assert.rejects(call('wiki', 'get', { wiki_id: 'synthetic' }), error => error.safeCode === 'http_404');
});

test('benchmark refuses non-loopback addresses and embeds unambiguous ownership in synthetic documents', () => {
  assert.throws(() => createTencentPerfClient({ ...config, coreBaseUrl: 'https://example.com' }), error => error.code === 'loopback_endpoint_required');
  assert.throws(() => createTencentPerfClient({ ...config, coreBaseUrl: 'http://user:password@127.0.0.1:8420' }));
  const body = syntheticTencentDocument('synthetic-run', 2, 3);
  assert.match(body, /tspperfsynthetic-runproject2slot3/u);
  assert.match(body, /已确认方案但尚未实施/u);
  assert.ok(Buffer.byteLength(body) > 1000);
  assert.ok(!body.includes('project1slot3'));
  assert.ok(syntheticTencentDocument('synthetic-run', 2, 3, 1, true).startsWith('---\ntype: source\nlocked: true\n---'));
});

test('Core collection respects the public 100-row limit and refuses unstable or duplicate paging', async () => {
  const calls = [];
  const records = Array.from({ length: 205 }, (_, n) => ({ id: 'synthetic-' + n }));
  const rows = await collectTencentCoreRows(async ({ limit, offset }) => {
    calls.push({ limit, offset }); return { data: { total: records.length, messages: records.slice(offset, offset + limit) } };
  });
  assert.equal(rows.length, 205); assert.deepEqual(calls, [{ limit: 100, offset: 0 }, { limit: 100, offset: 100 }, { limit: 100, offset: 200 }]);
  await assert.rejects(collectTencentCoreRows(async () => ({ data: { total: 101, messages: [] } })), error => error.safeCode === 'core_query_empty_page');
  await assert.rejects(collectTencentCoreRows(async () => ({ data: { total: 2, messages: [{ id: 'same' }, { id: 'same' }] } })), error => error.safeCode === 'core_query_duplicate_row');
});

test('unsafe or incomplete measured phases stop escalation while preserving the exact 20% boundary', () => {
  assert.equal(tencentPhaseSafetyStop({ total: 0, failed: 0, truncated: true }), 'no_measured_samples');
  assert.equal(tencentPhaseSafetyStop({ total: 47, failed: 0, truncated: true }), 'phase_deadline_exceeded');
  assert.equal(tencentPhaseSafetyStop({ total: 5, failed: 2, truncated: false }), 'measured_error_rate_above_20_percent');
  assert.equal(tencentPhaseSafetyStop({ total: 5, failed: 1, truncated: false }), null);
  assert.equal(tencentPhaseSafetyStop({ total: 48, failed: 0, truncated: false }), null);
});
