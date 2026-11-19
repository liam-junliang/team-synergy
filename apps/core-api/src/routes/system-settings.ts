import type { FastifyInstance } from 'fastify';
import { createSystemSettingsUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { hasAuthenticatedSession, unauthorized } from '../auth.js';

export function registerSystemSettingsRoutes(app: FastifyInstance, db: Db, remoteMcpUrl?: string): void {
  const settings = createSystemSettingsUseCases(db);
  app.get('/admin/settings', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    return settings.getSettings(request.principal);
  });
  app.put('/admin/settings', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    return settings.updateSettings(request.principal, request.body);
  });
  app.get('/platform/client-config', async (request, reply) => {
    if (!hasAuthenticatedSession(request) || !request.principal) return unauthorized(reply);
    const config = await settings.clientConfig(request.principal);
    return config.ok && remoteMcpUrl ? { ...config, data: { ...config.data, remote_mcp_url: remoteMcpUrl } } : config;
  });
}
