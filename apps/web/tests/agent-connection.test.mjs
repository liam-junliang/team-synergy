import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, identity, api, routing, authorization, installer, devices, i18n;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [identity, api, routing, authorization, installer, devices, i18n] = await Promise.all(['clientIdentity.ts', 'api.ts', 'workspaceRouting.ts', 'DeviceAuthorization.tsx', 'CliInstaller.tsx', 'DeviceManagement.tsx', 'i18n.ts'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => i18n.setLocale('zh-CN', false));

function render(Component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
const user = { code: 'U', account: 'liam', display_name: 'Liam', is_system_admin: false, must_change_password: false };
const request = { user_code: 'ABCD-EFGH', device_name: 'Liam laptop', client_type: 'cli', platform: 'win32', status: 'pending', expires_at: '2099-01-01T00:00:00Z' };
const release = { schema_version: 1, version: '0.1.0', release: '0.1.0-hash', node_version: '22.22.0', artifacts: [{ platform: 'win32', arch: 'x64', filename: 'tsp-win32-x64.zip', sha256: 'a'.repeat(64), size_bytes: 10, format: 'zip' }] };

test('authorization URL survives sign-in and initial password change without an automatic grant', () => {
  const href = 'https://platform.example/agent/authorize?code=abcd-efgh';
  assert.deepEqual(routing.parseWorkspacePath('/agent/authorize?code=abcd-efgh'), { view: 'agent', agentTab: 'authorize', authorizationCode: 'ABCD-EFGH' });
  assert.equal(routing.workspacePathAfterLogin(href, false), '/agent/authorize?code=abcd-efgh');
  assert.equal(routing.workspacePathAfterLogin(href, true), '/agent/authorize?code=abcd-efgh');
  assert.ok(routing.isWorkspacePath('/agent/authorize'));
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /PasswordChangePage[\s\S]*?onChanged=[\s\S]*?workspacePathAfterLogin\(window.location.href/);
  let calls = 0;
  const html = render(authorization.DeviceAuthorizationCard, { request, user, busy: false, onDecision() { calls++; } });
  assert.equal(calls, 0);
  assert.match(html, /Liam laptop/); assert.match(html, /ABCD-EFGH/); assert.match(html, /@liam/);
  assert.match(html, /type="checkbox"/); assert.match(html, /disabled="">确认授权/);
  assert.match(html, />拒绝</);
});

test('expired, approved and denied requests cannot render an enabled grant form', () => {
  const cases = [
    [{ ...request, expires_at: '2020-01-01T00:00:00Z' }, undefined, '授权请求已过期'],
    [{ ...request, status: 'denied' }, undefined, '已拒绝这次授权'],
    [{ ...request, status: 'consumed' }, undefined, '授权已完成'],
    [request, 'approve', '授权已完成'],
  ];
  for (const [item, decision, expected] of cases) {
    const html = render(authorization.DeviceAuthorizationCard, { request: item, user, busy: false, decision, onDecision() {} });
    assert.ok(html.includes(expected)); assert.doesNotMatch(html, /type="checkbox"|>确认授权</);
  }
});

test('CLI installer only offers available release artifacts and never source-build commands', () => {
  const html = render(installer.CliInstaller, { apiUrl: 'https://platform.example/api' }, [[['cli-release'], release]]);
  assert.match(html, /Windows/); assert.match(html, /macOS/); assert.match(html, /Linux/);
  assert.match(html, /https:\/\/platform.example\/api\/cli\/install.ps1/);
  assert.match(html, /ExecutionPolicy Bypass/); assert.match(html, /x64/);
  assert.doesNotMatch(html, /pnpm install|npm link|git clone|--token/);
  const missing = render(installer.CliInstaller, { apiUrl: 'https://platform.example/api' }, [[['cli-release'], { ...release, artifacts: [] }]]);
  assert.match(missing, /此平台尚未发布安装包/); assert.doesNotMatch(missing, /Invoke-WebRequest|curl|install.ps1/);
  const pending = render(installer.CliInstaller, { apiUrl: 'https://platform.example/api' });
  assert.match(pending, /正在检查平台发布版本/); assert.doesNotMatch(pending, /Invoke-WebRequest|curl/);
  for (const platform of ['linux', 'darwin']) {
    const command = installer.cliInstallCommand(platform, 'https://platform.example/api');
    assert.match(command, /curl -fsSL.* -o "\$installer" &&\nsh "\$installer"/);
    assert.match(command, /--base-url 'https:\/\/platform.example\/api'/);
    assert.doesNotMatch(command, /\|\s*(sh|bash)/);
  }
});

test('device list displays actual last sign-in and treats unknown historical timestamps honestly', () => {
  const device = { code: 'D', device_name: 'Desktop', created_at: '2020-01-01T00:00:00Z', last_login_at: '2026-10-18T06:00:00Z', client_type: 'cli', platform: 'Windows', current: true, session_count: 2, status: 'active' };
  const html = render(devices.DeviceManagement, { userCode: 'U' }, [[['devices', 'U'], [device]], [['devices', 'OTHER'], [{ ...device, device_name: 'Private other device' }]]]);
  assert.match(html, /当前客户端/); assert.match(html, /最后登录：/); assert.match(html, /dateTime="2026-10-18T06:00:00Z"/);
  assert.doesNotMatch(html, /2020|Private other device/); assert.match(html, /登录会话（2）/);
  const legacy = render(devices.DeviceRow, { userCode: 'U', device: { ...device, current: false, client_type: 'legacy', last_login_at: null } });
  assert.match(legacy, /未知（旧授权记录）/); assert.doesNotMatch(legacy, /2020|当前客户端/);
  const account = readFileSync(new URL('../src/AccountWorkbench.tsx', import.meta.url), 'utf8');
  assert.match(account, /<DeviceManagement key=\{selectedUser.code\} userCode=\{selectedUser.code\}/);
});

test('browser identity is random and stable across login/logout, while session credentials are separate', async () => {
  const previousWindow = globalThis.window; const previousFetch = globalThis.fetch;
  const values = new Map(); const calls = [];
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, dispatchEvent() {} };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, authorization: new Headers(init?.headers).get('Authorization') });
    return new Response(JSON.stringify({ ok: true, data: url.endsWith('/auth/password-login') ? { device_token: 'only-session-token' } : url.endsWith('/auth/whoami') ? user : {} }), { status: 200 });
  };
  try {
    const first = identity.webClientIdentity();
    assert.match(first.installation_id, /^[a-f0-9-]{36}$/i); assert.match(first.installation_secret, /^[a-z0-9_-]{43}$/i);
    await api.loginWebSession({ account: 'liam', password: 'test-password', device_name: 'Chrome · Windows' });
    assert.deepEqual(calls[0].body.device_identity, first);
    assert.equal(calls[1].authorization, 'Bearer only-session-token');
    await api.restoreWebSession();
    assert.deepEqual(calls.find(call => call.url.endsWith('/auth/device-identity')).body, { device_identity: first });
    await api.logoutWebSession();
    assert.deepEqual(identity.webClientIdentity(), first);
    assert.equal(api.hasWebAuthToken(), false);
    assert.equal(values.has(identity.CLIENT_IDENTITY_STORAGE_KEY), true);
    assert.equal(identity.browserClientInfo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Edg/130.0').name, 'Edge · Windows');
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
});

