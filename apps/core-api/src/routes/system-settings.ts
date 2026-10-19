import type { FastifyInstance } from 'fastify';
import { createSystemSettingsUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

export function registerSystemSettingsRoutes(app: FastifyInstance, db: Db): void {
  const settings = createSystemSettingsUseCases(db);
  app.get('/admin/settings', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return settings.getSettings(request.principal);
  });
  app.put('/admin/settings', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return settings.updateSettings(request.principal, request.body);
  });
  app.get('/platform/client-config', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return settings.clientConfig(request.principal);
  });
}
