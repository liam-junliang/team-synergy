import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import type { ApiResult, createApiClient } from './api-client.js';

interface Context {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string } };
}
const code = encodeURIComponent;
export function registerPermissionCommands(program: Command, project: Command, team: Command, context: Context) {
  const run = async (action: () => Promise<ApiResult<unknown>>) => {
    try { const result = await action(); context.printResult(result); if (!result.ok) process.exitCode = 1; }
    catch (error) { context.printResult(context.failResult(error)); process.exitCode = 1; }
  };
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: unknown) => context.requireApiClient().permissionsRequest(method, route, body);
  const role = (value: string, isTeam = false) => {
    if (!(isTeam ? ['admin', 'member'] : ['admin', 'member', 'viewer']).includes(value)) throw new DomainError('member_role_invalid', '只能设置 Admin/Member/Viewer；Owner 请使用 ownership 转移');
    return value;
  };
  team.command('members <team_code>').description('查看正式团队成员及权限').action((teamCode: string) => run(() => call('GET', `/teams/${code(teamCode)}/members`)));
  team.command('role <team_code> <user_code>').description('调整团队角色；Admin 不能管理同级').requiredOption('--role <role>', 'admin / member').action((teamCode: string, userCode: string, opts: {role: string}) => run(() => call('PATCH', `/teams/${code(teamCode)}/members/${code(userCode)}`, {role: role(opts.role, true)})));
  team.command('remove <team_code> <user_code>').description('移出团队并撤销其团队内项目授权；负责人/未完成任务受保护').option('--preview', '只查看移出影响').action((teamCode: string, userCode: string, opts: {preview?: boolean}) => run(() => call(opts.preview ? 'GET' : 'DELETE', `/teams/${code(teamCode)}/members/${code(userCode)}${opts.preview ? '/removal-impact' : ''}`)));
  const member = project.command('member').description('项目显式授权；支持外部成员与继承例外');
  for (const action of ['add', 'role', 'remove'] as const) {
    const command = member.command(`${action} <user_code>`).option('--project <project_code>', '默认当前目录绑定项目');
    if (action !== 'remove') command.requiredOption('--role <role>', 'admin / member / viewer');
    command.description(action === 'remove' ? '撤销显式权限，团队成员可能恢复默认权限' : '添加或调整显式项目角色')
      .action((userCode: string, opts: {project?: string; role?: string}) => run(async () => {
        const projectCode = await context.resolveProjectCode(opts.project);
        const base = `/projects/${code(projectCode)}/members`;
        return call(action === 'add' ? 'POST' : action === 'role' ? 'PATCH' : 'DELETE', action === 'add' ? base : `${base}/${code(userCode)}`,
          action === 'remove' ? undefined : {user_code: userCode, role: role(opts.role ?? '')});
      }));
  }
  project.command('policy [mode]').description('查看或设置 private / team_read / team_write；仅负责人').option('--project <project_code>', '默认当前目录绑定项目').option('--preview', '只预览访问范围变化')
    .action((mode: string | undefined, opts: {project?: string; preview?: boolean}) => run(async () => {
      if (mode && !['private','team_read','team_write'].includes(mode)) throw new DomainError('project_policy_invalid', '项目访问方式无效');
      const path = `/projects/${code(await context.resolveProjectCode(opts.project))}/access-policy`;
      return call(mode && !opts.preview ? 'PUT' : 'GET', path + (mode && opts.preview ? `?member_policy=${code(mode)}` : ''), mode && !opts.preview ? {member_policy: mode} : undefined);
    }));
  const ownership = program.command('ownership').description('唯一负责人转移、接收、恢复与旧数据确认');
  ownership.command('list').description('查看本人发起或待接收的转移').action(() => run(() => call('GET','/ownership-transfers')));
  for (const action of ['transfer','recover','resolve'] as const) {
    const command = ownership.command(`${action} <scope> <scope_code> <user_code>`).description(action === 'resolve' ? '确认旧多 Owner 数据的唯一负责人' : action === 'recover' ? '为失效负责人发起受审计恢复，仍需接收人接受' : '发起所有权转移；接收人接受后生效');
    if (action === 'recover') command.requiredOption('--reason <reason>', '恢复原因');
    command.action((scope: string, scopeCode: string, userCode: string, opts: {reason?: string}) => run(() => {
      if (!['team','project'].includes(scope)) throw new DomainError('ownership_scope_invalid', 'scope 必须是 team 或 project');
      return call('POST', action === 'resolve' ? '/ownership/resolve' : `/ownership-transfers${action === 'recover' ? '/recover' : ''}`, {scope, scope_code: scopeCode, [action === 'resolve' ? 'owner_user_code' : 'target_user_code']: userCode, reason: opts.reason});
    }));
  }
  for (const action of ['accept','cancel']) ownership.command(`${action} <transfer_code>`).description(action === 'accept' ? '接收本人名下待确认的所有权' : '取消待处理的转移').action((value: string) => run(() => call('POST', `/ownership-transfers/${code(value)}/${action}`)));
  const closure = program.command('account').description('个人账号与注销交接').command('closure').description('先转移责任、处理任务和 Run，再注销');
  for (const action of ['status','begin','cancel','complete']) {
    const command = closure.command(action).description({status:'查看注销交接清单',begin:'开始注销准备，禁止新建或接收所有权',cancel:'取消注销准备',complete:'完成注销并撤销所有登录凭据'}[action] ?? action);
    if(action === 'complete') command.requiredOption('--confirm', '确认注销当前账号');
    command.action(() => run(() => call(action === 'status' ? 'GET' : 'POST', `/account/closure${action === 'status' ? '' : `/${action}`}`)));
  }
}
