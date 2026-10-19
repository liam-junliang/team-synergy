import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@team-synergy/domain';
import { createApiClient, type ApiResult } from './api-client.js';
import { normalizeApiUrl, type DeviceIdentity } from './device-identity.js';

export interface CliLoginResult { device_code: string; device_token: string; user_code: string; device_name: string }
interface DeviceGrant { device_code: string; user_code: string; expires_in: number; interval: number }

export function verificationUrl(apiUrl: string, userCode: string, webUrl?: string): string {
  const url = new URL(normalizeApiUrl(webUrl ?? apiUrl));
  // Same-origin /api deployments are the standard. Direct API deployments may supply --web.
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/api$/, '')}/agent/authorize`;
  url.searchParams.set('code', userCode);
  return url.toString();
}

function openBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
  child.on('error', () => process.stderr.write('无法自动打开浏览器，请手工打开上面的授权地址。\n'));
  child.unref();
}

export async function loginThroughBrowser(options: {
  api: string; name: string; identity: DeviceIdentity; noBrowser?: boolean; web?: string;
}): Promise<ApiResult<CliLoginResult>> {
  const api = createApiClient({ baseUrl: options.api, skipAuth: true, requestTimeoutMs: 15_000 });
  const start = await api.request<DeviceGrant>('POST', '/auth/device/start', { device_name: options.name, device_identity: options.identity });
  if (!start.ok) return start;
  const grant = start.data;
  if (!grant || typeof grant.device_code !== 'string' || !/^[A-Z0-9-]{6,16}$/i.test(grant.user_code)
    || !Number.isFinite(grant.expires_in) || grant.expires_in <= 0 || grant.expires_in > 1800
    || !Number.isFinite(grant.interval) || grant.interval < 1 || grant.interval > 60) {
    throw new DomainError('auth_device_response_invalid', '平台返回的设备授权信息无效');
  }
  const url = verificationUrl(options.api, grant.user_code, options.web);
  process.stderr.write(`请在浏览器中登录并确认本机授权：\n${url}\n授权码：${grant.user_code}\n等待授权（最多 ${grant.expires_in} 秒）。按 Ctrl+C 取消。\n`);
  if (!options.noBrowser) openBrowser(url);
  const deadline = Date.now() + grant.expires_in * 1000;
  let interval = grant.interval * 1000;
  while (Date.now() < deadline) {
    await delay(Math.min(interval, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    const token = await api.request<CliLoginResult>('POST', '/auth/device/token', { device_code: grant.device_code });
    if (token.ok) {
      if (!token.data || typeof token.data.device_token !== 'string' || !token.data.device_token
        || typeof token.data.device_code !== 'string' || typeof token.data.user_code !== 'string' || typeof token.data.device_name !== 'string') {
        throw new DomainError('auth_device_response_invalid', '平台返回的登录凭据无效');
      }
      return token;
    }
    if (token.error.code === 'authorization_pending') continue;
    if (token.error.code === 'slow_down') { interval += 5000; continue; }
    return token;
  }
  return { ok: false, error: { code: 'expired_token', message: '本次浏览器授权已过期，请重新运行登录命令' } };
}
