import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
    process.emit('SIGTERM');
    release();
    assert.deepEqual(await (await response).json(), { done: true });
    await app.close();
    assert.equal(closes, 1);
  } finally { remove(); await app.close(); }
});

test('a timed-out or failed drain exits nonzero without claiming a completed job', () => {
  const lifecycle = new URL('../dist/lifecycle.js', import.meta.url).href;
  for (const mode of ['timeout', 'failure']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { mock } from 'node:test';
      import { installShutdown, API_SHUTDOWN_TIMEOUT_MS } from ${JSON.stringify(lifecycle)};
      mock.timers.enable({apis:['setTimeout']});
      let completed = false;
      const pending = ${mode === 'timeout' ? 'new Promise(() => {})' : "Promise.reject(new Error('secret connection details'))"};
      installShutdown({close:()=>pending.then(()=>{completed=true;})});
      process.emit('SIGTERM');
      ${mode === 'timeout' ? 'mock.timers.tick(API_SHUTDOWN_TIMEOUT_MS);' : 'await new Promise(resolve=>setImmediate(resolve));'}
      if (completed) process.stdout.write('completed');
    `], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, mode === 'timeout' ? /shutdown timed out/ : /shutdown failed/);
    assert.doesNotMatch(result.stderr, /secret connection details/);
  }
});

test('shutdown allows the full 45 second model window instead of forcing exit at 30 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exits = [];
  t.mock.method(process, 'exit', code => { exits.push(code); });
  let release;
  const close = new Promise(resolve => { release = resolve; });
  let closes = 0;
  const remove = installShutdown({ close: () => { closes++; return close; } });
  try {
    process.emit('SIGTERM');
    process.emit('SIGINT');
    t.mock.timers.tick(45_000);
    assert.deepEqual(exits, [], 'an in-flight model request must have its own timeout window');
    assert.equal(closes, 1);
    release();
    await close;
    await Promise.resolve();
    t.mock.timers.tick(90_000);
    assert.deepEqual(exits, [], 'successful drain must clear its deadline');
  } finally { release(); remove(); }
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
