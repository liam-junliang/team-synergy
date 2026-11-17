import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb,
  insertProject,
  insertProjectMember,
  insertTeam,
  insertTeamMember,
  insertUser,
  openTestDb,
  publicCode,
} from './test-db.mjs';

const fixtures = [];
let fixtureSequence = 0;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

async function createFixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  const createdAt = '2026-08-14T00:00:00.000Z';
  const codeOffset = fixtureSequence * 1000;
  fixtureSequence += 1;

  const owner = await insertUser(db, {
    code: publicCode(codeOffset + 1),
    account: `admin.devices.${codeOffset}`,
    display_name: 'Owner',
    status: 'active',
    is_system_admin: true,
    created_at: createdAt,
  });
  const deviceUser = await insertUser(db, {
    code: publicCode(codeOffset + 2),
    account: `device.user.${codeOffset}`,
    display_name: 'Device User',
    status: 'active',
    created_at: createdAt,
  });
  const team = await insertTeam(db, {
    code: publicCode(codeOffset + 11),
    name: `Devices Team ${codeOffset}`,
    created_at: createdAt,
  });
  await insertTeamMember(db, {
    team_id: team.id,
    principal_id: owner.id,
    role: 'owner',
    display_name: owner.display_name,
    created_at: createdAt,
  });
  await insertTeamMember(db, {
    team_id: team.id,
    principal_id: deviceUser.id,
    role: 'member',
    display_name: deviceUser.display_name,
    created_at: createdAt,
  });
  const project = await insertProject(db, {
    code: publicCode(codeOffset + 21),
    team_id: team.id,
    name: `ACP ${codeOffset}`,
    current_snapshot: 1,
    created_at: createdAt,
  });
  await insertProjectMember(db, {
    principal_id: owner.id,
    project_id: project.id,
    role: 'owner',
    display_name: owner.display_name,
    created_at: createdAt,
  });
  await insertProjectMember(db, {
    principal_id: deviceUser.id,
    project_id: project.id,
    role: 'member',
    display_name: deviceUser.display_name,
    created_at: createdAt,
  });
  const [device] = await db.insert(schema.devices).values({
    code: publicCode(codeOffset + 31),
    principal_id: deviceUser.id,
    device_name: 'fixture-device',
    credential_hash: 'must-never-leave-the-api',
    created_at: createdAt,
  }).returning();
  await db.insert(schema.devices).values({
    code: publicCode(codeOffset + 32),
    principal_id: owner.id,
    device_name: 'admin-device',
    credential_hash: hashToken('admin-device-token'),
    created_at: createdAt,
  });

  const fixture = { app, db, owner, deviceUser, device };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture.app.close();
    await closeTestDb(fixture.db);
  }
});

test('device routes expose public fields and revoke by device_code', async () => {
  const { app, db, owner, deviceUser, device } = await createFixture();

  const listed = await app.inject({
    method: 'GET',
    url: `/devices?user_code=${deviceUser.code}`,
    headers: { authorization: 'Bearer admin-device-token' },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), {
    ok: true,
    data: [{
      device_code: device.code,
      device_name: 'fixture-device',
      created_at: '2026-08-14T00:00:00.000Z',
      last_login_at: '2026-08-14T00:00:00.000Z',
      client_type: 'legacy', platform: null, current: false, session_count: 0, status: 'active',
    }],
  });
  assert.equal(Object.hasOwn(listed.json().data[0], 'credential_hash'), false);
  assert.equal(Object.hasOwn(listed.json().data[0], 'device_id'), false);

  const revoked = await app.inject({
    method: 'POST',
    url: `/devices/${device.code}/revoke`,
    headers: { authorization: 'Bearer admin-device-token' },
    payload: {},
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.deepEqual(revoked.json(), {
    ok: true,
    data: { device_code: device.code, user_code: deviceUser.code },
  });

  const empty = await app.inject({
    method: 'GET',
    url: `/devices?user_code=${deviceUser.code}`,
    headers: { authorization: 'Bearer admin-device-token' },
  });
  assert.equal(empty.json().data.length, 1, 'revoked installation history remains available');
  assert.equal(empty.json().data[0].status, 'revoked');
  assert.equal(empty.json().data[0].session_count, 0);

  const audit = (await db.select().from(schema.auditEvents))
    .find((event) => event.entity_id === device.id);
  assert.equal(audit.action, 'device.revoked');
  assert.equal(audit.principal_id, owner.id);
});

test('device list uses a fixed query count and counts only live unrevoked sessions', async () => {
  const { app, db, deviceUser, device } = await createFixture();
  const query = db.$client.query.bind(db.$client);
  async function measured() {
    let calls = 0;
    db.$client.query = (...args) => { calls += 1; return query(...args); };
    try {
      const response = await app.inject({ method: 'GET', url: `/devices?user_code=${deviceUser.code}`, headers: { authorization: 'Bearer admin-device-token' } });
      assert.equal(response.statusCode, 200, response.body);
      return { calls, data: response.json().data };
    } finally { db.$client.query = query; }
  }
  // Initial legacy-token authentication performs a one-time credential upgrade.
  await measured();
  const first = await measured();
  const devices = await db.insert(schema.devices).values(Array.from({ length: 30 }, (_, i) => ({ principal_id: deviceUser.id,
    device_name: `bulk-${i}`, credential_hash: hashToken(`bulk-device-${i}`), created_at: '2026-10-23T00:00:00Z' }))).returning();
  await db.insert(schema.deviceSessions).values([
    { device_id: device.id, token_hash: hashToken('session-live'), created_at: '2026-10-23T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
    { device_id: device.id, token_hash: hashToken('session-expired'), created_at: '2026-10-23T00:00:00Z', expires_at: '2000-01-01T00:00:00Z' },
    { device_id: device.id, token_hash: hashToken('session-revoked'), created_at: '2026-10-23T00:00:00Z', revoked_at: '2026-10-23T00:00:00Z' },
    { device_id: devices[0].id, token_hash: hashToken('session-unbounded'), created_at: '2026-10-23T00:00:00Z' },
  ]);
  const bulk = await measured();
  assert.equal(bulk.calls, first.calls, 'query count must be independent of device count');
  assert.equal(bulk.data.length, 31);
  assert.equal(bulk.data.find(item => item.device_code === device.code).session_count, 1);
  assert.equal(bulk.data.find(item => item.device_code === devices[0].code).session_count, 1);
  console.log(`A-01 devices: ${bulk.calls} DB calls for 1 and 31 devices`);
});
