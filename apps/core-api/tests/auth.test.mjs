import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { hashPassword } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb,
  insertFeature,
  insertProject,
  insertProjectMember,
  insertTeam,
  insertTeamMember,
  insertUser,
  openTestDb,
  publicCode,
} from './test-db.mjs';

const fixtures = [];
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
let fixtureSequence = 0;

async function createFixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  const createdAt = '2026-08-13T00:00:00.000Z';
  const codeOffset = fixtureSequence * 1000;
  fixtureSequence += 1;

  const owner = await insertUser(db, {
    code: publicCode(codeOffset + 1),
    account: `system.owner.${codeOffset}`,
    display_name: 'Owner',
    status: 'active',
    is_system_admin: true,
    created_at: createdAt,
  });
  const authUser = await insertUser(db, {
    code: publicCode(codeOffset + 2),
    account: `auth.user.${codeOffset}`,
    display_name: 'Auth User',
    status: 'active',
    bind_token_hash: hashToken('bind-route-token'),
    bind_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: createdAt,
  });
  const team = await insertTeam(db, {
    code: publicCode(codeOffset + 11),
    name: `Core Team ${codeOffset}`,
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
    principal_id: authUser.id,
    role: 'member',
    display_name: authUser.display_name,
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
    principal_id: authUser.id,
    project_id: project.id,
    role: 'member',
    display_name: authUser.display_name,
    created_at: createdAt,
  });
  const feature = await insertFeature(db, {
    code: publicCode(31),
    project_id: project.id,
    title: 'Auth Feature',
    status: 'active',
  });

  const fixture = { app, db, owner, authUser, team, project, feature };
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

test('auth routes complete login, whoami, logout, and revoke the bearer token', async () => {
  const { app, db, authUser } = await createFixture();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { bind_token: 'bind-route-token', device_name: 'route-test' },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().ok, true, login.body);
  assert.equal(login.json().data.user_code, authUser.code);
  assert.match(login.json().data.device_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.equal(login.json().data.device_name, 'route-test');

  const deviceToken = login.json().data.device_token;
  const [device] = await db.select().from(schema.devices);
  assert.equal(device.principal_id, authUser.id);
  const [session] = await db.select().from(schema.deviceSessions);
  assert.equal(session.token_hash, hashToken(deviceToken));
  assert.notEqual(device.credential_hash, session.token_hash);
  assert.notEqual(device.credential_hash, deviceToken);

  const headers = { authorization: `Bearer ${deviceToken}` };
  const whoami = await app.inject({ method: 'GET', url: '/auth/whoami', headers });
  assert.equal(whoami.statusCode, 200, whoami.body);
  assert.deepEqual(whoami.json(), {
    ok: true,
    data: {
      user_code: authUser.code,
      account: authUser.account,
      display_name: 'Auth User',
      status: 'active',
      is_system_admin: false,
      must_change_password: false,
    },
  });

  const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.deepEqual(logout.json(), {
    ok: true,
    data: {
      logged_out: true,
      device_code: device.code,
      user_code: authUser.code,
    },
  });

  const revoked = await app.inject({ method: 'GET', url: '/auth/whoami', headers });
  assert.equal(revoked.statusCode, 401, revoked.body);
  assert.equal(revoked.json().ok, false);
  assert.equal(revoked.json().error.code, 'unauthorized');
});

test('initial password login blocks non-auth routes until the user changes password', async () => {
  const { app, db, authUser, team } = await createFixture();
  await db.update(schema.users).set({
    password_hash: await hashPassword('TEMP1234'),
    must_change_password: true,
    password_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }).where(eq(schema.users.id, authUser.id));

  const login = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'TEMP1234', device_name: 'web-initial' },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().data.user_code, authUser.code);

  const headers = { authorization: `Bearer ${login.json().data.device_token}` };
  const gated = await app.inject({ method: 'GET', url: '/teams', headers });
  assert.equal(gated.statusCode, 403, gated.body);
  assert.equal(gated.json().error.code, 'password_change_required');

  // 首次改密也必须携带当前凭据（初始密码），缺失被拒绝。
  const missingCurrent = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers,
    payload: { new_password: 'StrongPass1!' },
  });
  assert.equal(missingCurrent.statusCode, 400, missingCurrent.body);
  assert.equal(missingCurrent.json().ok, false);
  assert.equal(missingCurrent.json().error.code, 'auth_current_password_required');

  const changed = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers,
    payload: { new_password: 'StrongPass1!', current_password: 'TEMP1234' },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { ok: true, data: { user_code: authUser.code, revoked_devices: 0 } });

  const wrong = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'WrongPass1!', device_name: 'web-wrong' },
  });
  assert.equal(wrong.statusCode, 401, wrong.body);
  assert.equal(wrong.json().error.code, 'unauthorized');
  const relogin = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account.toUpperCase(), password: 'StrongPass1!', device_name: 'web-login' },
  });
  assert.equal(relogin.statusCode, 200, relogin.body);
  const teams = await app.inject({
    method: 'GET',
    url: '/teams',
    headers: { authorization: `Bearer ${relogin.json().data.device_token}` },
  });
  assert.equal(teams.statusCode, 200, teams.body);
  assert.equal(teams.json().ok, true);
  assert.equal(teams.json().data[0].team_code, team.code);
});

