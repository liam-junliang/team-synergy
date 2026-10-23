import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

export async function registerSecurityHeaders(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: { reportOnly: process.env.TSP_CSP_MODE !== 'enforce', useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    strictTransportSecurity: false,
  });
  app.addHook('onSend', async (request, reply) => {
    // Forwarded headers are deliberately not trusted by the standalone API.
    // TLS termination must set HSTS at the trusted reverse proxy instead.
    if (request.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
  });
  app.addContentTypeParser('application/csp-report', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => {
    try { done(null, JSON.parse(String(body))); } catch { done(null, null); }
  });
  let reports = 0;
  let windowStart = Date.now();
  const directives = new Set(['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem',
    'style-src-attr', 'img-src', 'font-src', 'connect-src', 'frame-src', 'frame-ancestors', 'object-src', 'base-uri', 'form-action']);
  app.post('/security/csp-report', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (Date.now() - windowStart > 60_000) { reports = 0; windowStart = Date.now(); }
    // Bounded, anonymous telemetry. Never log the document/blocked URL, snippets or arbitrary report text.
    if (++reports <= 120) {
      const report = (request.body as { 'csp-report'?: { 'effective-directive'?: unknown } } | null)?.['csp-report'];
      const directive = report?.['effective-directive'];
      if (typeof directive === 'string' && directives.has(directive)) app.log.warn({ directive }, 'CSP policy violation');
    }
    return reply.code(204).send();
  });
}
