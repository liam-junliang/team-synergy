import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { schema } from '@team-synergy/persistence';
import { createHttpTestContext, insertUser, testCode } from './http-test-helpers.mjs';

test('browser approval logs the real CLI into a stable device with independently revocable sessions', { timeout: 40_000 }, async () => {
  const ctx = await createHttpTestContext(import.meta.url);
  const cliPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const browserToken = 'test-browser-approval-session';
  const authFile = path.join(ctx.authHome, 'auth.json');
  const children = new Set();
  async function request(route, method = 'GET', body, token = browserToken) {
    const response = await fetch(`${ctx.apiUrl}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, payload: await response.json() };
  }
  function startLogin() {
    const child = spawn(process.execPath, [cliPath, 'auth', 'login', '--api', ctx.apiUrl, '--no-browser', '--name', 'Browser-approved CLI'], {
      env: ctx.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    children.add(child);
    let output = '', error = '';
    let resolveCode, rejectCode;
    const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => {
      error += chunk;
      const match = error.match(/agent\/authorize\?code=([A-Z0-9-]+)/);
      if (match) resolveCode(match[1]);
    });
    const done = new Promise((resolve, reject) => {
      child.on('error', (failure) => { rejectCode(failure); reject(failure); });
      child.on('close', (status) => {
        children.delete(child);
        rejectCode(new Error(`Login ended before presenting an authorization code: ${error}`));
        resolve({ status, output, error });
      });
    });
    return { code, done };
  }
  try {
    const user = await insertUser(ctx.db, { code: testCode(980), account: 'browser.approval', displayName: 'Browser Approval' });
    await ctx.db.insert(schema.devices).values({
      code: testCode(981), principal_id: user.id, device_name: 'Legacy browser',
      credential_hash: createHash('sha256').update(browserToken).digest('hex'), created_at: new Date().toISOString(),
    });
    let previous;
    for (let attempt = 0; attempt < 2; attempt++) {
      const login = startLogin();
      const userCode = await login.code;
      const info = await request(`/auth/device/request?user_code=${encodeURIComponent(userCode)}`);
      assert.equal(info.status, 200);
      assert.equal(info.payload.data.device_name, 'Browser-approved CLI');
      assert.equal(info.payload.data.status, 'pending');
      const approval = await request('/auth/device/approve', 'POST', { user_code: userCode, decision: 'approve' });
      assert.equal(approval.status, 200, JSON.stringify(approval.payload));
      const result = await login.done;
      assert.equal(result.status, 0, `${result.output}\n${result.error}`);
      const config = JSON.parse(readFileSync(authFile, 'utf8'));
      assert.equal(config.user_code, user.code);
      assert.ok(!result.output.includes(config.device_token), 'CLI stdout must not reveal a bearer credential');
      assert.equal((await request('/auth/whoami', 'GET', undefined, config.device_token)).status, 200);
      if (previous) {
        assert.equal(config.device_code, previous.device_code);
        assert.notEqual(config.device_token, previous.device_token);
        assert.equal((await request('/auth/whoami', 'GET', undefined, previous.device_token)).status, 200, 'Reauthentication leaves existing sessions intact');
      }
      const devices = await request(`/devices?user_code=${user.code}`);
      assert.equal(devices.payload.data.length, 2, 'Browser and CLI are separate clients; re-login does not duplicate devices');
      const current = devices.payload.data.find((device) => device.device_code === config.device_code);
      assert.equal(current.client_type, 'cli');
      assert.equal(current.session_count, attempt + 1);
      assert.ok(Date.parse(current.last_login_at) >= Date.parse(current.created_at));
      previous = config;
    }
    const sessions = await request(`/devices/${previous.device_code}/sessions`, 'GET', undefined, previous.device_token);
    assert.equal(sessions.payload.data.length, 2);
    assert.equal(sessions.payload.data.filter((session) => session.current).length, 1);
    const logout = await ctx.runCli(['auth', 'logout']);
    assert.equal(logout.status, 0, logout.out);
    assert.equal((await request('/auth/whoami', 'GET', undefined, previous.device_token)).status, 401);
    assert.equal((await request('/auth/whoami')).status, 200, 'CLI logout must not log out the browser');
    const remaining = await request(`/devices/${previous.device_code}/sessions`);
    assert.equal(remaining.payload.data.filter((session) => session.status === 'active').length, 1);
  } finally {
    for (const child of children) child.kill();
    await ctx.cleanup();
  }
});
