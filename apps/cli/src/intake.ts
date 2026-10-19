import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_SKILL_VERSION, PublicCodeSchema, type IntakeBundle, type IntakeContext } from '@team-synergy/contracts';
import type { ApiResult, createApiClient } from './api-client.js';
import { readAuthConfig } from './auth-store.js';
import { assertIntakeRegularPath, intakeBinding, intakeNamespace, intakeRepository, normalizeIntakeScopes, readIntakeBundle, scanIntakeSource, validateIntakeSource } from './intake-source.js';
import { intakeSkillText } from './intake-skill.js';

interface Context {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string; details?: unknown } };
}
type Options = { project?: string; repository?: string; scope?: string[]; out?: string; idempotencyKey?: string; baseRevision?: string; plan?: string };
const code = (value: string) => encodeURIComponent(PublicCodeSchema.parse(value));
function positive(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DomainError('intake_revision_invalid', '--base-revision 必须是正整数');
  return Number(value);
}
function idempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/.test(value)) throw new DomainError('intake_idempotency_invalid', '幂等键需要 8–100 个字母、数字或 . _ : -；断线重试使用相同键');
  return value;
}
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.error.details as Record<string, unknown> | undefined);
  return result.data;
}
function binding(project?: string) {
  return intakeBinding(process.cwd(), project, process.env.ACP_API_URL?.trim() || readAuthConfig()?.api_url);
}

