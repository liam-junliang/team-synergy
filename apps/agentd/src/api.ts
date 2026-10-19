import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export class AgentdError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export interface ApiConfig { apiUrl: string; deviceToken: string; deviceCode?: string; legacyFingerprints?: string[] }
export function readApiConfig(): ApiConfig {
  const directory = process.env.AGENTCTL_HOME ?? path.join(homedir(), '.agentctl');
  let stored: { api_url?: string; device_token?: string; device_code?: string } = {};
  try { stored = JSON.parse(readFileSync(path.join(directory, 'auth.json'), 'utf8')); } catch { /* Login is required below. */ }
  const apiUrl = (process.env.ACP_API_URL ?? stored.api_url ?? '').replace(/\/+$/, '');
  const deviceToken = process.env.ACP_DEVICE_TOKEN ?? process.env.ACP_TOKEN ?? (stored.api_url?.replace(/\/+$/, '') === apiUrl ? stored.device_token : undefined);
  if (!apiUrl || !deviceToken) throw new AgentdError('unauthorized', 'agentd 需要 tsp auth login 的设备凭据和 core-api 地址');
  if (stored.device_code && stored.api_url?.replace(/\/+$/, '') === apiUrl) {
    const stable = createHash('sha256').update(`${apiUrl}\ndevice:${stored.device_code}`).digest('hex');
    let fingerprints: string[] = [];
    try {
      const value = JSON.parse(readFileSync(path.join(directory, 'device-sessions', `${stable}.json`), 'utf8')) as { fingerprints?: unknown };
      if (Array.isArray(value.fingerprints)) fingerprints = value.fingerprints.filter((item): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)).slice(-256);
    } catch { /* Legacy installations have no session fingerprint history. */ }
    if (deviceToken === stored.device_token || fingerprints.includes(createHash('sha256').update(deviceToken).digest('hex'))) {
      return { apiUrl, deviceToken, deviceCode: stored.device_code, legacyFingerprints: fingerprints };
    }
  }
  return { apiUrl, deviceToken };
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
    response = await fetch(`${config.apiUrl}${url}`, { method, headers: { authorization: `Bearer ${config.deviceToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  } catch (error) { throw new AgentdError('api_unreachable', `无法连接 core-api：${error instanceof Error ? error.message : String(error)}`); }
  const result = await response.json() as { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!result.ok) throw new AgentdError(result.error?.code ?? 'api_error', result.error?.message ?? `HTTP ${response.status}`, result.error?.details);
  return result.data as T;
}
