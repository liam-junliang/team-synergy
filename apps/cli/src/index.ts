#!/usr/bin/env node
import { Command } from 'commander';
import { createWorkspace, cleanupWorkspace, identifyWorkspace } from '@team-synergy/integrations';
import {
  renderContextPackFromTask,
  type HandoffDocumentContext,
  type RemoteHandoffDocument,
  type RemoteHandoffDocumentSummary,
  type RemoteHandoffFolder,
  type RemoteProjectDocument,
  type RemoteProjectHome,
  type RemoteRequirementDocument,
  type RemoteRequirementDocumentSummary,
  type RemoteTaskShape,
} from './pack.js';
import { createApiClient, apiUrlConfigured } from './api-client.js';
import { authFilePath, readAuthConfig, removeAuthConfig, writeAuthConfig } from './auth-store.js';
import { identifyExistingCliDevice, normalizeApiUrl, readOrCreateDeviceIdentity } from './device-identity.js';
import { loginThroughBrowser } from './browser-auth.js';
import { collectHandoffUploadPlan } from './handoff-upload.js';
import { registerHandoverCommands } from './handover.js';
import { registerArchitectureCommands } from './architecture.js';
import { registerPermissionCommands } from './permissions.js';
import { registerTestingCommands } from './testing.js';
import { registerSkillCommands } from './skills.js';
import { registerIntakeCommands } from './intake.js';
import { prepareRunSkillContext } from './skill-context.js';
import { DomainError } from '@team-synergy/domain';
import {
  ArtifactKindSchema,
  DefectSeveritySchema,
  DefectStatusSchema,
  EvidenceResultSchema,
  EvidenceTypeSchema,
  ProfileSchema,
  PUBLIC_CODE_BYTE_LENGTH,
  TaskSourceSchema,
  TaskStatusSchema,
  publicCodeFromBytes,
} from '@team-synergy/contracts';
import { z } from 'zod';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * tsp：人、脚本与所有 Agent 的通用 CLI 入口（docs/06）。
 * 机器模式稳定输出 JSON：{ ok: true, data } 或 { ok: false, error: { code, message, details } }。
 * 修复批（TASK-106）：
 * - 枚举选项一律 Zod 解析，移除类型逃逸（review 重要项 5）；
 * - 命令解析错误也输出 JSON envelope（review 重要项 6）；
 * - claim 集成真实 worktree 创建（review 重要项 7），失败补偿清理；
 * - 引用检查 fail closed，--force 显式覆盖（review 阻断 6）。
 */

const program = new Command();
const HandoffDocumentKindSchema = z.enum(['doc', 'api', 'diagram', 'general', 'integration', 'deployment', 'data', 'operations', 'release']);

program
  .name('tsp')
  .description('Team Synergy CLI — 项目事实的通用操作入口')
  .version('0.1.0')
  .exitOverride();

// ---- 全局配置：身份、数据库、仓库与工作区根 ----
function principalCode(): string {
  return process.env.ACP_PRINCIPAL_CODE?.trim()
    || readAuthConfig()?.user_code
    || '';
}

function createPublicCode(): string {
  return publicCodeFromBytes(randomBytes(PUBLIC_CODE_BYTE_LENGTH));
}

type CliErrorResult = { ok: false; error: { code: string; message: string; details?: unknown } };
type CliSuccessResult<T> = { ok: true; data: T };

function printResult<T>(result: CliErrorResult | CliSuccessResult<T>): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function failResult(e: unknown): CliErrorResult {
  if (e instanceof DomainError) {
    const domainError: DomainError & { details?: unknown } = e;
    return {
      ok: false,
      error: {
        code: domainError.code,
        message: domainError.message,
        ...(domainError.details ? { details: domainError.details } : {}),
      },
    };
  }
  return { ok: false, error: { code: 'internal_error', message: e instanceof Error ? e.message : String(e) } };
}

function requireApiClient() {
  if (!apiUrlConfigured()) {
    throw new DomainError('api_required', '需要配置 ACP_API_URL 或先执行 tsp auth login 生成本机 auth.json', {
      env: 'ACP_API_URL',
      auth_file: authFilePath(),
    });
  }
  const explicitPrincipal = process.env.ACP_PRINCIPAL_CODE?.trim();
  return createApiClient({
    baseUrl: process.env.ACP_API_URL ?? '',
    ...(explicitPrincipal ? { principalCode: explicitPrincipal } : {}),
  });
}

function requireAuthApiUrl(): string {
  const configured = process.env.ACP_API_URL?.trim() || readAuthConfig()?.api_url || '';
  if (!configured) {
    throw new DomainError('api_required', '需要配置 ACP_API_URL 或先执行 tsp auth login 生成本机 auth.json', {
      env: 'ACP_API_URL',
      auth_file: authFilePath(),
    });
  }
  return configured;
}

function unwrapApiResult<T>(result: CliErrorResult | CliSuccessResult<T>): T {
  if (!result.ok) {
    throw new DomainError(
      result.error.code,
      result.error.message,
      typeof result.error.details === 'object' && result.error.details !== null
        ? result.error.details as Record<string, unknown>
        : undefined,
    );
  }
  return result.data;
}

/** Zod 枚举解析：失败返回 null（调用方输出机器可读错误） */
function parseEnum<S extends z.ZodType<string>>(schema: S, value: string): z.output<S> | null {
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

/** 主仓库 HEAD（供 worktree 基线） */
function repoHead(repoPath: string): string {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new DomainError('repo_head_unavailable', `无法读取主仓库 HEAD：${repoPath}`, { stderr: r.stderr.trim() });
  }
  return r.stdout.trim();
}

/** 解析验收标准 JSON（机器模式错误） */
function parseAcceptanceJson(raw: string): Array<{ id: string; text: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError('acceptance_invalid', '验收标准不是合法 JSON');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((a) => a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' && typeof (a as { text?: unknown }).text === 'string')
  ) {
    throw new DomainError('acceptance_invalid', '验收标准形状错误：需要 [{"id":"AC-1","text":"..."}]');
  }
  return parsed as Array<{ id: string; text: string }>;
}

function parseStringArrayJson(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError('invalid_json_array', '参数必须是合法 JSON 数组');
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new DomainError('invalid_json_array', '参数必须是字符串 JSON 数组');
  }
  return parsed.map((item) => item.trim()).filter(Boolean);
}

// ---- auth 命令族（docs/23：一次性绑定 token → 本机设备凭据） ----
const auth = program.command('auth').description('CLI 设备认证：login / logout / whoami');

