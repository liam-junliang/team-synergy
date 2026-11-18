import type { FastifyInstance } from 'fastify';

/** Stop admission in preClose; wait only after all workers have been stopped. */
export function registerBackgroundDrain(app: FastifyInstance, worker: { start(): void; stop(): Promise<void> }): void {
  let draining: Promise<void> | undefined;
  const stop = () => {
    if (!draining) {
      try { draining = worker.stop(); } catch (error) { draining = Promise.reject(error); }
      // Keep the failure for onClose without an unhandled rejection while HTTP drains.
      void draining.catch(() => undefined);
    }
    return draining;
  };
  app.addHook('onReady', async () => { worker.start(); });
  app.addHook('preClose', async () => { stop(); });
  app.addHook('onClose', async () => { await stop(); });
}

/** A single in-flight poll, including material indexing when memory is disabled. */
export function registerBackgroundLoop(app: FastifyInstance, options: {
  intervalMs: number; run(): Promise<unknown>; onError(): void;
}): void {
  let stopped = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  registerBackgroundDrain(app, {
    start() {
      stopped = false;
      timer = setInterval(() => {
        if (stopped || pending) return;
        pending = Promise.resolve().then(() => options.run())
          .then(() => undefined, () => { options.onError(); })
          .finally(() => { pending = undefined; });
      }, options.intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  });
}
