import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { authDirectory, readAuthConfig, writeAuthConfig } from './auth-store.js';
import { createApiClient } from './api-client.js';

export interface DeviceIdentity {
  installation_id: string;
  installation_secret: string;
  client_type: 'cli';
  platform: string;
}

export function normalizeApiUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new DomainError('api_url_invalid', '请提供完整的平台 API 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DomainError('api_url_invalid', 'API 地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址');
  }
  return url.toString().replace(/\/+$/, '');
}

function assertNoLinks(target: string): void {
  let current = path.resolve(target);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new DomainError('auth_identity_invalid', '设备身份目录不能使用符号链接或目录联接');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (current === parent) return;
    current = parent;
  }
}

/** Installation proof is scoped to the API address and survives session logout. */
export function readOrCreateDeviceIdentity(apiUrl: string): DeviceIdentity {
  const api = normalizeApiUrl(apiUrl);
  const directory = path.join(authDirectory(), 'devices');
  const file = path.join(directory, `${createHash('sha256').update(api).digest('hex')}.json`);
  assertNoLinks(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const read = (): DeviceIdentity => {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 4096) throw new DomainError('auth_identity_invalid', '本机设备身份文件无效，请保留后检查');
    let value: Partial<DeviceIdentity>;
    try { value = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeviceIdentity>; }
    catch { throw new DomainError('auth_identity_invalid', '本机设备身份文件无法读取，请保留后检查'); }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.installation_id ?? '')
      || !/^[A-Za-z0-9_-]{43}$/.test(value.installation_secret ?? '') || value.client_type !== 'cli') {
      throw new DomainError('auth_identity_invalid', '本机设备身份文件字段无效，请保留后检查');
    }
    return { installation_id: value.installation_id as string, installation_secret: value.installation_secret as string, client_type: 'cli', platform: platform() };
  };
  try { return read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const identity: DeviceIdentity = { installation_id: randomUUID(), installation_secret: randomBytes(32).toString('base64url'), client_type: 'cli', platform: platform() };
  try { writeFileSync(file, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read(); throw error; }
  return identity;
}

/** Attach a legacy device only when its existing authenticated session proves ownership. */
export async function identifyExistingCliDevice(apiUrl: string, identity: DeviceIdentity): Promise<void> {
  const previous = readAuthConfig();
  if (!previous || normalizeApiUrl(previous.api_url) !== apiUrl) return;
  const api = createApiClient({ baseUrl: apiUrl, deviceToken: previous.device_token, requestTimeoutMs: 10_000 });
  // Older servers and expired sessions must not prevent a fresh explicit authentication.
  const result = await api.request<{ device_code: string }>('POST', '/auth/device-identity', { device_identity: identity });
  if (result.ok && /^[0-9A-HJKMNP-TV-Z]{20}$/.test(result.data.device_code)) {
    writeAuthConfig({ ...previous, device_code: result.data.device_code });
  }
}
