import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../dist/api-client.js';

test('CLI task array consumer follows pages without dropping filters or tasks', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    const offset = Number(parsed.searchParams.get('offset'));
    return new Response(JSON.stringify({ ok: true, data: [{ task_code: `task-${offset}` }], total: 3,
      page: offset + 1, has_more: offset < 2 }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await createApiClient({ baseUrl: 'http://localhost', principalCode: 'test' })
      .listTasks('?project_code=PROJECT&status=running&limit=1');
    assert.deepEqual(result, { ok: true, data: [{ task_code: 'task-0' }, { task_code: 'task-1' }, { task_code: 'task-2' }] });
    assert.deepEqual(calls.map(url => url.searchParams.get('offset')), ['0', '1', '2']);
    assert.ok(calls.every(url => url.searchParams.get('project_code') === 'PROJECT' && url.searchParams.get('status') === 'running'));
  } finally { globalThis.fetch = originalFetch; }
});
