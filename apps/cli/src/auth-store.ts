import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deviceSessionDirectory, readDeviceProfile, sameDeviceProfile, withDeviceProfileLock, writeDeviceProfile, type DeviceProfile } from '@team-synergy/contracts/device-session';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type AuthConfig = DeviceProfile;

export function authDirectory(): string {
  return deviceSessionDirectory();
}

export function authFilePath(): string {
  return path.join(authDirectory(), 'auth.json');
}

export function readAuthConfig(): AuthConfig | null {
  return readDeviceProfile(authDirectory());
}

export function writeAuthConfig(config: AuthConfig): void {
  mkdirSync(authDirectory(), { recursive: true, mode: 0o700 });
  if (config.device_code) recordDeviceSession(config);
  writeDeviceProfile(authDirectory(), config);
}

export function saveAuthConfig(config: AuthConfig, expected?: AuthConfig): Promise<void> {
  return withDeviceProfileLock(authDirectory(), () => {
    const current = readAuthConfig();
    if (!expected || current && sameDeviceProfile(expected, current)) writeAuthConfig(config);
  });
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

export function clearCurrentAuthConfig(expected: AuthConfig): Promise<void> {
  return withDeviceProfileLock(authDirectory(), () => {
    const current = readAuthConfig();
    if (current && sameDeviceProfile(expected, current)) removeAuthConfig();
  });
}
