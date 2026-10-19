import type { FastifyInstance } from 'fastify';
import type { Db } from '@team-synergy/persistence';
import { createOwnershipUseCases } from '@team-synergy/application';

export function registerOwnershipRoutes(app: FastifyInstance, db: Db): void {
  const uc = createOwnershipUseCases(db);

  app.get('/ownership-transfers', async request => uc.listTransfers(request.principal ?? ''));

  for (const recovery of [false, true]) {
    app.post<{ Body: Record<string, unknown> }>(recovery ? '/ownership-transfers/recover' : '/ownership-transfers', async request => {
      const body = request.body ?? {};
      if (body.scope !== 'team' && body.scope !== 'project') return { ok: false as const, error: { code: 'ownership_scope_invalid', message: '所有权范围必须为 team 或 project' } };
      return uc.requestTransfer({
        scope: body.scope, scopeCode: String(body.scope_code ?? ''), targetUserCode: String(body.target_user_code ?? ''),
        actorPrincipalCode: request.principal ?? '', reason: typeof body.reason === 'string' ? body.reason : undefined, recovery,
      });
    });
  }

  app.post<{ Params: { code: string } }>('/ownership-transfers/:code/accept', async request => (
    uc.acceptTransfer({ transferCode: request.params.code, actorPrincipalCode: request.principal ?? '' })
  ));
  app.post<{ Params: { code: string } }>('/ownership-transfers/:code/cancel', async request => (
    uc.cancelTransfer({ transferCode: request.params.code, actorPrincipalCode: request.principal ?? '' })
  ));
  app.post<{ Body: Record<string, unknown> }>('/ownership/resolve', async request => {
    const body = request.body ?? {};
    if (body.scope !== 'team' && body.scope !== 'project') return { ok: false as const, error: { code: 'ownership_scope_invalid', message: '所有权范围必须为 team 或 project' } };
    return uc.resolveOwnership({ scope: body.scope, scopeCode: String(body.scope_code ?? ''), ownerUserCode: String(body.owner_user_code ?? ''), actorPrincipalCode: request.principal ?? '' });
  });

  app.get('/account/closure', async request => uc.closureStatus(request.principal ?? ''));
  app.post('/account/closure/begin', async request => uc.beginClosure(request.principal ?? ''));
  app.post('/account/closure/cancel', async request => uc.cancelClosure(request.principal ?? ''));
  app.post('/account/closure/complete', async request => uc.completeClosure(request.principal ?? ''));
}
