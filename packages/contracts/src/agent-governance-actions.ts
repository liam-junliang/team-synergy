import { z } from 'zod';
import { code, inputText, type AgentActionDefinition } from './agent-action-definition.js';
import { ProjectMemberPolicySchema } from './schemas.js';

const managers = ['owner', 'admin'] as const;
const owners = ['owner'] as const;
const teamRole = z.enum(['admin', 'member']);
const projectRole = z.enum(['admin', 'member', 'viewer']);
const orderedCodes = z.array(code).refine(codes => new Set(codes).size === codes.length, '公开编码不可重复');
const teamCode = code.describe('团队公开编码，从 list_teams 获取。');
const userCode = code.describe('用户公开编码，从相关的成员列表获取。');
const projectName = inputText(240).describe('项目名称。');
const teamName = inputText(240).describe('团队名称。');
const repositoryTarget = { kind: 'repository', key: 'repository_code' } as const;
const repositoryCode = code.describe('仓库公开编码，从 list_project_repositories 获取。');
const repositoryFields = {
  name: inputText(240).describe('仓库显示名称。'),
  purpose: inputText(1000).describe('仓库用途。'),
  remote_url: inputText(2048).describe('不含密码、令牌、查询参数或片段的 Git 远端地址。'),
  default_branch: inputText(300).describe('仓库的默认主线分支。'),
};

