import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deviceSessionDirectory, DeviceSessionError, localDeviceSession, readDeviceProfile } from '@team-synergy/contracts/device-session';

export class AgentdError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export interface ApiConfig {
  apiUrl: string; deviceToken: string; authDirectory: string; deviceCode?: string; legacyFingerprints?: string[];
  localSession?: ReturnType<typeof localDeviceSession>;
}
export function readApiConfig(): ApiConfig {
  const directory = deviceSessionDirectory();
  const profile = readDeviceProfile(directory);
  let stored: { api_url?: string; device_token?: string; device_code?: string } = profile ?? {};
  if (!profile) {
    try {
      const raw = JSON.parse(readFileSync(path.join(directory, 'auth.json'), 'utf8'));
      if (raw && typeof raw === 'object') stored = raw;
    } catch { /* Legacy config is optional. */ }
  }
  const apiUrl = (process.env.ACP_API_URL?.trim() || stored.api_url || '').replace(/\/+$/, '');
  const overrideToken = process.env.ACP_DEVICE_TOKEN || process.env.ACP_TOKEN;
  const profileUrl = stored.api_url?.replace(/\/+$/, '');
  if (!overrideToken && profileUrl && profileUrl !== apiUrl) throw new AgentdError('auth_profile_mismatch', '当前 API 地址与本机已登录的平台不同，请核对 ACP_API_URL');
  const deviceToken = overrideToken || (profileUrl === apiUrl ? stored.device_token : undefined);
  if (!apiUrl || !deviceToken) throw new AgentdError('unauthorized', 'agentd 需要 tsp auth login 的设备凭据和 core-api 地址');
  const localSession = !overrideToken && profile && profileUrl === apiUrl ? localDeviceSession(apiUrl, profile, directory) : undefined;
  if (stored.device_code && stored.api_url?.replace(/\/+$/, '') === apiUrl) {
    const stable = createHash('sha256').update(`${apiUrl}\ndevice:${stored.device_code}`).digest('hex');
    let fingerprints: string[] = [];
    try {
      const value = JSON.parse(readFileSync(path.join(directory, 'device-sessions', `${stable}.json`), 'utf8')) as { fingerprints?: unknown };
      if (Array.isArray(value.fingerprints)) fingerprints = value.fingerprints.filter((item): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)).slice(-256);
    } catch { /* Legacy installations have no session fingerprint history. */ }
    if (deviceToken === stored.device_token || fingerprints.includes(createHash('sha256').update(deviceToken).digest('hex'))) {
      return { apiUrl, deviceToken, authDirectory: directory, deviceCode: stored.device_code, legacyFingerprints: fingerprints, localSession };
    }
  }
  return { apiUrl, deviceToken, authDirectory: directory, localSession };
}
export function credentialFingerprint(config: ApiConfig): string { return createHash('sha256').update(`${config.apiUrl}\n${config.deviceCode ? `device:${config.deviceCode}` : config.deviceToken}`).digest('hex'); }
export function matchesCredentialFingerprint(config: ApiConfig, fingerprint: string): boolean {
  return fingerprint === credentialFingerprint(config)
    || fingerprint === createHash('sha256').update(`${config.apiUrl}\n${config.deviceToken}`).digest('hex')
    || Boolean(config.deviceCode && config.legacyFingerprints?.includes(fingerprint));
}
export async function apiRequest<T>(config: ApiConfig, method: 'GET'|'POST', url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    const token = config.localSession ? await config.localSession.token() : config.deviceToken;
    response = await fetch(`${config.apiUrl}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  } catch (error) {
    if (error instanceof DeviceSessionError) throw new AgentdError(error.code, error.message);
    throw new AgentdError('api_unreachable', `无法连接 core-api：${error instanceof Error ? error.message : String(error)}`);
  }
  // A reverse proxy may reply before the API has restarted, including with a
  // non-JSON body. The watchdog can use the time remaining on its Run lease.
  if ([502, 503, 504].includes(response.status)) throw new AgentdError('api_unreachable', `core-api 暂时不可用（HTTP ${response.status}）`);
  const result = await response.json() as { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!result.ok) throw new AgentdError(result.error?.code ?? 'api_error', result.error?.message ?? `HTTP ${response.status}`, result.error?.details);
  return result.data as T;
}
