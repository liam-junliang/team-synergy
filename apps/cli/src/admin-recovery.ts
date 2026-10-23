import type { Command } from 'commander';
import type { Readable, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { DomainError } from '@team-synergy/domain';

async function loadServerModules() {
  const [persistence, application] = await Promise.all([import('@team-synergy/persistence'), import('@team-synergy/application')]);
  return { openDb: persistence.openDb, closeDb: persistence.closeDb, resetLocalAdminPassword: application.resetLocalAdminPassword };
}
interface RecoveryIO {
  input: Readable & { isTTY?: boolean };
  terminal: Writable & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  localOperator: string;
  localHostname: string;
  load: typeof loadServerModules;
}

async function passwordFromStdin(input: RecoveryIO['input']): Promise<string> {
  if (input.isTTY) throw new DomainError('admin_recovery_stdin_required', 'Pipe a password through secure stdin; interactive echo is disabled for this command');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 1024) throw new DomainError('admin_recovery_invalid', 'Password input exceeds the supported size');
    chunks.push(buffer);
  }
  const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (/[\r\n]/.test(password) || password.length < 8 || password.length > 128) throw new DomainError('admin_recovery_invalid', 'Supply one password of 8 to 128 characters');
  return password;
}

/** Direct database operation; no API endpoint or credential command-line argument. */
export async function runAdminResetPassword(options: { account: string; passwordStdin?: boolean }, overrides: Partial<RecoveryIO> = {}) {
  const env = overrides.env ?? process.env;
  if (env.TSP_ALLOW_LOCAL_ADMIN_RESET !== '1' || !env.TSP_DATABASE_URL?.trim()) throw new DomainError('admin_recovery_not_enabled', 'Server-local recovery requires TSP_ALLOW_LOCAL_ADMIN_RESET=1 and an explicit TSP_DATABASE_URL');
  const input = overrides.input ?? process.stdin;
  const terminal = overrides.terminal ?? process.stderr;
  if (!options.passwordStdin && !terminal.isTTY) throw new DomainError('admin_recovery_terminal_required', 'Generated passwords require a terminal; use --password-stdin for automation');
  const password = options.passwordStdin ? await passwordFromStdin(input) : randomBytes(24).toString('base64url');
  let modules: Awaited<ReturnType<typeof loadServerModules>>;
  try { modules = await (overrides.load ?? loadServerModules)(); }
  catch { throw new DomainError('admin_recovery_unavailable', 'Recovery must run in a server installation with application and database modules'); }
  let db: Awaited<ReturnType<typeof modules.openDb>> | undefined;
  try {
    db = await modules.openDb({ databaseUrl: env.TSP_DATABASE_URL, migrate: false });
    const result = await modules.resetLocalAdminPassword(db, { account: options.account, newPassword: password,
      localOperator: overrides.localOperator ?? userInfo().username, localHostname: overrides.localHostname ?? hostname(),
    });
    if (!result.ok) throw new DomainError(result.error.code, 'Administrator recovery failed; verify the account, bootstrap configuration and database');
    if (!options.passwordStdin) terminal.write(`Temporary administrator password: ${password}\nExpires: ${result.data.expires_at}\n`);
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // Database errors may contain connection strings or query parameters.
    throw new DomainError('admin_recovery_failed', 'Administrator recovery failed; verify server database access');
  } finally { if (db) await modules.closeDb(db); }
}

export function registerAdminRecoveryCommands(program: Command): void {
  program.command('admin:reset-password').description('服务器本机恢复平台管理员初始口令（不经过 HTTP）')
    .requiredOption('--account <account>', '平台管理员账号')
    .option('--password-stdin', '从安全管道读取新口令；默认仅向终端展示随机口令')
    .action(async (options: { account: string; passwordStdin?: boolean }) => {
      try { process.stdout.write(`${JSON.stringify(await runAdminResetPassword(options))}\n`); }
      catch (error) {
        const code = error instanceof DomainError ? error.code : 'admin_recovery_failed';
        process.stderr.write(`${code}: Administrator recovery failed; check server configuration and account eligibility.\n`);
        process.exitCode = 1;
      }
    });
}
