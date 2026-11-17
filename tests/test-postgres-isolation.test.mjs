import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import { assertOwnedTestDatabase, createTestFixture, requireTestContext } from '../scripts/test-database-guard.mjs';

const context = requireTestContext();
test('test credentials cannot open a socket to the runtime port or authenticate as postgres', async t => {
  let sockets = 0;
  t.mock.method(net.Socket.prototype, 'connect', () => { sockets++; throw Error('Unexpected network connection'); });
  for (const change of [{ port: 5432 }, { port: 15432 }, { user: 'postgres' }]) {
    const client = new pg.Client({ host: context.config.host, port: 55432, user: context.config.role,
      password: context.config.password, database: context.lease.databaseName, ...change });
    await assert.rejects(client.connect(), /isolation rejected/u);
  }
  assert.equal(sockets, 0);
});

test('fresh fixture ownership survives public reset and test role cannot change the protected marker', async () => {
  const fixture = await createTestFixture('guardproof');
  const client = new pg.Client({ connectionString: fixture.databaseUrl }); await client.connect();
  try {
    await fixture.assertOwned(client);
    await client.query('drop schema public cascade; create schema public');
    await fixture.assertOwned(client);
    await assert.rejects(client.query("update tsp_test_guard.fixture set fixture_token='forged'"), { code: '42501' });
    await assert.rejects(client.query('alter role tsp_test_runner superuser'), { code: '42501' });
    await assert.rejects(assertOwnedTestDatabase(client, { ...fixture, oid: String(Number(fixture.oid) + 1) }), /isolation rejected/u);
  } finally { await client.end(); await fixture.dispose(); }
});
