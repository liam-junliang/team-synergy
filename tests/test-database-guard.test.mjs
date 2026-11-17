import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDisposableTestDatabase, assertTestDatabaseUrl, verifyTestConnection } from '../scripts/test-database-guard.mjs';

const config = { host: '127.0.0.1', port: 55432, role: 'tsp_test_runner', password: 'TEST_ONLY_RANDOM_SECRET_'.repeat(2),
  systemIdentifier: '123456789', nonce: 'a'.repeat(32), dataDirectory: '/isolated/test/data' };
const good = new URL('postgresql://127.0.0.1:55432/tsp_tests_fixture_123'); good.username = config.role; good.password = config.password;

test('URL pin rejects runtime names, wrong port/host/user and URL options before connecting', () => {
  assert.equal(assertTestDatabaseUrl(good.href, { config }), 'tsp_tests_fixture_123');
  for (const [field, value] of [['pathname','/acp'], ['pathname','/tsp_memory_restore_test'], ['pathname','/team_synergy_test'],
    ['port','5432'], ['port','15432'], ['hostname','localhost'], ['username','postgres'], ['password','business-credential'], ['search','?host=other']]) {
    const url = new URL(good); url[field] = value;
    assert.throws(() => assertTestDatabaseUrl(url.href, { config }), /isolation rejected/u);
  }
});

test('a plausible test name without a trusted live run lease cannot grant authority', () => {
  const previous = process.env.TSP_TEST_RUN_FILE; delete process.env.TSP_TEST_RUN_FILE;
  try { assert.throws(() => assertDisposableTestDatabase(good.href), /isolation rejected/u); }
  finally { if (previous !== undefined) process.env.TSP_TEST_RUN_FILE = previous; }
});

test('invalid connection strings never expose credentials through parser errors', () => {
  const secret = 'do-not-expose-fixture-credential';
  for (const input of ['postgres://user:' + secret + '@[broken', 'postgres://user:' + secret + '@localhost/%zz']) {
    assert.throws(() => assertDisposableTestDatabase(input), error =>
      error.message.includes('isolation rejected') && !String(error.stack).includes(secret) && !('input' in error));
  }
});

test('post-connect verification rejects substituted cluster, role, marker or recreated OID before DDL', async () => {
  const lease = { databaseName: 'tsp_tests_fixture_123', oid: '42', runToken: 'b'.repeat(32), token: 'c'.repeat(32) };
  const identity = { systemIdentifier: config.systemIdentifier, dataDirectory: config.dataDirectory, nonce: config.nonce,
    port: 55432, databaseName: lease.databaseName, oid: '42', owner: config.role,
    fixture: { database_oid: 42, database_name: lease.databaseName, owner_role: config.role, run_token: lease.runToken, fixture_token: lease.token } };
  const row = { role: config.role, current_role: config.role, rolsuper: false, rolcreatedb: true, rolcreaterole: true,
    rolreplication: false, rolbypassrls: false, identity };
  const client = value => ({ query: async () => ({ rows: [value] }) });
  await verifyTestConnection(client(row), lease, config);
  for (const changed of [{ systemIdentifier: '987' }, { nonce: 'd'.repeat(32) }, { oid: '43' }, { owner: 'postgres' },
    { fixture: { ...identity.fixture, fixture_token: 'd'.repeat(32) } }]) {
    await assert.rejects(verifyTestConnection(client({ ...row, identity: { ...identity, ...changed } }), lease, config), /isolation rejected/u);
  }
  await assert.rejects(verifyTestConnection(client({ ...row, rolsuper: true }), lease, config), /isolation rejected/u);
});
