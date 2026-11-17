import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webSecurityHeaders } from '../security-headers.mjs';

test('Web policy starts in report mode and supports an explicit enforcing rollout', () => {
  const headers = webSecurityHeaders({ development: true, enforce: false });
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy-Report-Only'], /report-uri \/api\/security\/csp-report/);
  assert.match(headers['Content-Security-Policy-Report-Only'], /ws:\/\/127\.0\.0\.1:5173/);
  const production = webSecurityHeaders({ enforce: true });
  assert.equal(production['Content-Security-Policy-Report-Only'], undefined);
  assert.match(production['Content-Security-Policy'], /frame-src 'self' https:/);
  assert.doesNotMatch(production['Content-Security-Policy'], /unsafe-eval|ws:/);
});
