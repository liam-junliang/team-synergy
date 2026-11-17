import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerSecurityHeaders } from '../dist/security-headers.js';

test('security headers cover successes and errors without trusting forwarded HTTPS', async () => {
  const app = Fastify();
  await registerSecurityHeaders(app);
  app.get('/ok', async () => ({ ok: true }));
  try {
    for (const url of ['/ok', '/missing']) {
      const response = await app.inject({ url, headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.match(response.headers['content-security-policy-report-only'], /frame-ancestors 'none'/);
      assert.equal(response.headers['strict-transport-security'], undefined);
    }
    const report = await app.inject({ method: 'POST', url: '/security/csp-report', headers: { 'content-type': 'application/csp-report' },
      payload: JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'https://secret.invalid/?token=private' } }) });
    assert.equal(report.statusCode, 204);
    assert.equal(report.body, '');
  } finally { await app.close(); }
});

test('API CSP enforcement is an explicit rollout switch', async () => {
  const previous = process.env.TSP_CSP_MODE;
  process.env.TSP_CSP_MODE = 'enforce';
  const app = Fastify();
  try {
    await registerSecurityHeaders(app);
    app.get('/ok', async () => 'ok');
    const response = await app.inject('/ok');
    assert.match(response.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(response.headers['content-security-policy-report-only'], undefined);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.TSP_CSP_MODE; else process.env.TSP_CSP_MODE = previous;
  }
});
