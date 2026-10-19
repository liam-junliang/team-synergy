import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { schema } from '@team-synergy/persistence';
import {
  createHttpTestContext,
  insertMember,
  insertProject,
  insertTeam,
  insertUser,
  testCode,
} from './http-test-helpers.mjs';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

test('agentctl auth login/whoami/logout completes against a real core-api', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const authFile = path.join(ctx.authHome, 'auth.json');
  try {
    const team = await insertTeam(ctx.db, { code: testCode(300) });
    const cliUser = await insertUser(ctx.db, {
      code: testCode(301),
      legacyCode: 'user-cli',
      account: 'cli.user',
      displayName: 'CLI User',
      bindTokenHash: hashToken('bind-cli-token'),
      bindTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const otherUser = await insertUser(ctx.db, {
      code: testCode(302),
      legacyCode: 'user-other',
      account: 'other.user',
      displayName: 'Other User',
    });
    const project = await insertProject(ctx.db, { code: testCode(303), legacyCode: 'PROJECT-A', teamId: team.id });
    await insertMember(ctx.db, { principalId: cliUser.id, projectId: project.id, role: 'member', displayName: 'CLI User' });
    await insertMember(ctx.db, { principalId: otherUser.id, projectId: project.id, role: 'member', displayName: 'Other User' });
    const [feature] = await ctx.db.insert(schema.features).values({
      code: testCode(304),
      legacy_code: 'FEATURE-AUTH-CLI',
      project_id: project.id,
      title: 'Auth CLI',
      status: 'active',
    }).returning();
    await ctx.db.insert(schema.tasks).values([
      {
        code: testCode(305),
        legacy_code: 'TASK-ME',
        feature_id: feature.id,
        title: 'mine',
        profile: 'builder',
        source: 'ad-hoc',
        status: 'assigned',
        assignee_principal_id: cliUser.id,
        acceptance: JSON.stringify([{ id: 'AC-1', text: 'mine' }]),
        base_snapshot: 0,
        created_at: 't0',
      },
      {
        code: testCode(306),
        legacy_code: 'TASK-OTHER',
        feature_id: feature.id,
        title: 'other',
        profile: 'builder',
        source: 'ad-hoc',
        status: 'assigned',
        assignee_principal_id: otherUser.id,
        acceptance: JSON.stringify([{ id: 'AC-1', text: 'other' }]),
        base_snapshot: 0,
        created_at: 't0',
      },
    ]);

    const login = await ctx.runCli(['auth', 'login', '--api', ctx.apiUrl, '--token', 'bind-cli-token', '--name', 'cli-e2e'], {
      ACP_API_URL: '',
      ACP_PRINCIPAL_CODE: '',
      ACP_TOKEN: '',
    });
    assert.equal(login.status, 0, `${login.out}\n${login.err}`);
    assert.equal(JSON.parse(login.out).data.user_code, cliUser.code);
    assert.equal(existsSync(authFile), true);
    const config = JSON.parse(readFileSync(authFile, 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['api_url', 'device_code', 'device_name', 'device_token', 'user_code']);
    assert.equal(config.api_url, ctx.apiUrl);
    assert.equal(config.user_code, cliUser.code);
    assert.equal(config.device_name, 'cli-e2e');

    const whoami = await ctx.runCli(['auth', 'whoami']);
    assert.equal(whoami.status, 0, `${whoami.out}\n${whoami.err}`);
    assert.deepEqual(JSON.parse(whoami.out).data, {
      user_code: cliUser.code,
      account: 'cli.user',
      display_name: 'CLI User',
      status: 'active',
      is_system_admin: false,
      must_change_password: false,
    });

    const mine = await ctx.runCli(['task', 'list'], {
      ACP_PRINCIPAL_CODE: '',
      ACP_TOKEN: '',
    });
    assert.equal(mine.status, 0, `${mine.out}\n${mine.err}`);
    assert.deepEqual(JSON.parse(mine.out).data.map((task) => task.task_code), [testCode(305)]);

    const explicitIdentity = await ctx.runCli(['task', 'list'], {
      ACP_PRINCIPAL_CODE: otherUser.code,
      ACP_TOKEN: '',
    });
    assert.equal(explicitIdentity.status, 0, `${explicitIdentity.out}\n${explicitIdentity.err}`);
    assert.deepEqual(JSON.parse(explicitIdentity.out).data.map((task) => task.task_code), [testCode(306)]);

    const all = await ctx.runCli(['task', 'list', '--all'], {
      ACP_PRINCIPAL_CODE: '',
      ACP_TOKEN: '',
    });
    assert.equal(all.status, 0, `${all.out}\n${all.err}`);
    assert.deepEqual(
      JSON.parse(all.out).data.map((task) => task.task_code).sort(),
      [testCode(305), testCode(306)],
    );

    const logout = await ctx.runCli(['auth', 'logout']);
    assert.equal(logout.status, 0, `${logout.out}\n${logout.err}`);
    assert.equal(JSON.parse(logout.out).data.logged_out, true);
    assert.equal(existsSync(authFile), false);

    const loggedOutWhoami = await ctx.runCli(['auth', 'whoami'], { ACP_API_URL: '' });
    assert.equal(loggedOutWhoami.status, 1);
    assert.equal(JSON.parse(loggedOutWhoami.out).error.code, 'auth_not_logged_in');

    const devices = await ctx.db.select().from(schema.devices);
    assert.equal(devices.length, 1, 'Logout preserves the installation and its execution identity');
    const sessions = await ctx.db.select().from(schema.deviceSessions);
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].revoked_at, 'Logout revokes only the current session');
  } finally {
    await ctx.cleanup();
  }
});

