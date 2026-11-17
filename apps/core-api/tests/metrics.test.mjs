import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { schema, openDb, closeDb, observeSlowQueries, withDatabaseRequestContext } from '@team-synergy/persistence';
import { registerMetrics } from '../dist/metrics.js';
import { registerAuthMiddleware } from '../dist/auth.js';
import { openTestDb, closeTestDb, insertUser, insertTeam, insertProject, insertFeature } from './test-db.mjs';

const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.app.close(); await closeTestDb(f.db); } });
async function fixture() {
  const db = await openTestDb();
  const app = Fastify({ logger: false });
  const observerCount = db.$client.listenerCount('tsp:slow-query');
  registerMetrics(app, db);
  registerAuthMiddleware(app, db);
  const users = {};
  for (const name of ['admin', 'member']) {
    const user = await insertUser(db, { account: `metrics.${name}`, display_name: name,
      is_system_admin: name === 'admin', created_at: new Date().toISOString() });
    const token = `metrics-${name}-secret`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: name,
      credential_hash: createHash('sha256').update(token).digest('hex'), created_at: new Date().toISOString() });
    users[name] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  app.get('/observed/:item', async () => ({ ok: true }));
  app.get('/slow/:item', async () => { await db.execute(sql`select pg_sleep(0.51), ${'http-secret'}::text`); return { ok: true }; });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const result = { app, db, users, observerCount, url: app.listeningOrigin };
  fixtures.push(result);
  return result;
}

