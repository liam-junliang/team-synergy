import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSystemAgentRoutes } from '../dist/routes/system-agent.js';

test('system-agent HTTP responses never serialize SQL or driver secrets', async () => {
  const cause = new Error('SELECT private_body FROM users; password=must-not-leak');
  const db = { select() { throw cause; }, transaction() { throw cause; } };
  const app = Fastify({ logger: false });
  app.decorateRequest('principal', 'authenticated-test-user');
  registerSystemAgentRoutes(app, db, { isConfigured: () => true });
  try {
    const requests = [
      { method: 'GET', url: '/projects/project/system-agent/jobs' },
      { method: 'GET', url: '/system-agent/jobs/job' },
      { method: 'POST', url: '/projects/project/system-agent/jobs', payload: { document_code: 'document', base_revision: 1, instruction: 'Clarify purpose', request_key: 'request' } },
      { method: 'POST', url: '/system-agent/jobs/job/cancel' },
      { method: 'POST', url: '/system-agent/jobs/job/reject' },
      { method: 'POST', url: '/system-agent/jobs/job/apply', payload: { proposal_hash: 'hash', base_revision: 1 } },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      assert.deepEqual(response.json(), { ok: false, error: { code: 'internal_error', message: '系统 Agent 暂时无法完成操作，请稍后重试' } });
      assert.doesNotMatch(response.body, /SELECT|private_body|password|must-not-leak/);
    }
  } finally { await app.close(); }
});
