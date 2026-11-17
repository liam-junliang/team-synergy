import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installShutdown, startupFailure } from '../dist/lifecycle.js';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb } from './test-db.mjs';

test('startup errors expose a safe single line through nested database failures', () => {
  for (const code of ['3D000', '28P01', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'OTHER']) {
    const result = startupFailure({ cause: { code, message: 'secret-password\nunsafe' } });
    assert.ok(result.length > 10);
    assert.ok(!result.includes('secret-password'));
    assert.ok(!result.includes('\n'));
  }
});

test('SIGTERM drains an in-flight request and closes once', async () => {
  const app = Fastify();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let closes = 0;
  app.get('/slow', async () => { entered(); await gate; return { done: true }; });
  app.addHook('onClose', async () => { closes++; });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const remove = installShutdown(app);
  try {
    const response = fetch(`${app.listeningOrigin}/slow`);
    await started;
    process.emit('SIGTERM');
    process.emit('SIGINT');
    release();
    assert.deepEqual(await (await response).json(), { done: true });
    await app.close();
    assert.equal(closes, 1);
  } finally { remove(); await app.close(); }
});

test('readiness validates migration head and fails independently of liveness', async () => {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  try {
    assert.equal((await app.inject('/ready')).statusCode, 200);
    assert.ok(db.$client.listenerCount('error') > 0, 'idle pool disconnects must not terminate liveness');
    db.$client.emit('error', new Error('connection lost'));
    assert.equal((await app.inject('/health')).statusCode, 200);
    // A separate fake handle exercises a failed dependency without stopping shared PostgreSQL.
    const unavailable = await buildServer({ db: Object.assign(Object.create(db), {
      $client: { query: async () => { throw new Error('unavailable'); } },
    }), logger: false });
    try {
      assert.equal((await unavailable.inject('/ready')).statusCode, 503);
      assert.equal((await unavailable.inject('/health')).statusCode, 200);
    } finally { await unavailable.close(); }
    const drifted = await buildServer({ db: Object.assign(Object.create(db), {
      $client: { query: async () => ({ rows: [{ hash: 'outdated', created_at: '0' }] }) },
    }), logger: false });
    try {
      assert.equal((await drifted.inject('/ready')).statusCode, 503);
      assert.equal((await drifted.inject('/health')).statusCode, 200);
    } finally { await drifted.close(); }
  } finally { await app.close(); await closeTestDb(db); }
});
