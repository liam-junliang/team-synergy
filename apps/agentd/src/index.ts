#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { AgentdError, apiRequest, credentialFingerprint, matchesCredentialFingerprint, readApiConfig, type ApiConfig } from './api.js';
import { isProcessAlive, journalPath, journals, readJournal, terminateProcessTree, writeJournal, type Journal, type Lease, type Session } from './runtime.js';

function print(data: unknown): void { process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`); }
function failure(error: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error instanceof AgentdError ? error.code : 'internal_error', message: error instanceof Error ? error.message : String(error), ...(error instanceof AgentdError && error.details !== undefined ? { details: error.details } : {}) } }, null, 2)}\n`);
  process.exitCode = 1;
}
interface StartOptions { run: string; prompt?: string; agentCommand?: string; workspace?: string; leaseToken?: string; executionEpoch?: string; startKey?: string }
async function start(options: StartOptions, previous?: Session): Promise<Session> {
  const config = readApiConfig();
  const fingerprint = credentialFingerprint(config);
  const context = await apiRequest<{ run_code: string; task_code: string; workspace_path: string; status: string; execution_epoch: number }>(config, 'GET', `/runs/${encodeURIComponent(options.run)}/execution`);
  if (context.status !== 'active') throw new AgentdError('run_not_active', `Run 当前不可启动：${context.status}`);
  const startKey = options.startKey ?? randomUUID();
  const local = journals().find(({ journal }) => journal.runCode === context.run_code && journal.startKey === startKey && matchesCredentialFingerprint(config, journal.credentialFingerprint));
  if (local && options.agentCommand && options.agentCommand !== local.journal.session.agent_command) throw new AgentdError('conflict', '启动 key 已用于另一条命令');
  if (local && options.workspace && path.resolve(options.workspace) !== local.journal.workspace) throw new AgentdError('conflict', '启动 key 已用于另一工作区');
  if (local && options.prompt && path.resolve(options.prompt) !== local.journal.session.prompt_path) throw new AgentdError('conflict', '启动 key 已用于另一 Prompt');
  if (local && isProcessAlive(local.journal.processId)) return local.journal.session;
  const workspace = path.resolve(options.workspace ?? context.workspace_path);
  const repoPath = existsSync(path.join(workspace, '.git')) ? workspace : path.join(workspace, 'repo');
  if (!existsSync(repoPath)) throw new AgentdError('workspace_repo_not_found', `本机工作区不存在：${repoPath}`);
  const promptPath = path.resolve(options.prompt ?? previous?.prompt_path ?? path.join(workspace, '.agent', 'project-state', 'brief.md'));
  const launchKind = options.agentCommand ? 'custom' : previous?.launch_kind ?? 'default';
  if (launchKind === 'default' && !existsSync(promptPath)) throw new AgentdError('prompt_not_found', `Prompt 文件不存在：${promptPath}`);
  const command = options.agentCommand ?? (launchKind === 'custom' ? previous?.agent_command : 'codex exec -');
  if (!command) throw new AgentdError('session_command_missing', '缺少 Agent 启动命令');
  const suppliedToken = options.leaseToken ?? process.env.ACP_RUN_LEASE_TOKEN;
  const epoch = Number(options.executionEpoch ?? process.env.ACP_EXECUTION_EPOCH ?? context.execution_epoch);
  let lease: Lease;
  if (suppliedToken) lease = await apiRequest<Lease>(config, 'POST', `/runs/${context.run_code}/lease/renew`, { lease_token: suppliedToken, execution_epoch: epoch });
  else if (local && !local.journal.completed) lease = await apiRequest<Lease>(config, 'POST', `/runs/${context.run_code}/lease/renew`, { lease_token: local.journal.lease.lease_token, execution_epoch: local.journal.lease.execution_epoch });
  else lease = await apiRequest<Lease>(config, 'POST', `/runs/${context.run_code}/lease`, { execution_epoch: context.execution_epoch });
  const session = await apiRequest<Session & { created: boolean }>(config, 'POST', `/runs/${context.run_code}/sessions`, { start_key: startKey, agent_command: command, prompt_path: promptPath, launch_kind: launchKind, resumed_from_session_code: previous?.session_code, ...lease });
  if (!session.created && !local) throw new AgentdError('session_already_registered', '启动已登记；本机没有对应 journal，拒绝重复启动');
  if (!session.created && local?.journal.completed) return local.journal.session;
  const file = journalPath(session.session_code);
  const journal: Journal = { session, runCode: context.run_code, taskCode: context.task_code, workspace, repoPath, credentialFingerprint: fingerprint, lease, startKey, completed: false, exitCode: null, error: null, output: '', processId: null };
  writeJournal(file, journal);
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.js'), file], { cwd: repoPath, env: { ...process.env, ACP_API_URL: config.apiUrl, ACP_DEVICE_TOKEN: config.deviceToken, ACP_DATABASE_URL: undefined }, detached: true, windowsHide: true, stdio: 'ignore' });
  journal.processId = child.pid ?? null; journal.session.process_id = child.pid ?? null; writeJournal(file, journal);
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); }); });
    // The supervisor owns subsequent journal writes. Its PID is stable and is also recorded there.
    const running = await apiRequest<Session>(config, 'POST', `/agent-sessions/${session.session_code}/state`, { status: 'running', process_id: child.pid, lease_token: lease.lease_token, execution_epoch: lease.execution_epoch });
    return running;
  } catch (error) {
    await terminateProcessTree(child.pid);
    const current = readJournal(file); current.completed = true; current.error = error instanceof Error ? error.message : String(error); writeJournal(file, current);
    throw error;
  }
}
async function reportJournal(config: ApiConfig, journal: Journal): Promise<void> {
  await apiRequest(config, 'POST', `/agent-sessions/${journal.session.session_code}/state`, { status: journal.completed ? journal.exitCode === 0 ? 'finished' : journal.session.status === 'cancelled' ? 'cancelled' : 'failed' : 'running', process_id: journal.processId, exit_code: journal.exitCode, last_error: journal.error, last_output: journal.output, lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch });
}
async function sync(run: string) {
  const config = readApiConfig(); let synced = 0;
  for (const { file, journal } of journals().filter(({ journal }) => journal.runCode === run && matchesCredentialFingerprint(config, journal.credentialFingerprint))) {
    if (!journal.completed && journal.processId && !isProcessAlive(journal.processId)) { journal.completed = true; journal.error = 'Agent session monitor exited without an exit result'; writeJournal(file, journal); }
    try { await reportJournal(config, journal); synced++; } catch (error) { if (!(error instanceof AgentdError) || error.code === 'api_unreachable') throw error; }
  }
  return { ...(await apiRequest<{ run_code: string; sessions: Session[] }>(config, 'GET', `/runs/${encodeURIComponent(run)}/sessions`)), synced };
}
async function stop(options: { session?: string; run?: string }) {
  if ((options.session ? 1 : 0) + (options.run ? 1 : 0) !== 1) throw new AgentdError('stop_target_required', 'stop 必须且只能指定 --session 或 --run');
  const config = readApiConfig();
  const targets = journals().filter(({ journal }) => matchesCredentialFingerprint(config, journal.credentialFingerprint) && (options.session ? journal.session.session_code === options.session : journal.runCode === options.run));
  if (options.session && targets.length === 0) throw new AgentdError('session_not_local', '此设备没有该 Session 的托管进程记录');
  for (const { file, journal } of targets) {
    if (!journal.completed) {
      await terminateProcessTree(journal.processId);
      await terminateProcessTree(journal.childProcessId);
      const current = readJournal(file); current.completed = true; current.error = 'Session cancelled by local operator'; current.session.status = 'cancelled'; current.session.last_error = current.error; current.session.process_id = null; writeJournal(file, current);
      try { await reportJournal(config, current); } catch { /* Source control-channel ack works after business lease revocation. */ }
      journal.session = current.session;
    }
  }
  return { run_code: options.run ?? targets[0]?.journal.runCode, sessions: targets.map(({ journal }) => journal.session), local_stopped: true };
}
const program = new Command().name('agentd').description('通过设备鉴权 HTTP 管理本机 Agent Session').version('0.1.0').exitOverride();
function launchOptions(command: Command): Command { return command.requiredOption('--run <run_code>', 'Run 编码').option('--prompt <file>', '本机 Prompt 文件').option('--agent-command <cmd>', '自定义本机 Agent 命令').option('--workspace <path>', '本机 Workspace 路径').option('--lease-token <token>', '执行租约，建议使用 ACP_RUN_LEASE_TOKEN').option('--execution-epoch <epoch>', '执行代数').option('--start-key <key>', '幂等启动 key'); }
launchOptions(program.command('start')).action(async options => { try { print(await start(options)); } catch (error) { failure(error); } });
launchOptions(program.command('resume')).action(async (options: StartOptions) => {
  try {
    const config = readApiConfig();
    const context = await apiRequest<{ status: string }>(config, 'GET', `/runs/${encodeURIComponent(options.run)}/execution`);
    const data = await apiRequest<{ sessions: Session[] }>(config, 'GET', `/runs/${encodeURIComponent(options.run)}/sessions`);
    let resumedOptions = options;
    if (context.status === 'suspended') {
      // Only an explicit resume command reactivates the source Run. The server checks
      // source identity and refuses unresolved handovers before issuing a new lease.
      const restored = await apiRequest<{ execution_epoch: number; lease: Lease }>(config, 'POST', `/runs/${encodeURIComponent(options.run)}/resume`, {});
      resumedOptions = { ...options, leaseToken: restored.lease.lease_token, executionEpoch: String(restored.execution_epoch) };
    }
    print(await start(resumedOptions, data.sessions[0]));
  } catch (error) { failure(error); }
});
program.command('sessions').requiredOption('--run <run_code>', 'Run 编码').action(async options => { try { print(await apiRequest(readApiConfig(), 'GET', `/runs/${options.run}/sessions`)); } catch (error) { failure(error); } });
program.command('sync').requiredOption('--run <run_code>', 'Run 编码').action(async options => { try { print(await sync(options.run)); } catch (error) { failure(error); } });
program.command('stop').option('--session <session_code>', 'Session 编码').option('--run <run_code>', 'Run 编码').action(async options => { try { print(await stop(options)); } catch (error) { failure(error); } });
program.parseAsync().catch(error => { if (['commander.helpDisplayed','commander.version'].includes(error.code)) return; failure(error); });