test('bearer principal takes precedence over x-principal-code on protected and transition routes', async () => {
  const { app, authUser, owner, project } = await createFixture();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { bind_token: 'bind-route-token', device_name: 'precedence-test' },
  });
  const token = login.json().data.device_token;

  const whoami = await app.inject({
    method: 'GET',
    url: '/auth/whoami',
    headers: { authorization: `Bearer ${token}`, 'x-principal-code': owner.code },
  });
  assert.equal(whoami.statusCode, 200, whoami.body);
  assert.equal(whoami.json().data.user_code, authUser.code);

  const feature = await app.inject({
    method: 'POST',
    url: '/features',
    headers: { authorization: `Bearer ${token}`, 'x-principal-code': owner.code },
    payload: { project_code: project.code, title: 'spoofed owner create' },
  });
  assert.equal(feature.statusCode, 403, feature.body);
  assert.equal(feature.json().ok, false);
  assert.equal(feature.json().error.code, 'feature_forbidden');
});

test('system admin can reissue a one-time bind token for an existing user code', async () => {
  const { app, db, owner, authUser } = await createFixture();
  await db.insert(schema.devices).values({
    code: publicCode(41),
    principal_id: owner.id,
    device_name: 'admin',
    credential_hash: hashToken('admin-device-token'),
    created_at: '2026-08-13T00:00:00.000Z',
  });

  const reissued = await app.inject({
    method: 'POST',
    url: `/users/${authUser.code}/bind-token`,
    headers: { authorization: 'Bearer admin-device-token' },
    payload: {},
  });
  assert.equal(reissued.statusCode, 200, reissued.body);
  assert.equal(reissued.json().ok, true, reissued.body);
  assert.equal(reissued.json().data.user_code, authUser.code);
  assert.notEqual(reissued.json().data.bind_token, 'bind-route-token');

  const oldLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { bind_token: 'bind-route-token', device_name: 'old' },
  });
  assert.equal(oldLogin.statusCode, 401, oldLogin.body);

  const newLogin = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { bind_token: reissued.json().data.bind_token, device_name: 'web' },
  });
  assert.equal(newLogin.statusCode, 200, newLogin.body);
  assert.equal(newLogin.json().data.user_code, authUser.code);
});

test('system admin creates a user with a generated public code and ignores caller-supplied user_code', async () => {
  const { app, db, owner } = await createFixture();

  const spoofed = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { 'x-principal-code': owner.code },
    payload: { account: 'spoofed', display_name: 'Spoofed' },
  });
  assert.equal(spoofed.statusCode, 401, spoofed.body);

  await db.insert(schema.devices).values({
    code: publicCode(42),
    principal_id: owner.id,
    device_name: 'admin',
    credential_hash: hashToken('admin-device-token'),
    created_at: '2026-08-13T00:00:00.000Z',
  });
  const created = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { authorization: 'Bearer admin-device-token' },
    payload: {
      user_code: publicCode(999),
      account: 'new.user',
      display_name: 'New User',
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().ok, true, created.body);
  assert.notEqual(created.json().data.user_code, publicCode(999));
  assert.match(created.json().data.user_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  assert.equal(created.json().data.account, 'new.user');
  assert.match(created.json().data.initial_password, /^[A-Z2-9]{8}$/);

  const login = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: {
      account: 'new.user',
      password: created.json().data.initial_password,
      device_name: 'first-login',
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  const whoami = await app.inject({
    method: 'GET',
    url: '/auth/whoami',
    headers: { authorization: `Bearer ${login.json().data.device_token}` },
  });
  assert.equal(whoami.json().data.user_code, created.json().data.user_code);
  assert.equal(whoami.json().data.must_change_password, true);
});

