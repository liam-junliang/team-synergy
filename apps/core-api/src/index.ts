import { buildServer } from './server.js';
import { installShutdown, startupFailure } from './lifecycle.js';

let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  app = await buildServer();
  const removeSignals = installShutdown(app);
  app.addHook('onClose', async () => { removeSignals(); });
  await app.listen({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });
} catch (error) {
  process.stderr.write(`${startupFailure(error)}\n`);
  if (app) await app.close().catch(() => undefined);
  process.exitCode = 1;
}