auth
  .command('login')
  .description('通过浏览器授权本机（也兼容一次性 bind token）')
  .requiredOption('--api <url>', 'core-api URL')
  .option('--token <bind-token>', '一次性 bind token；省略时使用浏览器授权')
  .option('--name <device-name>', '设备名称', hostname())
  .option('--no-browser', '不自动打开浏览器，输出地址后等待手工授权')
  .option('--web <url>', '平台 Web 地址（API 与 Web 不同源时指定）')
  .action(async (opts: { api: string; token?: string; name: string; browser: boolean; web?: string }) => {
    try {
      const apiUrl = normalizeApiUrl(opts.api);
      const identity = readOrCreateDeviceIdentity(apiUrl);
      await identifyExistingCliDevice(apiUrl, identity);
      const client = createApiClient({ baseUrl: apiUrl, skipAuth: true });
      const result = opts.token
        ? await client.login({ bind_token: opts.token, device_name: opts.name, device_identity: identity })
        : await loginThroughBrowser({ api: apiUrl, name: opts.name, identity, noBrowser: !opts.browser, web: opts.web });
      if (!result.ok) {
        printResult(result);
        process.exitCode = 1;
        return;
      }
      writeAuthConfig({
        api_url: apiUrl,
        device_token: result.data.device_token,
        user_code: result.data.user_code,
        device_name: result.data.device_name,
        device_code: result.data.device_code,
      });
      printResult({ ok: true, data: { device_code: result.data.device_code, user_code: result.data.user_code, device_name: result.data.device_name, auth_file: authFilePath() } });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

auth
  .command('logout')
  .description('结束当前登录会话，保留本机安装身份')
  .action(async () => {
    try {
      const config = readAuthConfig();
      if (!config) throw new DomainError('auth_not_logged_in', '本机尚未登录');
      const client = createApiClient({ baseUrl: config.api_url, deviceToken: config.device_token });
      const result = await client.logout();
      removeAuthConfig();
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

auth
  .command('login-password')
  .description('使用 account + password 登录并保存设备凭据（初始密码用户登录后需立即 auth passwd）')
  .requiredOption('--api <url>', 'core-api URL')
  .requiredOption('--account <account>', '登录账号')
  .requiredOption('--password <password>', '当前密码（初始密码或永久密码）')
  .option('--name <device-name>', '设备名称', hostname())
  .option('--new-password <password>', '登录后立即设置的新密码（初始密码用户推荐使用）')
  .action(async (opts: { api: string; account: string; password: string; name: string; newPassword?: string }) => {
    try {
      const apiUrl = normalizeApiUrl(opts.api);
      const identity = readOrCreateDeviceIdentity(apiUrl);
      await identifyExistingCliDevice(apiUrl, identity);
      const client = createApiClient({ baseUrl: apiUrl, skipAuth: true });
      const login = await client.passwordLogin({ account: opts.account, password: opts.password, device_name: opts.name, device_identity: identity });
      if (!login.ok) {
        printResult(login);
        process.exitCode = 1;
        return;
      }
      writeAuthConfig({
        api_url: apiUrl,
        device_token: login.data.device_token,
        user_code: login.data.user_code,
        device_name: login.data.device_name,
        device_code: login.data.device_code,
      });

      // 初始密码用户：服务端会以 password_change_required 拦截业务请求。
      // 提供 --new-password 时当场完成改密，一步进入可用状态。
      // 改密必须携带刚获取的 Bearer 设备 token（skipAuth client 会被 401 拒绝）。
      let changed: { revoked_devices?: number } | undefined;
      if (opts.newPassword) {
        const authedClient = createApiClient({ baseUrl: apiUrl, deviceToken: login.data.device_token });
        const change = await authedClient.changePassword({
          new_password: opts.newPassword,
          current_password: opts.password,
        });
        if (!change.ok) {
          printResult(change);
          process.exitCode = 1;
          return;
        }
        changed = { revoked_devices: change.data.revoked_devices };
      }
      const whoami = await createApiClient({ baseUrl: apiUrl, deviceToken: readAuthConfig()?.device_token ?? login.data.device_token }).whoami();
      printResult({
        ok: true as const,
        data: {
          user_code: login.data.user_code,
          device_code: login.data.device_code,
          device_name: login.data.device_name,
          must_change_password: whoami.ok ? whoami.data.must_change_password : null,
          ...(changed ? { password_changed: true, revoked_devices: changed.revoked_devices } : {}),
          hint: whoami.ok && whoami.data.must_change_password && !opts.newPassword
            ? '当前为初始密码，请执行 tsp auth passwd 设置新密码'
            : undefined,
          auth_file: authFilePath(),
        },
      });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

auth
  .command('passwd')
  .description('修改当前账号密码（首次改密填管理员发放的初始密码；改密后其他设备将被吊销）')
  .requiredOption('--current <password>', '当前密码（初始密码或现有永久密码）')
  .requiredOption('--new <password>', '新密码（8 到 128 个字符）')
  .action(async (opts: { current: string; new: string }) => {
    try {
      const config = readAuthConfig();
      if (!config) throw new DomainError('auth_not_logged_in', '本机尚未登录');
      const client = createApiClient({ baseUrl: config.api_url, deviceToken: config.device_token });
      const result = await client.changePassword({
        new_password: opts.new,
        current_password: opts.current,
      });
      if (result.ok) {
        printResult({ ok: true as const, data: { user_code: result.data.user_code, revoked_devices: result.data.revoked_devices } });
      } else {
        printResult(result);
        process.exitCode = 1;
      }
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

auth
  .command('whoami')
  .description('使用本机设备 token 查询当前用户')
  .action(async () => {
    try {
      const config = readAuthConfig();
      if (!config) throw new DomainError('auth_not_logged_in', '本机尚未登录');
      const result = await createApiClient({ baseUrl: config.api_url }).whoami();
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- project 命令族（bootstrap：初始化项目容器） ----
const project = program.command('project').description('项目操作：create / list / members / bind / current');
const repository = program.command('repository').alias('repo').description('项目代码仓库：list / clone / attach / status');

project
  .command('init')
  .description('创建项目容器（编码由服务端生成；建议使用 project create）')
  .requiredOption('--name <name>', '项目名')
  .requiredOption('--team <team_code>', '所属团队编码')
  .option('--policy <mode>', 'private / team_read / team_write；默认团队可读', 'team_read')
  .action(async (opts: { name: string; team: string; policy: string }) => {
    try {
      const result = await requireApiClient().createProject({ team_code: opts.team, name: opts.name, member_policy: opts.policy });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- task 命令族 ----
const task = program.command('task').description('任务闭环：create / assign / claim / attach / run / submit / verify / close / history');

task
  .command('list')
  .description('列出任务（默认按当前有效身份过滤；docs/22 Agent 找活）')
  .option('--assigned-to <principal|me>', '按 Assignee 过滤；me = 当前有效身份（覆盖默认值）')
  .option('--all', '查看全部任务，不按 Assignee 过滤')
  .option('--status <status>', '按状态过滤')
  .action(async (opts: { assignedTo?: string; all?: boolean; status?: string }) => {
    try {
      if (opts.status) {
        const parsed = parseEnum(TaskStatusSchema, opts.status);
        if (!parsed) {
          throw new DomainError('invalid_status', `非法状态：${opts.status}`, { valid: TaskStatusSchema.options });
        }
      }
      const api = requireApiClient();
      const assigned = opts.all
        ? undefined
        : opts.assignedTo && opts.assignedTo !== 'me'
          ? opts.assignedTo
          : principalCode();
      const query = [
        opts.status ? `status=${encodeURIComponent(opts.status)}` : '',
        assigned ? `assignee_principal_code=${encodeURIComponent(assigned)}` : '',
      ].filter(Boolean).join('&');
      const result = await api.listTasks(query ? `?${query}` : '');
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

task
  .command('assign')
  .description('分派任务给成员（仅 Owner；docs/11 分派与领取分离）')
  .argument('<task_code>')
  .requiredOption('--assignee <user_code>', '被分派成员的用户编码')
  .action(async (taskId: string, opts: { assignee: string }) => {
    try {
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getTask(taskId));
      const result = await api.assignTask(taskId, {
        assignee_principal_code: opts.assignee,
        base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

/** claim 共享实现（claim 与 run 命令复用）：本地真实 worktree + 状态同步 + Context Pack 渲染 */
interface ClaimOutcome {
  runCode: string;
  workspaceCode: string;
  workspaceRoot: string;
  projectCode: string;
  packPath: string;
  projectDocumentPath: string;
  requirementsIndexPath: string;
  requirementDocumentPath: string | null;
  designIndexPath: string;
  designPrototypePaths: string[];
  designNotesPaths: string[];
  handoffIndexPath: string;
  handoffDocumentPaths: string[];
  skillsIndexPath: string;
  taskStatus: string;
}

async function resolveProjectCode(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const { identifyBoundProject } = await import('./project-binding.js');
  const current = identifyBoundProject(process.cwd());
  if (current?.binding.project_code) return current.binding.project_code;
  throw new DomainError('project_code_required', '请使用 --project 指定项目编码，或先执行 tsp project bind');
}

async function fetchHandoffContext(api: ReturnType<typeof createApiClient>, projectCode: string): Promise<HandoffDocumentContext> {
  const library = unwrapApiResult(await api.listHandoffLibrary(projectCode));
  const folders = Array.isArray(library.folders)
    ? library.folders.filter((item): item is RemoteHandoffFolder => typeof item === 'object' && item !== null)
    : [];
  const summaries = Array.isArray(library.documents)
    ? library.documents.filter((item): item is RemoteHandoffDocumentSummary => (
      typeof item === 'object' && item !== null && (item as Record<string, unknown>).status === 'active'
      && (item as Record<string, unknown>).source_kind !== 'requirement'
      && (item as Record<string, unknown>).source_kind !== 'architecture'
      && (item as Record<string, unknown>).source_kind !== 'testing'
    ))
    : [];
  const documents = await Promise.all(summaries.map(async (summary) => (
    unwrapApiResult(await api.getHandoffDocument(summary.document_code)) as unknown as RemoteHandoffDocument
  )));
  return { folders, documents };
}

async function runClaim(taskCode: string, profileRaw: string, repo: string): Promise<ClaimOutcome> {
  const profile = parseEnum(ProfileSchema, profileRaw);
  if (!profile) {
    throw new DomainError('invalid_profile', `非法 Profile：${profileRaw}`, { valid: ProfileSchema.options });
  }
  const runCode = createPublicCode();
  const workspaceCode = createPublicCode();
  const workspacesRoot = process.env.ACP_WORKSPACES_DIR ?? path.join(process.cwd(), '.worktrees');
  const workspaceRoot = path.join(workspacesRoot, runCode);
  const gitBase = repoHead(repo);
  const cleanupOnError = () => {
    try {
      cleanupWorkspace({ workspaceRoot, recycleDir: path.join(workspaceRoot, '..', '.recycle'), isReferenced: () => false, force: true });
    } catch {
      /* best effort */
    }
  };
  const api = requireApiClient();
  const current = unwrapApiResult(await api.getTask(taskCode));
  const projectCode = typeof current.project_code === 'string' && current.project_code
    ? current.project_code
    : typeof current.project_id === 'string' && current.project_id
      ? current.project_id
    : null;
  if (!projectCode) {
    throw new DomainError('task_project_not_found', `任务 ${taskCode} 未关联有效项目，无法构建执行上下文`);
  }
  const projectHome = unwrapApiResult(await api.getProjectHome(projectCode)) as unknown as RemoteProjectHome;
  const projectDocument: RemoteProjectDocument = { project_code: projectCode, title: projectHome.overview?.title ?? '项目说明', content: projectHome.overview?.content ?? '', revision: projectHome.overview?.revision ?? 0 };
  const requirementDocuments = unwrapApiResult(await api.listRequirementDocuments(projectCode)) as unknown as RemoteRequirementDocumentSummary[];
  const handoffContext = await fetchHandoffContext(api, projectCode);
  handoffContext.home = projectHome;
  let relatedRequirementDocument: RemoteRequirementDocument | null = null;
  const requirementId = typeof current.requirement_code === 'string' && current.requirement_code
    ? current.requirement_code
    : typeof current.requirement_id === 'string' && current.requirement_id
      ? current.requirement_id
      : null;
  if (requirementId) {
    const requirement = unwrapApiResult(await api.getRequirement(requirementId));
    const documentId = typeof requirement.document_code === 'string' && requirement.document_code
      ? requirement.document_code
      : typeof requirement.document_id === 'string' && requirement.document_id
        ? requirement.document_id
        : null;
    if (documentId) {
      relatedRequirementDocument = unwrapApiResult(await api.getRequirementDocument(documentId)) as unknown as RemoteRequirementDocument;
    }
  }
  const baseSnapshot = typeof current.base_snapshot === 'number' ? current.base_snapshot : 0;
  let serverClaimed = false;
  try {
    createWorkspace({
      repoPath: repo,
      workspaceRoot,
      baseCommit: gitBase,
      meta: {
        project_code: projectCode,
        feature_code: String(current.feature_code ?? current.feature_id ?? ''),
        task_code: taskCode,
        run_code: runCode,
        workspace_code: workspaceCode,
        agent_profile: profile,
        project_snapshot: baseSnapshot,
        git_base: gitBase,
      },
    });
    const result = await api.claimTask(taskCode, {
      profile,
      base_snapshot: baseSnapshot,
      workspace_path: workspaceRoot,
      git_base: gitBase,
      run_code: runCode,
      workspace_code: workspaceCode,
    });
    const claimed = unwrapApiResult(result);
    serverClaimed = true;
    const skillContext = await prepareRunSkillContext(api, workspaceRoot, runCode);
    const claimedTask = { ...current, ...claimed } as RemoteTaskShape;
    const pack = renderContextPackFromTask(
      claimedTask,
      { workspaceRoot, runCode, principalCode: principalCode(), skillContext },
      projectDocument,
      { documents: requirementDocuments, related: relatedRequirementDocument },
      handoffContext,
    );
    return {
      runCode,
      workspaceCode,
      workspaceRoot,
      projectCode,
      packPath: pack.briefPath,
      projectDocumentPath: pack.projectDocumentPath,
      requirementsIndexPath: pack.requirementsIndexPath,
      requirementDocumentPath: pack.requirementDocumentPath,
      designIndexPath: pack.designIndexPath,
      designPrototypePaths: pack.designPrototypePaths,
      designNotesPaths: pack.designNotesPaths,
      handoffIndexPath: pack.handoffIndexPath,
      handoffDocumentPaths: pack.handoffDocumentPaths,
      skillsIndexPath: pack.skillsIndexPath,
      taskStatus: String(claimed.status),
    };
  } catch (e) {
    if (serverClaimed) throw new DomainError('claim_context_failed', 'Run 已创建，本机上下文准备失败；工作区已保留，请检查技能授权与本机文件后恢复', {
      run_code: runCode, workspace_code: workspaceCode, workspace_path: workspaceRoot,
      cause: e instanceof DomainError ? e.code : 'context_write_failed',
    });
    cleanupOnError();
    throw e;
  }
}

/**
 * 将平台 Run 绑定到已经由外部编排器启动的共享工作目录。
 * 不创建或改写 Git worktree；调用者必须自行保证文件范围隔离。
 */
async function attachExistingWorkspace(taskCode: string, profileRaw: string, workspace: string): Promise<ClaimOutcome> {
  const profile = parseEnum(ProfileSchema, profileRaw);
  if (!profile) {
    throw new DomainError('invalid_profile', `非法 Profile：${profileRaw}`, { valid: ProfileSchema.options });
  }
  const workspaceRoot = path.resolve(workspace);
  const runCode = createPublicCode();
  const workspaceCode = createPublicCode();
  const gitBase = repoHead(workspaceRoot);
  const api = requireApiClient();
  const current = unwrapApiResult(await api.getTask(taskCode));
  const projectCode = typeof current.project_code === 'string' && current.project_code
    ? current.project_code
    : typeof current.project_id === 'string' && current.project_id
      ? current.project_id
      : null;
  if (!projectCode) {
    throw new DomainError('task_project_not_found', `任务 ${taskCode} 未关联有效项目，无法构建执行上下文`);
  }
  const projectHome = unwrapApiResult(await api.getProjectHome(projectCode)) as unknown as RemoteProjectHome;
  const projectDocument: RemoteProjectDocument = { project_code: projectCode, title: projectHome.overview?.title ?? '项目说明', content: projectHome.overview?.content ?? '', revision: projectHome.overview?.revision ?? 0 };
  const requirementDocuments = unwrapApiResult(await api.listRequirementDocuments(projectCode)) as unknown as RemoteRequirementDocumentSummary[];
  const handoffContext = await fetchHandoffContext(api, projectCode);
  handoffContext.home = projectHome;
  let relatedRequirementDocument: RemoteRequirementDocument | null = null;
  const requirementCode = typeof current.requirement_code === 'string' && current.requirement_code
    ? current.requirement_code
    : typeof current.requirement_id === 'string' && current.requirement_id
      ? current.requirement_id
      : null;
  if (requirementCode) {
    const requirement = unwrapApiResult(await api.getRequirement(requirementCode));
    const documentCode = typeof requirement.document_code === 'string' && requirement.document_code
      ? requirement.document_code
      : typeof requirement.document_id === 'string' && requirement.document_id
        ? requirement.document_id
        : null;
    if (documentCode) {
      relatedRequirementDocument = unwrapApiResult(await api.getRequirementDocument(documentCode)) as unknown as RemoteRequirementDocument;
    }
  }
  const baseSnapshot = typeof current.base_snapshot === 'number' ? current.base_snapshot : 0;
  const stateRoot = path.join(workspaceRoot, '.agent', 'runs', runCode, 'project-state');
  const claimed = unwrapApiResult(await api.claimTask(taskCode, {
    profile,
    base_snapshot: baseSnapshot,
    workspace_path: workspaceRoot,
    git_base: gitBase,
    run_code: runCode,
    workspace_code: workspaceCode,
  }));
  let pack: ReturnType<typeof renderContextPackFromTask>;
  try {
    const skillContext = await prepareRunSkillContext(api, workspaceRoot, runCode);
    pack = renderContextPackFromTask(
      { ...current, ...claimed } as RemoteTaskShape,
      { workspaceRoot, stateRoot, runCode, principalCode: principalCode(), executionMode: 'external_shared', skillContext },
      projectDocument,
      { documents: requirementDocuments, related: relatedRequirementDocument },
      handoffContext,
    );
  } catch (error) {
    throw new DomainError('claim_context_failed', 'Run 已创建，本机上下文准备失败；工作区已保留，请检查技能授权与本机文件后恢复', {
      run_code: runCode, workspace_code: workspaceCode, workspace_path: workspaceRoot,
      cause: error instanceof DomainError ? error.code : 'context_write_failed',
    });
  }
  return {
    runCode,
    workspaceCode,
    workspaceRoot,
    projectCode,
    packPath: pack.briefPath,
    projectDocumentPath: pack.projectDocumentPath,
    requirementsIndexPath: pack.requirementsIndexPath,
    requirementDocumentPath: pack.requirementDocumentPath,
    designIndexPath: pack.designIndexPath,
    designPrototypePaths: pack.designPrototypePaths,
    designNotesPaths: pack.designNotesPaths,
    handoffIndexPath: pack.handoffIndexPath,
    handoffDocumentPaths: pack.handoffDocumentPaths,
    skillsIndexPath: pack.skillsIndexPath,
    taskStatus: String(claimed.status),
  };
}

task
  .command('claim')
  .description('领取任务（仅 Assignee；校验依赖/冲突/Profile；创建真实 worktree；状态经 core-api HTTP 同步）')
  .argument('<task_code>')
  .requiredOption('--profile <profile>', 'planner / builder / verifier')
  .requiredOption('--repo <path>', '主仓库路径（worktree 基线来源）')
  .action(async (taskCode: string, opts: { profile: string; repo: string }) => {
    try {
      const outcome = await runClaim(taskCode, opts.profile, opts.repo);
      printResult({
        ok: true,
        data: {
          task_code: taskCode,
          project_code: outcome.projectCode,
          run_code: outcome.runCode,
          workspace_code: outcome.workspaceCode,
          status: outcome.taskStatus,
          pack: outcome.packPath,
          project_document: outcome.projectDocumentPath,
          requirements_index: outcome.requirementsIndexPath,
          requirement_document: outcome.requirementDocumentPath,
          design_index: outcome.designIndexPath,
          design_prototypes: outcome.designPrototypePaths,
          design_notes: outcome.designNotesPaths,
          handoff_index: outcome.handoffIndexPath,
          skills_index: outcome.skillsIndexPath,
          handoff_documents: outcome.handoffDocumentPaths,
        },
      });
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

task
  .command('attach')
  .description('把外部编排器已启动的 Agent 绑定到平台 Run；共享目录不创建 worktree')
  .argument('<task_code>')
  .requiredOption('--profile <profile>', 'planner / builder / verifier')
  .option('--workspace <path>', '外部 Agent 正在使用的 Git 工作目录', '.')
  .action(async (taskCode: string, opts: { profile: string; workspace: string }) => {
    try {
      const outcome = await attachExistingWorkspace(taskCode, opts.profile, opts.workspace);
      printResult({
        ok: true,
        data: {
          task_code: taskCode,
          project_code: outcome.projectCode,
          run_code: outcome.runCode,
          workspace_code: outcome.workspaceCode,
          status: outcome.taskStatus,
          execution_mode: 'external_shared',
          shared_workspace: true,
          pack: outcome.packPath,
          project_document: outcome.projectDocumentPath,
          requirements_index: outcome.requirementsIndexPath,
          requirement_document: outcome.requirementDocumentPath,
          design_index: outcome.designIndexPath,
          design_prototypes: outcome.designPrototypePaths,
          design_notes: outcome.designNotesPaths,
          handoff_index: outcome.handoffIndexPath,
          skills_index: outcome.skillsIndexPath,
          handoff_documents: outcome.handoffDocumentPaths,
        },
      });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- run：一条命令启动 Agent 执行循环（TASK-110：claim → 执行器 → 收尾检查） ----
task
  .command('run')
  .description('一条命令启动执行循环：claim → 在 Run 工作区执行命令 → 收尾检查（不自动 submit，提交仍是显式动作）')
  .argument('<task_code>')
  .requiredOption('--profile <profile>', 'planner / builder / verifier')
  .requiredOption('--repo <path>', '主仓库路径（worktree 基线来源）')
  .requiredOption('--command <cmd>', '执行命令（在 Run 工作区的 repo/ 内运行，如 codex exec ...）')
  .option('--print-result', '执行完成后打印收尾检查报告（默认输出到 stdout 最后一段）')
  .action(async (taskCode: string, opts: { profile: string; repo: string; command: string }) => {
    let outcome: ClaimOutcome | null = null;
    try {
      outcome = await runClaim(taskCode, opts.profile, opts.repo);
      const repoDir = path.join(outcome.workspaceRoot, 'repo');
      const childEnv = {
        ...process.env,
        ACP_TASK_CODE: taskCode,
        ACP_RUN_CODE: outcome.runCode,
        ACP_PROJECT_CODE: outcome.projectCode,
        ACP_WORKSPACE_ROOT: outcome.workspaceRoot,
        ACP_BRIEF_PATH: outcome.packPath,
        ACP_PROJECT_DOCUMENT_PATH: outcome.projectDocumentPath,
        ACP_REQUIREMENTS_INDEX_PATH: outcome.requirementsIndexPath,
        ACP_DESIGN_INDEX_PATH: outcome.designIndexPath,
        ACP_DESIGN_PROTOTYPE_PATHS: JSON.stringify(outcome.designPrototypePaths),
        ACP_DESIGN_NOTES_PATHS: JSON.stringify(outcome.designNotesPaths),
        ACP_HANDOFF_INDEX_PATH: outcome.handoffIndexPath,
        ACP_SKILLS_INDEX_PATH: outcome.skillsIndexPath,
        ACP_HANDOFF_DOCUMENT_PATHS: JSON.stringify(outcome.handoffDocumentPaths),
        ...(outcome.requirementDocumentPath ? { ACP_REQUIREMENT_DOCUMENT_PATH: outcome.requirementDocumentPath } : {}),
      };
      // 执行器（codex / 脚本 / 任意命令）在 Run 工作区内运行
      const child = spawn(opts.command, {
        cwd: repoDir,
        env: childEnv,
        shell: true,
        stdio: 'inherit',
      });
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new DomainError('executor_failed', `执行命令退出码 ${code}`, { command: opts.command, run_code: outcome?.runCode }));
        });
      });
      // 收尾检查：工作区改动摘要 + submit 指引（docs/21：提交是显式动作，不自动 submit）
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' });
      const dirtyFiles = status.stdout.trim().split(/\r?\n/).filter(Boolean);
      printResult({
        ok: true,
        data: {
          task_code: taskCode,
          run_code: outcome.runCode,
          task_status: outcome.taskStatus,
          project_code: outcome.projectCode,
          workspace_root: outcome.workspaceRoot,
          brief: outcome.packPath,
          project_document: outcome.projectDocumentPath,
          requirements_index: outcome.requirementsIndexPath,
          requirement_document: outcome.requirementDocumentPath,
          design_index: outcome.designIndexPath,
          design_prototypes: outcome.designPrototypePaths,
          design_notes: outcome.designNotesPaths,
          handoff_index: outcome.handoffIndexPath,
          skills_index: outcome.skillsIndexPath,
          handoff_documents: outcome.handoffDocumentPaths,
          executor: { command: opts.command, exit_code: 0 },
          wrap_up: {
            dirty_files: dirtyFiles,
            dirty_count: dirtyFiles.length,
            next: [
              `提交产物：tsp task submit ${taskCode} --run-code ${outcome.runCode} --artifact-kind commit --artifact-uri git:<commit> --artifact-hash <hash> --evidence-type self_test --evidence-result pass --acceptance-refs <ids>`,
              '提交前请确认：验收标准全部满足（见 brief.md），自测证据 pass。',
            ],
          },
        },
      });
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

task
  .command('status')
  .description('查看任务状态与派生视图（ACP_API_URL 时读服务端）')
  .argument('<task_code>')
  .action(async (taskId: string) => {
    try {
      const result = await requireApiClient().getTask(taskId);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

task
  .command('submit')
  .description('提交产物与自测证据（running → self_tested → submitted，两段转换）')
  .argument('<task_code>')
  .requiredOption('--run-code <run_code>', 'Run 编码')
  .requiredOption('--artifact-kind <kind>', 'commit / document / report / other')
  .requiredOption('--artifact-uri <uri>', '产物引用（如 git:<commit>）')
  .requiredOption('--artifact-hash <hash>', '产物内容哈希')
  .requiredOption('--evidence-type <type>', 'self_test / verifier_review / deployment / manual')
  .requiredOption('--evidence-result <result>', 'pass / fail / inconclusive')
  .option('--acceptance-refs <ids>', '覆盖的验收标准 ID，逗号分隔')
  .option('--evidence-command <cmd>', '自测命令')
  .option('--evidence-summary <text>', '自测摘要')
  .action(
    async (
      taskId: string,
      opts: {
        runCode: string; artifactKind: string; artifactUri: string; artifactHash: string;
        evidenceType: string; evidenceResult: string; acceptanceRefs?: string;
        evidenceCommand?: string; evidenceSummary?: string;
      },
    ) => {
      try {
        const artifactKind = parseEnum(ArtifactKindSchema, opts.artifactKind);
        if (!artifactKind) throw new DomainError('invalid_artifact_kind', `非法产物类型：${opts.artifactKind}`);
        const evidenceType = parseEnum(EvidenceTypeSchema, opts.evidenceType);
        if (!evidenceType) throw new DomainError('invalid_evidence_type', `非法证据类型：${opts.evidenceType}`);
        const evidenceResult = parseEnum(EvidenceResultSchema, opts.evidenceResult);
        if (!evidenceResult) throw new DomainError('invalid_evidence_result', `非法证据结果：${opts.evidenceResult}`);
        const api = requireApiClient();
        const current = unwrapApiResult(await api.getTask(taskId));
        const result = await api.submitTask(taskId, {
          run_code: opts.runCode,
          base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
          artifact: { kind: artifactKind, uri: opts.artifactUri, contentHash: opts.artifactHash },
          evidence: {
            type: evidenceType,
            result: evidenceResult,
            acceptanceRefs: opts.acceptanceRefs ? opts.acceptanceRefs.split(',').map((s) => s.trim()) : [],
            command: opts.evidenceCommand,
            summary: opts.evidenceSummary,
          },
        });
        printResult(result);
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        printResult(failResult(e));
        process.exitCode = 1;
      }
    },
  );

// ---- task create / verify / close / history（docs/02/11 闭环：拆分、验收、交付确认） ----
task
  .command('create')
  .description('创建任务（编码由服务端生成，draft 起步；docs/11 人工确认）')
  .requiredOption('--feature <feature_code>', '所属 Feature 编码')
  .requiredOption('--title <title>', '任务标题')
  .requiredOption('--profile <profile>', 'planner / builder / verifier')
  .requiredOption('--source <source>', 'requirement / defect / ad-hoc / integration')
  .requiredOption('--acceptance <json>', '验收标准 JSON：[{"id":"AC-1","text":"..."}]')
  .option('--brief <markdown>', '完整执行简报（Markdown）')
  .option('--brief-file <path>', '从本地 Markdown 文件读取完整执行简报')
  .option('--requirement <requirement_code>', '关联稳定需求条目编码')
  .option('--baseline <baseline_code>', '按指定冻结需求基线创建任务（仅 Owner）')
  .option('--depends-on <codes>', '依赖任务编码，逗号分隔')
  .option('--validation-seams <json>', '验证接缝 JSON 数组')
  .option('--scope <json>', '范围 JSON：{"writable_paths":[...]}')
  .action(
    async (
      opts: { feature: string; title: string; profile: string; source: string; acceptance: string;
        brief?: string; briefFile?: string; requirement?: string; baseline?: string; dependsOn?: string; validationSeams?: string; scope?: string },
    ) => {
      try {
        if (opts.brief && opts.briefFile) {
          throw new DomainError('task_brief_conflict', '--brief 与 --brief-file 不能同时使用');
        }
        const profile = parseEnum(ProfileSchema, opts.profile);
        if (!profile) throw new DomainError('invalid_profile', `非法 Profile：${opts.profile}`);
        const source = parseEnum(TaskSourceSchema, opts.source);
        if (!source) throw new DomainError('invalid_source', `非法来源：${opts.source}`);
        const api = requireApiClient();
        const result = await api.createTask({
          feature_code: opts.feature,
          title: opts.title,
          brief: opts.briefFile ? readFileSync(path.resolve(opts.briefFile), 'utf8') : opts.brief,
          profile,
          source,
          requirement_code: opts.requirement,
          baseline_code: opts.baseline,
          acceptance: parseAcceptanceJson(opts.acceptance),
          depends_on_codes: opts.dependsOn ? opts.dependsOn.split(',').map((s) => s.trim()) : undefined,
          validation_seams: opts.validationSeams ? JSON.parse(opts.validationSeams) : undefined,
          scope: opts.scope ? JSON.parse(opts.scope) : undefined,
        });
        printResult(result);
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        printResult(failResult(e));
        process.exitCode = 1;
      }
    },
  );

task
  .command('update')
  .description('在执行前维护任务契约；running 后禁止修改（仅 Owner）')
  .argument('<task_code>')
  .option('--title <title>', '任务标题')
  .option('--brief <markdown>', '完整执行简报（Markdown）')
  .option('--brief-file <path>', '从本地 Markdown 文件读取完整执行简报')
  .option('--acceptance <json>', '验收标准 JSON 数组')
  .option('--validation-seams <json>', '验证接缝 JSON 数组')
  .option('--scope <json>', '范围 JSON：{"writable_paths":[...]}')
  .action(async (taskCode: string, opts: {
    title?: string;
    brief?: string;
    briefFile?: string;
    acceptance?: string;
    validationSeams?: string;
    scope?: string;
  }) => {
    try {
      if (opts.brief && opts.briefFile) {
        throw new DomainError('task_brief_conflict', '--brief 与 --brief-file 不能同时使用');
      }
      if (![opts.title, opts.brief, opts.briefFile, opts.acceptance, opts.validationSeams, opts.scope].some((value) => value !== undefined)) {
        throw new DomainError('task_contract_update_empty', '至少提供一个需要修改的任务契约字段');
      }
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getTask(taskCode));
      const result = await api.updateTaskContract(taskCode, {
        base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
        title: opts.title ?? String(current.title ?? ''),
        brief: opts.briefFile ? readFileSync(path.resolve(opts.briefFile), 'utf8') : (opts.brief ?? current.brief ?? ''),
        acceptance: opts.acceptance ? parseAcceptanceJson(opts.acceptance) : (Array.isArray(current.acceptance) ? current.acceptance : []),
        validation_seams: opts.validationSeams ? parseStringArrayJson(opts.validationSeams) : current.validation_seams,
        scope: opts.scope ? JSON.parse(opts.scope) : current.scope,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

task
  .command('cancel')
  .description('取消尚未开始执行的任务（draft / ready / assigned；仅 Owner）')
  .argument('<task_code>')
  .option('--reason <reason>', '取消原因')
  .action(async (taskCode: string, opts: { reason?: string }) => {
    try {
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getTask(taskCode));
      const result = await api.cancelTask(taskCode, {
        base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
        reason: opts.reason,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

task
  .command('verify')
  .description('提交验证证据（verifier 独立 Run；submitted → verified；Builder 禁止）')
  .argument('<task_code>')
  .requiredOption('--run-code <run_code>', '验证 Run 编码')
  .requiredOption('--evidence-result <result>', 'pass / fail / inconclusive')
  .requiredOption('--acceptance-refs <ids>', '覆盖的验收标准 ID，逗号分隔')
  .option('--evidence-command <cmd>', '验证命令')
  .option('--evidence-summary <text>', '验证摘要')
  .action(
    async (
      taskId: string,
      opts: { runCode: string; evidenceResult: string; acceptanceRefs: string; evidenceCommand?: string; evidenceSummary?: string },
    ) => {
      try {
        const evidenceResult = parseEnum(EvidenceResultSchema, opts.evidenceResult);
        if (!evidenceResult) throw new DomainError('invalid_evidence_result', `非法证据结果：${opts.evidenceResult}`);
        const api = requireApiClient();
        const current = unwrapApiResult(await api.getTask(taskId));
        const result = await api.verifyTask(taskId, {
          run_code: opts.runCode,
          base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
          evidence: {
            result: evidenceResult,
            acceptanceRefs: opts.acceptanceRefs.split(',').map((s) => s.trim()),
            command: opts.evidenceCommand,
            summary: opts.evidenceSummary,
          },
        });
        printResult(result);
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        printResult(failResult(e));
        process.exitCode = 1;
      }
    },
  );

task
  .command('close')
  .description('关闭任务（verified → closed；仅 Owner，docs/11 交付确认）')
  .argument('<task_code>')
  .action(async (taskId: string) => {
    try {
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getTask(taskId));
      const result = await api.closeTask(taskId, {
        base_snapshot: typeof current.base_snapshot === 'number' ? current.base_snapshot : 0,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

task
  .command('history')
  .description('任务审计流（人读时间线，Agent 读事实）')
  .argument('<task_code>')
  .action(async (taskId: string) => {
    try {
      const result = await requireApiClient().taskHistory(taskId);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

// ---- 项目功能结构与交付计划命令族 ----
const feature = program.command('feature').description('Feature 操作：create / list / show / update');

feature
  .command('create')
  .description('创建 Feature（编码由服务端生成；仅 Owner）')
  .requiredOption('--title <title>', '标题')
  .option('--project <project_code>', '所属项目编码；默认从当前目录绑定推断')
  .option('--goal <text>', '目标')
  .option('--module <module_code>', '所属功能模块编码')
  .option('--milestone <milestone_code>', '目标里程碑编码')
  .option('--start-date <date>', 'Feature 开始日期 YYYY-MM-DD；必须在里程碑窗口内')
  .option('--end-date <date>', 'Feature 结束日期 YYYY-MM-DD；必须在里程碑窗口内')
  .action(async (opts: { title: string; project?: string; goal?: string; module?: string; milestone?: string; startDate?: string; endDate?: string }) => {
    try {
      const result = await requireApiClient().createFeature({
        project_code: await resolveProjectCode(opts.project),
        title: opts.title,
        goal: opts.goal,
        module_code: opts.module,
        milestone_code: opts.milestone,
        start_date: opts.startDate,
        end_date: opts.endDate,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

feature
  .command('list')
  .description('列出项目 Feature（名称为主，编码用于后续命令）')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .action(async (opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listFeatures(await resolveProjectCode(opts.project));
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

feature
  .command('show')
  .description('查看 Feature 及其模块和目标里程碑')
  .argument('<feature_code>')
  .action(async (featureCode: string) => {
    try {
      const result = await requireApiClient().getFeature(featureCode);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

feature
  .command('update')
  .description('编辑 Feature、目标里程碑及里程碑窗口内的独立排期（仅 Owner）')
  .argument('<feature_code>')
  .option('--title <title>', '标题')
  .option('--goal <text>', '目标')
  .option('--module <module_code>', '所属功能模块编码')
  .option('--milestone <milestone_code>', '目标里程碑编码')
  .option('--start-date <date>', 'Feature 开始日期 YYYY-MM-DD')
  .option('--end-date <date>', 'Feature 结束日期 YYYY-MM-DD')
  .option('--clear-start-date', '清空开始日期；应与 --clear-end-date 一起使用')
  .option('--clear-end-date', '清空结束日期；应与 --clear-start-date 一起使用')
  .option('--status <status>', 'active / delivered / archived')
  .action(async (featureCode: string, opts: { title?: string; goal?: string; module?: string; milestone?: string; startDate?: string; endDate?: string; clearStartDate?: boolean; clearEndDate?: boolean; status?: string }) => {
    try {
      const result = await requireApiClient().updateFeature(featureCode, {
        title: opts.title,
        goal: opts.goal,
        module_code: opts.module,
        milestone_code: opts.milestone,
        start_date: opts.clearStartDate ? null : opts.startDate,
        end_date: opts.clearEndDate ? null : opts.endDate,
        status: opts.status,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

const projectModule = program.command('module').description('项目功能模块：create / list / update');

projectModule
  .command('list')
  .description('列出项目功能模块')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .action(async (opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listModules(await resolveProjectCode(opts.project));
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

projectModule
  .command('create')
  .description('创建项目功能模块（仅 Owner）')
  .requiredOption('--name <name>', '模块名称')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .option('--description <text>', '模块边界说明')
  .option('--sort-order <number>', '排序值', '0')
  .action(async (opts: { name: string; project?: string; description?: string; sortOrder: string }) => {
    try {
      const result = await requireApiClient().createModule(await resolveProjectCode(opts.project), {
        name: opts.name,
        description: opts.description,
        sort_order: Number(opts.sortOrder),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

projectModule
  .command('update')
  .description('编辑、排序或归档功能模块（仅 Owner）')
  .argument('<module_code>')
  .option('--name <name>', '模块名称')
  .option('--description <text>', '模块边界说明')
  .option('--sort-order <number>', '排序值')
  .option('--status <status>', 'active / archived')
  .action(async (moduleCode: string, opts: { name?: string; description?: string; sortOrder?: string; status?: string }) => {
    try {
      const result = await requireApiClient().updateModule(moduleCode, {
        name: opts.name,
        description: opts.description,
        sort_order: opts.sortOrder === undefined ? undefined : Number(opts.sortOrder),
        status: opts.status,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

const phase = program.command('phase').description('项目阶段：create / list / update');

phase
  .command('list')
  .description('列出项目阶段')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .action(async (opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listPhases(await resolveProjectCode(opts.project));
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

phase
  .command('create')
  .description('创建项目阶段（仅 Owner）')
  .requiredOption('--name <name>', '阶段名称')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .option('--goal <text>', '阶段目标')
  .option('--start-date <date>', '开始日期 YYYY-MM-DD')
  .option('--end-date <date>', '结束日期 YYYY-MM-DD')
  .option('--sort-order <number>', '排序值', '0')
  .action(async (opts: { name: string; project?: string; goal?: string; startDate?: string; endDate?: string; sortOrder: string }) => {
    try {
      const result = await requireApiClient().createPhase(await resolveProjectCode(opts.project), {
        name: opts.name,
        goal: opts.goal,
        start_date: opts.startDate,
        end_date: opts.endDate,
        sort_order: Number(opts.sortOrder),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

phase
  .command('update')
  .description('编辑项目阶段（仅 Owner）')
  .argument('<phase_code>')
  .option('--name <name>', '阶段名称')
  .option('--goal <text>', '阶段目标')
  .option('--start-date <date>', '开始日期 YYYY-MM-DD')
  .option('--end-date <date>', '结束日期 YYYY-MM-DD')
  .option('--clear-start-date', '清空开始日期')
  .option('--clear-end-date', '清空结束日期')
  .option('--sort-order <number>', '排序值')
  .option('--status <status>', 'planned / active / completed / archived')
  .action(async (phaseCode: string, opts: { name?: string; goal?: string; startDate?: string; endDate?: string; clearStartDate?: boolean; clearEndDate?: boolean; sortOrder?: string; status?: string }) => {
    try {
      const result = await requireApiClient().updatePhase(phaseCode, {
        name: opts.name,
        goal: opts.goal,
        start_date: opts.clearStartDate ? null : opts.startDate,
        end_date: opts.clearEndDate ? null : opts.endDate,
        sort_order: opts.sortOrder === undefined ? undefined : Number(opts.sortOrder),
        status: opts.status,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

const milestone = program.command('milestone').description('项目里程碑：create / list / update');

milestone
  .command('list')
  .description('列出项目里程碑及 Feature 交付进度')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .action(async (opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listMilestones(await resolveProjectCode(opts.project));
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

milestone
  .command('create')
  .description('在阶段中创建里程碑（仅 Owner）')
  .requiredOption('--phase <phase_code>', '所属项目阶段编码')
  .requiredOption('--name <name>', '里程碑名称')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .option('--goal <text>', '交付目标')
  .option('--start-date <date>', '开始日期 YYYY-MM-DD')
  .option('--target-date <date>', '目标日期 YYYY-MM-DD')
  .option('--owner <user_code>', '负责人用户编码')
  .option('--sort-order <number>', '排序值', '0')
  .action(async (opts: { phase: string; name: string; project?: string; goal?: string; startDate?: string; targetDate?: string; owner?: string; sortOrder: string }) => {
    try {
      const result = await requireApiClient().createMilestone(await resolveProjectCode(opts.project), {
        phase_code: opts.phase,
        name: opts.name,
        goal: opts.goal,
        start_date: opts.startDate,
        target_date: opts.targetDate,
        owner_principal_code: opts.owner,
        sort_order: Number(opts.sortOrder),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

milestone
  .command('update')
  .description('编辑里程碑或调整所属阶段（仅 Owner）')
  .argument('<milestone_code>')
  .option('--phase <phase_code>', '所属项目阶段编码')
  .option('--name <name>', '里程碑名称')
  .option('--goal <text>', '交付目标')
  .option('--start-date <date>', '开始日期 YYYY-MM-DD')
  .option('--target-date <date>', '目标日期 YYYY-MM-DD')
  .option('--clear-start-date', '清空开始日期')
  .option('--clear-target-date', '清空目标日期')
  .option('--owner <user_code>', '负责人用户编码')
  .option('--sort-order <number>', '排序值')
  .option('--status <status>', 'planned / active / at_risk / completed / cancelled')
  .action(async (milestoneCode: string, opts: { phase?: string; name?: string; goal?: string; startDate?: string; targetDate?: string; clearStartDate?: boolean; clearTargetDate?: boolean; owner?: string; sortOrder?: string; status?: string }) => {
    try {
      const result = await requireApiClient().updateMilestone(milestoneCode, {
        phase_code: opts.phase,
        name: opts.name,
        goal: opts.goal,
        start_date: opts.clearStartDate ? null : opts.startDate,
        target_date: opts.clearTargetDate ? null : opts.targetDate,
        owner_principal_code: opts.owner,
        sort_order: opts.sortOrder === undefined ? undefined : Number(opts.sortOrder),
        status: opts.status,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- team 命令族（docs/15 MVP：Owner/Member 两级，CLI 加入） ----
const team = program.command('team').description('团队操作：create / list / add');

team
  .command('create')
  .description('创建团队，编码由服务端生成，创建者自动成为 Owner')
  .requiredOption('--name <name>', '团队名称')
  .action(async (opts: { name: string }) => {
    try {
      const result = await requireApiClient().createTeam({ name: opts.name });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

team
  .command('add')
  .description('向团队添加成员（Owner / Admin 按层级授权）')
  .argument('<team_code>')
  .argument('<user_code>')
  .requiredOption('--role <role>', 'admin / member')
  .action(async (teamId: string, principal: string, opts: { role: string }) => {
    try {
      const result = await requireApiClient().addTeamMember(teamId, { user_code: principal, role: opts.role });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

team
  .command('list')
  .description('列出当前用户加入的团队')
  .action(async () => {
    try {
      const result = await requireApiClient().listTeams();
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

registerPermissionCommands(program, project, team, { requireApiClient, resolveProjectCode, printResult, failResult });

// ---- defect 命令族（docs/19：Defect 闭环与任务来源分类） ----
const defect = program.command('defect').description('缺陷操作：report / list / transition');

defect
  .command('report')
  .description('上报缺陷（编码由服务端生成；任何成员；docs/19 闭环起点）')
  .requiredOption('--feature <feature_code>', '所属 Feature 编码')
  .requiredOption('--title <title>', '缺陷标题')
  .requiredOption('--severity <severity>', 'critical / high / medium / low')
  .requiredOption('--description <text>', '缺陷描述')
  .option('--found-in <version>', '发现版本')
  .option('--related-requirement <requirement_code>', '关联需求编码')
  .action(
    async (
      opts: { feature: string; title: string; severity: string; description: string; foundIn?: string; relatedRequirement?: string },
    ) => {
      try {
        const severity = parseEnum(DefectSeveritySchema, opts.severity);
        if (!severity) {
          throw new DomainError('invalid_severity', `非法严重度：${opts.severity}`, { valid: DefectSeveritySchema.options });
        }
        const result = await requireApiClient().reportDefect({
          feature_code: opts.feature,
          title: opts.title,
          severity,
          description: opts.description,
          found_in: opts.foundIn,
          related_requirement_code: opts.relatedRequirement,
        });
        printResult(result);
        if (!result.ok) process.exitCode = 1;
      } catch (e) {
        printResult(failResult(e));
        process.exitCode = 1;
      }
    },
  );

defect
  .command('list')
  .description('缺陷列表（--status 过滤）')
  .option('--status <status>', 'reported / triaged / fixing / retest / closed / rejected')
  .action(async (opts: { status?: string }) => {
    try {
      if (opts.status) {
        const parsed = parseEnum(DefectStatusSchema, opts.status);
        if (!parsed) {
          throw new DomainError('invalid_status', `非法状态：${opts.status}`, { valid: DefectStatusSchema.options });
        }
      }
      const result = await requireApiClient().listDefects(opts.status ? `?status=${encodeURIComponent(opts.status)}` : '');
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

defect
  .command('transition')
  .description('缺陷状态流转：triaged（Owner 分诊）/ fixing（绑定修复任务）/ retest / closed / rejected')
  .argument('<defect_code>')
  .requiredOption('--to <status>', '目标状态')
  .option('--fix-task <task_code>', '修复任务编码（进入 fixing 必填，来源须 defect-fix）')
  .action(async (defectId: string, opts: { to: string; fixTask?: string }) => {
    try {
      const to = parseEnum(DefectStatusSchema, opts.to);
      if (!to) {
        throw new DomainError('defect_transition_invalid', `非法流转目标：${opts.to}`, { valid: DefectStatusSchema.options });
      }
      const result = await requireApiClient().transitionDefect(defectId, { to, fix_task_code: opts.fixTask });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

// ---- user 命令族（docs/23 用户体系：账号创建/列表/禁用） ----
const user = program.command('user').description('用户账号：create / list / disable');

user
  .command('create')
  .description('创建用户账号（仅系统管理员；返回短时有效的初始密码）')
  .argument('<account>')
  .requiredOption('--name <display_name>', '显示名')
  .action(async (account: string, opts: { name: string }) => {
    try {
      const result = await requireApiClient().createUser(account, { display_name: opts.name });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

user
  .command('list')
  .description('用户账号列表')
  .action(async () => {
    try {
      const result = await requireApiClient().listUsers();
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

user
  .command('disable')
  .description('禁用账号（仅系统管理员；不能禁用系统管理员）')
  .argument('<user_code>')
  .action(async (userId: string) => {
    try {
      const result = await requireApiClient().disableUser(userId);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

// ---- whoami：当前会话身份（Agent 在 Run 会话中确认自己是谁） ----
program
  .command('whoami')
  .description('当前会话身份（ACP_PRINCIPAL_CODE / ACP_API_URL）')
  .action(() => {
    printResult({
      ok: true,
      data: {
        principal_code: principalCode(),
        database_configured: Boolean(process.env.ACP_DATABASE_URL?.trim()),
        api_url: process.env.ACP_API_URL ?? null,
        sync_mode: apiUrlConfigured() ? 'http' : 'api_required',
      },
    });
  });

// ---- workspace 命令族（docs/04/07：Worktree 生命周期） ----
const workspace = program.command('workspace').description('项目工作空间与 Run 工作区操作：init / create / identify / cleanup');

workspace
  .command('init')
  .description('初始化独立 Git 项目工作空间并绑定云端项目')
  .argument('<project_code>')
  .option('--dir <path>', '项目工作空间目录', '.')
  .option('--name <name>', '云端显示的工作空间名称')
  .action(async (projectCode: string, opts: { dir: string; name?: string }) => {
    try {
      const apiUrl = requireAuthApiUrl();
      const { prepareProjectWorkspace, finalizeProjectWorkspaceBinding } = await import('./project-workspace.js');
      const { identifyBoundProject } = await import('./project-binding.js');
      const prepared = prepareProjectWorkspace(opts.dir);
      const existing = identifyBoundProject(prepared.root);
      if (existing && path.dirname(path.dirname(existing.path)) === prepared.root && existing.binding.project_workspace_code) {
        if (existing.binding.project_code !== projectCode) {
          throw new DomainError('project_workspace_already_bound', '该项目工作空间已经绑定到另一个云端项目', {
            current_project_code: existing.binding.project_code,
          });
        }
        printResult({ ok: true, data: { ...prepared, binding: existing.binding, binding_path: existing.path, reused: true } });
        return;
      }
      const registered = unwrapApiResult(await requireApiClient().registerProjectWorkspace(projectCode, {
        name: opts.name?.trim() || `${hostname()} 项目工作空间`,
      }));
      const workspaceCode = String(registered.project_workspace_code ?? '');
      if (!workspaceCode) throw new DomainError('project_workspace_registration_invalid', '云端未返回项目工作空间编码');
      const bound = finalizeProjectWorkspaceBinding(prepared.root, projectCode, workspaceCode, apiUrl);
      printResult({ ok: true, data: { ...prepared, binding: bound.binding, binding_path: bound.path, reused: false } });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

workspace
  .command('create')
  .description('创建 Run 工作区（git worktree + 标准骨架 + workspace.yaml）')
  .requiredOption('--repo <path>', '主仓库路径')
  .requiredOption('--base <commit>', 'git 基线提交')
  .requiredOption('--task <task_code>', '任务编码')
  .option('--run <run_code>', 'Run 编码；默认自动生成')
  .option('--workspace <workspace_code>', 'Workspace 编码；默认自动生成')
  .requiredOption('--profile <profile>', 'Agent Profile')
  .requiredOption('--feature <feature_code>', 'Feature 编码')
  .requiredOption('--project <project_code>', 'Project 编码')
  .option('--snapshot <n>', '项目快照版本', '0')
  .requiredOption('--root <dir>', '工作区根目录（必须不存在）')
  .action(
    (opts: {
      repo: string; base: string; task: string; run?: string; workspace?: string; profile: string;
      feature: string; project: string; snapshot: string; root: string;
    }) => {
      try {
        const profile = parseEnum(ProfileSchema, opts.profile);
        if (!profile) throw new DomainError('invalid_profile', `非法 Profile：${opts.profile}`);
        const result = createWorkspace({
          repoPath: opts.repo,
          workspaceRoot: opts.root,
          baseCommit: opts.base,
          meta: {
            project_code: opts.project,
            feature_code: opts.feature,
            task_code: opts.task,
            run_code: opts.run ?? createPublicCode(),
            workspace_code: opts.workspace ?? createPublicCode(),
            agent_profile: profile,
            project_snapshot: Number(opts.snapshot),
            git_base: opts.base,
          },
        });
        printResult({ ok: true, data: result });
      } catch (e) {
        printResult(failResult(e));
        process.exitCode = 1;
      }
    },
  );

workspace
  .command('identify')
  .description('识别当前工作区（向上查找 .agent/workspace.yaml）')
  .option('--dir <dir>', '起始目录，默认当前目录')
  .action((opts: { dir?: string }) => {
    const found = identifyWorkspace(opts.dir ?? process.cwd());
    if (!found) {
      printResult({ ok: false, error: { code: 'workspace_not_found', message: '未找到 .agent/workspace.yaml' } });
      process.exitCode = 1;
      return;
    }
    printResult({ ok: true, data: found });
  });

workspace
  .command('cleanup')
  .description('清理工作区（引用检查 fail closed → Patch 保护 → 移入回收区）')
  .requiredOption('--root <dir>', '工作区根目录')
  .requiredOption('--recycle-dir <dir>', '回收区目录')
  .option('--dry-run', '只报告动作，不执行')
  .option('--force', '跳过引用检查（仅 db 不可用时由人确认，高风险）')
  .action(async (opts: { root: string; recycleDir: string; dryRun?: boolean; force?: boolean }) => {
    try {
      let referenced = false;
      if (!opts.force) {
        const identified = identifyWorkspace(opts.root);
        if (!identified) {
          throw new DomainError('workspace_not_found', '未找到 .agent/workspace.yaml');
        }
        const api = requireApiClient();
        const task = unwrapApiResult(await api.getTask(identified.meta.task_code));
        const runs = Array.isArray(task.runs) ? task.runs : [];
        referenced = task.handover_pending === true || runs.some((run) => {
          if (typeof run !== 'object' || run === null) return false;
          const record = run as Record<string, unknown>;
          return (record.run_code ?? record.run_id) === identified.meta.run_code
            && ['active', 'suspended', 'preparing'].includes(String(record.status));
        });
      }
      const result = cleanupWorkspace({
        workspaceRoot: opts.root,
        recycleDir: opts.recycleDir,
        dryRun: opts.dryRun,
        isReferenced: () => referenced,
        force: opts.force,
      });
      printResult({ ok: true, data: result });
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

// ---- requirement-doc 命令族：Agent 生成、修订、检索模块化需求文档 ----
const requirementDoc = program.command('requirement-doc').description('协作需求文档：list / search / show / create / revise');

requirementDoc
  .command('list')
  .description('列出项目需求文档索引（可从当前目录项目绑定推断）')
  .option('--project <project_code>', '项目编码')
  .option('--query <query>', '标题、模块、摘要、正文或关键词检索', '')
  .action(async (opts: { project?: string; query: string }) => {
    try {
      const result = await requireApiClient().listRequirementDocuments(await resolveProjectCode(opts.project), opts.query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirementDoc
  .command('search')
  .description('按关键词快速检索需求文档')
  .argument('<query>')
  .option('--project <project_code>', '项目编码')
  .action(async (query: string, opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listRequirementDocuments(await resolveProjectCode(opts.project), query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirementDoc
  .command('show')
  .description('读取一份需求文档的完整当前版本、目录和 Revision')
  .argument('<document_code>')
  .action(async (documentId: string) => {
    try {
      const result = await requireApiClient().getRequirementDocument(documentId);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirementDoc
  .command('create')
  .description('从 Markdown 文件上传协作需求文档')
  .requiredOption('--project <project_code>', '项目编码')
  .requiredOption('--module <module_code_or_key>', '功能模块编码；兼容旧模块标识')
  .requiredOption('--title <title>', '文档标题')
  .requiredOption('--summary <summary>', '供 Agent 索引判断的短摘要')
  .requiredOption('--file <path>', 'Markdown 正文文件')
  .option('--keywords <keywords>', '逗号分隔关键词', '')
  .action(async (opts: { project: string; module: string; title: string; summary: string; file: string; keywords: string }) => {
    try {
      const content = readFileSync(path.resolve(opts.file), 'utf8');
      const result = await requireApiClient().createRequirementDocument(opts.project, {
        module_code: opts.module,
        module_key: opts.module,
        title: opts.title,
        summary: opts.summary,
        content,
        keywords: opts.keywords.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirementDoc
  .command('revise')
  .description('从 Markdown 文件创建新的不可变 Revision')
  .argument('<document_code>')
  .requiredOption('--module <module_code_or_key>', '功能模块编码；兼容旧模块标识')
  .requiredOption('--title <title>', '文档标题')
  .requiredOption('--summary <summary>', '短摘要')
  .requiredOption('--file <path>', 'Markdown 正文文件')
  .requiredOption('--change <summary>', '本次变更摘要')
  .option('--keywords <keywords>', '逗号分隔关键词', '')
  .action(async (documentId: string, opts: { module: string; title: string; summary: string; file: string; change: string; keywords: string }) => {
    try {
      const content = readFileSync(path.resolve(opts.file), 'utf8');
      const result = await requireApiClient().reviseRequirementDocument(documentId, {
        module_code: opts.module,
        module_key: opts.module,
        title: opts.title,
        summary: opts.summary,
        content,
        change_summary: opts.change,
        keywords: opts.keywords.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirementDoc
  .command('reviews')
  .description('查看需求文档各 Revision 的可选评审记录')
  .argument('<document_code>')
  .action(async (documentCode: string) => {
    try {
      const result = await requireApiClient().listRequirementDocumentReviews(documentCode);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { printResult(failResult(error)); process.exitCode = 1; }
  });

requirementDoc
  .command('review-start')
  .description('为需求文档当前 Revision 发起可选评审；不阻塞提炼需求项或创建任务草稿')
  .argument('<document_code>')
  .action(async (documentCode: string) => {
    try {
      const result = await requireApiClient().startRequirementDocumentReview(documentCode);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { printResult(failResult(error)); process.exitCode = 1; }
  });

requirementDoc
  .command('review-vote')
  .description('对指定文档版本评审表达意见')
  .argument('<review_code>')
  .requiredOption('--vote <vote>', 'support / changes_requested / abstain')
  .option('--comment <text>', '补充意见', '')
  .action(async (reviewCode: string, opts: { vote: string; comment: string }) => {
    try {
      if (!['support', 'changes_requested', 'abstain'].includes(opts.vote)) throw new DomainError('requirement_review_vote_invalid', `非法评审意见：${opts.vote}`);
      const result = await requireApiClient().voteRequirementDocumentReview(reviewCode, { vote: opts.vote, comment: opts.comment });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { printResult(failResult(error)); process.exitCode = 1; }
  });

requirementDoc
  .command('review-close')
  .description('结束评审并记录结论')
  .argument('<review_code>')
  .requiredOption('--conclusion <conclusion>', 'passed / changes_requested / no_consensus')
  .action(async (reviewCode: string, opts: { conclusion: string }) => {
    try {
      if (!['passed', 'changes_requested', 'no_consensus'].includes(opts.conclusion)) throw new DomainError('requirement_review_conclusion_invalid', `非法评审结论：${opts.conclusion}`);
      const result = await requireApiClient().closeRequirementDocumentReview(reviewCode, { conclusion: opts.conclusion });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) { printResult(failResult(error)); process.exitCode = 1; }
  });

// ---- idea / topic：需求发现、讨论与可追溯决策 ----
const idea = program.command('idea').description('想法池：create / list / search / archive / restore');

idea.command('list').option('--project <project_code>', '项目编码；默认从当前目录绑定推断').option('--query <query>', '关键词检索', '').action(async (opts: { project?: string; query: string }) => {
  try { const result = await requireApiClient().listRequirementIdeas(await resolveProjectCode(opts.project), opts.query); printResult(result); if (!result.ok) process.exitCode = 1; }
  catch (error) { printResult(failResult(error)); process.exitCode = 1; }
});
idea.command('search').argument('<query>').option('--project <project_code>', '项目编码；默认从当前目录绑定推断').action(async (query: string, opts: { project?: string }) => {
  try { const result = await requireApiClient().listRequirementIdeas(await resolveProjectCode(opts.project), query); printResult(result); if (!result.ok) process.exitCode = 1; }
  catch (error) { printResult(failResult(error)); process.exitCode = 1; }
});
idea.command('create').requiredOption('--title <title>', '一句话想法').option('--detail <text>', '补充观察').option('--source <source>', '来源').option('--project <project_code>', '项目编码；默认从当前目录绑定推断').action(async (opts: { title: string; detail?: string; source?: string; project?: string }) => {
  try { const result = await requireApiClient().createRequirementIdea(await resolveProjectCode(opts.project), { title: opts.title, detail: opts.detail, source: opts.source }); printResult(result); if (!result.ok) process.exitCode = 1; }
  catch (error) { printResult(failResult(error)); process.exitCode = 1; }
});
idea.command('archive').argument('<idea_code>').action(async (ideaCode: string) => { try { const result = await requireApiClient().updateRequirementIdea(ideaCode, { status: 'archived' }); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });
idea.command('restore').argument('<idea_code>').action(async (ideaCode: string) => { try { const result = await requireApiClient().updateRequirementIdea(ideaCode, { status: 'active' }); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });

const topic = program.command('topic').description('需求议题：create / list / show / comment / alternative / feedback / decide / link-ideas / link-documents');
topic.command('list').option('--project <project_code>', '项目编码；默认从当前目录绑定推断').option('--query <query>', '关键词检索', '').action(async (opts: { project?: string; query: string }) => { try { const result = await requireApiClient().listRequirementTopics(await resolveProjectCode(opts.project), opts.query); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });
topic.command('show').argument('<topic_code>').action(async (topicCode: string) => { try { const result = await requireApiClient().getRequirementTopic(topicCode); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });
topic.command('create').requiredOption('--title <title>', '议题名称').requiredOption('--problem <text>', '要解决的问题').option('--goal <text>', '期望结果').option('--ideas <codes>', '来源想法编码，逗号分隔').option('--project <project_code>', '项目编码；默认从当前目录绑定推断').action(async (opts: { title: string; problem: string; goal?: string; ideas?: string; project?: string }) => { try { const result = await requireApiClient().createRequirementTopic(await resolveProjectCode(opts.project), { title: opts.title, problem_statement: opts.problem, goal: opts.goal, idea_codes: opts.ideas?.split(',').map((code) => code.trim()).filter(Boolean) ?? [] }); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });

function registerTopicEntryCommand(name: 'comment' | 'alternative' | 'feedback', description: string) {
  topic.command(name).description(description).argument('<topic_code>').requiredOption('--content <text>', '记录内容').option('--source-type <type>', '反馈来源实体类型').option('--source-code <code>', '反馈来源实体公开编码').action(async (topicCode: string, opts: { content: string; sourceType?: string; sourceCode?: string }) => {
    try { const result = await requireApiClient().addRequirementTopicEntry(topicCode, { entry_type: name, content: opts.content, source_entity_type: opts.sourceType, source_entity_code: opts.sourceCode }); printResult(result); if (!result.ok) process.exitCode = 1; }
    catch (error) { printResult(failResult(error)); process.exitCode = 1; }
  });
}
registerTopicEntryCommand('comment', '补充议题讨论');
registerTopicEntryCommand('alternative', '记录一个备选方案');
registerTopicEntryCommand('feedback', '从设计、开发或缺陷反馈回议题并重新讨论');
topic.command('decide').description('形成新决策，可显式替代历史决策').argument('<topic_code>').requiredOption('--content <text>', '决策内容').option('--rationale <text>', '决策依据与取舍').option('--supersedes <entry_code>', '被替代的历史决策记录编码').action(async (topicCode: string, opts: { content: string; rationale?: string; supersedes?: string }) => { try { const result = await requireApiClient().addRequirementTopicEntry(topicCode, { entry_type: 'decision', content: opts.content, rationale: opts.rationale, supersedes_entry_code: opts.supersedes }); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });
topic.command('link-ideas').argument('<topic_code>').requiredOption('--ideas <codes>', '想法公开编码，逗号分隔').action(async (topicCode: string, opts: { ideas: string }) => { try { const result = await requireApiClient().linkRequirementTopicIdeas(topicCode, opts.ideas.split(',').map((code) => code.trim()).filter(Boolean)); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });
topic.command('link-documents').argument('<topic_code>').requiredOption('--documents <codes>', '需求文档公开编码，逗号分隔').action(async (topicCode: string, opts: { documents: string }) => { try { const result = await requireApiClient().linkRequirementTopicDocuments(topicCode, opts.documents.split(',').map((code) => code.trim()).filter(Boolean)); printResult(result); if (!result.ok) process.exitCode = 1; } catch (error) { printResult(failResult(error)); process.exitCode = 1; } });

// ---- docs 命令族：项目文档库，多级目录与不可变 Revision ----
const docs = program.command('docs').alias('handoff').description('项目文档库：list / search / show / folder-create / folder-update / create / upload / revise');

docs
  .command('list')
  .description('列出项目文档目录和文档，可从当前项目工作空间推断项目编码')
  .option('--project <project_code>', '项目编码')
  .option('--query <query>', '标题、摘要或正文检索', '')
  .action(async (opts: { project?: string; query: string }) => {
    try {
      const result = await requireApiClient().listHandoffLibrary(await resolveProjectCode(opts.project), opts.query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('search')
  .description('检索接口、部署、数据、发布等项目文档')
  .argument('<query>')
  .option('--project <project_code>', '项目编码')
  .action(async (query: string, opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listHandoffLibrary(await resolveProjectCode(opts.project), query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('show')
  .description('读取文档、来源和历史；架构图源见 architecture_document，测试资料见 testing_asset；完整源内容使用 architecture show 或 test asset show，测试文件使用 test asset download')
  .argument('<document_code>')
  .option('--output <path>', '将当前正文写入本地 Markdown 文件（架构与测试资料仅导出说明；原文件请使用对应下载命令）')
  .action(async (documentCode: string, opts: { output?: string }) => {
    try {
      const result = await requireApiClient().getHandoffDocument(documentCode);
      if (!result.ok || !opts.output) {
        printResult(result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const outputPath = path.resolve(opts.output);
      writeFileSync(outputPath, String(result.data.content ?? ''), 'utf8');
      printResult({ ok: true, data: { ...result.data, exported_path: outputPath } });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('folder-create')
  .description('在项目文档库创建文件夹，可指定父文件夹')
  .requiredOption('--name <name>', '文件夹名称')
  .option('--project <project_code>', '项目编码；默认从当前项目工作空间推断')
  .option('--parent <folder_code>', '普通父文件夹编码；系统文件夹不允许子文件夹')
  .action(async (opts: { name: string; project?: string; parent?: string }) => {
    try {
      const result = await requireApiClient().createHandoffFolder(await resolveProjectCode(opts.project), {
        name: opts.name,
        parent_folder_code: opts.parent ?? null,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('folder-update')
  .description('重命名、移动或归档普通文件夹；系统文件夹固定不可修改')
  .argument('<folder_code>')
  .option('--name <name>', '新名称')
  .option('--parent <folder_code>', '移动到父文件夹')
  .option('--root', '移动到项目文档库根目录')
  .option('--status <status>', 'active / archived')
  .action(async (folderCode: string, opts: { name?: string; parent?: string; root?: boolean; status?: string }) => {
    try {
      const result = await requireApiClient().updateHandoffFolder(folderCode, {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.root ? { parent_folder_code: null } : opts.parent ? { parent_folder_code: opts.parent } : {}),
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('create')
  .description('从本地 Markdown 文件上传一份项目文档')
  .requiredOption('--title <title>', '文档标题')
  .requiredOption('--file <path>', '本地 Markdown 文件')
  .option('--project <project_code>', '项目编码；默认从当前项目工作空间推断')
  .option('--folder <folder_code>', '所属文件夹编码；不传则放在根目录')
  .option('--kind <kind>', 'doc / api / diagram；兼容 general / integration / deployment / data / operations / release', 'doc')
  .option('--summary <summary>', '供人和 Agent 判断用途的短摘要', '')
  .action(async (opts: { title: string; file: string; project?: string; folder?: string; kind: string; summary: string }) => {
    try {
      const kind = parseEnum(HandoffDocumentKindSchema, opts.kind);
      if (!kind) throw new DomainError('project_document_kind_invalid', `非法项目文档类型：${opts.kind}`, { valid: HandoffDocumentKindSchema.options });
      const result = await requireApiClient().createHandoffDocument(await resolveProjectCode(opts.project), {
        folder_code: opts.folder ?? null,
        kind,
        title: opts.title,
        summary: opts.summary,
        content: readFileSync(path.resolve(opts.file), 'utf8'),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('upload')
  .description('上传单个 Markdown，或递归上传文件夹及其中的 Markdown 文档')
  .argument('<path>', '本地 .md/.markdown/.txt 文件或文件夹')
  .option('--project <project_code>', '项目编码；默认从当前项目工作空间推断')
  .option('--folder <folder_code>', '上传到指定云端父文件夹；不传则放在根目录')
  .option('--kind <kind>', 'auto / doc / api / diagram；兼容旧分类值', 'auto')
  .option('--name <name>', '上传文件夹时使用的云端根文件夹名称')
  .option('--title <title>', '上传单个文件时覆盖文档标题')
  .option('--summary <summary>', '上传单个文件时覆盖文档摘要')
  .action(async (inputPath: string, opts: {
    project?: string; folder?: string; kind: string; name?: string; title?: string; summary?: string;
  }) => {
    try {
      const explicitKind = opts.kind === 'auto' ? null : parseEnum(HandoffDocumentKindSchema, opts.kind);
      if (opts.kind !== 'auto' && !explicitKind) {
        throw new DomainError('project_document_kind_invalid', `非法项目文档类型：${opts.kind}`, {
          valid: ['auto', ...HandoffDocumentKindSchema.options],
        });
      }
      const plan = collectHandoffUploadPlan(inputPath);
      const projectCode = await resolveProjectCode(opts.project);
      const api = requireApiClient();
      const folderCodes = new Map<string, string>();
      const createdFolders: Array<{ folder_code: string; relative_path: string; name: string }> = [];
      const createdDocuments: Array<{ document_code: string; relative_path: string; title: string; kind: string }> = [];

      if (plan.source_type === 'directory') {
        const rootFolder = unwrapApiResult(await api.createHandoffFolder(projectCode, {
          name: opts.name?.trim() || plan.root_name,
          parent_folder_code: opts.folder ?? null,
        }));
        const rootFolderCode = String(rootFolder.folder_code ?? '');
        if (!rootFolderCode) throw new DomainError('api_bad_response', '创建文档根文件夹后未返回 folder_code');
        folderCodes.set('', rootFolderCode);
        createdFolders.push({ folder_code: rootFolderCode, relative_path: '.', name: String(rootFolder.name ?? plan.root_name) });

        for (const directory of plan.directories) {
          const parentFolderCode = folderCodes.get(directory.parent_relative_path ?? '');
          if (!parentFolderCode) {
            throw new DomainError('handoff_upload_parent_missing', `无法解析本地文件夹的云端父目录：${directory.relative_path}`);
          }
          const created = unwrapApiResult(await api.createHandoffFolder(projectCode, {
            name: directory.name,
            parent_folder_code: parentFolderCode,
          }));
          const folderCode = String(created.folder_code ?? '');
          if (!folderCode) throw new DomainError('api_bad_response', `创建文档文件夹后未返回 folder_code：${directory.relative_path}`);
          folderCodes.set(directory.relative_path, folderCode);
          createdFolders.push({ folder_code: folderCode, relative_path: directory.relative_path, name: directory.name });
        }
      }

      for (const localDocument of plan.documents) {
        const folderCode = plan.source_type === 'directory'
          ? folderCodes.get(localDocument.parent_relative_path ?? '')
          : opts.folder ?? null;
        if (plan.source_type === 'directory' && !folderCode) {
          throw new DomainError('handoff_upload_parent_missing', `无法解析文档的云端文件夹：${localDocument.relative_path}`);
        }
        const kind = explicitKind ?? localDocument.inferred_kind;
        const created = unwrapApiResult(await api.createHandoffDocument(projectCode, {
          folder_code: folderCode,
          kind,
          title: plan.source_type === 'file' && opts.title?.trim() ? opts.title.trim() : localDocument.title,
          summary: plan.source_type === 'file' && opts.summary !== undefined ? opts.summary : localDocument.summary,
          content: readFileSync(localDocument.absolute_path, 'utf8'),
        }));
        const documentCode = String(created.document_code ?? '');
        if (!documentCode) throw new DomainError('api_bad_response', `创建项目文档后未返回 document_code：${localDocument.relative_path}`);
        createdDocuments.push({
          document_code: documentCode,
          relative_path: localDocument.relative_path,
          title: String(created.title ?? localDocument.title),
          kind,
        });
      }

      printResult({
        ok: true,
        data: {
          project_code: projectCode,
          source_path: plan.source_path,
          source_type: plan.source_type,
          folders_created: createdFolders.length,
          documents_created: createdDocuments.length,
          folders: createdFolders,
          documents: createdDocuments,
        },
      });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

docs
  .command('revise')
  .description('从本地 Markdown 文件创建新的不可变项目文档 Revision')
  .argument('<document_code>')
  .requiredOption('--file <path>', '本地 Markdown 文件')
  .requiredOption('--change <summary>', '本次变更摘要')
  .option('--title <title>', '新标题；不传则保留')
  .option('--summary <summary>', '新摘要；不传则保留')
  .option('--folder <folder_code>', '移动到指定文件夹；不传则保留')
  .option('--kind <kind>', 'doc / api / diagram；兼容旧分类值，不传则保留')
  .option('--status <status>', 'active / archived；不传则保留')
  .action(async (documentCode: string, opts: {
    file: string; change: string; title?: string; summary?: string; folder?: string; kind?: string; status?: string;
  }) => {
    try {
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getHandoffDocument(documentCode));
      const kind = opts.kind === undefined ? String(current.legacy_kind ?? current.kind ?? 'doc') : parseEnum(HandoffDocumentKindSchema, opts.kind);
      if (!kind) throw new DomainError('project_document_kind_invalid', `非法项目文档类型：${opts.kind}`, { valid: HandoffDocumentKindSchema.options });
      const result = await api.reviseHandoffDocument(documentCode, {
        ...(opts.folder !== undefined ? { folder_code: opts.folder } : {}),
        kind,
        title: opts.title ?? String(current.title ?? ''),
        summary: opts.summary ?? String(current.summary ?? ''),
        content: readFileSync(path.resolve(opts.file), 'utf8'),
        change_summary: opts.change,
        ...(opts.status !== undefined ? { status: opts.status } : {}),
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- design 命令族：Agent 上传、修订、检索并导出视觉原型及配套说明 ----
interface DesignContentOptions { file?: string; image?: string; url?: string; attachment?: string }

function designContent(opts: DesignContentOptions, required: boolean): Record<string, unknown> {
  const inputs = [opts.file, opts.image, opts.url, opts.attachment].filter((value) => value !== undefined);
  if (inputs.length > 1 || (required && inputs.length === 0)) {
    throw new DomainError('design_source_invalid', '请选择且仅选择 --file、--image、--url 或 --attachment；修订时可省略以保留当前材料');
  }
  if (opts.url !== undefined) {
    let url: URL;
    try { url = new URL(opts.url); } catch { throw new DomainError('design_url_invalid', '链接必须是有效的 HTTP 或 HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new DomainError('design_url_invalid', '链接必须使用 HTTP 或 HTTPS，且不能包含用户名或密码');
    return { content_kind: 'url', external_url: opts.url.trim(), html_content: '' };
  }
  if (opts.attachment !== undefined) {
    const filePath = path.resolve(opts.attachment);
    if (!statSync(filePath).isFile() || statSync(filePath).size > 20 * 1024 * 1024) throw new DomainError('design_file_invalid', '附件必须是文件且不能超过 20 MiB');
    return { content_kind: 'file', html_content: '', file_name: path.basename(filePath), file_mime_type: 'application/octet-stream', file_content_base64: readFileSync(filePath).toString('base64') };
  }
  if (opts.image !== undefined) {
    const imagePath = path.resolve(opts.image);
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[path.extname(imagePath).toLowerCase()];
    if (!mime || !statSync(imagePath).isFile() || statSync(imagePath).size > 4 * 1024 * 1024) throw new DomainError('design_image_invalid', '图片支持 PNG、JPEG、WebP 或 GIF，且不能超过 4 MiB');
    const alt = path.basename(imagePath).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return { content_kind: 'image', html_content: `<!doctype html><html><head><meta charset="UTF-8"><meta name="acp-prototype-kind" content="image"></head><body><img src="data:${mime};base64,${readFileSync(imagePath).toString('base64')}" alt="${alt}"></body></html>` };
  }
  return opts.file === undefined ? {} : { content_kind: 'html', html_content: readFileSync(path.resolve(opts.file), 'utf8') };
}

const design = program.command('design').description('视觉与交互原型：list / show / create / revise / download');

design
  .command('list')
  .description('列出项目设计原型，可按标题或摘要检索')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .option('--query <query>', '标题或摘要检索', '')
  .option('--status <status>', 'draft / ready / archived', '')
  .action(async (opts: { project?: string; query: string; status: string }) => {
    try {
      const result = await requireApiClient().listDesignPrototypes(
        await resolveProjectCode(opts.project), opts.query, opts.status,
      );
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

design
  .command('show')
  .description('查看当前原型 Revision；可分别导出 HTML 与配套设计说明')
  .argument('<prototype_code>')
  .option('--output <path>', '将当前 HTML Revision 写入本地文件')
  .option('--notes-output <path>', '将当前配套设计说明写入 Markdown 文件')
  .action(async (prototypeCode: string, opts: { output?: string; notesOutput?: string }) => {
    try {
      const result = await requireApiClient().getDesignPrototype(prototypeCode);
      if (!result.ok) {
        printResult(result);
        process.exitCode = 1;
        return;
      }
      if (!opts.output && !opts.notesOutput) {
        printResult(result);
        return;
      }
      const html = typeof result.data.html_content === 'string' ? result.data.html_content : '';
      const notes = typeof result.data.notes_markdown === 'string' ? result.data.notes_markdown : '';
      const outputPath = opts.output ? path.resolve(opts.output) : undefined;
      const notesOutputPath = opts.notesOutput ? path.resolve(opts.notesOutput) : undefined;
      if (outputPath && ['url', 'file'].includes(String(result.data.content_kind))) throw new DomainError('design_export_unsupported', '链接不导出 HTML；附件请使用 design download 并指定 --revision 和 --out');
      if (outputPath) writeFileSync(outputPath, html, 'utf8');
      if (notesOutputPath) writeFileSync(notesOutputPath, notes, 'utf8');
      printResult({ ok: true, data: { ...result.data, exported_path: outputPath, notes_exported_path: notesOutputPath } });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

design
  .command('download <prototype_code>')
  .description('使用当前身份下载指定 Revision 的原始附件')
  .requiredOption('--revision <number>', '附件版本号')
  .requiredOption('--out <path>', '保存附件的本地路径')
  .option('--force', '显式覆盖已有文件')
  .action(async (prototypeCode: string, opts: { revision: string; out: string; force?: boolean }) => {
    try {
      const revision = Number(opts.revision);
      if (!/^\d+$/.test(opts.revision) || !Number.isSafeInteger(revision) || revision < 1) throw new DomainError('design_revision_invalid', 'Revision 必须是正整数');
      const outputPath = path.resolve(opts.out);
      if (!opts.force && existsSync(outputPath)) throw new DomainError('output_exists', '目标文件已存在；请更换 --out 或显式使用 --force');
      const data = unwrapApiResult(await requireApiClient().downloadDesignPrototypeFile(prototypeCode, revision));
      writeFileSync(outputPath, data, { flag: opts.force ? 'w' : 'wx' });
      printResult({ ok: true, data: { prototype_code: prototypeCode, revision, exported_path: outputPath, file_size: data.byteLength } });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

design
  .command('create')
  .description('上传 HTML、图片或附件，或保存外部 URL')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .requiredOption('--title <title>', '原型标题')
  .option('--file <path>', '本地 HTML 文件；与其他材料选项互斥')
  .option('--image <path>', '本地 PNG / JPEG / WebP / GIF 图片，最多 4 MiB')
  .option('--url <url>', 'HTTP 或 HTTPS 链接')
  .option('--attachment <path>', '保留原始内容的任意附件，最多 20 MiB')
  .option('--notes-file <path>', '配套设计说明 Markdown 文件')
  .option('--summary <summary>', '原型目标与适用范围', '')
  .option('--requirements <codes>', '关联需求编码，逗号分隔', '')
  .option('--status <status>', 'draft / ready', 'draft')
  .action(async (opts: DesignContentOptions & { project?: string; title: string; notesFile?: string; summary: string; requirements: string; status: string }) => {
    try {
      const content = designContent(opts, true);
      const result = await requireApiClient().createDesignPrototype(await resolveProjectCode(opts.project), {
        title: opts.title,
        summary: opts.summary,
        ...content,
        notes_markdown: opts.notesFile ? readFileSync(path.resolve(opts.notesFile), 'utf8') : '',
        requirement_codes: opts.requirements.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        status: opts.status,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

design
  .command('revise')
  .description('创建新的不可变原型 Revision；省略材料参数则保留原内容')
  .argument('<prototype_code>')
  .option('--file <path>', '本地 HTML 文件；与其他材料选项互斥')
  .option('--image <path>', '本地 PNG / JPEG / WebP / GIF 图片，最多 4 MiB')
  .option('--url <url>', 'HTTP 或 HTTPS 链接')
  .option('--attachment <path>', '保留原始内容的任意附件，最多 20 MiB')
  .option('--notes-file <path>', '配套设计说明 Markdown 文件；不传则保留当前版本')
  .requiredOption('--change <summary>', '本次设计变更摘要')
  .option('--title <title>', '新标题；不传则保留')
  .option('--summary <summary>', '新摘要；不传则保留')
  .option('--requirements <codes>', '关联需求编码，逗号分隔；不传则保留')
  .option('--status <status>', 'draft / ready / archived；不传则保留')
  .action(async (prototypeCode: string, opts: DesignContentOptions & {
    notesFile?: string; change: string; title?: string; summary?: string; requirements?: string; status?: string;
  }) => {
    try {
      const content = designContent(opts, false);
      const api = requireApiClient();
      const current = unwrapApiResult(await api.getDesignPrototype(prototypeCode));
      const linkedRequirements = Array.isArray(current.linked_requirements)
        ? current.linked_requirements.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return [];
          const code = (item as Record<string, unknown>).requirement_code;
          return typeof code === 'string' ? [code] : [];
        })
        : [];
      const result = await api.reviseDesignPrototype(prototypeCode, {
        title: opts.title ?? String(current.title ?? ''),
        summary: opts.summary ?? String(current.summary ?? ''),
        ...content,
        notes_markdown: opts.notesFile === undefined
          ? String(current.notes_markdown ?? '')
          : readFileSync(path.resolve(opts.notesFile), 'utf8'),
        requirement_codes: opts.requirements === undefined
          ? linkedRequirements
          : opts.requirements.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
        status: opts.status ?? String(current.status ?? 'draft'),
        change_summary: opts.change,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

// ---- requirement 命令族（结构化条目：稳定引用、任务关联与验收） ----
const requirement = program.command('requirement').description('需求清单：create / list / search / show / update');

requirement
  .command('create')
  .description('创建需求项；先按文档/模块提炼，Feature 可在梳理后绑定')
  .option('--feature <feature_code>', '所属 Feature 编码（可后续绑定）')
  .option('--module <module_code>', '所属功能模块编码；有来源文档时默认继承')
  .requiredOption('--title <title>', '需求标题')
  .requiredOption('--body <body>', '需求正文')
  .option('--document <document_code>', '来源需求文档编码')
  .action(async (opts: { feature?: string; module?: string; title: string; body: string; document?: string }) => {
    try {
      const result = await requireApiClient().createRequirement({
        feature_code: opts.feature,
        module_code: opts.module,
        document_code: opts.document,
        title: opts.title,
        body: opts.body,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

requirement
  .command('list')
  .description('列出当前项目的结构化需求项')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .option('--query <query>', '按编码、标题、正文或 Feature 检索', '')
  .action(async (opts: { project?: string; query: string }) => {
    try {
      const result = await requireApiClient().listRequirements(await resolveProjectCode(opts.project), opts.query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

requirement
  .command('show')
  .description('查看需求详情及关联任务')
  .argument('<requirement_code>')
  .action(async (requirementId: string) => {
    try {
      const result = await requireApiClient().getRequirement(requirementId);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

requirement
  .command('update')
  .description('编辑需求项正文、验收标准和待澄清问题（仅 Owner）')
  .argument('<requirement_code>')
  .requiredOption('--title <title>', '需求标题')
  .requiredOption('--body <body>', '需求正文')
  .option('--feature <feature_code>', '绑定或移动到 Feature')
  .option('--module <module_code>', '绑定或移动到功能模块')
  .option('--acceptance <json>', '验收标准 JSON 数组；不传则保留当前值')
  .option('--open-questions <json>', '待澄清问题字符串 JSON 数组；不传则保留当前值')
  .action(async (requirementId: string, opts: { title: string; body: string; feature?: string; module?: string; acceptance?: string; openQuestions?: string }) => {
    try {
      const result = await requireApiClient().updateRequirement(requirementId, {
        title: opts.title,
        body: opts.body,
        feature_code: opts.feature,
        module_code: opts.module,
        acceptance_criteria: opts.acceptance ? parseAcceptanceJson(opts.acceptance) : undefined,
        open_questions: opts.openQuestions ? parseStringArrayJson(opts.openQuestions) : undefined,
      });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

// ---- project 命令族扩展（多项目 + 当前目录单方面绑定） ----
project
  .command('create')
  .description('创建项目，编码由服务端生成，创建者自动成为 Owner')
  .requiredOption('--name <name>', '项目名')
  .requiredOption('--team <team_code>', '所属团队编码')
  .action(async (opts: { name: string; team: string }) => {
    try {
      const result = await requireApiClient().createProject({ team_code: opts.team, name: opts.name });
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

project
  .command('list')
  .description('列出当前用户参与的项目及角色')
  .action(async () => {
    try {
      const result = await requireApiClient().listProjects(principalCode());
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

requirement
  .command('search')
  .description('在当前项目需求清单中检索需求项')
  .argument('<query>')
  .option('--project <project_code>', '项目编码；默认从当前目录绑定推断')
  .action(async (query: string, opts: { project?: string }) => {
    try {
      const result = await requireApiClient().listRequirements(await resolveProjectCode(opts.project), query);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (e) {
      printResult(failResult(e));
      process.exitCode = 1;
    }
  });

project
  .command('members')
  .description('列出项目成员（与团队成员分开管理）')
  .argument('<project_code>')
  .action(async (projectCode: string) => {
    try {
      const result = await requireApiClient().listProjectMembers(projectCode);
      printResult(result);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

project
  .command('bind')
  .description('将当前目录单方面绑定到项目（服务端不保存本地路径）')
  .argument('<project_code>')
  .action(async (projectCode: string) => {
    try {
      const apiUrl = requireAuthApiUrl();
      const { bindProject } = await import('./project-binding.js');
      printResult({ ok: true, data: bindProject(process.cwd(), projectCode, apiUrl) });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

project
  .command('current')
  .description('从当前目录向上查找项目绑定')
  .action(async () => {
    try {
      const { identifyBoundProject } = await import('./project-binding.js');
      const current = identifyBoundProject(process.cwd());
      if (!current) throw new DomainError('project_binding_not_found', '未找到 .agent/bound-project.yaml');
      printResult({ ok: true, data: current });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

async function remoteRepositories(projectCode: string) {
  return unwrapApiResult(await requireApiClient().listProjectRepositories(projectCode)) as Array<{
    repository_code: string;
    project_code: string;
    name: string;
    purpose: string | null;
    remote_url: string;
    default_branch: string | null;
    status: string;
  }>;
}

repository
  .command('list')
  .description('列出云端项目配置的代码仓库及本机检出状态')
  .option('--project <project_code>', '项目编码；默认从当前项目工作空间推断')
  .action(async (opts: { project?: string }) => {
    try {
      const projectCode = await resolveProjectCode(opts.project);
      const repositories = await remoteRepositories(projectCode);
      const { identifyBoundProject } = await import('./project-binding.js');
      const current = identifyBoundProject(process.cwd());
      if (current?.binding.project_code === projectCode) {
        const { localRepositoryStatus } = await import('./project-workspace.js');
        printResult({ ok: true, data: localRepositoryStatus(process.cwd(), repositories) });
      } else {
        printResult({ ok: true, data: repositories.map((item) => ({ ...item, checkout_status: 'workspace_not_bound', local_path: null, git_head: null, dirty: null })) });
      }
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

repository
  .command('clone')
  .description('按云端配置将一个项目代码仓库检出到当前项目工作空间')
  .argument('<repository_code>')
  .option('--to <path>', '目标目录；默认 code/<仓库名称>')
  .action(async (repositoryCode: string, opts: { to?: string }) => {
    try {
      const projectCode = await resolveProjectCode();
      const repositories = await remoteRepositories(projectCode);
      const selected = repositories.find((item) => item.repository_code === repositoryCode);
      if (!selected) throw new DomainError('repository_not_found', `当前项目未配置代码仓库：${repositoryCode}`);
      const { cloneRepository } = await import('./project-workspace.js');
      printResult({ ok: true, data: cloneRepository(process.cwd(), selected, opts.to) });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

repository
  .command('attach')
  .description('将已有本地 Git 仓库登记到当前项目工作空间')
  .argument('<repository_code>')
  .requiredOption('--dir <path>', '本地独立 Git 仓库根目录')
  .option('--remote <name>', '用于校验云端地址的 Git remote', 'origin')
  .action(async (repositoryCode: string, opts: { dir: string; remote: string }) => {
    try {
      const projectCode = await resolveProjectCode();
      const repositories = await remoteRepositories(projectCode);
      const selected = repositories.find((item) => item.repository_code === repositoryCode);
      if (!selected) throw new DomainError('repository_not_found', `当前项目未配置代码仓库：${repositoryCode}`);
      const { attachRepository } = await import('./project-workspace.js');
      printResult({ ok: true, data: attachRepository(process.cwd(), selected, opts.dir, opts.remote) });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

repository
  .command('status')
  .description('检查当前项目工作空间的全部云端仓库与本机 Git 状态')
  .action(async () => {
    try {
      const projectCode = await resolveProjectCode();
      const repositories = await remoteRepositories(projectCode);
      const { localRepositoryStatus } = await import('./project-workspace.js');
      printResult({ ok: true, data: localRepositoryStatus(process.cwd(), repositories) });
    } catch (error) {
      printResult(failResult(error));
      process.exitCode = 1;
    }
  });

registerHandoverCommands(program, task);
registerArchitectureCommands(program, { requireApiClient, resolveProjectCode, printResult, failResult });
registerTestingCommands(program, { requireApiClient, resolveProjectCode, printResult, failResult });
registerSkillCommands(program, { requireApiClient, resolveProjectCode, printResult, failResult });
registerIntakeCommands(program, { requireApiClient, resolveProjectCode, printResult, failResult });

// ---- 机器模式 JSON 全覆盖（review 重要项 6） ----
try {
  await program.parseAsync();
} catch (err) {
  const e = err as { code?: string; exitCode?: number };
  if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') {
    process.exitCode = 0; // help/version 已正常输出
  } else {
    printResult(failResult(err));
    process.exitCode = 1;
  }
}
