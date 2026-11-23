import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  createCodeUnderstandingUseCases, createMemberUseCases, createProjectMaterialQueryUseCases,
  createProjectUseCases, createProjectUseCasesProject, createPublicCode, createTaskService, createTestingUseCases,
  findProjectByCode, findUserByCode, isProjectManager, resolveProjectAccess,
} from '@team-synergy/application';
import {
  ArtifactKindSchema, CodeGraphQuerySchema, MemoryBriefInput, MemoryDocumentReadInput, MemorySearchQuery, MemorySourcesInput,
  ProfileSchema, ProjectMaterialGlobInput, ProjectMaterialGrepInput, ProjectMaterialListInput,
  ProjectMaterialReadInput, PublicCodeSchema, TaskSourceSchema, TaskStatusSchema,
  agentWorkspaceActions, agentWorkspaceInputSchema, agentWorkspaceRoleAllows,
} from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { schema, type Db } from '@team-synergy/persistence';
import type { RemoteMcpGrant } from './remote-mcp-authorization.js';
import type { ExecuteWorkspaceAction } from './agent-workspace-actions.js';
import { RemoteMcpToolModuleSchema, SearchRemoteMcpToolsInput, searchRemoteMcpTools, type RemoteMcpToolModule } from './remote-mcp-tool-catalog.js';

export type RemoteMcpRequest = (options: { method: 'GET' | 'POST'; url: string; projectCode: string; payload?: object }) => Promise<unknown>;

type ProjectActor = { projectCode: string; principalCode: string };

const empty = z.strictObject({});
const snapshot = z.int().min(0).max(2147483647);
const taskCode = z.strictObject({ task_code: PublicCodeSchema });
const taskAction = taskCode.extend({ base_snapshot: snapshot });
const text = (max: number) => z.string().trim().min(1).max(max);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const httpsUrl = z.url({ protocol: /^https$/ }).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}, '请输入不含账户密码的 HTTPS 链接');

const taskDraft = z.strictObject({
  feature_code: PublicCodeSchema,
  title: text(240),
  brief: text(8000).optional(),
  profile: ProfileSchema.default('builder'),
  source: TaskSourceSchema.default('ad-hoc'),
  requirement_code: PublicCodeSchema.optional(),
  defect_code: PublicCodeSchema.optional(),
  acceptance: z.array(z.strictObject({ id: text(64), text: text(2000) })).min(1).max(30)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, '验收项编号不可重复'),
  depends_on_codes: z.array(PublicCodeSchema).max(30).optional(),
  idempotency_key: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/),
});
const taskSubmit = taskAction.extend({
  run_code: PublicCodeSchema,
  artifact: z.strictObject({ kind: ArtifactKindSchema, uri: httpsUrl, content_hash: sha }),
  evidence: z.strictObject({
    result: z.literal('pass'),
    acceptance_refs: z.array(text(64)).min(1).max(30),
    command: text(2000).optional(),
    summary: text(4000),
  }),
});

const testRun = taskCode.extend({
  title: text(512),
  environment: text(4096),
  tested_version: text(512),
  commit_sha: sha.optional(),
  notes_markdown: text(8000).optional(),
  asset_refs: z.array(z.strictObject({ asset_code: PublicCodeSchema, revision: snapshot.min(1) })).max(20).optional(),
  results: z.array(z.strictObject({
    case_code: PublicCodeSchema,
    case_revision: snapshot.min(1),
    result: z.enum(['not_run', 'pass', 'fail', 'blocked', 'skipped']),
    actual_result: text(4000).optional(),
    notes: text(4000).optional(),
    report_urls: z.array(httpsUrl).max(5).optional(),
  })).min(1).max(20),
});

function dataOf<T>(result: unknown): T {
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new DomainError('connector_service_unavailable', '项目服务暂时不可用');
  }
  if (result.ok === true && 'data' in result) return result.data as T;
  if ('error' in result && result.error && typeof result.error === 'object' &&
      'code' in result.error && typeof result.error.code === 'string' &&
      'message' in result.error && typeof result.error.message === 'string' && result.error.code !== 'internal_error') {
    throw new DomainError(result.error.code, result.error.message);
  }
  throw new DomainError('connector_service_unavailable', '项目服务暂时不可用');
}

