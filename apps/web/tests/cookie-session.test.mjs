import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('Web restores HttpOnly sessions and sends CSRF without reading any stored credentials', async () => {
  const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const storage = new Map([['acp.device_token', 'old-session-credential'], ['tsp:web:client-identity:v1', 'old-device-credential']]);
  const calls = [];
  let csrf = 'csrf-first';
  const user = { user_code: 'U', account: 'cookie.user', display_name: 'Cookie User', status: 'active', is_system_admin: false, must_change_password: false };
  globalThis.window = { localStorage: {
    getItem(key) { assert.equal(key, 'acp.auth_user', 'credentials must never be read from localStorage'); return storage.get(key) ?? null; },
    setItem(key, value) { assert.equal(key, 'acp.auth_user', 'only display data may be stored'); storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
  }, dispatchEvent() {} };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, data: url.endsWith('/auth/web/session') || url.endsWith('/auth/web/login') ? { user, csrf_token: csrf } : [] });
  };
  try {
    const api = await vite.ssrLoadModule('/src/api.ts');
    assert.equal((await api.restoreWebSession()).account, 'cookie.user');
    await api.createTeam({ name: 'CSRF team' });
    assert.equal(new Headers(calls.at(-1).init.headers).get('X-CSRF-Token'), 'csrf-first');
    csrf = 'csrf-rotated';
    await api.restoreWebSession();
    await api.createTeam({ name: 'Rotated CSRF' });
    assert.equal(new Headers(calls.at(-1).init.headers).get('X-CSRF-Token'), 'csrf-rotated');
    const successfulFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('fixture network unavailable'); };
    await assert.rejects(api.logoutWebSession(), /fixture network unavailable/);
    assert.equal(api.storedAuthUser()?.account, 'cookie.user', 'a failed sign-out must not pretend the HttpOnly cookie was cleared');
    globalThis.fetch = successfulFetch;
    await api.logoutWebSession();
    assert.equal(new Headers(calls.at(-1).init.headers).get('X-CSRF-Token'), 'csrf-rotated');
    assert.equal(storage.size, 0);
    await api.createTeam({ name: 'Expired session' });
    assert.equal(new Headers(calls.at(-1).init.headers).get('X-CSRF-Token'), null);
    for (const call of calls) {
      assert.equal(call.init.credentials, 'same-origin');
      assert.equal(new Headers(call.init.headers).get('Authorization'), null);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    await vite.close();
  }
});
