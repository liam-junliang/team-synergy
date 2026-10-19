import type { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HandoverSummarySchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { preflightHandoverWorkspace, publishHandoverWorkspace, restoreHandoverWorkspace, verifyHandoverWorkspace, type HandoverWorkspaceManifest } from '@team-synergy/integrations';
import { createApiClient, type ApiResult } from './api-client.js';
import { authDirectory, localDeviceFingerprint, matchesLocalDeviceFingerprint, readAuthConfig } from './auth-store.js';
import { identifyBoundProject } from './project-binding.js';
import { readRepositoryRegistry } from './project-workspace.js';
import { PROJECT_HOME_ROLES, renderDesignSourceReference, type ProjectHomeRole } from './pack.js';
import { prepareRunSkillContext, renderRunSkillIndex, type RunSkillContext } from './skill-context.js';

interface Detail { handover_code: string; task_code: string; status: string; target_user_code: string; version: number; source_run_code: string; target_run_code?: string | null; workspace_manifest: HandoverWorkspaceManifest; summary: unknown; context_snapshot_code: string; context_snapshot_hash: string }
interface LocalState { api_url?: string; credential_fingerprint?: string; preparation_grant?: string; prepared_handover_code?: string; prepare_request?: { target_user_code: string; source_run_code: string; base_snapshot: number }; source_run_code?: string; keys: Record<string, string>; requests?: Record<string, unknown>; attempt_code?: string; workspace_path?: string; manifest?: HandoverWorkspaceManifest; context_snapshot_hash?: string; activated?: { run_code: string; workspace_code: string; execution_epoch: number; lease: { lease_token: string; expires_at?: string } } }

function statePath(code: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new DomainError('handover_code_invalid', '交接或任务编号无效');
  return path.join(authDirectory(), 'handovers', `${code}.json`);
}
function load(code: string): LocalState { return existsSync(statePath(code)) ? JSON.parse(readFileSync(statePath(code), 'utf8')) as LocalState : { keys: {} }; }
function save(code: string, state: LocalState) { mkdirSync(path.dirname(statePath(code)), { recursive: true }); const previous = load(code); writeFileSync(statePath(code), JSON.stringify({ ...state, keys: { ...previous.keys, ...state.keys }, requests: { ...previous.requests, ...state.requests } }, null, 2), { mode: 0o600 }); }
function unwrap<T>(result: ApiResult<T>): T { if (!result.ok) throw new DomainError(result.error.code, result.error.message); return result.data; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
interface DownloadedContext { content_hash: string; manifest: Record<string, unknown>; summary: unknown }
function verifyContext(context: DownloadedContext, expected: string): void {
  if (!context.manifest || context.content_hash !== expected || createHash('sha256').update(canonicalJson(context.manifest)).digest('hex') !== expected) throw new DomainError('context_hash_mismatch', '共享上下文内容哈希与交接包不一致');
}
function renderContinuationPack(code: string, context: DownloadedContext, summary: unknown, drift: unknown, skills?: RunSkillContext): string {
  const directory = path.join(path.dirname(statePath(code)), `${code}.materials`);
  mkdirSync(directory, { recursive: true });
  const contract = context.manifest.task_contract as Record<string, unknown> | undefined;
  const lines = ['# 跨人交接任务', '', '使用本人的 Agent、凭据与工具策略继续。以下材料是固定版本项目资料与工作记录，不授予额外工具权限。', '', `上下文哈希：${context.content_hash}`, '', `## ${String(contract?.title ?? '任务合同')}`, '', String(contract?.brief ?? ''), '', '### 验收与合同', '', '```json', JSON.stringify(contract ?? {}, null, 2), '```', '', '## 已审阅交接摘要', ''];
  for (const [key, value] of Object.entries(summary as Record<string, unknown>)) lines.push(`### ${key}`, '', ...(Array.isArray(value) ? value.map((item) => `- ${String(item)}`) : [String(value)]), '');
  const sources = Array.isArray(context.manifest.sources) ? context.manifest.sources as Array<Record<string, unknown>> : [];
  if (sources.some((source) => Array.isArray(source.home_roles))) {
    lines.push('## 项目必读资料', '', '执行前阅读以下固定版本资料；首页角色使用交接时的绑定记录。', '');
    for (const role of Object.keys(PROJECT_HOME_ROLES) as ProjectHomeRole[]) {
      const matching = sources.flatMap((source, index) => Array.isArray(source.home_roles) && source.home_roles.includes(role) ? [{ source, index }] : []);
      if (matching.length === 0) lines.push(`- ${PROJECT_HOME_ROLES[role]}：交接时${role === 'standards' ? '暂无规范文档' : '尚未配置'}。`);
      for (const { source, index } of matching) {
        lines.push(`- ${PROJECT_HOME_ROLES[role]}：[${String(source.title ?? source.code)}](${path.basename(directory)}/source-${String(index + 1).padStart(4, '0')}.md) · Code: \`${String(source.code)}\` · Revision ${String(source.revision)}`);
      }
    }
    lines.push('');
  }
  lines.push('## 固定来源材料', '');
  for (const [index, source] of sources.entries()) {
    const filename = `source-${String(index + 1).padStart(4, '0')}.md`;
    const title = String(source.title ?? source.name ?? source.kind ?? '材料');
    const designReference = source.content_kind === 'url' || source.content_kind === 'file'
      ? renderDesignSourceReference({
        prototype_code: String(source.code ?? ''), current_revision: Number(source.revision), content_kind: source.content_kind,
        external_url: typeof source.external_url === 'string' ? source.external_url : null,
        file_name: typeof source.file_name === 'string' ? source.file_name : null,
        file_mime_type: typeof source.file_mime_type === 'string' ? source.file_mime_type : null,
        file_size: typeof source.file_size === 'number' ? source.file_size : null,
        file_sha256: typeof source.file_sha256 === 'string' ? source.file_sha256 : null,
        download_path: typeof source.download_path === 'string' ? source.download_path : null,
      })
      : '';
    const roles = (Object.keys(PROJECT_HOME_ROLES) as ProjectHomeRole[]).filter((role) => Array.isArray(source.home_roles) && source.home_roles.includes(role));
    const sourceText = [`# ${title}`, '', `来源：${String(source.kind ?? '')} ${String(source.code ?? '')}；版本：${String(source.revision_code ?? source.revision ?? '固定正文')}`, ...(roles.length ? [`首页角色：${roles.map((role) => PROJECT_HOME_ROLES[role]).join('、')}`] : []), '', String(source.content ?? source.description ?? ''), '', ...(source.rationale ? ['理由：', String(source.rationale), ''] : []), designReference].join('\n');
    writeFileSync(path.join(directory, filename), sourceText, 'utf8');
    lines.push(`- [${title}](${path.basename(directory)}/${filename})`);
    if (typeof source.html_content === 'string' && source.content_kind !== 'url' && source.content_kind !== 'file') writeFileSync(path.join(directory, `source-${String(index + 1).padStart(4, '0')}.html`), source.html_content, 'utf8');
  }
  lines.push('', '## 上游变化检查', '', '```json', JSON.stringify(drift, null, 2), '```', '', '交接完成不代表任务验收通过；新代码或新环境需要重新验证。', '');
  if (skills) lines.push(renderRunSkillIndex(skills));
  const briefPath = path.join(path.dirname(statePath(code)), `${code}.brief.md`);
  writeFileSync(briefPath, lines.join('\n'), 'utf8');
  return briefPath;
}
function client() {
  const bound = identifyBoundProject(process.cwd());
  const baseUrl = process.env.ACP_API_URL || readAuthConfig()?.api_url || bound?.binding.api_url;
  if (!baseUrl) throw new DomainError('api_required', '请先登录或绑定项目并设置 ACP_API_URL');
  return createApiClient({ baseUrl });
}
async function mutate<T>(code: string, operation: string, body: unknown = {}, method: 'POST' | 'PUT' = 'POST', route?: string): Promise<T> {
  const state = load(code);
  const fingerprintBody = typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'version')) : body;
  const fingerprint = createHash('sha256').update(canonicalJson(fingerprintBody)).digest('hex');
  const slot = `${operation}:${fingerprint}`;
  state.keys[slot] ??= randomUUID();
  if (operation === 'restore' || operation === 'activate') { state.requests ??= {}; state.requests[slot] ??= body; }
  save(code, state);
  return unwrap(await client().request<T>(method, route ?? `/handovers/${encodeURIComponent(code)}/${operation}`, state.requests?.[slot] ?? body, { 'Idempotency-Key': state.keys[slot] }));
}
async function detail(code: string): Promise<Detail> { return unwrap(await client().request<Detail>('GET', `/handovers/${encodeURIComponent(code)}`)); }
function agentd(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const entry = fileURLToPath(new URL('../../agentd/dist/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: { ...process.env, ...environment }, maxBuffer: 1024 * 1024 });
  let envelope: ApiResult<unknown>;
  try { envelope = JSON.parse(result.stdout) as ApiResult<unknown>; } catch { throw new DomainError('handover_agentd_failed', 'agentd 未返回有效结果', { stderr: result.stderr?.trim() }); }
  return unwrap(envelope);
}
function repository(options: { repo: string; repository?: string; remote: string }) {
  const repo = path.resolve(options.repo);
  let repositoryCode = options.repository;
  const binding = identifyBoundProject(repo);
  if (!repositoryCode && binding) repositoryCode = readRepositoryRegistry(path.dirname(path.dirname(binding.path))).find((item) => path.resolve(item.path) === repo)?.repository_code;
  if (!repositoryCode) throw new DomainError('repository_required', '请指定 --repository，或使用已绑定的本机仓库');
  return { repo, repositoryCode };
}

export function registerHandoverCommands(program: Command, task: Command): void {
  const execute = <Args extends unknown[]>(fn: (...args: Args) => Promise<unknown>) => async (...args: Args) => {
    try { process.stdout.write(JSON.stringify({ ok: true, data: await fn(...args) }, null, 2) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error instanceof DomainError ? error.code : 'internal_error', message: error instanceof Error ? error.message : String(error) } }, null, 2) + '\n'); process.exitCode = 1; }
  };
  const handover = task.command('handover').description('固定上下文与代码，交给另一位成员在其电脑上继续');
  handover.command('prepare <task_code>').requiredOption('--target <user_code>').requiredOption('--run <source_run_code>').requiredOption('--summary <file>', '已审阅的结构化摘要 JSON')
    .option('--repo <path>', '源仓库根目录', '.').option('--repository <code>').option('--remote <name>', 'Git 远端', 'origin').option('--paths <files...>', '明确选择仓库内文件；默认选取安全的变更文件')
    .option('--agent-stopped', '明确确认外部 Agent 已停止').option('--managed-agent', '通过本机 agentd 停止托管 Agent')
    .action(execute(async (taskCode: string, options: { target: string; run: string; summary: string; repo: string; repository?: string; remote: string; paths?: string[]; agentStopped?: boolean; managedAgent?: boolean }) => {
      if (!options.agentStopped && !options.managedAgent) throw new DomainError('source_stop_required', '停止外部 Agent 后传 --agent-stopped，或传 --managed-agent 停止本机托管进程');
      const summary = HandoverSummarySchema.parse(JSON.parse(readFileSync(options.summary, 'utf8')));
      const selected = repository(options);
      const preflight = preflightHandoverWorkspace({ repoPath: selected.repo, remoteName: options.remote, selectedPaths: options.paths });
      const current = unwrap(await client().getTask(taskCode));
      if (typeof current.project_code !== 'string' || !current.project_code) throw new DomainError('task_project_not_found', '任务没有可用项目关联，无法核对代码仓库');
      const registered = unwrap(await client().listProjectRepositories(current.project_code)).find((item) => item.repository_code === selected.repositoryCode);
      const comparableRemote = (value: string) => value.replace(/\.git$/, '').replace(/\/$/, '');
      if (!registered || registered.status !== 'active' || typeof registered.remote_url !== 'string' || comparableRemote(registered.remote_url) !== comparableRemote(preflight.remoteUrl)) throw new DomainError('handover_repository_mismatch', '所选仓库或 Git 远端与任务项目登记不一致；未暂停任务或推送代码');
      const taskState = load(taskCode);
      const prior = taskState.prepared_handover_code ? await detail(taskState.prepared_handover_code) : undefined;
      const original = taskState.prepare_request;
      if (prior?.status === 'preparing' && !original) throw new DomainError('handover_prepare_recovery_required', '本机旧准备记录缺少原始请求；请取消此交接，显式恢复源 Run 后重新准备，避免使用过期授权推送');
      const replayOriginal = original && original.source_run_code === options.run && original.target_user_code === options.target && (!prior || prior.status === 'preparing');
      const prepareRequest = replayOriginal ? original : { target_user_code: options.target, source_run_code: options.run, base_snapshot: Number(current.base_snapshot) };
      taskState.prepare_request = prepareRequest; save(taskCode, taskState);
      // The existing prepare receipt rotates the short-lived source grant for this exact request.
      const prepared = await mutate<{ handover_code: string; preparation_grant: string }>(taskCode, 'prepare', prepareRequest, 'POST', `/tasks/${encodeURIComponent(taskCode)}/handovers/prepare`);
      taskState.prepared_handover_code = prepared.handover_code; save(taskCode, taskState);
      const state = load(prepared.handover_code);
      Object.assign(state, { preparation_grant: prepared.preparation_grant, source_run_code: options.run }); save(prepared.handover_code, state);
      if (options.managedAgent) {
        const stopped = agentd(['stop', '--run', options.run]) as { local_stopped?: boolean; sessions?: unknown[] };
        if (!stopped.local_stopped || !stopped.sessions?.length) throw new DomainError('source_stop_unconfirmed', '本机没有该 Run 的托管停止记录；请人工核实外部 Agent 后使用 --agent-stopped');
      }
      await mutate(prepared.handover_code, 'source-stop-ack', { preparation_grant: prepared.preparation_grant, stopped: true, assurance: options.managedAgent ? 'managed_process' : 'manual_confirmation' });
      const manifest = state.manifest ?? publishHandoverWorkspace({ repoPath: selected.repo, repositoryCode: selected.repositoryCode, handoverCode: prepared.handover_code, remoteName: options.remote, selectedPaths: options.paths });
      state.manifest = manifest; save(prepared.handover_code, state);
      const latest = await detail(prepared.handover_code);
      await mutate(prepared.handover_code, 'draft', { summary, workspace_manifest: manifest, preparation_grant: prepared.preparation_grant, version: latest.version }, 'PUT');
      return { handover_code: prepared.handover_code, workspace_manifest: manifest, excluded_paths: preflight.excluded, next: `tsp task handover publish ${prepared.handover_code}` };
    }));
  handover.command('show <code>').action(execute(async (code: string) => detail(code)));
  for (const operation of ['publish', 'accept', 'cancel'] as const) handover.command(`${operation} <code>`).action(execute(async (code: string) => mutate(code, operation, { version: (await detail(code)).version })));
  handover.command('restore <code>').requiredOption('--repo <path>', 'B 的本机代码仓库').requiredOption('--dir <path>', '新的独立工作树目录').option('--remote <name>', 'Git 远端', 'origin')
    .action(execute(async (code: string, options: { repo: string; dir: string; remote: string }) => {
      const handoverDetail = await detail(code);
      const state = load(code);
      const restored = await mutate<{ attempt_code: string; target_run_code: string }>(code, 'restore', { version: handoverDetail.version, workspace_path: path.resolve(options.dir), git_base: handoverDetail.workspace_manifest.snapshot_commit });
      state.attempt_code = restored.attempt_code; state.workspace_path = path.resolve(options.dir); state.manifest = handoverDetail.workspace_manifest; state.context_snapshot_hash = handoverDetail.context_snapshot_hash; save(code, state);
      const workspace = restoreHandoverWorkspace({ repoPath: options.repo, workspacePath: options.dir, manifest: handoverDetail.workspace_manifest, attemptCode: restored.attempt_code, remoteName: options.remote });
      const context = unwrap(await client().request<DownloadedContext>('GET', `/context-snapshots/${encodeURIComponent(handoverDetail.context_snapshot_code)}`));
      verifyContext(context, handoverDetail.context_snapshot_hash);
      const contextPath = path.join(path.dirname(statePath(code)), `${code}.context.json`);
      writeFileSync(contextPath, JSON.stringify({ context, summary: handoverDetail.summary }, null, 2));
      const drift = unwrap(await client().request<unknown>('GET', `/context-snapshots/${encodeURIComponent(handoverDetail.context_snapshot_code)}/diff`));
      const skills = await prepareRunSkillContext(client(), options.dir, restored.target_run_code);
      const briefPath = renderContinuationPack(code, context, handoverDetail.summary, drift, skills);
      const ready = await mutate(code, 'ready', { version: (await detail(code)).version, attempt_code: restored.attempt_code, workspace_digest: workspace.workspace_digest, snapshot_commit: handoverDetail.workspace_manifest.snapshot_commit, context_snapshot_hash: handoverDetail.context_snapshot_hash, assurance: 'client_reported' });
      return { ...workspace, target_run_code: restored.target_run_code, context_path: contextPath, brief_path: briefPath, ready };
    }));
  handover.command('activate <code>').option('--agent-command <command>', '使用本人凭据启动的新 Agent 命令；未指定时只激活').action(execute(async (code: string, options: { agentCommand?: string }) => {
    const state = load(code);
    if (!state.workspace_path || !state.manifest || !state.attempt_code) throw new DomainError('handover_not_restored', '请先在本机 restore');
    verifyHandoverWorkspace(state.workspace_path, state.manifest);
    const contextPath = path.join(path.dirname(statePath(code)), `${code}.context.json`);
    const stored = JSON.parse(readFileSync(contextPath, 'utf8')) as { context: DownloadedContext };
    verifyContext(stored.context, state.context_snapshot_hash ?? '');
    const current = await detail(code);
    const targetRunCode = state.activated?.run_code ?? current.target_run_code;
    if (!targetRunCode) throw new DomainError('handover_not_restored', '目标 Run 尚未准备');
    const skills = await prepareRunSkillContext(client(), state.workspace_path, targetRunCode);
    const briefPath = renderContinuationPack(code, stored.context, stored.context.summary, { note: '激活时服务端再次检查当前来源版本' }, skills);
    const activated = state.activated ?? await mutate<NonNullable<LocalState['activated']>>(code, 'activate', { version: (await detail(code)).version, attempt_code: state.attempt_code, context_snapshot_hash: state.context_snapshot_hash });
    const auth = readAuthConfig();
    const token = process.env.ACP_DEVICE_TOKEN || process.env.ACP_TOKEN || auth?.device_token;
    const apiUrl = (process.env.ACP_API_URL || auth?.api_url || identifyBoundProject(process.cwd())?.binding.api_url || '').replace(/\/+$/, '');
    const fingerprint = token ? localDeviceFingerprint(apiUrl, token) : undefined;
    if (state.activated && (state.api_url !== apiUrl || !token || !matchesLocalDeviceFingerprint(apiUrl, token, state.credential_fingerprint))) throw new DomainError('handover_device_conflict', '本地交接激活记录属于其他服务或设备');
    if (activated.lease.expires_at && Date.parse(activated.lease.expires_at) <= Date.now() + 5000) activated.lease = unwrap(await client().request('POST', `/runs/${encodeURIComponent(activated.run_code)}/lease`, { execution_epoch: activated.execution_epoch }));
    state.api_url = apiUrl;
    state.credential_fingerprint = fingerprint;
    state.activated = activated; save(code, state);
    if (options.agentCommand) { state.keys['agent-start'] ??= randomUUID(); save(code, state); }
    const started = options.agentCommand ? agentd(['start', '--run', activated.run_code, '--workspace', state.workspace_path, '--agent-command', options.agentCommand, '--prompt', briefPath, '--start-key', state.keys['agent-start'] ?? ''], { ACP_RUN_LEASE_TOKEN: activated.lease.lease_token, ACP_EXECUTION_EPOCH: String(activated.execution_epoch) }) : undefined;
    return { run_code: activated.run_code, workspace_code: activated.workspace_code, execution_epoch: activated.execution_epoch, workspace_path: state.workspace_path, context_path: contextPath, brief_path: briefPath, ...(started ? { session: started } : {}) };
  }));
  const context = program.command('context').description('读取固定版本共享上下文和版本漂移');
  for (const operation of ['show', 'diff'] as const) context.command(`${operation} <snapshot_code>`).action(execute(async (code: string) => unwrap(await client().request('GET', `/context-snapshots/${encodeURIComponent(code)}${operation === 'diff' ? '/diff' : ''}`))));
}