test('password change without current password is rejected once the user has a permanent password', async () => {
  const { app, db, authUser } = await createFixture();
  await db.update(schema.users).set({
    password_hash: await hashPassword('CurrentPass1!'),
    must_change_password: false,
    password_expires_at: null,
  }).where(eq(schema.users.id, authUser.id));

  const login = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'CurrentPass1!', device_name: 'rotate-test' },
  });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { authorization: `Bearer ${login.json().data.device_token}` };

  const missing = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers,
    payload: { new_password: 'StrongPass1!' },
  });
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().ok, false);
  assert.equal(missing.json().error.code, 'auth_current_password_required');

  const wrong = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers,
    payload: { new_password: 'StrongPass1!', current_password: 'WrongPass1!' },
  });
  assert.equal(wrong.statusCode, 401, wrong.body);
  assert.equal(wrong.json().ok, false);
  assert.equal(wrong.json().error.code, 'auth_credentials_invalid');

  // 两次失败后旧密码仍然有效，新密码未生效。
  const stillOld = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'CurrentPass1!', device_name: 'still-old' },
  });
  assert.equal(stillOld.statusCode, 200, stillOld.body);

  // 用最初设备发起改密：保留当前设备，吊销中途登录的 still-old 设备。
  const changed = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers,
    payload: { new_password: 'StrongPass1!', current_password: 'CurrentPass1!' },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.deepEqual(changed.json(), { ok: true, data: { user_code: authUser.code, revoked_devices: 1 } });

  const kept = await app.inject({ method: 'GET', url: '/auth/whoami', headers });
  assert.equal(kept.statusCode, 200, kept.body);
  const revokedToken = await app.inject({
    method: 'GET',
    url: '/auth/whoami',
    headers: { authorization: `Bearer ${stillOld.json().data.device_token}` },
  });
  assert.equal(revokedToken.statusCode, 401, revokedToken.body);
});

test('password change revokes every other device but keeps the calling device', async () => {
  const { app, db, authUser } = await createFixture();
  await db.update(schema.users).set({
    password_hash: await hashPassword('RotatePass1!'),
    must_change_password: false,
    password_expires_at: null,
  }).where(eq(schema.users.id, authUser.id));

  const first = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'RotatePass1!', device_name: 'device-a' },
  });
  const second = await app.inject({
    method: 'POST',
    url: '/auth/password-login',
    payload: { account: authUser.account, password: 'RotatePass1!', device_name: 'device-b' },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);

  const changed = await app.inject({
    method: 'POST',
    url: '/auth/password-change',
    headers: { authorization: `Bearer ${second.json().data.device_token}` },
    payload: { new_password: 'NextPass123!', current_password: 'RotatePass1!' },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.revoked_devices, 1);

  const keptAlive = await app.inject({
    method: 'GET',
    url: '/auth/whoami',
    headers: { authorization: `Bearer ${second.json().data.device_token}` },
  });
  assert.equal(keptAlive.statusCode, 200, keptAlive.body);
  const revoked = await app.inject({
    method: 'GET',
    url: '/auth/whoami',
    headers: { authorization: `Bearer ${first.json().data.device_token}` },
  });
  assert.equal(revoked.statusCode, 401, revoked.body);
  const [audit] = await db.select().from(schema.auditEvents)
    .where(eq(schema.auditEvents.action, 'user.password_changed'))
    .orderBy(schema.auditEvents.id)
    .limit(10);
  assert.ok(audit);
});

test('x-principal-code legacy identity is rejected when the environment switch is off', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAcpEnv = process.env.ACP_ENV;
  process.env.NODE_ENV = 'production';
  process.env.ACP_ENV = 'production';
  const { app } = await createFixture();
  try {
    const denied = await app.inject({
      method: 'GET',
      url: '/teams',
      headers: { 'x-principal-code': publicCode(2) },
    });
    assert.equal(denied.statusCode, 401, denied.body);
    assert.equal(denied.json().error.code, 'legacy_identity_disabled');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousAcpEnv === undefined) delete process.env.ACP_ENV; else process.env.ACP_ENV = previousAcpEnv;
    await app.close();
  }
});
