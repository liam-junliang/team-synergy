import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../dist/server.js';
import { closeTestDb, openTestDb } from './test-db.mjs';

test('GET /health 返回 ok 与 contracts/domain 链路自检', async () => {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.contracts.task_statuses.includes('ready'));
    assert.equal(body.domain_check['draft_to_ready'], true);
    assert.equal(body.domain_check['closed_is_terminal'], true);
  } finally {
    await app.close();
    await closeTestDb(db);
  }
});
