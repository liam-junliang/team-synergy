import type { FastifyInstance } from 'fastify';
import { MemberRoleSchema, ArtifactKindSchema, ProjectMemberPolicySchema } from '@team-synergy/contracts';
import {
  MODULE_STATUSES,
  MILESTONE_STATUSES,
  PHASE_STATUSES,
  createMemberUseCases,
  createProjectStructureUseCases,
  createProjectUseCasesProject,
  createProjectHomeUseCases,
  createProjectPolicyUseCases,
  type ProjectHomeBindings,
} from '@team-synergy/application';
import type { Db } from '@team-synergy/persistence';
import { principalOf, unauthorized } from '../auth.js';

interface PrincipalBody {
  principal_code?: string;
  user_code?: string;
}

function parseProjectStatus<T extends readonly string[]>(allowed: T, value: unknown) {
  return typeof value === 'string' && allowed.includes(value as T[number]) ? value as T[number] : null;
}

export function registerProjectRoutes(app: FastifyInstance, db: Db): void {
  const projects = createProjectUseCasesProject(db);
  const members = createMemberUseCases(db);
  const structure = createProjectStructureUseCases(db);
  const home = createProjectHomeUseCases(db);
  const policy = createProjectPolicyUseCases(db);
  app.get<{ Params: { project_code: string }; Querystring: { member_policy?: string } }>('/projects/:project_code/access-policy', async request => {
    const parsed = ProjectMemberPolicySchema.optional().safeParse(request.query.member_policy);
    if (!parsed.success) return { ok: false as const, error: { code: 'project_policy_invalid', message: '项目访问方式无效' } };
    return policy.previewPolicy(request.params.project_code, principalOf(request), parsed.data);
  });
  app.put<{ Params: { project_code: string }; Body: { member_policy?: unknown } }>('/projects/:project_code/access-policy', async request => {
    const parsed = ProjectMemberPolicySchema.safeParse(request.body?.member_policy);
    if (!parsed.success) return { ok: false as const, error: { code: 'project_policy_invalid', message: '项目访问方式无效' } };
    return policy.updatePolicy({ projectCode: request.params.project_code, principalCode: principalOf(request), memberPolicy: parsed.data });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/home', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return await home.getHome(request.params.project_code, principalOf(request));
  });
  app.put<{ Params: { project_code: string }; Body: ProjectHomeBindings }>('/projects/:project_code/home', async (request, reply) => {
    if (!request.principal) return unauthorized(reply);
    return await home.updateHome({ projectCode: request.params.project_code, principalCode: principalOf(request), bindings: request.body });
  });

  app.post<{ Body: Record<string, unknown> }>('/projects', async (request) => {
    const body = request.body ?? {};
    const policy = ProjectMemberPolicySchema.safeParse(body.member_policy ?? 'team_read');
    if (!policy.success) return { ok: false as const, error: { code: 'project_policy_invalid', message: '项目访问方式无效' } };
    return await projects.createProject({
      teamCode: String(body.team_code ?? ''),
      name: String(body.name ?? ''),
      description: typeof body.description === 'string' ? body.description : undefined,
      memberPolicy: policy.data,
      principalCode: principalOf(request, body as PrincipalBody),
    });
  });

  app.get<{ Querystring: { principal_code?: string; team_code?: string } }>('/projects', async (request) => ({
    ok: true as const,
    data: await projects.listProjects(principalOf(request), request.query.team_code),
  }));

  app.put<{ Body: Record<string, unknown> }>('/projects/order', async (request) => {
    const body = request.body ?? {};
    return await projects.reorderProjects({
      teamCode: String(body.team_code ?? ''),
      projectCodes: Array.isArray(body.project_codes) ? body.project_codes.map(String) : [],
      principalCode: principalOf(request, body as PrincipalBody),
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code', async (request) => (
    await projects.getProject(request.params.project_code, principalOf(request))
  ));

  app.patch<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code', async (request) => {
    const body = request.body ?? {};
    return await projects.updateProject({
      projectCode: request.params.project_code,
      name: String(body.name ?? ''),
      description: body.description === undefined
        ? undefined
        : (typeof body.description === 'string' ? body.description : null),
      principalCode: principalOf(request, body as PrincipalBody),
    });
  });

  app.patch<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/status', async (request) => {
    const status = parseProjectStatus(['active', 'archived'] as const, request.body?.status);
    if (!status) {
      return { ok: false as const, error: { code: 'project_status_invalid', message: `非法项目状态：${String(request.body?.status ?? '')}`, details: { valid: ['active', 'archived'] } } };
    }
    return await projects.updateProjectStatus({
      projectCode: request.params.project_code,
      status,
      principalCode: principalOf(request, request.body as PrincipalBody),
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/repositories', async (request) => (
    await projects.listProjectRepositories(request.params.project_code, principalOf(request))
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/repositories', async (request) => {
    const body = request.body ?? {};
    return await projects.createProjectRepository({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: String(body.name ?? ''),
      purpose: typeof body.purpose === 'string' ? body.purpose : undefined,
      remoteUrl: String(body.remote_url ?? ''),
      defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
    });
  });

  app.patch<{ Params: { repository_code: string }; Body: Record<string, unknown> }>('/repositories/:repository_code', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined
      ? undefined
      : body.status === 'active' || body.status === 'archived'
        ? body.status
        : null;
    if (status === null) {
      return { ok: false as const, error: { code: 'repository_status_invalid', message: '代码仓库状态无效' } };
    }
    return await projects.updateProjectRepository({
      repositoryCode: request.params.repository_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: typeof body.name === 'string' ? body.name : undefined,
      purpose: body.purpose === undefined ? undefined : (typeof body.purpose === 'string' ? body.purpose : null),
      remoteUrl: typeof body.remote_url === 'string' ? body.remote_url : undefined,
      defaultBranch: body.default_branch === undefined ? undefined : (typeof body.default_branch === 'string' ? body.default_branch : null),
      status: status ?? undefined,
    });
  });

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/workspaces', async (request) => {
    const body = request.body ?? {};
    return await projects.registerProjectWorkspace({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: String(body.name ?? ''),
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/document', async (request) => (
    await projects.getProjectDocument(request.params.project_code, principalOf(request))
  ));

  app.put<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/document', async (request) => {
    const body = request.body ?? {};
    return await projects.saveProjectDocument({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      title: String(body.title ?? ''),
      content: String(body.content ?? ''),
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/members', async (request) => {
    const access = await projects.getProject(request.params.project_code, principalOf(request));
    if (!access.ok) return access;
    return { ok: true as const, data: await members.listMembers(request.params.project_code, principalOf(request)) };
  });

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/members', async (request) => {
    const body = request.body ?? {};
    const role = MemberRoleSchema.safeParse(body.role);
    if (!role.success) {
      return { ok: false as const, error: { code: 'member_role_invalid', message: '项目成员角色无效' } };
    }
    return await members.addMember({
      userCode: String(body.user_code ?? ''),
      role: role.data,
      actorPrincipalCode: principalOf(request, body as PrincipalBody),
      projectCode: request.params.project_code,
    });
  });

  app.patch<{ Params: { project_code: string; user_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/members/:user_code', async (request) => {
    const role = MemberRoleSchema.safeParse(request.body?.role);
    if (!role.success) return { ok: false as const, error: { code: 'member_role_invalid', message: '非法成员角色' } };
    return members.updateMemberRole({ projectCode: request.params.project_code, userCode: request.params.user_code, role: role.data, actorPrincipalCode: principalOf(request) });
  });

  app.delete<{ Params: { project_code: string; user_code: string } }>('/projects/:project_code/members/:user_code', async (request) => (
    await members.removeMember({
      projectCode: request.params.project_code,
      userCode: request.params.user_code,
      actorPrincipalCode: principalOf(request),
    })
  ));

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/artifacts', async (request) => (
    await projects.listArtifacts(request.params.project_code, principalOf(request))
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/artifacts', async (request) => {
    const body = request.body ?? {};
    const kind = ArtifactKindSchema.safeParse(body.kind);
    if (!kind.success) {
      return { ok: false as const, error: { code: 'artifact_kind_invalid', message: '项目产物类型无效' } };
    }
    return await projects.registerArtifact({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      kind: kind.data,
      title: String(body.title ?? ''),
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      uri: String(body.uri ?? ''),
      contentHash: String(body.content_hash ?? ''),
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/modules', async (request) => (
    await structure.listModules({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/modules', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(MODULE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'module_status_invalid', message: '功能模块状态无效', details: { valid: MODULE_STATUSES } } };
    }
    return await structure.createModule({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: String(body.name ?? ''),
      description: typeof body.description === 'string' ? body.description : undefined,
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      status: status ?? undefined,
    });
  });

  app.put<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/modules/order', async (request) => {
    const body = request.body ?? {};
    return await structure.reorderModules({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      moduleCodes: Array.isArray(body.module_codes) ? body.module_codes.map(String) : [],
    });
  });

  app.patch<{ Params: { module_code: string }; Body: Record<string, unknown> }>('/modules/:module_code', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(MODULE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'module_status_invalid', message: '功能模块状态无效', details: { valid: MODULE_STATUSES } } };
    }
    return await structure.updateModule({
      moduleCode: request.params.module_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: typeof body.name === 'string' ? body.name : undefined,
      description: body.description === undefined ? undefined : (typeof body.description === 'string' ? body.description : null),
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      status: status ?? undefined,
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/phases', async (request) => (
    await structure.listPhases({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/phases', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(PHASE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'phase_status_invalid', message: '阶段状态无效', details: { valid: PHASE_STATUSES } } };
    }
    return await structure.createPhase({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: String(body.name ?? ''),
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      startDate: typeof body.start_date === 'string' ? body.start_date : undefined,
      endDate: typeof body.end_date === 'string' ? body.end_date : undefined,
      status: status ?? undefined,
    });
  });

  app.patch<{ Params: { phase_code: string }; Body: Record<string, unknown> }>('/phases/:phase_code', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(PHASE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'phase_status_invalid', message: '阶段状态无效', details: { valid: PHASE_STATUSES } } };
    }
    return await structure.updatePhase({
      phaseCode: request.params.phase_code,
      principalCode: principalOf(request, body as PrincipalBody),
      name: typeof body.name === 'string' ? body.name : undefined,
      goal: body.goal === undefined ? undefined : (typeof body.goal === 'string' ? body.goal : null),
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      startDate: body.start_date === undefined ? undefined : (typeof body.start_date === 'string' ? body.start_date : null),
      endDate: body.end_date === undefined ? undefined : (typeof body.end_date === 'string' ? body.end_date : null),
      status: status ?? undefined,
    });
  });

  app.get<{ Params: { project_code: string } }>('/projects/:project_code/milestones', async (request) => (
    await structure.listMilestones({
      projectCode: request.params.project_code,
      principalCode: principalOf(request),
    })
  ));

  app.post<{ Params: { project_code: string }; Body: Record<string, unknown> }>('/projects/:project_code/milestones', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(MILESTONE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'milestone_status_invalid', message: '里程碑状态无效', details: { valid: MILESTONE_STATUSES } } };
    }
    return await structure.createMilestone({
      projectCode: request.params.project_code,
      principalCode: principalOf(request, body as PrincipalBody),
      phaseCode: String(body.phase_code ?? ''),
      name: String(body.name ?? ''),
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      startDate: typeof body.start_date === 'string' ? body.start_date : undefined,
      targetDate: typeof body.target_date === 'string' ? body.target_date : undefined,
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      status: status ?? undefined,
      ownerPrincipalCode: typeof body.owner_principal_code === 'string' ? body.owner_principal_code : undefined,
    });
  });

  app.patch<{ Params: { milestone_code: string }; Body: Record<string, unknown> }>('/milestones/:milestone_code', async (request) => {
    const body = request.body ?? {};
    const status = body.status === undefined ? undefined : parseProjectStatus(MILESTONE_STATUSES, body.status);
    if (body.status !== undefined && status === null) {
      return { ok: false as const, error: { code: 'milestone_status_invalid', message: '里程碑状态无效', details: { valid: MILESTONE_STATUSES } } };
    }
    return await structure.updateMilestone({
      milestoneCode: request.params.milestone_code,
      principalCode: principalOf(request, body as PrincipalBody),
      phaseCode: typeof body.phase_code === 'string' ? body.phase_code : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      goal: body.goal === undefined ? undefined : (typeof body.goal === 'string' ? body.goal : null),
      startDate: body.start_date === undefined ? undefined : (typeof body.start_date === 'string' ? body.start_date : null),
      targetDate: body.target_date === undefined ? undefined : (typeof body.target_date === 'string' ? body.target_date : null),
      sortOrder: typeof body.sort_order === 'number' ? body.sort_order : undefined,
      status: status ?? undefined,
      ownerPrincipalCode: body.owner_principal_code === undefined
        ? undefined
        : (typeof body.owner_principal_code === 'string' && body.owner_principal_code.length > 0 ? body.owner_principal_code : null),
    });
  });
}
