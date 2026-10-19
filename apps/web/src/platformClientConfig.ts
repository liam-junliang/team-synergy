import { fetchEnvelope } from './api';

export interface PlatformClientConfig {
  public_web_url: string | null;
  public_api_url: string | null;
}

export const PLATFORM_CLIENT_CONFIG_QUERY_KEY = ['platform-client-config'] as const;

export function getPlatformClientConfig(): Promise<PlatformClientConfig> {
  // Read through the authenticated same-origin API. Configured addresses are command output only.
  return fetchEnvelope('/platform/client-config');
}

export function clientConnectionUrls(config: PlatformClientConfig, currentOrigin: string) {
  const webUrl = config.public_web_url ?? currentOrigin;
  return { webUrl, apiUrl: config.public_api_url ?? `${webUrl}/api` };
}

export function cliLoginCommand(config: PlatformClientConfig, currentOrigin: string): string {
  const { webUrl, apiUrl } = clientConnectionUrls(config, currentOrigin);
  // These URL characters are safe as a single argument in both PowerShell and POSIX shells.
  // The server applies the same restriction when administrators save addresses.
  const safe = (value: string) => /^https?:\/\/[A-Za-z0-9._~:/%[\]-]+$/.test(value);
  if (!safe(apiUrl) || !safe(webUrl)) throw new Error('Invalid platform connection address');
  return `tsp auth login --api ${apiUrl}${config.public_api_url || config.public_web_url ? ` --web ${webUrl}` : ''}\ntsp auth whoami`;
}
