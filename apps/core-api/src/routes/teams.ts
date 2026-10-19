import type { FastifyInstance } from 'fastify';
import { createTeamUseCases } from '@team-synergy/application';
import { TeamRoleSchema } from '@team-synergy/contracts';
import type { Db } from '@team-synergy/persistence';
export function registerTeamRoutes(app: FastifyInstance, db: Db): void {
  const uc = createTeamUseCases(db);

  app.post<{ Body: Record<string, unknown> }>('/teams', async (request) => {
    const body = request.body ?? {};
    return await uc.createTeam({
      name: String(body.name ?? ''),
      principalCode: request.principal ?? '',
    });
  });

  app.get('/teams', async (request) => ({
    ok: true as const,
    data: await uc.listTeams(request.principal ?? ''),
  }));

  app.put<{ Body: Record<string, unknown> }>('/teams/order', async (request) => {
    const body = request.body ?? {};
    return await uc.reorderTeams({
      teamCodes: Array.isArray(body.team_codes) ? body.team_codes.map(String) : [],
      principalCode: request.principal ?? '',
    });
  });

  app.patch<{ Params: { team_code: string }; Body: Record<string, unknown> }>('/teams/:team_code', async (request) => {
    const body = request.body ?? {};
    return await uc.renameTeam({
      teamCode: request.params.team_code,
      name: String(body.name ?? ''),
      actorPrincipalCode: request.principal ?? '',
    });
  });

  app.get<{ Params: { team_code: string } }>('/teams/:team_code/members', async (request) => (
    await uc.listMembers(request.params.team_code, request.principal ?? '')
  ));

  app.get<{ Params: { team_code: string } }>('/teams/:team_code/projects-governance', async request => (
    uc.listProjectGovernance(request.params.team_code, request.principal ?? '')
  ));

  app.get<{ Params: { team_code: string; user_code: string } }>('/teams/:team_code/members/:user_code/removal-impact', async (request) => (
    await uc.memberRemovalImpact({ teamCode: request.params.team_code, userCode: request.params.user_code, actorPrincipalCode: request.principal ?? '' })
  ));

  app.post<{ Params: { team_code: string }; Body: Record<string, unknown> }>('/teams/:team_code/members', async (request) => {
    const body = request.body ?? {};
    const role = TeamRoleSchema.safeParse(body.role);
    if (!role.success) {
      return { ok: false as const, error: { code: 'member_role_invalid', message: `非法成员角色：${String(body.role ?? '')}` } };
    }
    return await uc.addMember({
      teamCode: request.params.team_code,
      userCode: String(body.user_code ?? ''),
      role: role.data,
      actorPrincipalCode: request.principal ?? '',
    });
  });

  app.patch<{ Params: { team_code: string; user_code: string }; Body: Record<string, unknown> }>('/teams/:team_code/members/:user_code', async (request) => {
    const body = request.body ?? {};
    const role = TeamRoleSchema.safeParse(body.role);
    if (!role.success) {
      return { ok: false as const, error: { code: 'member_role_invalid', message: `非法成员角色：${String(body.role ?? '')}` } };
    }
    return await uc.updateMemberRole({
      teamCode: request.params.team_code,
      userCode: request.params.user_code,
      role: role.data,
      actorPrincipalCode: request.principal ?? '',
    });
  });

  app.delete<{ Params: { team_code: string; user_code: string } }>('/teams/:team_code/members/:user_code', async (request) => (
    await uc.removeMember({
      teamCode: request.params.team_code,
      userCode: request.params.user_code,
      actorPrincipalCode: request.principal ?? '',
    })
  ));
}