export const governanceActions: readonly AgentActionDefinition[] = [
  {
    name: 'list_teams', module: 'teams', description: '列出当前账号加入的团队，返回团队编码和角色。创建项目时先找到所属团队。',
    method: 'GET', path: '/teams', schema: z.strictObject({}), scope: 'account',
  },
  {
    name: 'create_team', module: 'teams', description: '新建团队，当前账号成为负责人。超时后先查团队列表，再判断是否需要重试。',
    method: 'POST', path: '/teams', schema: z.strictObject({ name: teamName }), scope: 'account',
  },
  {
    name: 'rename_team', module: 'teams', description: '团队负责人或管理员修改团队名称。',
    method: 'PATCH', path: '/teams/:team_code', schema: z.strictObject({ team_code: teamCode, name: teamName }), scope: 'account',
  },
  {
    name: 'reorder_teams', module: 'teams', description: '更新当前账号的团队显示顺序，按新顺序提交本人全部团队编码。',
    method: 'PUT', path: '/teams/order', schema: z.strictObject({ team_codes: orderedCodes }), scope: 'account',
  },
  {
    name: 'list_team_members', module: 'teams', description: '查看所属团队的正式成员及角色。项目外部协作者不在团队成员列表中。',
    method: 'GET', path: '/teams/:team_code/members', schema: z.strictObject({ team_code: teamCode }), scope: 'account',
  },
  {
    name: 'list_team_projects_governance', module: 'teams', description: '团队负责人或管理员查看团队内活跃项目的名称、状态和负责人等管理信息。',
    method: 'GET', path: '/teams/:team_code/projects-governance', schema: z.strictObject({ team_code: teamCode }), scope: 'account',
  },
  {
    name: 'preview_team_member_removal', module: 'teams', description: '移出团队成员前查询其关联项目、所有权、未完成任务和进行中的 Run。',
    method: 'GET', path: '/teams/:team_code/members/:user_code/removal-impact',
    schema: z.strictObject({ team_code: teamCode, user_code: userCode }), scope: 'account',
  },
  {
    name: 'add_team_member', module: 'teams', description: '团队负责人或管理员向团队添加正式成员。只有团队负责人可授予管理员角色。',
    method: 'POST', path: '/teams/:team_code/members',
    schema: z.strictObject({ team_code: teamCode, user_code: userCode, role: teamRole }), scope: 'account',
  },
  {
    name: 'update_team_member_role', module: 'teams', description: '调整团队成员角色。管理员的任免由团队负责人处理。',
    method: 'PATCH', path: '/teams/:team_code/members/:user_code',
    schema: z.strictObject({ team_code: teamCode, user_code: userCode, role: teamRole }), scope: 'account',
  },
  {
    name: 'remove_team_member', module: 'teams', description: '移出团队成员并撤销其在该团队下的项目授权。先预览影响并确认本次移出。',
    method: 'DELETE', path: '/teams/:team_code/members/:user_code',
    schema: z.strictObject({ team_code: teamCode, user_code: userCode }), scope: 'account', destructive: true,
  },
  {
    name: 'create_project', module: 'projects', description: '在指定团队创建项目，创建者成为项目负责人。默认访问方式为 team_read。超时后先查项目列表。',
    method: 'POST', path: '/projects', scope: 'account',
    schema: z.strictObject({ team_code: teamCode, name: projectName, description: inputText(8000).optional(),
      member_policy: ProjectMemberPolicySchema.optional() }),
  },
  {
    name: 'get_project', module: 'projects', description: '查看指定项目的基本信息、当前快照、访问方式和当前账号的项目权限。',
    method: 'GET', path: '/projects/:projectCode', schema: z.strictObject({}), scope: 'project',
  },
  {
    name: 'update_project', module: 'projects', description: '项目负责人或管理员修改项目名称及说明。传 null 可清空说明。',
    method: 'PATCH', path: '/projects/:projectCode', scope: 'project', roles: managers,
    schema: z.strictObject({ name: projectName, description: inputText(8000).nullable().optional() }),
  },
  {
    name: 'reorder_projects', module: 'projects', description: '更新当前账号在一个团队中的项目显示顺序，按新顺序提交该团队的全部可访问项目编码。',
    method: 'PUT', path: '/projects/order',
    schema: z.strictObject({ team_code: teamCode, project_codes: orderedCodes }), scope: 'account',
  },
  {
    name: 'archive_project', module: 'projects', description: '项目负责人归档已完成交接的项目。归档后项目退出日常列表，恢复由系统管理员在后台处理。',
    method: 'PATCH', path: '/projects/:projectCode/status', scope: 'project', roles: owners, destructive: true,
    schema: z.strictObject({ status: z.literal('archived').default('archived') }),
  },
  {
    name: 'get_project_home', module: 'projects', description: '查看项目首页绑定的项目说明、参与指引和规范目录。',
    method: 'GET', path: '/projects/:projectCode/home', schema: z.strictObject({}), scope: 'project',
  },
  {
    name: 'update_project_home', module: 'projects', description: '项目负责人或管理员将项目文档关联到首页。传 null 解除对应绑定。',
    method: 'PUT', path: '/projects/:projectCode/home', scope: 'project', roles: managers,
    schema: z.strictObject({ overview_document_code: code.nullable().optional(), guide_document_code: code.nullable().optional() })
      .refine(input => input.overview_document_code !== undefined || input.guide_document_code !== undefined, '至少指定一个首页文档绑定'),
  },
  {
    name: 'preview_project_access_policy', module: 'projects', description: '项目负责人查看当前访问方式，或预览变更后哪些团队成员获得或失去继承权限。',
    method: 'GET', path: '/projects/:projectCode/access-policy', scope: 'project', roles: owners, requiresWorkspacePermission: true,
    schema: z.strictObject({ member_policy: ProjectMemberPolicySchema.optional() }),
  },
  {
    name: 'update_project_access_policy', module: 'projects', description: '项目负责人更新团队成员默认访问方式。先预览影响并确认本次变更。',
    method: 'PUT', path: '/projects/:projectCode/access-policy', scope: 'project', roles: owners, destructive: true,
    schema: z.strictObject({ member_policy: ProjectMemberPolicySchema }),
  },
  {
    name: 'add_project_member', module: 'projects', description: '为用户添加项目显式角色，支持团队外部协作者。授予管理员角色须由项目负责人执行。',
    method: 'POST', path: '/projects/:projectCode/members', scope: 'project', roles: managers,
    schema: z.strictObject({ user_code: userCode, role: projectRole }),
  },
  {
    name: 'update_project_member_role', module: 'projects', description: '修改显式项目成员角色。对只有团队继承权限的成员，使用添加项目成员建立显式角色。',
    method: 'PATCH', path: '/projects/:projectCode/members/:user_code', scope: 'project', roles: managers,
    schema: z.strictObject({ user_code: userCode, role: projectRole }),
  },
  {
    name: 'remove_project_member', module: 'projects', description: '撤销项目显式角色。团队成员可能恢复默认权限，操作前核对项目访问方式并确认。',
    method: 'DELETE', path: '/projects/:projectCode/members/:user_code', scope: 'project', roles: managers, destructive: true,
    schema: z.strictObject({ user_code: userCode }),
  },
  {
    name: 'list_project_repositories', module: 'repositories', description: '查看项目登记的 Git 仓库、默认分支、用途和状态。',
    method: 'GET', path: '/projects/:projectCode/repositories', schema: z.strictObject({}), scope: 'project',
  },
  {
    name: 'create_project_repository', module: 'repositories', description: '项目负责人或管理员登记一个项目 Git 仓库及其默认主线分支。',
    method: 'POST', path: '/projects/:projectCode/repositories', scope: 'project', roles: managers,
    schema: z.strictObject({ ...repositoryFields, purpose: repositoryFields.purpose.optional(), default_branch: repositoryFields.default_branch.optional() }),
  },
  {
    name: 'update_project_repository', module: 'repositories', description: '修改项目仓库名称、用途、远端地址或默认分支。用 null 清空用途或默认分支。',
    method: 'PATCH', path: '/repositories/:repository_code', scope: 'project', roles: managers, projectObject: repositoryTarget,
    schema: z.strictObject({ repository_code: repositoryCode, name: repositoryFields.name.optional(),
      purpose: repositoryFields.purpose.nullable().optional(), remote_url: repositoryFields.remote_url.optional(),
      default_branch: repositoryFields.default_branch.nullable().optional() })
      .refine(input => input.name !== undefined || input.purpose !== undefined || input.remote_url !== undefined || input.default_branch !== undefined,
        '至少提供一个要修改的仓库字段'),
  },
  {
    name: 'archive_project_repository', module: 'repositories', description: '归档项目仓库，停止作为活跃仓库使用。操作前确认要归档的仓库编码。',
    method: 'PATCH', path: '/repositories/:repository_code', scope: 'project', roles: managers, projectObject: repositoryTarget, destructive: true,
    schema: z.strictObject({ repository_code: repositoryCode, status: z.literal('archived').default('archived') }),
  },
  {
    name: 'restore_project_repository', module: 'repositories', description: '将当前项目已归档的仓库恢复为活跃状态。',
    method: 'PATCH', path: '/repositories/:repository_code', scope: 'project', roles: managers, projectObject: repositoryTarget,
    schema: z.strictObject({ repository_code: repositoryCode, status: z.literal('active').default('active') }),
  },
];
