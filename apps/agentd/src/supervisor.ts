#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { apiRequest, AgentdError, matchesCredentialFingerprint, readApiConfig } from './api.js';
import { readJournal, terminateProcessTree, writeJournal, type Journal, type Lease } from './runtime.js';

/** Diagnostic tail only; never advertised as a portable transcript. */
class OutputTail {
  private readonly lines: string[] = [];
  private readonly pending = new Map<'stdout'|'stderr', string>();
  append(source: 'stdout'|'stderr', text: string): void {
    const parts = `${this.pending.get(source) ?? ''}${text}`.split(/\r?\n/);
    this.pending.set(source, parts.pop() ?? '');
    for (const line of parts) this.push(source, line);
  }
  flush(): void { for (const source of ['stdout','stderr'] as const) { const value = this.pending.get(source); if (value) this.push(source, value); this.pending.set(source, ''); } }
  private push(source: string, value: string) { this.lines.push(`[${source}] ${value}`); if (this.lines.length > 50) this.lines.splice(0, this.lines.length - 50); }
  value(): string { return this.lines.join('\n').slice(-32_000); }
}
async function supervise(file: string): Promise<void> {
  const config = readApiConfig();
  const journal: Journal = readJournal(file);
  if (journal.completed || !matchesCredentialFingerprint(config, journal.credentialFingerprint)) return;
  // Check device, membership, epoch and token before any process is spawned.
  journal.lease = await apiRequest<Lease>(config, 'POST', `/runs/${journal.runCode}/lease/renew`, { lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch });
  journal.processId = process.pid; journal.session.process_id = process.pid; journal.session.status = 'running'; journal.startedAt = new Date().toISOString();
  writeJournal(file, journal);
  await apiRequest(config, 'POST', `/agent-sessions/${journal.session.session_code}/state`, { status: 'running', process_id: process.pid, lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch });
  const env = { ...process.env, ACP_DATABASE_URL: undefined, ACP_RUN_CODE: journal.runCode, ACP_TASK_CODE: journal.taskCode, ACP_WORKSPACE_ROOT: journal.workspace, ACP_BRIEF_PATH: journal.session.prompt_path ?? '', ACP_RUN_LEASE_TOKEN: journal.lease.lease_token, ACP_EXECUTION_EPOCH: String(journal.lease.execution_epoch) };
  let child: ChildProcess;
  if (journal.session.launch_kind === 'default') {
    if (!journal.session.prompt_path) throw new Error('默认 Agent 需要 Prompt 文件');
    const prompt = readFileSync(journal.session.prompt_path, 'utf8');
    // A fixed launcher may resolve codex.cmd on Windows. Prompt text is never
    // interpolated into the shell or argument vector; Codex reads it from stdin.
    child = spawn('codex exec -', { cwd: journal.repoPath, env, windowsHide: true, shell: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    child.stdin?.on('error', () => { /* Early process failure is captured by close/error below. */ });
    child.stdin?.end(prompt);
  } else child = spawn(journal.session.agent_command, { cwd: journal.repoPath, env, windowsHide: true, shell: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
  journal.childProcessId = child.pid;
  writeJournal(file, journal);
  const output = new OutputTail();
  let completed = false;
  let watchdogBusy = false;
  let watchdogError: string|null = null;
  const save = () => { journal.output = output.value(); writeJournal(file, journal); };
  child.stdout?.on('data', chunk => { output.append('stdout', chunk.toString()); save(); });
  child.stderr?.on('data', chunk => { output.append('stderr', chunk.toString()); save(); });
  const checkLease = async () => {
    if (watchdogBusy || completed) return;
    watchdogBusy = true;
    try {
      journal.lease = await apiRequest<Lease>(config, 'POST', `/runs/${journal.runCode}/lease/renew`, { lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch });
      await apiRequest(config, 'POST', `/agent-sessions/${journal.session.session_code}/state`, { status: 'running', process_id: process.pid, last_output: output.value(), lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch });
      if (!completed) save();
    } catch (error) {
      // A transport failure can use the remaining lease; explicit rejection fences immediately.
      if (!(error instanceof AgentdError) || error.code !== 'api_unreachable' || Date.now() >= Date.parse(journal.lease.expires_at)) {
        watchdogError = `Execution lease lost: ${error instanceof Error ? error.message : String(error)}`;
        await terminateProcessTree(child.pid);
      }
    } finally { watchdogBusy = false; }
  };
  const pollMs = Math.max(250, Math.min(5000, Number(process.env.AGENTD_WATCHDOG_INTERVAL_MS) || 5000));
  const timer = setInterval(() => { void checkLease(); }, pollMs);
  await new Promise<void>(resolve => {
    const finish = async (exitCode: number|null, error: string|null) => {
      if (completed) return;
      completed = true; clearInterval(timer); output.flush();
      journal.completed = true; journal.exitCode = exitCode; journal.error = watchdogError ?? error ?? (exitCode === 0 ? null : `Agent process exited with code ${exitCode ?? 'unknown'}`); journal.output = output.value(); journal.session.status = exitCode === 0 && !journal.error ? 'finished' : 'failed';
      writeJournal(file, journal);
      try { await apiRequest(config, 'POST', `/agent-sessions/${journal.session.session_code}/state`, { status: journal.session.status, exit_code: exitCode, last_error: journal.error, last_output: journal.output, lease_token: journal.lease.lease_token, execution_epoch: journal.lease.execution_epoch }); } catch { /* Fenced source cannot write; journal preserves diagnostic result. */ }
      resolve();
    };
    child.once('error', error => { void finish(null, error.message); });
    child.once('close', (code, signal) => { void finish(code, code === null ? `Agent process exited due to signal ${signal ?? 'unknown'}` : null); });
  });
}
const file = process.argv[2];
if (!file) { process.stderr.write('Local session journal path is required\n'); process.exitCode = 1; }
else supervise(file).catch(error => {
  try { const journal = readJournal(file); journal.completed = true; journal.error = error instanceof Error ? error.message : String(error); writeJournal(file, journal); } catch { /* Preserve original failure. */ }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
});