test('session mutations and browser approval use separate authenticated endpoints', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body && JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, data: url.includes('/devices?') ? [{ device_code: 'D', device_name: 'Desktop', created_at: '2020', last_login_at: '2026', client_type: 'cli', platform: 'win32', current: true, session_count: 2, status: 'active' }] : {} }), { status: 200 }); };
  try {
    const list = await api.listDevices('U'); assert.equal(list[0].code, 'D'); assert.equal(list[0].last_login_at, '2026'); assert.equal(list[0].session_count, 2);
    await api.listDeviceSessions('D'); await api.renameDevice('D', 'New name'); await api.revokeSession('S');
    await api.getDeviceAuthorizationRequest('ABCD-EFGH'); await api.decideDeviceAuthorization('ABCD-EFGH', 'deny');
    assert.equal(calls[1].url, '/api/devices/D/sessions'); assert.equal(calls[2].method, 'PATCH'); assert.deepEqual(calls[2].body, { device_name: 'New name' });
    assert.equal(calls[3].url, '/api/sessions/S/revoke'); assert.equal(calls[4].url, '/api/auth/device/request?user_code=ABCD-EFGH');
    assert.deepEqual(calls[5].body, { user_code: 'ABCD-EFGH', decision: 'deny' });
    assert.doesNotMatch(JSON.stringify(calls), /device_code|installation_secret/);
  } finally { globalThis.fetch = previousFetch; }
});

test('all new connection copy is translated and user-owned labels remain verbatim', () => {
  for (const file of ['DeviceManagement.tsx', 'DeviceAuthorization.tsx', 'CliInstaller.tsx']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) assert.ok(i18n.englishMessages[match[1]], `missing translation: ${match[1]}`);
  }
  i18n.setLocale('en-US', false);
  const html = render(authorization.DeviceAuthorizationCard, { request: { ...request, device_name: '我的电脑' }, user, busy: false, onDecision() {} });
  assert.match(html, /Authorize CLI client/); assert.match(html, /我的电脑/); assert.match(html, /disabled="">Authorize/);
});
