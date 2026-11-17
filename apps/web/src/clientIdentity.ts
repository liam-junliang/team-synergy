export interface WebClientIdentity {
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

/** Only display metadata crosses JavaScript; installation credentials live in HttpOnly cookies. */
export function webClientIdentity(): WebClientIdentity {
  return { client_type: 'web', platform: browserClientInfo(typeof navigator === 'undefined' ? '' : navigator.userAgent).platform };
}
