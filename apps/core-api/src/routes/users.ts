import type { FastifyInstance } from 'fastify';
import { createUserUseCases } from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { unauthorized } from '../auth.js';

export function registerUserRoutes(app: FastifyInstance, db: Db): void {
  const uc = createUserUseCases(db);

  app.get('/users', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.listUsers(request.principal);
  });

  app.get('/users/directory', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.listUserDirectory(request.principal);
  });

  app.post<{ Body: Record<string, unknown> }>('/users', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    const body = request.body ?? {};
    return await uc.createUser({
      account: String(body.account ?? ''),
      displayName: String(body.display_name ?? ''),
      actorPrincipalCode: request.principal,
    });
  });

  app.post<{ Params: { user_code: string } }>('/users/:user_code/disable', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.disableUser({
      userCode: request.params.user_code,
      actorPrincipalCode: request.principal,
    });
  });

  app.post<{ Params: { user_code: string } }>('/users/:user_code/enable', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.enableUser({ userCode: request.params.user_code, actorPrincipalCode: request.principal });
  });

  app.post<{ Params: { user_code: string } }>('/users/:user_code/bind-token', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.issueBindToken({
      userCode: request.params.user_code,
      actorPrincipalCode: request.principal,
    });
  });

  app.post<{ Params: { user_code: string } }>('/users/:user_code/initial-password', async (request, reply) => {
    if (request.authKind !== 'bearer' || !request.principal) return unauthorized(reply);
    return await uc.issueInitialPassword({
      userCode: request.params.user_code,
      actorPrincipalCode: request.principal,
    });
  });
}
