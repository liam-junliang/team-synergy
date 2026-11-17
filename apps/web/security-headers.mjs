// Shared by Vite dev/preview; production nginx uses the same policy in deploy/.
export function webSecurityHeaders({ development = false, enforce = process.env.TSP_CSP_MODE === 'enforce' } = {}) {
  const policy = [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    // Inline scripts also occur in the existing sandboxed srcdoc prototypes.
    "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
    "font-src 'self' data:", `connect-src 'self'${development ? ' ws://127.0.0.1:5173 ws://localhost:5173' : ''}`,
    // Users can explicitly preview external HTTPS design URLs in a sandbox.
    "frame-src 'self' https:", "report-uri /api/security/csp-report",
  ].join('; ');
  return { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    [enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: policy };
}
