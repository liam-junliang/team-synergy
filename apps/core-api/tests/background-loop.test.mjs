import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerBackgroundDrain, registerBackgroundLoop } from '../dist/background-loop.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('closing stops every poll before waiting, then releases the database after all active work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = Fastify(), first = deferred(), second = deferred(), entered = deferred(), hold = deferred();
  const counts = [0, 0], events = [];
  app.addHook('onClose', async () => { events.push('database closed'); });
  for (const [index, gate] of [first, second].entries()) {
    registerBackgroundLoop(app, { intervalMs: 10, onError: () => assert.fail('unexpected work failure'),
      run: async () => { counts[index]++; await gate.promise; events.push(`work ${index} finished`); } });
  }
  app.addHook('preClose', async () => { entered.resolve(); await hold.promise; });
  await app.ready();
  t.mock.timers.tick(10);
  await flush();
  assert.deepEqual(counts, [1, 1]);
  const closing = app.close();
  try {
    await entered.promise;
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(counts, [1, 1], 'shutdown must not admit more polls while an earlier worker is pending');
    hold.resolve();
    first.resolve();
    await flush();
    assert.ok(!events.includes('database closed'));
    second.resolve();
    await closing;
    assert.deepEqual(new Set(events.slice(0, 2)), new Set(['work 0 finished', 'work 1 finished']));
    assert.equal(events.at(-1), 'database closed');
  } finally { first.resolve(); second.resolve(); hold.resolve(); await app.close(); }
});

test('all existing workers receive stop without waiting for another worker, and stop is idempotent', async () => {
  const app = Fastify(), first = deferred(), second = deferred(), entered = deferred(), events = [];
  for (const [index, gate] of [first, second].entries()) registerBackgroundDrain(app, {
    start() { events.push(`start ${index}`); },
    async stop() { events.push(`stop ${index}`); await gate.promise; },
  });
  app.addHook('preClose', async () => { entered.resolve(); });
  await app.ready();
  const closing = app.close();
  try {
    await entered.promise;
    assert.deepEqual(events, ['start 0', 'start 1', 'stop 0', 'stop 1']);
    first.resolve(); second.resolve();
    await closing;
    await app.close();
    assert.equal(events.filter(value => value.startsWith('stop ')).length, 2);
  } finally { first.resolve(); second.resolve(); await app.close(); }
});

test('normal polls remain single-flight, recover after failure, and have no timer after closing', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = Fastify(), gate = deferred();
  let calls = 0, failures = 0;
  registerBackgroundLoop(app, { intervalMs: 10, onError: () => { failures++; }, run: async () => {
    calls++;
    if (calls === 1) { await gate.promise; throw Error('synthetic failure'); }
  } });
  await app.ready();
  try {
    t.mock.timers.tick(100);
    await flush();
    assert.equal(calls, 1);
    gate.resolve(); await flush();
    assert.equal(failures, 1);
    t.mock.timers.tick(10); await flush();
    assert.equal(calls, 2);
    await app.close();
    t.mock.timers.tick(100); await flush();
    assert.equal(calls, 2);
  } finally { gate.resolve(); await app.close(); }
});

test('a worker shutdown error is retained until onClose rather than becoming successful drain', async () => {
  const app = Fastify();
  registerBackgroundDrain(app, { start() {}, async stop() { throw Error('synthetic drain failure'); } });
  await app.ready();
  await assert.rejects(app.close(), /synthetic drain failure/);
});

test('closing an idle poller does not start work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = Fastify(); let calls = 0;
  registerBackgroundLoop(app, { intervalMs: 3000, onError() {}, async run() { calls++; } });
  await app.ready();
  await app.close();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(calls, 0);
});

test('new HTTP writes are rejected during preClose while an accepted request can finish', { timeout: 10_000 }, async () => {
  const app = Fastify(), accepted = deferred(), release = deferred(), closingEntered = deferred(), holdClose = deferred();
  let writes = 0;
  app.post('/write', async () => { writes++; accepted.resolve(); await release.promise; return { saved: true }; });
  app.addHook('preClose', async () => { closingEntered.resolve(); await holdClose.promise; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = app.listeningOrigin;
  const first = fetch(origin + '/write', { method: 'POST' });
  await accepted.promise;
  const closing = app.close();
  try {
    await closingEntered.promise;
    const rejected = await fetch(origin + '/write', { method: 'POST' });
    assert.equal(rejected.status, 503);
    assert.equal(writes, 1);
    release.resolve();
    assert.deepEqual(await (await first).json(), { saved: true });
    holdClose.resolve();
    await closing;
  } finally { release.resolve(); holdClose.resolve(); await app.close(); }
});
