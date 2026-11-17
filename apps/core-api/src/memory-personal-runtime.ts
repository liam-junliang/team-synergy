import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EngineConfig } from './memory-engines.js';

const inflight = new WeakMap<EngineConfig, Map<string, Promise<{ userId: string; apiKey: string }>>>();
const codePattern = /^[0-9A-HJKMNP-TV-Z]{20}$/u;
function endpoint(config: EngineConfig) {
  const url = new URL(config.openviking.baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) {
    throw Error('Invalid personal engine address');
  }
  return url.href.replace(/\/+$/u, '');
}

/** Pinned OV seeded-key wire contract. Credentials never leave the server. */
function mapping(config: NonNullable<EngineConfig['personalProvisioning']>, principalCode: string) {
  const userId = 'tsp_' + principalCode.toLowerCase();
  const seed = createHmac('sha256', config.keySeed).update(config.accountId + '\0' + principalCode).digest('hex');
  const secret = createHash('sha256').update(userId + '\0' + seed).digest('hex');
  const apiKey = [config.accountId,userId,secret].map(value => Buffer.from(value).toString('base64url')).join('.');
  return { userId, apiKey, seed };
}

export async function ensurePersonalMemoryResource(config: EngineConfig, principalCode: string) {
  if (!codePattern.test(principalCode)) throw Error('Invalid personal identity');
  const existing = config.accounts[principalCode];
  if (existing) return existing;
  if (!config.personalProvisioning) throw Error('Missing personal mapping');
  let pending = inflight.get(config);
  if (!pending) { pending = new Map(); inflight.set(config,pending); }
  const prior = pending.get(principalCode);
  if (prior) return prior;
  const provision = async () => {
    const settings = config.personalProvisioning;
    if (!settings) throw Error('Missing personal mapping');
    const expected = mapping(settings,principalCode), base = endpoint(config);
    const adminPath = '/api/v1/admin/accounts/' + encodeURIComponent(settings.accountId) + '/users';
    const call = async (route: string, key: string, body?: unknown) => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(12000) });
      const data: unknown = response.ok ? await response.json() : (await response.arrayBuffer(), null);
      return { status: response.status, data: data as { status?: string; result?: { user_id?: string; role?: string; user_key?: string }; account_id?: string; user_id?: string } | null };
    };
    let member = await call(adminPath + '/' + expected.userId,settings.adminApiKey);
    if (member.status === 404) {
      const created = await call(adminPath,settings.adminApiKey,{ user_id: expected.userId, role: 'user', seed: expected.seed });
      if (created.status !== 409) {
        const key = created.data?.result?.user_key;
        if (created.status !== 200 || typeof key !== 'string' || key.length !== expected.apiKey.length ||
          !timingSafeEqual(Buffer.from(key),Buffer.from(expected.apiKey))) throw Error('Personal provisioning not verified');
      }
      member = await call(adminPath + '/' + expected.userId,settings.adminApiKey);
    }
    if (member.status !== 200 || member.data?.result?.user_id !== expected.userId ||
      typeof member.data.result.role !== 'string' || member.data.result.role.toLowerCase() !== 'user') {
      throw Error('Personal identity mismatch');
    }
    // Existing identities are never reassigned or silently rotated on a key mismatch.
    const health = await call('/health',expected.apiKey);
    if (health.status !== 200 || health.data?.account_id !== settings.accountId || health.data.user_id !== expected.userId) {
      throw Error('Personal credential not verified');
    }
    const account = { userId: expected.userId, apiKey: expected.apiKey };
    config.accounts[principalCode] = account;
    return account;
  };
  const work = provision().finally(() => pending.delete(principalCode));
  pending.set(principalCode,work);
  return work;
}
