import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import type { ProjectSkillManifest, ProjectSkills, SkillDetail } from '@team-synergy/contracts';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiResult, createApiClient } from './api-client.js';
import { identifyBoundProject } from './project-binding.js';
import { assertSkillPathAncestors, readSkillDirectory, syncSkillManifest, validateSkillFiles } from './skill-sync.js';

interface Context {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string; details?: unknown } };
}
type Options = Record<string, string | boolean | undefined>;
const code = encodeURIComponent;
function text(options: Options, key: string): string | undefined { const value = options[key]; return typeof value === 'string' ? value : undefined; }
function integer(value: string | undefined, field: string, minimum = 1): number {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new DomainError('skill_argument_invalid', `${field} 必须是大于等于 ${minimum} 的整数`);
  return Number(value);
}
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  return result.data;
}
function input(options: Options): Record<string, unknown> {
  const file = text(options, 'file');
  const directory = text(options, 'directory');
  if (!file && !directory) throw new DomainError('skill_input_required', '请提供 --directory 技能包目录或 --file JSON');
  let body: Record<string, unknown> = {};
  if (file) {
    const absolute = path.resolve(file);
    assertSkillPathAncestors(absolute);
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 9 * 1024 * 1024) throw new DomainError('skill_input_invalid', '技能 JSON 必须是小于 9 MiB 的普通文件');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new DomainError('skill_input_invalid', '技能输入不是有效 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('skill_input_invalid', '技能输入必须是 JSON 对象');
    body = parsed as Record<string, unknown>;
  }
  if (directory) body.files = readSkillDirectory(directory);
  if (!Array.isArray(body.files)) throw new DomainError('skill_input_invalid', '技能输入必须包含 files 文件清单');
  body.files = validateSkillFiles(body.files);
  return body;
}
function requireOneScope(options: Options): { scope_type: 'team' | 'project'; scope_code: string } | undefined {
  const team = text(options, 'team'); const project = text(options, 'project');
  if (team && project) throw new DomainError('skill_scope_invalid', '--team 与 --project 不能同时指定');
  return team ? { scope_type: 'team', scope_code: team } : project ? { scope_type: 'project', scope_code: project } : undefined;
}

