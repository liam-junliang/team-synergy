import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface DeviceSessionReceipt {
  device_token: string;
  session_code?: string;
  refresh_token?: string;
  access_expires_at?: string;
  session_expires_at?: string;
  last_refreshed_at?: string | null;
}

export interface DeviceProfile extends DeviceSessionReceipt {
  api_url: string;
  user_code: string;
  device_name: string;
  device_code?: string;
  refresh_request_id?: string;
  refresh_retry_at?: number;
  upgrade_retry_at?: number;
}

export class DeviceSessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const tokenPattern = /^[a-f0-9]{64}$/;
const renewEarlyMs = 5 * 60_000;

export function deviceSessionDirectory(): string {
  return path.resolve(process.env.AGENTCTL_HOME || path.join(homedir(), '.agentctl'));
}

export function readDeviceProfile(directory = deviceSessionDirectory()): DeviceProfile | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(directory, 'auth.json'), 'utf8')) as Partial<DeviceProfile> & { user_id?: unknown };
    const userCode = typeof raw.user_code === 'string' ? raw.user_code : raw.user_id;
    if (typeof raw.api_url !== 'string' || typeof raw.device_token !== 'string'
      || typeof raw.device_name !== 'string' || typeof userCode !== 'string') return null;
    return { ...raw, api_url: raw.api_url, device_token: raw.device_token, device_name: raw.device_name, user_code: userCode };
  } catch { return null; }
}

export function writeDeviceProfile(directory: string, profile: DeviceProfile): void {
  const target = path.join(directory, 'auth.json');
  const temp = path.join(directory, '.auth-' + randomBytes(16).toString('hex') + '.tmp');
  try {
    writeFileSync(temp, JSON.stringify(profile, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** SQLite's OS lock is automatically released if a CLI command or the supervisor is killed. */
export async function withDeviceProfileLock<T>(directory: string, action: () => Promise<T> | T): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, '.device-session-lock.sqlite');
  const file = await open(lockPath, 'a', 0o600);
  await file.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(lockPath);
  const deadline = Date.now() + 12_000;
  try {
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        if (Date.now() >= deadline) throw new DeviceSessionError('api_unreachable', '另一个本机客户端仍在续期，请稍后重试');
        await delay(75);
      }
    }
    return await action();
  } finally { db.close(); }
}

function normalizeApi(api: string) { return api.replace(/\/+$/, ''); }

export function sameDeviceProfile(left: DeviceProfile, right: DeviceProfile): boolean {
  return normalizeApi(left.api_url) === normalizeApi(right.api_url) && left.user_code === right.user_code && left.device_code === right.device_code
    && (left.session_code && right.session_code ? left.session_code === right.session_code : left.device_token === right.device_token);
}

function expiry(value?: string): number { return typeof value === 'string' ? Date.parse(value) : NaN; }

export function secureDeviceRenewalEndpoint(api: string): boolean {
  try {
    const url = new URL(api);
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

async function readInstallationProof(directory: string, api: string) {
  const file = path.join(directory, 'devices', createHash('sha256').update(api).digest('hex') + '.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096) return undefined;
    const value = JSON.parse(readFileSync(file, 'utf8')) as { installation_id?: string; installation_secret?: string; client_type?: string };
    if (value.client_type !== 'cli' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.installation_id ?? '')
      || !/^[A-Za-z0-9_-]{43}$/.test(value.installation_secret ?? '')) return undefined;
    return { installation_id: value.installation_id, installation_secret: value.installation_secret, client_type: 'cli', platform: process.platform };
  } catch { return undefined; }
}

function expiredSession() {
  return new DeviceSessionError('auth_reauthentication_required', '本机设备授权已失效，请重新运行 tsp auth login');
}

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header && /^\d+$/.test(header) ? Number(header) : 0;
  return seconds > 0 ? Math.min(seconds, 3600) * 1000 : fallback;
}

function checkRenewalReceipt(value: unknown, current: DeviceProfile): DeviceSessionReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as DeviceSessionReceipt;
  const accessExpiry = expiry(receipt.access_expires_at);
  const sessionExpiry = expiry(receipt.session_expires_at);
  if (!tokenPattern.test(receipt.device_token ?? '') || !tokenPattern.test(receipt.refresh_token ?? '')
    || !/^[0-9A-HJKMNP-TV-Z]{20}$/.test(receipt.session_code ?? '')
    || current.session_code && current.session_code !== receipt.session_code
    || !Number.isFinite(accessExpiry) || !Number.isFinite(sessionExpiry) || accessExpiry <= Date.now() || accessExpiry > sessionExpiry
    || receipt.last_refreshed_at != null && !Number.isFinite(expiry(receipt.last_refreshed_at))) return undefined;
  return {
    device_token: receipt.device_token, refresh_token: receipt.refresh_token, session_code: receipt.session_code,
    access_expires_at: receipt.access_expires_at, session_expires_at: receipt.session_expires_at, last_refreshed_at: receipt.last_refreshed_at,
  };
}