function workspaceWriteReceipt(result: unknown) {
  // A completed mutation must remain a success even when its response includes long revision history.
  const identifiers = result && typeof result === 'object' ? Object.fromEntries(Object.entries(result).filter(([key, value]) =>
    ((key === 'code' || /_code$/.test(key)) && PublicCodeSchema.safeParse(value).success) ||
    (['revision', 'current_revision', 'base_snapshot'].includes(key) && Number.isSafeInteger(value)))) : {};
  return { applied: true, resultOmitted: true, ...identifiers, nextStep: '已保存。请读取目标对象或查看最新修订，无需重复提交。' };
}

function capability<S extends z.ZodType>(
  module: RemoteMcpToolModule,
  name: string,
  description: string,
  schema: S,
  action: (args: z.output<S>) => Promise<unknown>,
  write?: { idempotentHint: boolean; destructiveHint?: boolean },
) {
  return {
    module, name, description, schema,
    annotations: { readOnlyHint: write === undefined, destructiveHint: false, ...write },
    async execute(args: unknown) {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) throw new DomainError('validation_failed', parsed.error.issues.map(issue =>
        `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
      const result = await action(parsed.data);
      if (Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8') > 128_000) {
        if (write) return workspaceWriteReceipt(result);
        // A read can be requested again with a smaller page.
        throw new DomainError('agent_output_too_large', '结果超过 128 KB，请缩小查询范围或分页读取');
      }
      return result;
    },
  };
}

export function remoteMcpTools(db: Db, grant: RemoteMcpGrant, request: RemoteMcpRequest, webOrigin: string,
  executeWorkspace?: ExecuteWorkspaceAction) {
  const accountScoped = grant.projectCode === null;
  const projectSelector = PublicCodeSchema.describe('目标项目编码，使用 list_projects 返回的 projectCode。');
  const webUrl = (projectCode: string, path: string) => new URL('/projects/' + projectCode + path, webOrigin).href;
  function artifactUrl(projectCode: string, uri: string) {
    const execution = /^tsp:test-execution\/([0-9A-HJKMNP-TV-Z]{20})$/.exec(uri);
    if (execution) return webUrl(projectCode, '/testing?tab=executions&item=' + execution[1]);
    const asset = /^tsp:test-asset\/([0-9A-HJKMNP-TV-Z]{20})@([1-9]\d*)$/.exec(uri);
    if (asset && Number.isSafeInteger(Number(asset[2]))) return webUrl(projectCode, '/testing?tab=assets&item=' + asset[1] + '&revision=' + asset[2]);
    return httpsUrl.safeParse(uri).success ? uri : null;
  }
  const tasks = createTaskService(db);
  const projects = createProjectUseCases(db);
  const projectRegistry = createProjectUseCasesProject(db);
  const documents = createProjectMaterialQueryUseCases(db);
  const code = createCodeUnderstandingUseCases(db);
  const testing = createTestingUseCases(db);

  async function currentPrincipal() {
    const principal = await findUserByCode(db, grant.principalCode);
    if (!principal || principal.status !== 'active' || principal.deleted_at || principal.pending_deletion || principal.must_change_password) {
      throw new DomainError('connector_account_forbidden', '当前账号无法使用此连接');
    }
    return principal;
  }

  async function projectAccess(projectCode: string, principal: Awaited<ReturnType<typeof currentPrincipal>>) {
    if (grant.projectCode && projectCode !== grant.projectCode) {
      throw new DomainError('connector_project_mismatch', '此连接只能使用原授权项目');
    }
    const project = await findProjectByCode(db, projectCode);
    const access = project?.status === 'active' ? await resolveProjectAccess(db, project.id, principal.id) : null;
    if (!project || !access) throw new DomainError('project_forbidden', '当前账号无法访问此项目');
    return { project, role: access.role };
  }

  function projectCapability<S extends z.ZodObject>(
    module: RemoteMcpToolModule, name: string, description: string, schema: S,
    action: (args: z.output<S>, actor: ProjectActor) => Promise<unknown>,
    write?: { idempotentHint: boolean },
  ) {
    const scoped = schema.safeExtend({ projectCode: accountScoped ? projectSelector : projectSelector.optional() });
    return capability(module, name, description, scoped, async (input) => {
      const { projectCode, ...params } = input as z.output<S> & { projectCode?: string };
      const target = projectCode ?? grant.projectCode;
      if (!target) throw new DomainError('connector_project_required', '请先确认项目，并在本次调用传入 projectCode');
      const principal = await currentPrincipal();
      const { project, role } = await projectAccess(target, principal);
      if (write && (!grant.allowTaskWrite || role === 'viewer')) {
        throw new DomainError('project_forbidden', '当前项目权限不足，无法执行协作操作');
      }
      // The project parameter authorizes this call and never enters a downstream operation payload.
      return action(params as z.output<S>, { projectCode: project.code, principalCode: principal.code });
    }, write);
  }

  function memory(projectCode: string, scope: 'project' | 'personal', path: string, payload: object) {
    if (scope === 'personal' && !grant.allowPersonalMemory) {
      throw new DomainError('connector_personal_memory_forbidden', '当前连接未授权读取个人记忆');
    }
    return request({ method: 'POST', url: '/projects/' + projectCode + '/memory/' + path, projectCode, payload }).then(dataOf);
  }

  async function assertProjectObject(projectCode: string, kind: 'task' | 'feature', objectCode: string) {
    const features = schema.features;
    const projectsTable = schema.projects;
    const joinConditions = and(eq(projectsTable.code, projectCode), eq(projectsTable.status, 'active'));
    const match = kind === 'task'
      ? await db.select({ id: schema.tasks.id }).from(schema.tasks)
        .innerJoin(features, eq(features.id, schema.tasks.feature_id))
        .innerJoin(projectsTable, eq(projectsTable.id, features.project_id))
        .where(and(eq(schema.tasks.code, objectCode), joinConditions)).limit(1)
      : await db.select({ id: features.id }).from(features)
        .innerJoin(projectsTable, eq(projectsTable.id, features.project_id))
        .where(and(eq(features.code, objectCode), joinConditions)).limit(1);
    if (!match.length) throw new DomainError('connector_object_not_found', '当前连接授权的项目中没有此记录');
  }

  function withTaskLink<T extends object>(projectCode: string, value: T) {
    const code = 'task_code' in value && typeof value.task_code === 'string' ? value.task_code : undefined;
    return { ...value, projectCode, url: webUrl(projectCode, '/board' + (code ? '?task=' + encodeURIComponent(code) : '')) };
  }

  const workspace = agentWorkspaceActions
    .filter(action => (action.scope !== 'account' || accountScoped) &&
      ((action.scope === 'project' && action.method === 'GET' && !action.requiresWorkspacePermission) || grant.allowWorkspaceWrite))
    .map(action => ({ action, tool: capability(action.module, action.name, action.description,
      agentWorkspaceInputSchema(action, grant.projectCode), async input => {
        if (!executeWorkspace) throw new DomainError('agent_action_unavailable', '平台动作暂时不可用');
        return dataOf(await executeWorkspace(action, input, grant));
      }, action.method === 'GET' ? undefined : { idempotentHint: false, destructiveHint: action.destructive ?? false }) }));

  const read = [
    capability('projects', 'read_connector_skill', '读取内置 Connector 技能。空参数返回入门流程，传 module 查看该模块各工具的用法、参数、结果和示例。无需 projectCode。',
      z.strictObject({ module: RemoteMcpToolModuleSchema.optional() }), async ({ module }) => {
        const path = module ? `references/${module}.md` : 'SKILL.md';
        return {
          name: 'team-synergy-connector', path,
          markdown: await readFile(new URL(`../dist/connector-skill/${path}`, import.meta.url), 'utf8') + (module ?
            workspace.filter(({ action }) => action.module === module).map(({ action, tool }) => {
              const input = z.toJSONSchema(tool.schema, { io: 'input' });
              return `\n\n## \`${action.name}\`\n\n${action.description}\n\n` +
                `必填参数：${input.required?.join('、') || '无'}。完整字段与约束见工具 schema。`;
            }).join('') : ''),
        };
      }),
    capability('projects', 'get_connection_context', '查看当前账号和连接授权。用 list_projects 按名称定位项目，再用本连接的 search_tools 选择后续工作所需工具。传入 projectCode 可检查目标项目的角色和权限。',
      z.strictObject({ projectCode: projectSelector.optional() }), async ({ projectCode }) => {
      const principal = await currentPrincipal();
      const identity = {
        userCode: principal.code, account: principal.account, displayName: principal.display_name,
        connectionScope: accountScoped ? 'account' : 'project',
        allowPersonalMemory: grant.allowPersonalMemory, allowTaskWrite: grant.allowTaskWrite,
        allowWorkspaceWrite: grant.allowWorkspaceWrite === true,
      };
      const target = projectCode ?? grant.projectCode;
      if (!target) return { ...identity, projectCode: null, projectSelection: 'required',
        nextStep: '在本连接调用 list_projects 定位项目，再调用 search_tools 查询后续工作所需工具。项目不明确时先确认。' };
      const { project, role } = await projectAccess(target, principal);
      return { ...identity, projectCode: project.code, projectName: project.name, projectSelection: accountScoped ? 'explicit' : 'connector',
        role, allowTaskWrite: grant.allowTaskWrite && role !== 'viewer', allowWorkspaceWrite: grant.allowWorkspaceWrite === true && role !== 'viewer',
        canAssign: grant.allowTaskWrite && isProjectManager(role), projectUrl: webUrl(project.code, '/overview') };
    }),
    capability('projects', 'list_projects', '查找此连接可访问的项目，返回各项目的 projectCode 和协作权限。选定项目后，调用本连接的 search_tools 查找后续工作所需工具。',
      z.strictObject({ query: text(256).optional(), limit: z.int().min(1).max(100).default(40) }), async ({ query, limit }) => {
      const principal = await currentPrincipal();
      const projects = await projectRegistry.listProjects(principal.code);
      const sought = query?.toLocaleLowerCase();
      const matches = projects.filter(row => row.status === 'active' && (!grant.projectCode || row.project_code === grant.projectCode) &&
        (!sought || [row.project_code, row.name, row.team_name].some(value => value.toLocaleLowerCase().includes(sought))));
      const items = matches.slice(0, limit).map(row => ({
        projectCode: row.project_code, name: row.name, teamCode: row.team_code, teamName: row.team_name,
        role: row.role, status: row.status, allowTaskWrite: grant.allowTaskWrite && row.capabilities.write,
        canAssign: grant.allowTaskWrite && isProjectManager(row.role), projectUrl: webUrl(row.project_code, '/overview'),
      }));
      return { items, total: matches.length, truncated: matches.length > limit,
        nextStep: '为每项工作先调用本连接的 search_tools，传入目标 projectCode 和需求关键词。用本连接返回的工具和项目编码继续操作。' };
    }),
    projectCapability('materials', 'list_project_materials', '列出项目、需求、架构及长期测试资料的虚拟路径、版本和引用。query 匹配标题、路径、摘要。全文用 grep_project_materials。', ProjectMaterialListInput,
      async (args, actor) => dataOf(await documents.list({ ...actor, ...args }))),
    projectCapability('materials', 'glob_project_materials', '用 Glob 模式查找项目资料虚拟路径；例如 **/*.md。', ProjectMaterialGlobInput,
      async (args, actor) => dataOf(await documents.glob({ ...actor, ...args }))),
    projectCapability('materials', 'grep_project_materials', '在项目资料正文检索关键字，得到版本、引用及命中行。默认字面匹配，多词择一需指定 regex。', ProjectMaterialGrepInput,
      async (args, actor) => dataOf(await documents.grep({ ...actor, ...args }))),
    projectCapability('materials', 'read_project_material', '用来源 sourceCitation、虚拟路径或对象类型和编码读取原文。引用时使用实际修订及行号，注意历史版本。', ProjectMaterialReadInput,
      async (args, actor) => dataOf(await documents.read({ ...actor, ...args }))),
    projectCapability('memory', 'search_memory', '按当前问题主动检索项目讨论、决定和文档引用，默认项目。只有连接授权后才可指定 personal 检索本人的偏好。', MemorySearchQuery,
      async (args, actor) => memory(actor.projectCode, args.scope ?? 'project', 'search', { ...args, scope: args.scope ?? 'project' })),
    projectCapability('memory', 'read_memory_brief', '查当前项目近期讨论、已确认决定及资料引用的简报。需要概况或关键词检索未命中时使用，按状态引用来源。个人偏好需单独授权。', MemoryBriefInput,
      async (args, actor) => memory(actor.projectCode, args.scope, 'brief', args)),
    projectCapability('memory', 'read_memory_sources', '按 search_memory 返回的来源编码查来源，scope 应与原检索一致，默认项目。区分已讨论、确认和资料记载。', MemorySourcesInput,
      async (args, actor) => memory(actor.projectCode, args.scope ?? 'project', 'sources', { ...args, scope: args.scope ?? 'project' })),
    projectCapability('memory', 'read_memory_document', '阅读记忆引用的项目文档修订，可按位置或关键词分页。', MemoryDocumentReadInput,
      async (args, actor) => memory(actor.projectCode, 'project', 'documents/read', args)),
    projectCapability('code', 'read_code_catalog', '查当前项目的仓库、已发布分析和代码视图。项目角色决定可用的分析结果。', empty,
      async (_, actor) => dataOf(await code.context(actor))),
    projectCapability('code', 'query_code_graph', '在固定版本的 UA 或 CodeGraph 查询符号、依赖和源代码证据。先用 read_code_catalog 定位范围。', CodeGraphQuerySchema,
      async (args, actor) => dataOf(await code.graph({ ...actor, input: args }))),
    projectCapability('tasks', 'list_project_features', '列出此项目的 Feature、所属模块和目标。创建草稿前使用明确的 Feature 编码。', empty,
      async (_, actor) => dataOf(await projects.listFeatures(actor))),
    projectCapability('tasks', 'list_tasks', '列出此项目任务，支持状态、仅本人被分派和分页。', z.strictObject({
      status: TaskStatusSchema.optional(), mine: z.boolean().optional(), limit: z.int().min(1).max(50).default(20),
      offset: snapshot.default(0),
    }), async ({ status, mine, limit, offset }, actor) => {
      const page = await tasks.listTaskPage({ ...actor, status, assignedTo: mine ? actor.principalCode : undefined, limit, offset });
      return { ...page, data: page.data.map(item => withTaskLink(actor.projectCode, item)) };
    }),
    projectCapability('tasks', 'get_task', '查任务契约、最新状态、验收项与执行记录，进入写操作前核对 base_snapshot。', taskCode, async ({ task_code }, actor) => {
      await assertProjectObject(actor.projectCode, 'task', task_code);
      const result = await tasks.getTaskStatus(task_code, actor.principalCode);
      if (!result.ok) return dataOf(result);
      const item = result.data;
      return withTaskLink(actor.projectCode, {
        task_code: item.task_code, feature_code: item.feature_code, requirement_code: item.requirement_code,
        requirement_baseline_code: item.requirement_baseline_code, source_requirement_revision: item.source_requirement_revision,
        defect_code: item.defect_code, title: item.title, brief: item.brief, profile: item.profile, status: item.status,
        assignee_principal_code: item.assignee_principal_code, acceptance: item.acceptance, validation_seams: item.validation_seams,
        base_snapshot: item.base_snapshot,
        runs: item.runs.map(({ run_code, status, profile, principal_code, started_at, finished_at }) =>
          ({ run_code, status, profile, principal_code, started_at, finished_at })),
        evidences: item.evidences.map(({ evidence_code, run_code, type, acceptance_refs, result, summary, recorded_at }) =>
          ({ evidence_code, run_code, type, acceptance_refs, result, summary, recorded_at })),
        artifacts: item.artifacts.map(({ artifact_code, run_code, kind, title, content_hash, uri }) =>
          ({ artifact_code, run_code, kind, title, content_hash, uri: artifactUrl(actor.projectCode, uri) })),
      });
    }),
    projectCapability('projects', 'list_project_members', '查当前项目成员编码、显示名称和角色，供分派时匹配对象。', empty, async (_, actor) => {
      const members = await createMemberUseCases(db).listMembers(actor.projectCode, actor.principalCode);
      return members.map(({ user_code, display_name, role }) => ({ user_code, display_name, role }));
    }),
    projectCapability('testing', 'list_test_cases', '查看当前项目测试用例和当前修订，填写实际测试执行记录前核对用例步骤。', z.strictObject({ query: text(200).optional() }), async (args, actor) =>
      dataOf(await testing.listCases({ ...actor, ...args }))),
  ];

  const connectionCode = grant.allowTaskWrite ? PublicCodeSchema.parse(grant.connectionCode) : null;
  const write = connectionCode ? [
    projectCapability('tasks', 'create_task_draft', '创建任务草稿，提供明确的 Feature 和可验证的验收项。幂等键固定指向本次创建请求，超时重试时要复用。', taskDraft, async (args, actor) => {
      await assertProjectObject(actor.projectCode, 'feature', args.feature_code);
      const result = await projects.createTask({
        principalCode: actor.principalCode, featureCode: args.feature_code, title: args.title, brief: args.brief,
        source: args.source, profile: args.profile, acceptance: args.acceptance, requirementCode: args.requirement_code,
        defectCode: args.defect_code, dependsOnCodes: args.depends_on_codes, idempotencyKey: args.idempotency_key,
      });
      return withTaskLink(actor.projectCode, dataOf<object>(result));
    }, { idempotentHint: true }),
    projectCapability('tasks', 'assign_task', '项目负责人或管理员可发布并分派草稿给指定成员，使用 get_task 返回的 base_snapshot。', taskAction.extend({
      assignee_principal_code: PublicCodeSchema,
    }), async ({ task_code, assignee_principal_code, base_snapshot }, actor) => {
      await assertProjectObject(actor.projectCode, 'task', task_code);
      return withTaskLink(actor.projectCode, dataOf<object>(await tasks.assignTask({
        taskCode: task_code, principalCode: actor.principalCode, assigneePrincipalCode: assignee_principal_code, baseSnapshot: base_snapshot,
      })));
    }, { idempotentHint: false }),
    projectCapability('tasks', 'claim_task', '领取已分派给本人的 Builder 任务。仅当真实的外部执行工作区已就绪时提供其 HTTPS 工作区链接和 Git 基线提交。设备租约任务从本地执行入口领取。', taskAction.extend({
      workspace_url: httpsUrl, git_base: sha,
    }), async ({ task_code, base_snapshot, workspace_url, git_base }, actor) => {
      await assertProjectObject(actor.projectCode, 'task', task_code);
      return withTaskLink(actor.projectCode, dataOf<object>(await tasks.claimTask({
        taskCode: task_code, runCode: createPublicCode(), workspaceCode: createPublicCode(),
        principalCode: actor.principalCode, profile: 'builder', baseSnapshot: base_snapshot,
        workspacePath: workspace_url, gitBase: git_base, remoteConnectionCode: connectionCode,
      })));
    }, { idempotentHint: false }),
    projectCapability('tasks', 'submit_task_evidence', '提交当前连接领取的任务执行成果及真实通过的自测证明。提供可核验的 HTTPS 产物链接、内容哈希、验收项和结果摘要。提交后等待独立验收。', taskSubmit,
      async ({ task_code, run_code, base_snapshot, artifact, evidence }, actor) => {
        await assertProjectObject(actor.projectCode, 'task', task_code);
        return withTaskLink(actor.projectCode, dataOf<object>(await tasks.submitTask({
          taskCode: task_code, runCode: run_code, principalCode: actor.principalCode, baseSnapshot: base_snapshot,
          remoteConnectionCode: connectionCode,
          artifact: { kind: artifact.kind, uri: artifact.uri, contentHash: artifact.content_hash },
          evidence: { type: 'self_test', result: evidence.result, acceptanceRefs: evidence.acceptance_refs,
            command: evidence.command, summary: evidence.summary },
        })));
      }, { idempotentHint: false }),
    projectCapability('testing', 'record_test_execution', '登记项目已有用例的实际测试结果、执行环境、版本和证据链接，关联到对应任务。用于登记已验证事实，任务状态由执行流程更新。', testRun,
      async (args, actor) => {
        await assertProjectObject(actor.projectCode, 'task', args.task_code);
        const result = await testing.createExecution({ ...actor, input: { ...args, source: 'agent' } });
        if (!result.ok) return dataOf(result);
        const { code, counts, task_code } = result.data;
        return { code, counts, task_code, projectCode: actor.projectCode, url: webUrl(actor.projectCode, '/testing?tab=executions&item=' + code) };
      }, { idempotentHint: false }),
  ] : [];
  const search = capability('projects', 'search_tools',
    '选用 TeamSynergy 工具时先调用这一入口。空参数看模块简介，可按 module 和中英文 query 查找工具；提供 projectCode 可按该项目当前角色筛选。返回工具名后直接调用相应工具。',
    SearchRemoteMcpToolsInput, async (input): Promise<ReturnType<typeof searchRemoteMcpTools>> => {
      let visibleWrites = write;
      let visibleWorkspace = workspace;
      const target = input.projectCode ?? grant.projectCode;
      if (target) {
        const { role } = await projectAccess(target, await currentPrincipal());
        visibleWrites = role === 'viewer' ? [] : write.filter(tool => tool.name !== 'assign_task' || isProjectManager(role));
        visibleWorkspace = workspace.filter(({ action }) => action.scope === 'account' || agentWorkspaceRoleAllows(action, role));
      }
      return searchRemoteMcpTools([search, ...read, ...visibleWrites, ...visibleWorkspace.map(({ tool }) => tool)], input);
    });
  return [search, ...read, ...write, ...workspace.map(({ tool }) => tool)];
}
