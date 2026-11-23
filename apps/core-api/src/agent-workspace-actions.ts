import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { findProjectByCode, findUserByCode, resolveProjectAccess } from '@team-synergy/application';
import {
  agentWorkspaceActionByName, agentWorkspaceInputSchema, agentWorkspaceRequest, agentWorkspaceRoleAllows, PublicCodeSchema,
  type AgentActionDefinition, type AgentProjectObject,
} from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import { injectWorkspaceAction } from './auth.js';

const projectObjects = {
  repository: schema.projectRepositories,
  feature: schema.features,
  projectDocument: schema.projectDocuments,
  architecture: schema.architectureDocuments,
  designPrototype: schema.designPrototypes,
  testCase: schema.testCases,
  testAsset: schema.testAssets,
  module: schema.projectModules,
  phase: schema.projectPhases,
  milestone: schema.projectMilestones,
  topic: schema.requirementTopics,
  idea: schema.requirementIdeas,
  baseline: schema.requirementBaselines,
  requirementDocument: schema.requirementDocuments,
  testExecution: schema.testExecutions,
} satisfies Record<Exclude<AgentProjectObject, 'requirement' | 'defect'>, unknown>;

async function objectInProject(db: Db, kind: AgentProjectObject, objectCode: string, projectId: bigint) {
  if (kind === 'defect') {
    return db.select({ id: schema.defects.id }).from(schema.defects)
      .innerJoin(schema.features, eq(schema.features.id, schema.defects.feature_id))
      .where(and(eq(schema.defects.code, objectCode), eq(schema.features.project_id, projectId))).limit(1);
  }
  if (kind === 'requirement') {
    return db.select({ id: schema.requirements.id }).from(schema.requirements)
      .leftJoin(schema.features, eq(schema.features.id, schema.requirements.feature_id))
      .leftJoin(schema.projectModules, eq(schema.projectModules.id, schema.requirements.module_id))
      .leftJoin(schema.requirementDocuments, eq(schema.requirementDocuments.id, schema.requirements.document_id))
      .where(and(eq(schema.requirements.code, objectCode), eq(sql`coalesce(${schema.features.project_id}, ${schema.projectModules.project_id}, ${schema.requirementDocuments.project_id})`, projectId))).limit(1);
  }
  const table = projectObjects[kind];
  return db.select({ id: table.id }).from(table)
    .where(and(eq(table.code, objectCode), eq(table.project_id, projectId))).limit(1);
}

type WorkspaceActor = { principalCode: string; projectCode?: string | null };
export type ExecuteWorkspaceAction = (action: AgentActionDefinition, args: unknown, actor: WorkspaceActor) => Promise<unknown>;

export function workspaceActionExecutor(app: FastifyInstance, db: Db): ExecuteWorkspaceAction {
  return async (action, args, actor) => {
    const supplied = action.scope === 'project' && actor.projectCode && args && typeof args === 'object' &&
      !('projectCode' in args) ? { ...args, projectCode: actor.projectCode } : args;
    const input = agentWorkspaceInputSchema(action).safeParse(supplied);
    if (!input.success) {
      throw new DomainError('validation_failed', input.error.issues.map(issue =>
        `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
    }
    const principal = await findUserByCode(db, actor.principalCode);
    if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || principal.must_change_password) {
      throw new DomainError('agent_account_forbidden', '当前账号无法执行平台操作');
    }
    if (action.scope === 'account') {
      if (actor.projectCode) throw new DomainError('connector_project_mismatch', '此操作需要账号范围的连接');
    } else {
      const projectCode = PublicCodeSchema.safeParse(input.data.projectCode);
      if (!projectCode.success) throw new DomainError('project_selection_required', '请在本次调用提供 projectCode');
      if (actor.projectCode && actor.projectCode !== projectCode.data)
        throw new DomainError('connector_project_mismatch', '此连接只能操作原授权项目');
      const project = await findProjectByCode(db, projectCode.data);
      const access = project?.status === 'active' ? await resolveProjectAccess(db, project.id, principal.id) : null;
      if (!project || !access || !agentWorkspaceRoleAllows(action, access.role))
        throw new DomainError('project_forbidden', '当前账号或项目角色不允许此操作');
      if (action.projectObject) {
        const objectCode = PublicCodeSchema.parse(input.data[action.projectObject.key]);
        const [target] = await objectInProject(db, action.projectObject.kind, objectCode, project.id);
        if (!target) throw new DomainError('agent_object_not_found', '目标记录不在本次选择的项目');
      }
    }
    return injectWorkspaceAction(app, principal.code, agentWorkspaceRequest(action, input.data));
  };
}

export function registerAgentWorkspaceActions(app: FastifyInstance, db: Db): void {
  const execute = workspaceActionExecutor(app, db);
  app.post<{ Params: { name: string } }>('/agent/workspace-actions/:name', { bodyLimit: 128 * 1024, logLevel: 'silent' }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.authKind !== 'bearer' || !request.principal)
      return reply.code(401).send({ ok: false, error: { code: 'agent_device_login_required', message: '请先用 tsp auth login 授权 CLI 设备' } });
    const action = agentWorkspaceActionByName(request.params.name);
    if (!action) return reply.code(404).send({ ok: false, error: { code: 'agent_action_not_found', message: '当前版本没有此平台动作' } });
    try {
      return await execute(action, request.body, { principalCode: request.principal });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return reply.code(error.code.endsWith('forbidden') ? 403 : 400)
        .send({ ok: false, error: { code: error.code, message: error.message } });
    }
  });
}
