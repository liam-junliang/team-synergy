import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'tsp_session';
export const CSRF_COOKIE = 'tsp_csrf';
export const BROWSER_COOKIE = 'tsp_browser';
const SESSION_AGE = 90 * 24 * 60 * 60;
export const isSafeMethod = (method: string) => ['GET', 'HEAD', 'OPTIONS'].includes(method);
const isProduction = () => process.env.NODE_ENV === 'production' || process.env.ACP_ENV === 'production';
const loopback = (host: string) => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host.toLowerCase());

/** No forwarded header can silently downgrade a production cookie. */
export function webCookieSecure(request: FastifyRequest): boolean | null {
  if (isProduction() || request.protocol === 'https') return true;
  return loopback(request.hostname) && loopback(request.ip) ? false : null;
}
export function trustedWebOrigin(request: FastifyRequest): boolean {
  const supplied = request.headers.origin;
  if (typeof supplied !== 'string') return false;
  try {
    const origin = new URL(supplied);
    if (origin.origin !== supplied || origin.username || origin.password) return false;
    if (origin.origin === `${request.protocol}://${request.host}`) return true;
    const configured = process.env.TSP_WEB_ORIGIN;
    if (configured && origin.origin === new URL(configured).origin) return true;
    return !isProduction() && loopback(request.hostname) && loopback(request.ip)
      && origin.protocol === 'http:' && loopback(origin.hostname) && origin.port === '5173';
  } catch { return false; }
}
const cookieName = (name: string) => isProduction() ? `__Host-${name}` : name;
export function readWebCookies(request: FastifyRequest): { session?: string; csrf?: string; browser?: string; invalid: boolean } {
  const result: { session?: string; csrf?: string; browser?: string; invalid: boolean } = { invalid: false };
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    const key = item.slice(0, separator).trim();
    const names = [SESSION_COOKIE, CSRF_COOKIE, BROWSER_COOKIE];
    if (separator < 0 || !names.some(name => key === name || key === `__Host-${name}`)) continue;
    const index = names.findIndex(name => key === cookieName(name));
    if (index < 0) { result.invalid = true; continue; }
    const field = (['session', 'csrf', 'browser'] as const)[index];
    if (!field) continue;
    if (result[field] !== undefined) result.invalid = true;
    result[field] = item.slice(separator + 1).trim();
  }
  return result;
}
/** Installation proof remains inaccessible to browser JavaScript, including on relogin. */
export function browserIdentity(request: FastifyRequest, platform: unknown) {
  const stored = readWebCookies(request).browser;
  const valid = stored && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i.test(stored);
  const value = valid ? stored : `${randomUUID()}.${randomBytes(32).toString('base64url')}`;
  return { cookie: value, identity: { installation_id: value.slice(0, 36), installation_secret: value.slice(37), client_type: 'web' as const,
    platform: typeof platform === 'string' && platform.trim().length > 0 && platform.length <= 100 ? platform.trim() : 'browser' } };
}
function signature(session: string, nonce: string): string {
  return createHmac('sha256', session).update(`tsp-web-csrf-v1:${nonce}`).digest('base64url');
}
export function createWebCsrf(session: string): string {
  const nonce = randomBytes(32).toString('base64url');
  return `${nonce}.${signature(session, nonce)}`;
}
function equal(a: string, b: string): boolean {
  return Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function validWebCsrf(session: string, csrf: string | undefined): boolean {
  if (!csrf || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(csrf)) return false;
  const nonce = csrf.slice(0, 43);
  return equal(csrf.slice(44), signature(session, nonce));
}
export function verifyWebCsrf(request: FastifyRequest, session: string, csrf: string | undefined): boolean {
  const header = request.headers['x-csrf-token'];
  return trustedWebOrigin(request) && typeof header === 'string' && !!csrf && equal(header, csrf) && validWebCsrf(session, csrf);
}
function cookie(name: string, value: string, secure: boolean, age: number, httpOnly = false): string {
  return `${cookieName(name)}=${value}; Path=/; Max-Age=${age}; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}`;
}
export function setWebSession(reply: FastifyReply, session: string, csrf: string, browser: string, secure: boolean): void {
  reply.header('set-cookie', [cookie(SESSION_COOKIE, session, secure, SESSION_AGE, true), cookie(CSRF_COOKIE, csrf, secure, SESSION_AGE), cookie(BROWSER_COOKIE, browser, secure, SESSION_AGE, true)]);
  reply.header('cache-control', 'no-store');
}
export function refreshWebCsrf(reply: FastifyReply, csrf: string, secure: boolean): void {
  reply.header('set-cookie', cookie(CSRF_COOKIE, csrf, secure, SESSION_AGE));
  reply.header('cache-control', 'no-store');
}
export function clearWebSession(reply: FastifyReply, secure: boolean): void {
  reply.header('set-cookie', [cookie(SESSION_COOKIE, '', secure, 0, true), cookie(CSRF_COOKIE, '', secure, 0)]);
  reply.header('cache-control', 'no-store');
}
