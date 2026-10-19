import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface AuthConfig {
  api_url: string;
  device_token: string;
  user_code: string;
  device_name: string;
  device_code?: string;
}

export function authDirectory(): string {
  return process.env.AGENTCTL_HOME ?? path.join(homedir(), '.agentctl');
}

export function authFilePath(): string {
  return path.join(authDirectory(), 'auth.json');
}

export function readAuthConfig(): AuthConfig | null {
  try {
    const value = JSON.parse(readFileSync(authFilePath(), 'utf8')) as Partial<AuthConfig> & { user_id?: unknown };
    const userCode = typeof value.user_code === 'string'
      ? value.user_code
      : typeof value.user_id === 'string'
        ? value.user_id
        : null;
    if (
      typeof value.api_url !== 'string' ||
      typeof value.device_token !== 'string' ||
      userCode === null ||
      typeof value.device_name !== 'string'
    ) {
      return null;
    }
    return {
      api_url: value.api_url,
      device_token: value.device_token,
      user_code: userCode,
      device_name: value.device_name,
      ...(typeof value.device_code === 'string' ? { device_code: value.device_code } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAuthConfig(config: AuthConfig): void {
  mkdirSync(authDirectory(), { recursive: true });
  if (config.device_code) recordDeviceSession(config);
  writeFileSync(authFilePath(), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function stableDeviceFingerprint(apiUrl: string, deviceCode: string): string {
  return createHash('sha256').update(`${apiUrl.replace(/\/+$/, '')}\ndevice:${deviceCode}`).digest('hex');
}

function deviceHistoryPath(apiUrl: string, deviceCode: string): string {
  return path.join(authDirectory(), 'device-sessions', `${stableDeviceFingerprint(apiUrl, deviceCode)}.json`);
}

/** Local fingerprints identify existing journals, never authenticate a remote request. */
function recordDeviceSession(config: AuthConfig): void {
  if (!config.device_code) return;
  const file = deviceHistoryPath(config.api_url, config.device_code);
  const previous = readDeviceSessionFingerprints(config.api_url, config.device_code);
  const fingerprints = [...new Set([...previous,
    createHash('sha256').update(config.device_token).digest('hex'),
    createHash('sha256').update(`${config.api_url.replace(/\/+$/, '')}\n${config.device_token}`).digest('hex'),
  ])].slice(-256);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ fingerprints }) + '\n', { mode: 0o600 });
}

export function readDeviceSessionFingerprints(apiUrl: string, deviceCode: string): string[] {
  try {
    const value = JSON.parse(readFileSync(deviceHistoryPath(apiUrl, deviceCode), 'utf8')) as { fingerprints?: unknown };
    return Array.isArray(value.fingerprints) ? value.fingerprints.filter((item): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)).slice(-256) : [];
  } catch { return []; }
}

export function localDeviceFingerprint(apiUrl: string, token: string): string {
  const config = readAuthConfig();
  return config?.device_code && config.api_url.replace(/\/+$/, '') === apiUrl && config.device_token === token
    ? stableDeviceFingerprint(apiUrl, config.device_code)
    : createHash('sha256').update(token).digest('hex');
}

export function matchesLocalDeviceFingerprint(apiUrl: string, token: string, fingerprint: string | undefined): boolean {
  if (!fingerprint) return false;
  if (fingerprint === localDeviceFingerprint(apiUrl, token) || fingerprint === createHash('sha256').update(token).digest('hex')) return true;
  const config = readAuthConfig();
  return Boolean(config?.device_code && config.api_url.replace(/\/+$/, '') === apiUrl && config.device_token === token
    && readDeviceSessionFingerprints(apiUrl, config.device_code).includes(fingerprint));
}

export function removeAuthConfig(): void {
  rmSync(authFilePath(), { force: true });
}
