export const CLIENT_IDENTITY_STORAGE_KEY = 'tsp:web:client-identity:v1';

export interface WebClientIdentity {
  installation_id: string;
  installation_secret: string;
  client_type: 'web';
  platform: string;
}

export function browserClientInfo(userAgent: string): { name: string; platform: string } {
  const platform = /Windows/i.test(userAgent) ? 'Windows'
    : /Android/i.test(userAgent) ? 'Android'
      : /iPhone|iPad|iPod/i.test(userAgent) ? 'iOS'
        : /Macintosh|Mac OS X/i.test(userAgent) ? 'macOS'
          : /Linux/i.test(userAgent) ? 'Linux' : 'Browser';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
      : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari' : 'Web';
  return { name: `${browser} · ${platform}`, platform };
}

let volatileIdentity: Pick<WebClientIdentity, 'installation_id' | 'installation_secret'> | undefined;

function randomInstallationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This identifies one browser installation, never a physical computer or an authenticated account. */
export function webClientIdentity(): WebClientIdentity {
  const platform = browserClientInfo(typeof navigator === 'undefined' ? '' : navigator.userAgent).platform;
  let stored: typeof volatileIdentity;
  try {
    const value = JSON.parse(window.localStorage.getItem(CLIENT_IDENTITY_STORAGE_KEY) ?? 'null');
    if (value && /^[a-f0-9-]{36}$/i.test(value.installation_id) && /^[A-Za-z0-9_-]{43}$/.test(value.installation_secret)) stored = value;
  } catch { /* Storage can be unavailable; the current tab still gets an independent identity. */ }
  if (!stored) {
    stored = volatileIdentity ?? {
      installation_id: randomInstallationId(),
      installation_secret: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    };
    volatileIdentity = stored;
    try { window.localStorage.setItem(CLIENT_IDENTITY_STORAGE_KEY, JSON.stringify(stored)); } catch { /* Keep the identity in memory for this tab. */ }
  }
  return { installation_id: stored.installation_id, installation_secret: stored.installation_secret, client_type: 'web', platform };
}
