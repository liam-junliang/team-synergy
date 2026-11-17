import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb, insertUser } from './test-db.mjs';

test('body limits reject oversized auth/default requests and retain explicit document limits', async () => {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  try {
    const user = await insertUser(db, { account: 'body.limit', display_name: 'Limits', status: 'active', created_at: new Date().toISOString() });
    const token = 'body-limit-fixture-credential';
    await db.insert(schema.devices).values({ principal_id: user.id, credential_hash: createHash('sha256').update(token).digest('hex'), created_at: new Date().toISOString() });
    const headers = { authorization: `Bearer ${token}` };
    for (const [url, size, method] of [
      ['/auth/password-login', 20 * 1024, 'POST'],
      ['/teams', 1024 * 1024 + 1, 'POST'],
      ['/projects/missing/handoff/documents', 8 * 1024 * 1024 + 1, 'POST'],
      ['/requirement-documents/missing', 8 * 1024 * 1024 + 1, 'PATCH'],
      ['/projects/missing/architecture-documents', 24 * 1024 * 1024 + 1, 'POST'],
      ['/projects/missing/design-prototypes', 30 * 1024 * 1024 + 1, 'POST'],
    ]) {
      const response = await app.inject({ method, url, headers, payload: { padding: 'x'.repeat(size) } });
      assert.equal(response.statusCode, 413, url);
      assert.deepEqual(response.json(), { ok: false, error: { code: 'request_body_too_large', message: 'Request body exceeds the allowed size' } });
    }
    // Missing-resource/schema responses prove parsing reached the handler under each large limit.
    for (const [url, size] of [
      ['/projects/missing/handoff/documents', 2 * 1024 * 1024],
      ['/projects/missing/requirement-documents', 2 * 1024 * 1024],
      ['/projects/missing/architecture-documents', 24 * 1024 * 1024 - 100],
      ['/projects/missing/design-prototypes', 30 * 1024 * 1024 - 100],
    ]) {
      const response = await app.inject({ method: 'POST', url, headers, payload: { padding: 'x'.repeat(size) } });
      assert.notEqual(response.statusCode, 413, url);
      assert.ok(response.statusCode >= 400 && response.statusCode < 500, url);
    }
  } finally { await app.close(); await closeTestDb(db); }
});
