import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface Session {
  session_code: string; run_code: string; agent_command: string; launch_kind: 'custom'|'default'; prompt_path: string|null;
  process_id: number|null; status: string; execution_epoch: number; last_output?: string|null; last_error?: string|null; exit_code?: number|null;
}
export interface Lease { lease_token: string; execution_epoch: number; expires_at: string }
export interface Journal {
  session: Session; runCode: string; taskCode: string; workspace: string; repoPath: string; credentialFingerprint: string;
  lease: Lease; startKey: string; completed: boolean; exitCode: number|null; error: string|null; output: string; processId: number|null;
  childProcessId?: number; startedAt?: string;
}
export function journalDirectory(): string { return process.env.AGENTD_HOME ?? path.join(process.env.AGENTCTL_HOME ?? path.join(homedir(), '.agentctl'), 'agentd'); }
export function journalPath(sessionCode: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionCode)) throw new Error('Invalid session code');
  return path.join(journalDirectory(), `${sessionCode}.json`);
}
export function writeJournal(file: string, journal: Journal): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}
export function readJournal(file: string): Journal { return JSON.parse(readFileSync(file, 'utf8')) as Journal; }
export function journals(): Array<{ file: string; journal: Journal }> {
  if (!existsSync(journalDirectory())) return [];
  return readdirSync(journalDirectory()).filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).flatMap(name => {
    const file = path.join(journalDirectory(), name);
    try { return [{ file, journal: readJournal(file) }]; } catch { return []; }
  });
}
export function isProcessAlive(pid: number|null|undefined): boolean {
  if (!pid || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export async function terminateProcessTree(pid: number|null|undefined): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0 && isProcessAlive(pid)) throw new Error(`无法终止进程树 PID ${pid}`);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { return; } }
  for (let index = 0; index < 40 && isProcessAlive(pid); index++) await delay(25);
  if (!isProcessAlive(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
}