test('metrics is bearer-admin protected and reports HTTP templates, latency and pool occupancy over real HTTP', async () => {
  const f = await fixture();
  assert.equal((await fetch(`${f.url}/metrics`)).status, 401);
  assert.equal((await fetch(`${f.url}/metrics`, { headers: f.users.member.headers })).status, 403);
  for (const item of ['private-code-1', 'private-code-2']) {
    assert.equal((await fetch(`${f.url}/observed/${item}?token=private-query`, { headers: f.users.member.headers })).status, 200);
  }
  await fetch(`${f.url}/missing-private-path`, { headers: f.users.member.headers });
  const response = await fetch(`${f.url}/metrics`, { headers: f.users.admin.headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const body = await response.text();
  assert.match(body, /tsp_http_requests_total\{method="GET",route="\/observed\/:item",status_code="200"\} 2/);
  assert.match(body, /tsp_http_request_duration_seconds_count\{method="GET",route="\/observed\/:item",status_code="200"\} 2/);
  assert.match(body, /tsp_db_pool_connections\{state="total"\} [1-9]/);
  assert.match(body, /tsp_db_pool_connections\{state="idle"\}/);
  assert.match(body, /tsp_db_pool_connections\{state="active"\}/);
  assert.match(body, /tsp_db_pool_connections\{state="waiting"\}/);
  for (const secret of ['private-code', 'private-query', 'missing-private-path', 'metrics-admin-secret']) assert.ok(!body.includes(secret));
  await f.app.close();
  assert.equal(f.db.$client.listenerCount('tsp:slow-query'), f.observerCount, 'closing the server removes its DB observer');
});

test('business gauges count bounded task and agent states and derive generation success ratio', async () => {
  const f = await fixture();
  const createdAt = new Date().toISOString();
  const team = await insertTeam(f.db, { name: 'Metrics team', created_at: createdAt });
  const project = await insertProject(f.db, { team_id: team.id, name: 'Metrics project', created_at: createdAt });
  const feature = await insertFeature(f.db, { project_id: project.id, title: 'Metric feature' });
  await f.db.insert(schema.tasks).values(['ready', 'ready', 'draft'].map(status => ({
    feature_id: feature.id, title: 'Sensitive task title', profile: 'builder', source: 'ad-hoc', status, base_snapshot: 0, acceptance: '[]', created_at: createdAt,
  })));
  await f.db.insert(schema.systemAgentJobs).values(['awaiting_review', 'applied', 'failed', 'queued'].map((status, i) => ({
    project_id: project.id, document_id: 1n, requester_id: f.users.admin.id, request_key: String(i), request_hash: 'a'.repeat(64),
    base_revision: 1, base_title: 'Secret base title', base_summary: '', base_content: 'Private body', instruction: 'Secret instruction',
    status, created_at: createdAt, updated_at: createdAt,
  })));
  const body = await (await fetch(`${f.url}/metrics`, { headers: f.users.admin.headers })).text();
  assert.match(body, /tsp_tasks\{status="ready"\} 2/);
  assert.match(body, /tsp_tasks\{status="draft"\} 1/);
  assert.match(body, /tsp_system_agent_jobs\{status="failed"\} 1/);
  assert.match(body, /tsp_system_agent_generation_success_ratio 0\.6666666666666666/);
  assert.ok(!body.includes('Sensitive task title') && !body.includes('Private body') && !body.includes('Secret instruction'));
});

test('slow pool, transaction and callback queries report only safe route context and timeout cancels slow statements', async () => {
  const f = await fixture();
  const events = [];
  const remove = observeSlowQueries(f.db, event => events.push(event));
  try {
    assert.equal((await fetch(`${f.url}/slow/private-id?secret=value`, { headers: f.users.member.headers })).status, 200);
    assert.equal(events[0].route, '/slow/:item');
    assert.equal(events[0].method, 'GET');
    assert.equal(typeof events[0].request_id, 'string');
    events.length = 0;
    await withDatabaseRequestContext({ route: '/observed/:item', method: 'GET', request_id: 'safe-request-id' }, async () => {
      await f.db.execute(sql`select pg_sleep(0.51), ${'secret-parameter'}::text`);
      await f.db.transaction(tx => tx.execute(sql`select pg_sleep(0.51), ${'private-transaction'}::text`));
      await new Promise((resolve, reject) => f.db.$client.query('select pg_sleep(0.51), $1::text', ['callback-secret'], error => error ? reject(error) : resolve()));
    });
    assert.equal(events.length, 3);
    for (const event of events) {
      assert.ok(event.duration_ms >= 500);
      assert.deepEqual(Object.keys(event).sort(), ['duration_ms', 'method', 'request_id', 'route']);
      assert.equal(event.route, '/observed/:item');
      assert.equal(event.request_id, 'safe-request-id');
    }
    assert.ok(!JSON.stringify(events).includes('secret') && !JSON.stringify(events).includes('pg_sleep'));
    assert.equal((await f.db.$client.query('show statement_timeout')).rows[0].statement_timeout, '30s');
    await withDatabaseRequestContext({ route: '/failure/:item', method: 'POST', request_id: 'failed-request' },
      () => assert.rejects(f.db.$client.query('select pg_sleep(0.51); select 1/0'), error => error.code === '22012'));
    assert.equal(events.length, 4);
    assert.equal(events.at(-1).route, '/failure/:item');
    assert.ok(!JSON.stringify(events).includes('22012'));
    await assert.rejects(openDb({ statementTimeoutMs: -1 }), /must be an integer/);
    const short = await openDb({ databaseUrl: process.env.TSP_TEST_DATABASE_URL, migrate: false, statementTimeoutMs: 30 });
    try {
      await assert.rejects(short.execute(sql`select pg_sleep(0.2)`), error => (error.cause ?? error).code === '57014');
      assert.equal((await short.$client.query('select 1 as alive')).rows[0].alive, 1);
    } finally { await closeDb(short); }
  } finally { remove(); }
});



test('a failed metrics aggregate returns a sanitized 503 while authenticated HTTP stays usable', async () => {
  const f = await fixture();
  const select = f.db.select;
  f.db.select = function (...args) {
    if (args[0] && Object.hasOwn(args[0], 'status')) throw new Error('database-password private-parameter SQL text');
    return Reflect.apply(select, this, args);
  };
  try {
    const response = await fetch(`${f.url}/metrics`, { headers: f.users.admin.headers });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(JSON.parse(body).error.code, 'metrics_unavailable');
    assert.ok(!body.includes('database-password') && !body.includes('private-parameter') && !body.includes('SQL text'));
    assert.equal((await fetch(`${f.url}/observed/still-working`, { headers: f.users.member.headers })).status, 200);
  } finally { f.db.select = select; }
});
