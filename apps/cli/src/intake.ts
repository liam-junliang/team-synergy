import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_SKILL_VERSION, PublicCodeSchema, evaluateIntakeQuality, type IntakeBundle, type IntakeContext } from '@team-synergy/contracts';
import type { ApiResult, createApiClient } from './api-client.js';
import { readAuthConfig } from './auth-store.js';
import { enterpriseDossierPlan, enterpriseTemplate, ENTERPRISE_ARTIFACTS, parseIntakeProfile } from './intake-enterprise.js';
import { assertIntakeRegularPath, intakeBinding, intakeNamespace, intakeRepository, normalizeIntakeScopes, readIntakeBundle } from './intake-source.js';
import { assertIntakeOutputOutsideMaterials, parseIntakeMaterials, scanIntakeInputs, validateIntakeInputs, writeIntakeLocalSources, type IntakeLocalSources } from './intake-materials.js';
import { intakeSkillText, intakeSkillReferences } from './intake-skill.js';
import { diffIntakeBundles, exportIntakeBundle } from './intake-delivery.js';
import { fetchIntakeCodeKnowledge, intakeSnapshotScopes, loadIntakeCodeSnapshot, writeIntakeCodeKnowledge } from './intake-code-knowledge.js';

interface Context {
  requireApiClient: () => ReturnType<typeof createApiClient>;
  resolveProjectCode: (explicit?: string) => Promise<string>;
  printResult: (result: ApiResult<unknown>) => void;
  failResult: (error: unknown) => { ok: false; error: { code: string; message: string; details?: unknown } };
}
type Options = { project?: string; repository?: string; namespace?: string; scope?: string[]; material?: string[]; teamNote?: string[]; includeUntracked?: boolean; out?: string; profile?: string; idempotencyKey?: string; baseRevision?: string; plan?: string; codeRun?: string; codeQuery?: string; codeNode?: string };
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

  intake.command('prepare').description('采集已绑定仓库及补充文本资料，输出空候选、平台索引和固定版本技能；不调用模型')
    .option('--code-run <run_code>', '从一个已发布 UA/codegraph 分析的本机固定源码准备候选；不读取当前工作区')
    .option('--code-query <text>', '缩小已发布知识文档的查询范围；仅用于 --code-run')
    .option('--code-node <id>', '从固定知识节点展开关联；仅用于 --code-run')
    .option('--repository <repository_code>', '当前工作空间已 attach/clone 的仓库编码；纯资料模式可省略')
    .option('--scope <paths...>', '仓库相对路径，可指定多项；有仓库时必填，. 代表整个仓库')
    .option('--material <key=path...>', '补充 UTF-8 文件或目录；来源 key 稳定且唯一，原始本机路径不会上传')
    .option('--team-note <key=path...>', '团队说明或访谈文本，格式与 --material 相同；不自动视为已批准事实')
    .option('--include-untracked', '明确纳入未被 Git 忽略的未跟踪文本文件，仍执行安全过滤')
    .option('--namespace <namespace>', '增量分析时显式沿用旧候选 namespace，例如增加纯资料来源时')
    .requiredOption('--out <directory>', '新的输出目录；建议工作空间 outbox/，应在源码仓库外或被 Git 忽略')
    .option('--profile <profile>', 'pilot 或 enterprise；enterprise 会生成完整档案模板和质量门禁', 'pilot')
    .option('--project <project_code>', '必须与当前目录绑定项目一致')
    .action((opts: Options) => run(async () => {
      const selected = binding(opts.project);
      const profile = parseIntakeProfile(opts.profile);
      if (!opts.codeRun && (opts.codeQuery !== undefined || opts.codeNode !== undefined)) throw new DomainError('intake_code_run_required', '--code-query/--code-node 必须同时指定固定 --code-run');
      if (opts.codeRun && opts.includeUntracked) throw new DomainError('intake_scope_invalid', '固定分析已经声明捕获范围；不能通过 --include-untracked 混入当前工作区');
      const fixed = opts.codeRun ? loadIntakeCodeSnapshot(selected.workspace, selected.project_code, opts.codeRun) : null;
      const requestedRepository = opts.repository ? PublicCodeSchema.parse(opts.repository) : null;
      if (fixed && requestedRepository && fixed.repository_code !== requestedRepository) throw new DomainError('intake_repository_mismatch', '指定仓库与固定代码分析不一致');
      const repositoryCode = fixed?.repository_code ?? requestedRepository;
      const materials = parseIntakeMaterials(opts.material, opts.teamNote);
      if (!repositoryCode && !materials.length) throw new DomainError('intake_source_required', '请提供 --repository 或至少一个 --material / --team-note');
      if (!repositoryCode && (opts.scope?.length || opts.includeUntracked)) throw new DomainError('intake_scope_invalid', '纯资料接入不使用 --scope 或 --include-untracked');
      const scope = fixed ? intakeSnapshotScopes(fixed.code_snapshot.snapshot, opts.scope) : repositoryCode ? normalizeIntakeScopes(opts.scope ?? []) : [];
      if (scope.length + materials.length + (fixed ? 1 : 0) > 50) throw new DomainError('intake_source_too_large', '代码范围和补充来源合计不能超过 50 项');
      if (opts.namespace !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(opts.namespace)) throw new DomainError('intake_namespace_invalid', '--namespace 必须是旧候选中有效的来源标识');
      const repositoryRoot = fixed?.code_snapshot.root ?? (repositoryCode ? intakeRepository(process.cwd(), selected.project_code, repositoryCode) : null);
      if (!opts.out) throw new DomainError('intake_output_required', '请使用 --out 指定新目录');
      const out = path.resolve(opts.out);
      assertIntakeRegularPath(out);
      assertIntakeOutputOutsideMaterials(out, materials);
      if (fixed) assertIntakeOutputOutsideMaterials(out, [{ key: 'repository', kind: 'document', root: fixed.code_snapshot.root, prefix: '.', label: 'repository' }]);
      if (opts.includeUntracked && repositoryRoot) {
        const relative = path.relative(repositoryRoot, out);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new DomainError('intake_output_in_source', '--include-untracked 时输出目录必须位于代码仓库外，避免将本机来源映射和生成候选采集为证据');
      }
      if (existsSync(out)) throw new DomainError('intake_output_exists', '输出目录已经存在，请使用新目录；不会覆盖已有候选');
      const remote = unwrap(await call<IntakeContext>('GET', `${route(selected.project_code)}/context`));
      if (remote.project_code !== selected.project_code || (repositoryCode && !remote.repositories.some(repository => repository.code === repositoryCode))) throw new DomainError('intake_repository_mismatch', '仓库不属于当前平台项目或已经不可访问');
      if (remote.skill_version !== INTAKE_SKILL_VERSION) throw new DomainError('intake_skill_version_mismatch', '平台代码规格协议版本与本机 CLI 不一致，请从平台更新 CLI');
      const knowledge = fixed ? await fetchIntakeCodeKnowledge(context.requireApiClient(), selected.project_code, fixed.repository_code, fixed.code_snapshot, { query: opts.codeQuery, node: opts.codeNode }) : null;
      if (knowledge && materials.some(material => material.key === knowledge.source_key)) throw new DomainError('intake_material_collision', '补充资料 key 与代码知识的稳定来源 key 冲突');
      const namespace = opts.namespace ?? intakeNamespace(selected.workspace, repositoryCode, materials.map(input => `${input.kind}:${input.key}`));
      const localSources: IntakeLocalSources = { version: 1, project_code: selected.project_code, repository_code: repositoryCode, code_scopes: scope, include_untracked: opts.includeUntracked ?? false, materials, ...(fixed ? { code_snapshot: fixed.code_snapshot } : {}) };
      mkdirSync(out, { recursive: true });
      // Create output files before snapshotting so a deliberately in-repository output
      // directory is represented by dirty=true, rather than making its own snapshot stale.
      const candidatePath = path.join(out, 'intake.json');
      writeFileSync(candidatePath, '{}\n', { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(out, 'context.json'), JSON.stringify(remote, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(out, 'SKILL.md'), intakeSkillText(profile), { flag: 'wx', mode: 0o600 });
      mkdirSync(path.join(out, 'references'));
      for (const [name, text] of Object.entries(intakeSkillReferences())) writeFileSync(path.join(out, 'references', name), text, { flag: 'wx', mode: 0o600 });
      const codeKnowledge = fixed && knowledge ? writeIntakeCodeKnowledge(out, knowledge, selected.project_code, fixed.code_snapshot) : null;
      if (codeKnowledge) localSources.materials = [...materials, ...parseIntakeMaterials([`${codeKnowledge.source_key}=${codeKnowledge.material}`])].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      writeIntakeLocalSources(out, localSources);
      if (profile === 'enterprise') {
        mkdirSync(path.join(out, 'templates'));
        for (const artifact of ENTERPRISE_ARTIFACTS) {
          writeFileSync(path.join(out, 'templates', `${artifact.type}.md`), enterpriseTemplate(artifact), { flag: 'wx', mode: 0o600 });
        }
        writeFileSync(path.join(out, 'dossier-plan.md'), enterpriseDossierPlan(), { flag: 'wx', mode: 0o600 });
      }
      const source = scanIntakeInputs(localSources, process.cwd());
      if (profile === 'enterprise') source.production = { version: '1.0', scope_statement: '待 Agent 依据来源清单明确业务范围、遗漏和排除理由。', discovery_status: 'partial', capabilities: [], conflicts: [] };
      const template = { schema_version: 1, project_code: selected.project_code, repository_code: repositoryCode, namespace, profile, source, items: [] };
      writeFileSync(candidatePath, JSON.stringify(template, null, 2) + '\n', { mode: 0o600 });
      return { ok: true, data: { directory: out, bundle_path: candidatePath, profile, skill_version: INTAKE_SKILL_VERSION, namespace, source, ...(codeKnowledge ? { code_knowledge: codeKnowledge } : {}), next_step: codeKnowledge ? '请让本机 Agent 阅读 AGENT.md、SKILL.md 和 references/business-rules.md，查询同一分析并复核固定源码，提炼业务规则、需求与验收计划后 validate/export。' : profile === 'enterprise' ? '请让本机 Agent 阅读 SKILL.md、dossier-plan.md 与 templates/ 并填写 intake.json 的 items，然后运行 tsp intake validate <file> --profile enterprise。' : '请让本机 Agent 阅读 SKILL.md 与 context.json 并填写 intake.json 的 items，然后运行 tsp intake validate；空模板不能提交。', submitted: false } };
    }));

  const checkedBundle = (file: string, opts: Options): IntakeBundle => {
    const bundle = readIntakeBundle(file);
    binding(opts.project ?? bundle.project_code);
    if (opts.project && opts.project !== bundle.project_code) throw new DomainError('intake_project_mismatch', '候选包与指定项目不一致');
    if (opts.profile && parseIntakeProfile(opts.profile) !== bundle.profile) throw new DomainError('intake_profile_mismatch', '候选包的 profile 与 --profile 不一致');
    validateIntakeInputs(bundle, process.cwd(), file);
    return bundle;
  };
  intake.command('validate <file>').description('严格校验候选协议、引用、摘要和当前绑定仓库指纹；不访问或修改平台')
    .option('--profile <profile>', 'pilot 或 enterprise；省略时使用候选包中的 profile')
    .option('--project <project_code>', '必须与候选及当前绑定一致')
    .action((file: string, opts: Options) => run(async () => {
      const bundle = checkedBundle(file, opts);
      const quality = evaluateIntakeQuality(bundle);
      const qualityValid = quality.summary.blockers === 0;
      if (!qualityValid) process.exitCode = 1;
      return { ok: true, data: { valid: qualityValid, protocol_valid: true, quality_valid: qualityValid, quality_status: quality.status, profile: bundle.profile, project_code: bundle.project_code, repository_code: bundle.repository_code, item_count: bundle.items.length, manifest_sha256: bundle.source.manifest_sha256, source_complete: bundle.source.complete, quality, test_results: 'client_reported', submitted: false, next_step: qualityValid ? '可提交草稿供审阅；质检通过不等于内容已批准或运行已验证。' : '协议和来源校验有效，但存在质量阻断；允许 submit/replace 保存草稿，冻结发布计划前必须解决 blocker。' } };
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
  intake.command('diff <previous> <current>').description('比较两个历史候选的来源、规格、验收和受影响项；不要求旧来源仍在本机')
    .action((previous: string, current: string) => run(async () => ({ ok: true, data: diffIntakeBundles(readIntakeBundle(previous), readIntakeBundle(current)) })));
  intake.command('export <file>').description('从候选导出可阅读的规格、结构化验收及验证计划；不提交、不声明批准')
    .requiredOption('--out <directory>', '新的导出目录；不会覆盖已有资料')
    .action((file: string, opts: Options) => run(async () => {
      if (!opts.out) throw new DomainError('intake_output_required', '请使用 --out 指定新目录');
      return { ok: true, data: exportIntakeBundle(readIntakeBundle(file), opts.out) };
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
