import type { FastifyInstance } from 'fastify';

export function startupFailure(error: unknown): string {
  let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const current = cause as { code?: string; cause?: unknown };
    if (current.code === '3D000') return 'Database does not exist; create it before starting the API.';
    if (current.code === '28P01') return 'Database authentication failed; check the deployment credentials.';
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(current.code ?? '')) return 'Database is unreachable; check host, port and readiness.';
    cause = current.cause;
  }
  return 'API startup failed; check configuration, database migrations and port availability.';
}

export function installShutdown(app: FastifyInstance): () => void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
    void app.close().then(() => { clearTimeout(deadline); }, () => {
      process.stderr.write('API shutdown failed.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  };
}