export function registerIntakeCommands(program: Command, context: Context): void {
  const intake = program.command('intake').description('代码规格接入：本机采集、候选预览和审阅发布；输出 JSON envelope，不清理已有资料')
    .addHelpText('after', '\nprepare 不调用模型。Agent 按输出的 SKILL.md 填写候选后 validate/submit；提交前强制重新校验本机指纹。Web Owner/Admin 审阅后方可 apply。运行中请求用原键恢复；已停止/结束请求的原键只读取当前批次状态，新键才发起续传。');
  const run = async (action: () => Promise<ApiResult<unknown>>) => {
    try { const result = await action(); context.printResult(result); if (!result.ok) process.exitCode = 1; }
    catch (error) { context.printResult(context.failResult(error)); process.exitCode = 1; }
  };
  const call = <T>(method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown) => context.requireApiClient().request<T>(method, route, body);
  const project = async (opts: Options) => {
    const selected = await context.resolveProjectCode(opts.project);
    PublicCodeSchema.parse(selected);
    // These API-only commands may be run outside a workspace with an explicit project.
    // Local prepare/validate/submit/replace always require a matching binding below.
    return selected;
  };
  const route = (projectCode: string, batch?: string) => `/projects/${code(projectCode)}/intake${batch ? `/${code(batch)}` : ''}`;

  intake.command('prepare').description('从已绑定仓库采集安全跟踪文件，输出空候选、平台索引和固定版本技能；不调用模型')
    .requiredOption('--repository <repository_code>', '当前工作空间已 attach/clone 的仓库编码')
    .requiredOption('--scope <paths...>', '仓库相对路径，可指定多项；. 代表整个仓库')
    .requiredOption('--out <directory>', '新的输出目录；建议工作空间 outbox/，应在源码仓库外或被 Git 忽略')
    .option('--project <project_code>', '必须与当前目录绑定项目一致')
    .action((opts: Options) => run(async () => {
      const selected = binding(opts.project);
      const repositoryCode = PublicCodeSchema.parse(opts.repository);
      const scope = normalizeIntakeScopes(opts.scope ?? []);
      const root = intakeRepository(process.cwd(), selected.project_code, repositoryCode);
      if (!opts.out) throw new DomainError('intake_output_required', '请使用 --out 指定新目录');
      const out = path.resolve(opts.out);
      assertIntakeRegularPath(out);
      if (existsSync(out)) throw new DomainError('intake_output_exists', '输出目录已经存在，请使用新目录；不会覆盖已有候选');
      const remote = unwrap(await call<IntakeContext>('GET', `${route(selected.project_code)}/context`));
      if (remote.project_code !== selected.project_code || !remote.repositories.some(repository => repository.code === repositoryCode)) throw new DomainError('intake_repository_mismatch', '仓库不属于当前平台项目或已经不可访问');
      if (remote.skill_version !== INTAKE_SKILL_VERSION) throw new DomainError('intake_skill_version_mismatch', '平台代码规格协议版本与本机 CLI 不一致，请从平台更新 CLI');
      const namespace = intakeNamespace(selected.workspace, repositoryCode);
      mkdirSync(out, { recursive: true });
      // Create output files before snapshotting so a deliberately in-repository output
      // directory is represented by dirty=true, rather than making its own snapshot stale.
      const candidatePath = path.join(out, 'intake.json');
      writeFileSync(candidatePath, '{}\n', { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(out, 'context.json'), JSON.stringify(remote, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(out, 'SKILL.md'), intakeSkillText(), { flag: 'wx', mode: 0o600 });
      const source = scanIntakeSource(root, scope);
      const template = { schema_version: 1, project_code: selected.project_code, repository_code: repositoryCode, namespace, source, items: [] };
      writeFileSync(candidatePath, JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
      return { ok: true, data: { directory: out, bundle_path: candidatePath, skill_version: INTAKE_SKILL_VERSION, namespace, source, next_step: '请让本机 Agent 阅读 SKILL.md 与 context.json 并填写 intake.json 的 items，然后运行 tsp intake validate；空模板不能提交。', submitted: false } };
    }));

  const checkedBundle = (file: string, opts: Options): IntakeBundle => {
    const bundle = readIntakeBundle(file);
    binding(opts.project ?? bundle.project_code);
    if (opts.project && opts.project !== bundle.project_code) throw new DomainError('intake_project_mismatch', '候选包与指定项目不一致');
    validateIntakeSource(bundle, process.cwd());
    return bundle;
  };
  intake.command('validate <file>').description('严格校验候选协议、引用、摘要和当前绑定仓库指纹；不访问或修改平台')
    .option('--project <project_code>', '必须与候选及当前绑定一致')
    .action((file: string, opts: Options) => run(async () => {
      const bundle = checkedBundle(file, opts);
      return { ok: true, data: { valid: true, project_code: bundle.project_code, repository_code: bundle.repository_code, item_count: bundle.items.length, manifest_sha256: bundle.source.manifest_sha256, source_complete: bundle.source.complete, test_results: 'client_reported', submitted: false } };
    }));
  intake.command('submit <file>').description('校验本机来源后上传候选草稿；不创建业务实体。断线重试保持相同幂等键')
    .requiredOption('--idempotency-key <key>', '8–100 字符；同键同内容重放，不同内容冲突')
    .option('--project <project_code>', '必须与候选及当前绑定一致')
    .action((file: string, opts: Options) => run(async () => {
      const key = idempotencyKey(opts.idempotencyKey);
      const bundle = checkedBundle(file, opts);
      return call('POST', route(bundle.project_code), { bundle, idempotency_key: key });
    }));
  intake.command('replace <batch_code> <file>').description('替换允许编辑的未发布候选并使旧计划失效；已成功项由平台保护')
    .requiredOption('--base-revision <revision>', '已读取的批次版本')
    .option('--project <project_code>', '必须与候选及当前绑定一致')
    .action((batch: string, file: string, opts: Options) => run(async () => {
      const revision = positive(opts.baseRevision);
      const bundle = checkedBundle(file, opts);
      return call('PUT', route(bundle.project_code, batch), { bundle, base_revision: revision });
    }));
  intake.command('list').description('列出当前项目的接入批次和权限')
    .option('--project <project_code>', '默认当前绑定项目')
    .action((opts: Options) => run(async () => call('GET', route(await project(opts)))));
  for (const action of ['preview', 'status'] as const) {
    intake.command(`${action} <batch_code>`).description(action === 'preview' ? '读取候选、证据、建议关联和当前审阅计划' : '读取持久发布结果、逐项收据和是否停止')
      .option('--project <project_code>', '默认当前绑定项目')
      .action((batch: string, opts: Options) => run(async () => call('GET', route(await project(opts), batch))));
  }
  intake.command('apply <batch_code>').description('执行 Web 已审阅计划；运行中用原键恢复，已结束或停止用新键续传；不隐式批准')
    .requiredOption('--plan <sha256>', 'preview 返回并已审阅的冻结计划摘要')
    .requiredOption('--idempotency-key <key>', '持久 attempt 键；断线用原键，明确续传用新键')
    .option('--project <project_code>', '默认当前绑定项目')
    .action((batch: string, opts: Options) => run(async () => {
      if (!opts.plan || !/^[a-f0-9]{64}$/.test(opts.plan)) throw new DomainError('intake_plan_invalid', '--plan 必须是已审阅计划的 SHA-256');
      const key = idempotencyKey(opts.idempotencyKey);
      return call('POST', `${route(await project(opts), batch)}/apply`, { plan_hash: opts.plan, idempotency_key: key });
    }));
  intake.command('stop <batch_code>').description('停止后续发布，保留已经提交的真实资料和收据；不是回滚')
    .requiredOption('--base-revision <revision>', '已读取的批次版本')
    .option('--project <project_code>', '默认当前绑定项目')
    .action((batch: string, opts: Options) => run(async () => {
      const revision = positive(opts.baseRevision);
      return call('POST', `${route(await project(opts), batch)}/stop`, { base_revision: revision });
    }));
}