export function localDeviceSession(api: string, initial: DeviceProfile, directory = deviceSessionDirectory()) {
  let profile = initial;
  const base = normalizeApi(api);

  function readCurrent() {
    const current = readDeviceProfile(directory);
    if (!current || !sameDeviceProfile(profile, current) || normalizeApi(current.api_url) !== base
      || process.env.ACP_DEVICE_SESSION_CODE && current.session_code !== process.env.ACP_DEVICE_SESSION_CODE) {
      throw new DeviceSessionError('auth_profile_changed', '本机设备授权已切换，请重新执行该命令');
    }
    profile = current;
    return current;
  }

  function needsRenewal(current: DeviceProfile) {
    if (!current.refresh_token) {
      return Boolean(current.device_code && tokenPattern.test(current.device_token) && !(Number(current.upgrade_retry_at) > Date.now()));
    }
    if (current.refresh_request_id) return true;
    const accessExpiry = expiry(current.access_expires_at);
    if (accessExpiry === expiry(current.session_expires_at)) return false;
    return !(accessExpiry > Date.now() + renewEarlyMs);
  }

  async function token(): Promise<string> {
    const current = readCurrent();
    if (expiry(current.session_expires_at) <= Date.now()) throw expiredSession();
    if (!needsRenewal(current)) return current.device_token;
    if (!secureDeviceRenewalEndpoint(base)) {
      if (!current.refresh_token) return current.device_token;
      throw new DeviceSessionError('auth_refresh_https_required', '设备续期需要 HTTPS 或本机回环地址');
    }
    return withDeviceProfileLock(directory, async () => {
      let latest = readCurrent();
      if (!needsRenewal(latest)) return latest.device_token;
      if (expiry(latest.session_expires_at) <= Date.now()) throw expiredSession();
      const proof = await readInstallationProof(directory, base);
      if (!proof) {
        if (!latest.refresh_token) return latest.device_token;
        throw new DeviceSessionError('auth_device_identity_invalid', '本机设备安装身份不可用，请重新登录');
      }
      const refreshing = Boolean(latest.refresh_token);
      if (refreshing && !tokenPattern.test(latest.refresh_request_id ?? '')) {
        latest = { ...latest, refresh_request_id: randomBytes(32).toString('hex') };
        writeDeviceProfile(directory, latest);
      }
      function transient(message: string) {
        if (!refreshing || expiry(latest.access_expires_at) > Date.now() + 5000) return latest.device_token;
        throw new DeviceSessionError('api_unreachable', message);
      }
      if (refreshing && Number(latest.refresh_retry_at) > Date.now()) return transient('平台正在限制续期请求，请稍后重试');
      let response: Response;
      try {
        response = await fetch(base + '/auth/device/' + (refreshing ? 'refresh' : 'upgrade'), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
          headers: { 'content-type': 'application/json', ...(refreshing ? {} : { authorization: 'Bearer ' + latest.device_token }) },
          body: JSON.stringify({ device_identity: proof, ...(refreshing ? { refresh_token: latest.refresh_token, request_id: latest.refresh_request_id } : {}) }),
        });
      } catch {
        return transient('暂时无法连接平台续期设备授权');
      }
      if (response.status === 429 || !refreshing && (response.status === 404 || response.status === 409)) {
        const fallback = response.status === 429 ? 60_000 : 24 * 60 * 60_000;
        const retryAt = Date.now() + retryAfterMs(response, fallback);
        profile = refreshing ? { ...latest, refresh_retry_at: retryAt } : { ...latest, upgrade_retry_at: retryAt };
        writeDeviceProfile(directory, profile);
        return transient('平台正在限制续期请求，请稍后重试');
      }
      if (response.status === 401) throw expiredSession();
      if (!response.ok) {
        return transient('平台暂时无法续期设备授权');
      }
      const result = await response.json().catch(() => null) as { ok?: boolean; data?: unknown } | null;
      const receipt = result?.ok ? checkRenewalReceipt(result.data, latest) : undefined;
      if (!receipt) {
        // A legacy API may reply with a generic route-level envelope.
        return transient('平台设备续期结果暂不可确认');
      }
      const pending = readCurrent();
      if (pending.device_token !== latest.device_token || pending.refresh_request_id !== latest.refresh_request_id) {
        throw new DeviceSessionError('auth_profile_changed', '本机设备授权已切换，请重新执行该命令');
      }
      profile = { ...pending, ...receipt, refresh_request_id: undefined, refresh_retry_at: undefined, upgrade_retry_at: undefined };
      writeDeviceProfile(directory, profile);
      return profile.device_token;
    });
  }

  return { token, currentSessionCode: () => readCurrent().session_code };
}
