import type { FastifyInstance } from 'fastify';

// Covers the 45s extraction timeout plus HTTP/worker/database finalization.
export const API_SHUTDOWN_TIMEOUT_MS = 75_000;

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
  const removeSignals = () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  };
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Keep this referenced: a pending Promise alone must not exit successfully.
    const deadline = setTimeout(() => {
      process.stderr.write('API shutdown timed out; drain was not completed.\n');
      process.exit(1);
    }, API_SHUTDOWN_TIMEOUT_MS);
    void app.close().then(() => {
      clearTimeout(deadline);
      removeSignals();
    }, () => {
      clearTimeout(deadline);
      process.stderr.write('API shutdown failed.\n');
      process.exit(1);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return () => {
    // index.ts invokes this from onClose, before other drain hooks may finish.
    if (!closing) removeSignals();
  };
}