test('agentctl auth login-password and auth passwd complete the initial password lifecycle', async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const authFile = path.join(ctx.authHome, 'auth.json');
  try {
    // 与 packages/application/src/password-auth.ts 相同的 scrypt 哈希格式。
    const { scrypt: nodeScrypt, randomBytes } = await import('node:crypto');
    const hashPassword = async (password) => {
      const salt = randomBytes(16);
      const derived = await new Promise((resolve, reject) => {
        nodeScrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)));
      });
      return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
    };

    const cliUser = await insertUser(ctx.db, {
      code: testCode(310),
      legacyCode: 'user-cli-pwd',
      account: 'cli.pwd',
      displayName: 'CLI Pwd User',
      passwordHash: await hashPassword('TEMP1234'),
      mustChangePassword: true,
      passwordExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    // 初始密码登录：成功但 must_change_password=true，提示需要 passwd。
    const firstLogin = await ctx.runCli(
      ['auth', 'login-password', '--api', ctx.apiUrl, '--account', 'cli.pwd', '--password', 'TEMP1234', '--name', 'pwd-e2e'],
      { ACP_API_URL: '', ACP_PRINCIPAL_CODE: '', ACP_TOKEN: '' },
    );
    assert.equal(firstLogin.status, 0, `${firstLogin.out}\n${firstLogin.err}`);
    const loginData = JSON.parse(firstLogin.out).data;
    assert.equal(loginData.user_code, cliUser.code);
    assert.equal(loginData.must_change_password, true);
    assert.match(loginData.hint, /auth passwd/);
    assert.equal(existsSync(authFile), true);

    // 错误的当前密码被拒绝。
    const wrongCurrent = await ctx.runCli(['auth', 'passwd', '--current', 'WRONG000', '--new', 'StrongPass1!']);
    assert.equal(wrongCurrent.status, 1);
    assert.equal(JSON.parse(wrongCurrent.out).error.code, 'auth_credentials_invalid');

    // 正确改密：成功并返回吊销的其他设备数。
    const change = await ctx.runCli(['auth', 'passwd', '--current', 'TEMP1234', '--new', 'StrongPass1!']);
    assert.equal(change.status, 0, `${change.out}\n${change.err}`);
    assert.equal(JSON.parse(change.out).data.user_code, cliUser.code);
    assert.equal(typeof JSON.parse(change.out).data.revoked_devices, 'number');

    // 改密后 whoami 显示不再强制改密，旧密码不能再登录。
    const whoami = await ctx.runCli(['auth', 'whoami']);
    assert.equal(whoami.status, 0, `${whoami.out}\n${whoami.err}`);
    assert.equal(JSON.parse(whoami.out).data.must_change_password, false);

    const reloginOld = await ctx.runCli(
      ['auth', 'login-password', '--api', ctx.apiUrl, '--account', 'cli.pwd', '--password', 'TEMP1234'],
      { ACP_API_URL: '', ACP_PRINCIPAL_CODE: '', ACP_TOKEN: '' },
    );
    assert.equal(reloginOld.status, 1);

    // --new-password 一步完成登录+首改。
    const secondUser = await insertUser(ctx.db, {
      code: testCode(311),
      legacyCode: 'user-cli-pwd2',
      account: 'cli.pwd2',
      displayName: 'CLI Pwd User Two',
      passwordHash: await hashPassword('TEMPO234'),
      mustChangePassword: true,
      passwordExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const oneShotLogin = await ctx.runCli(
      ['auth', 'login-password', '--api', ctx.apiUrl, '--account', 'cli.pwd2', '--password', 'TEMPO234', '--new-password', 'FinalPass9!'],
      { ACP_API_URL: '', ACP_PRINCIPAL_CODE: '', ACP_TOKEN: '' },
    );
    assert.equal(oneShotLogin.status, 0, `${oneShotLogin.out}\n${oneShotLogin.err}`);
    const oneShotData = JSON.parse(oneShotLogin.out).data;
    assert.equal(oneShotData.user_code, secondUser.code);
    assert.equal(oneShotData.password_changed, true);
    assert.equal(oneShotData.must_change_password, false);
  } finally {
    await ctx.cleanup();
  }
});