export function registerSkillCommands(program: Command, context: Context): void {
  const skill = program.command('skill').description('团队和项目技能：版本、共享、项目采用与本机同步；不执行包内脚本');
  const run = async (action: () => Promise<ApiResult<unknown>>) => {
    try { const result = await action(); context.printResult(result); if (!result.ok) process.exitCode = 1; }
    catch (error) { context.printResult(context.failResult(error)); process.exitCode = 1; }
  };
  const call = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: unknown) => context.requireApiClient().skillRequest<T>(method, route, body);
  const scope = async (options: Options) => requireOneScope(options) ?? { scope_type: 'project' as const, scope_code: await context.resolveProjectCode() };
  skill.command('list').description('列出项目固定版本、启用状态和共享失效提示')
    .option('--project <project_code>', '默认当前目录绑定项目')
    .action((opts: Options) => run(async () => call('GET', `/projects/${code(await context.resolveProjectCode(text(opts, 'project')))}/skills`)));
  for (const action of ['catalog', 'search'] as const) {
    skill.command(action === 'search' ? 'search <query>' : 'catalog')
      .description('读取当前范围自有或获授权的技能目录；不会列出其他团队私有技能')
      .option('--team <team_code>', '团队范围').option('--project <project_code>', '项目范围；默认当前目录绑定')
      .option('--view <view>', 'owned / available / shared', 'available').option('--query <query>', '名称和说明关键词')
      .action((...args: unknown[]) => run(async () => {
        const opts = args[action === 'search' ? 1 : 0] as Options;
        const selected = await scope(opts);
        const view = text(opts, 'view') ?? 'available';
        if (!['owned', 'available', 'shared'].includes(view)) throw new DomainError('skill_argument_invalid', '--view 必须是 owned / available / shared');
        const query = new URLSearchParams({ [`${selected.scope_type}_code`]: selected.scope_code, view });
        const term = action === 'search' ? args[0] as string : text(opts, 'query');
        if (term !== undefined) query.set('q', term);
        return call('GET', `/skills?${query}`);
      }));
  }
  skill.command('show <skill_code>').description('读取已授权技能及文件；项目外部成员只读项目交付版本')
    .option('--revision <revision>', '仅返回指定版本').option('--project <project_code>', '通过项目交付授权读取')
    .action((value: string, opts: Options) => run(async () => {
      const selected = text(opts, 'revision') === undefined ? undefined : integer(text(opts, 'revision'), 'revision');
      const projectCode = text(opts, 'project') ?? identifyBoundProject(process.cwd())?.binding.project_code;
      const query = projectCode ? `?project_code=${code(projectCode)}` : '';
      const detail = unwrap(await call<SkillDetail>('GET', `/skills/${code(value)}${query}`));
      if (selected === undefined) return { ok: true, data: detail };
      const revision = detail.revisions.find(item => item.revision === selected);
      if (!revision) throw new DomainError('skill_revision_not_found', '此版本不存在或当前身份没有读取授权');
      return { ok: true, data: { ...detail, selected_revision: selected, revisions: [revision] } };
    }));
  for (const action of ['create', 'revise'] as const) {
    const command = skill.command(action === 'create' ? action : 'revise <skill_code>')
      .description(action === 'create' ? '上传完整技能包并建立第一个草稿；不执行脚本' : '创建不可变新修订，旧修订不变')
      .option('--directory <directory>', '含 SKILL.md 的本机目录（拒绝符号链接和目录联接）')
      .option('--file <path>', '技能 JSON；可用 --directory 替换 files');
    if (action === 'create') command.option('--team <team_code>', '创建团队技能').option('--project <project_code>', '创建项目技能；默认当前目录绑定').option('--change <summary>', '初始版本说明');
    else command.requiredOption('--base-revision <revision>', '编辑时读取的当前修订号').requiredOption('--change <summary>', '变更说明');
    command.action((...args: unknown[]) => run(async () => {
      const opts = args[action === 'create' ? 0 : 1] as Options;
      const body = input(opts);
      if (text(opts, 'change') !== undefined) body.change_summary = text(opts, 'change');
      if (action === 'create') {
        const selected = requireOneScope(opts);
        if (selected) Object.assign(body, selected);
        else if (body.scope_type !== undefined || body.scope_code !== undefined) {
          if (!['team', 'project'].includes(String(body.scope_type)) || typeof body.scope_code !== 'string' || !body.scope_code.trim()) throw new DomainError('skill_scope_invalid', 'JSON 的 scope_type / scope_code 无效');
        } else Object.assign(body, await scope(opts));
      }
      else body.base_revision = integer(text(opts, 'baseRevision'), 'base-revision');
      return call(action === 'create' ? 'POST' : 'PATCH', action === 'create' ? '/skills' : `/skills/${code(args[0] as string)}`, body);
    }));
  }
  skill.command('publish <skill_code>').description('发布指定修订；仅来源负责人或管理员')
    .requiredOption('--revision <revision>', '确切修订号')
    .action((value: string, opts: Options) => run(async () => call('POST', `/skills/${code(value)}/publish`, { revision: integer(text(opts, 'revision'), 'revision') })));
  skill.command('archive <skill_code>').description('归档技能，阻止新的采用和交付；历史保留')
    .option('--restore', '恢复归档的技能')
    .action((value: string, opts: Options) => run(async () => call('POST', `/skills/${code(value)}/archive`, { archived: !opts.restore })));
  skill.command('share <skill_code>').description('明确授权指定版本；共享不会授予编辑权或转授权')
    .option('--team <team_code>', '目标团队').option('--project <project_code>', '目标项目')
    .requiredOption('--revisions <revisions>', '确切修订列表，逗号分隔，例如 1,3')
    .option('--allow-projects', '允许目标团队所属项目采用').option('--allow-external', '明确允许目标项目的外部协作者读取')
    .action((value: string, opts: Options) => run(async () => {
      const target = requireOneScope(opts);
      if (!target) throw new DomainError('skill_scope_invalid', '共享必须明确指定目标 --team 或 --project');
      const revisions = (text(opts, 'revisions') ?? '').split(',').map(item => integer(item.trim(), 'revisions'));
      if (new Set(revisions).size !== revisions.length) throw new DomainError('skill_argument_invalid', '共享修订不能重复');
      return call('POST', `/skills/${code(value)}/shares`, { target_type: target.scope_type, target_code: target.scope_code, revisions, allow_projects: opts.allowProjects === true, allow_external: opts.allowExternal === true });
    }));
  skill.command('revoke <skill_code> <share_code>').description('撤销共享，阻止新同步和新执行；已下载的副本无法远程收回')
    .action((value: string, share: string) => run(async () => call('DELETE', `/skills/${code(value)}/shares/${code(share)}`)));
  for (const action of ['enable', 'update', 'disable'] as const) {
    const command = skill.command(`${action} <skill_code>`)
      .description(action === 'disable' ? '停用项目引用；不会改动技能源或历史版本' : '选择项目固定版本；仅项目负责人或管理员')
      .option('--project <project_code>', '默认当前目录绑定项目').option('--base-generation <generation>', '已读取的项目安装集合版本；省略时读取最新集合');
    if (action !== 'disable') command.requiredOption('--revision <revision>', '确切的已发布版本').option('--alias <alias>', '项目内唯一目录别名；已有安装默认沿用');
    command.action((value: string, opts: Options) => run(async () => {
      const projectCode = await context.resolveProjectCode(text(opts, 'project'));
      const selectedRevision = action === 'disable' ? undefined : integer(text(opts, 'revision'), 'revision');
      const explicitGeneration = text(opts, 'baseGeneration') === undefined ? undefined : integer(text(opts, 'baseGeneration'), 'base-generation', 0);
      const current = unwrap(await call<ProjectSkills>('GET', `/projects/${code(projectCode)}/skills`));
      const installed = current.installations.find(item => item.skill_code === value);
      if (action !== 'enable' && !installed) throw new DomainError('skill_installation_not_found', '此项目尚未采用该技能');
      const alias = text(opts, 'alias') ?? installed?.alias ?? unwrap(await call<SkillDetail>('GET', `/skills/${code(value)}?project_code=${code(projectCode)}`)).name;
      const revision = selectedRevision ?? installed?.revision;
      if (revision === undefined) throw new DomainError('skill_installation_not_found', '此项目尚未采用该技能');
      return call('PUT', `/projects/${code(projectCode)}/skills/${code(value)}`, {
        revision, alias, enabled: action === 'enable' || action === 'update' && installed?.enabled === true, base_generation: explicitGeneration ?? current.generation,
      });
    }));
  }
  for (const action of ['manifest', 'sync'] as const) {
    const command = skill.command(action).description(action === 'manifest' ? '读取确切版本清单；撤销授权会拒绝交付整个清单' : '校验并同步到工作区 .tsp/skills，保留本地修改；不改变平台版本选择')
      .option('--project <project_code>', '默认当前目录绑定项目').option('--run <run_code>', '使用 Run 固定清单与独立目录，不跟随项目升级');
    if (action === 'sync') command.option('--workspace <directory>', '目标工作区，默认当前目录').option('--check', '只检查差异与冲突，不写文件');
    command.action((opts: Options) => run(async () => {
      const runCode = text(opts, 'run');
      if (runCode && (text(opts, 'project') || !/^[0-9A-HJKMNP-TV-Z]{20}$/.test(runCode))) throw new DomainError('skill_argument_invalid', '--run 必须是公开编码，不能同时指定 --project');
      const workspace = path.resolve(text(opts, 'workspace') ?? process.cwd());
      const projectCode = runCode ? undefined : text(opts, 'workspace') && !text(opts, 'project')
        ? identifyBoundProject(workspace)?.binding.project_code : await context.resolveProjectCode(text(opts, 'project'));
      if (!runCode && !projectCode) throw new DomainError('project_code_required', '目标工作区未绑定项目，请显式指定 --project');
      const manifest = unwrap(await call<ProjectSkillManifest>('GET', runCode ? `/runs/${code(runCode)}/skills` : `/projects/${code(projectCode ?? '')}/skills/manifest`));
      if (projectCode && manifest.project_code !== projectCode) throw new DomainError('skill_manifest_invalid', '服务端清单的项目与请求不一致');
      if (action === 'manifest') return { ok: true, data: manifest };
      return { ok: true, data: syncSkillManifest(runCode ? path.join(workspace, '.agent', 'runs', runCode) : workspace, manifest, { check: opts.check === true, createRoot: !!runCode }) };
    }));
  }
}
