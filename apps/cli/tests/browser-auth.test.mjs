import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeApiUrl, readOrCreateDeviceIdentity } from '../dist/device-identity.js';
import { verificationUrl } from '../dist/browser-auth.js';
import { writeAuthConfig, localDeviceFingerprint, matchesLocalDeviceFingerprint, removeAuthConfig } from '../dist/auth-store.js';
import { credentialFingerprint, matchesCredentialFingerprint, readApiConfig } from '../../agentd/dist/api.js';
import { createHash } from 'node:crypto';

test('CLI installation identity persists across logout, is platform-scoped and fails closed on corruption', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tsp-identity-'));
  const previous = process.env.AGENTCTL_HOME;
  process.env.AGENTCTL_HOME = home;
  try {
    const first = readOrCreateDeviceIdentity('https://platform.test/api/');
    assert.deepEqual(readOrCreateDeviceIdentity('https://platform.test/api'), first);
    writeFileSync(path.join(home, 'auth.json'), '{}');
    rmSync(path.join(home, 'auth.json'));
    assert.deepEqual(readOrCreateDeviceIdentity('https://platform.test/api'), first);
    const second = readOrCreateDeviceIdentity('https://another.test/api');
    assert.notEqual(second.installation_id, first.installation_id);
    assert.notEqual(second.installation_secret, first.installation_secret);
    assert.equal(first.installation_secret.length, 43);
    for (const file of readdirSync(path.join(home, 'devices'))) writeFileSync(path.join(home, 'devices', file), '{broken');
    assert.throws(() => readOrCreateDeviceIdentity('https://platform.test/api'), error => error.code === 'auth_identity_invalid');
  } finally {
    if (previous === undefined) delete process.env.AGENTCTL_HOME; else process.env.AGENTCTL_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('authorization URLs use the selected platform and reject embedded credentials and non-HTTP schemes', () => {
  assert.equal(verificationUrl('https://example.test/api', 'ABCD-EFGH'), 'https://example.test/agent/authorize?code=ABCD-EFGH');
  assert.equal(verificationUrl('https://example.test/base/api', 'ABCD-EFGH'), 'https://example.test/base/agent/authorize?code=ABCD-EFGH');
  assert.equal(verificationUrl('http://localhost:8080', 'ABCD-EFGH', 'http://localhost:5173'), 'http://localhost:5173/agent/authorize?code=ABCD-EFGH');
  for (const value of ['file:///tmp/x', 'https://name:secret@example.test', 'https://example.test/api?token=secret', 'https://example.test/#fragment']) {
    assert.throws(() => normalizeApiUrl(value), error => error.code === 'api_url_invalid');
  }
});

test('same-device reauthorization preserves local handover and agentd ownership, including legacy journals', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tsp-relogin-'));
  const names = ['AGENTCTL_HOME', 'ACP_API_URL', 'ACP_TOKEN', 'ACP_DEVICE_TOKEN'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.AGENTCTL_HOME = home;
  try {
    const api = 'https://platform.test/api';
    const config = { api_url: api, user_code: 'USER', device_name: 'Laptop', device_code: 'DEVICE-A', device_token: 'session-one' };
    // The old bearer may be attached only by a successfully authenticated server identity response.
    writeAuthConfig(config);
    const oldHandover = createHash('sha256').update(config.device_token).digest('hex');
    const oldJournal = createHash('sha256').update(`${api}\n${config.device_token}`).digest('hex');
    const stable = localDeviceFingerprint(api, config.device_token);
    removeAuthConfig();
    writeAuthConfig({ ...config, device_token: 'session-two' });
    assert.equal(localDeviceFingerprint(api, 'session-two'), stable);
    assert.equal(matchesLocalDeviceFingerprint(api, 'session-two', oldHandover), true);
    const renewed = readApiConfig();
    assert.equal(credentialFingerprint(renewed), stable);
    assert.equal(matchesCredentialFingerprint(renewed, oldJournal), true);
    writeAuthConfig({ ...config, device_code: 'DEVICE-B', device_token: 'other-device' });
    assert.equal(matchesLocalDeviceFingerprint(api, 'other-device', oldHandover), false);
    assert.equal(matchesCredentialFingerprint(readApiConfig(), oldJournal), false);
    process.env.ACP_DEVICE_TOKEN = 'unrelated-override';
    assert.equal(readApiConfig().deviceCode, undefined, 'Explicit unrelated token must not borrow stored device identity');
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(home, { recursive: true, force: true });
  }
});

async function runBrowserLogin(response, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'tsp-flow-'));
  let startBody;
  let polls = 0;
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.headers.authorization, undefined);
    reply.setHeader('Content-Type', 'application/json');
    if (request.url === '/auth/device/start') {
      startBody = body;
      reply.end(JSON.stringify({ ok: true, data: { device_code: 'private-poll-secret', user_code: 'ABCD-EFGH', expires_in: options.expires ?? 30, interval: 1 } }));
    } else {
      assert.equal(request.url, '/auth/device/token');
      assert.deepEqual(body, { device_code: 'private-poll-secret' });
      polls++;
      reply.end(JSON.stringify(response(polls)));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}`;
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'auth', 'login', '--api', api, '--no-browser', '--name', 'Test laptop'], {
        env: { ...process.env, AGENTCTL_HOME: home, ACP_TOKEN: '', ACP_DEVICE_TOKEN: '', ACP_API_URL: '', ACP_PRINCIPAL_CODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let out = ''; let err = '';
      child.stdout.on('data', data => { out += data; });
      child.stderr.on('data', data => { err += data; });
      child.on('error', reject);
      child.on('close', status => resolve({ status, out, err }));
    });
    const config = (() => { try { return JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8')); } catch { return null; } })();
    return { ...result, config, startBody, polls };
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

test('CLI browser flow waits for explicit approval and stores credentials without printing secrets', async () => {
  const result = await runBrowserLogin(poll => poll === 1
    ? { ok: false, error: { code: 'authorization_pending', message: 'pending' } }
    : { ok: true, data: { device_code: 'DEVICE', device_token: 'private-bearer-secret', user_code: 'USER', device_name: 'Test laptop' } });
  assert.equal(result.status, 0, result.err + result.out);
  assert.equal(result.polls, 2);
  assert.equal(result.config.device_token, 'private-bearer-secret');
  assert.equal(result.startBody.device_identity.client_type, 'cli');
  assert.match(result.err, /agent\/authorize\?code=ABCD-EFGH/);
  assert.doesNotMatch(result.out + result.err, /private-poll-secret|private-bearer-secret/);
  assert.ok(!(result.out + result.err).includes(result.startBody.device_identity.installation_secret));
});

test('CLI browser flow denial and expiration do not save a session', async () => {
  const denied = await runBrowserLogin(() => ({ ok: false, error: { code: 'access_denied', message: 'denied' } }));
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.out).error.code, 'access_denied');
  assert.equal(denied.config, null);
  const expired = await runBrowserLogin(() => { throw new Error('Should expire before polling'); }, { expires: 1 });
  assert.equal(expired.status, 1);
  assert.equal(JSON.parse(expired.out).error.code, 'expired_token');
  assert.equal(expired.config, null);
});
