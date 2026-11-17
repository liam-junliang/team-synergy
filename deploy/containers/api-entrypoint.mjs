import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'serve';
if (!['serve', 'migrate'].includes(mode)) throw Error('Expected serve or migrate');
const password = readFileSync(process.env.TSP_DB_PASSWORD_FILE ?? '/run/secrets/db-password', 'utf8').replace(/\r?\n$/, '');
if (!password || /[\r\n\0]/.test(password)) throw Error('Invalid database password file');
const user = process.env.TSP_DB_USER ?? 'tsp';
const database = process.env.TSP_DB_NAME ?? 'team_synergy';
const port = process.env.TSP_DB_PORT ?? '15432';
if (![user, database].every(value => /^[a-z_][a-z0-9_]{0,62}$/.test(value)) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw Error('Invalid database identity');
const url = new URL(`postgres://127.0.0.1:${port}/${database}`);
url.username = user;
url.password = password;
process.env.TSP_DATABASE_URL = url.href;
const child = spawn(process.execPath, [mode === 'migrate' ? '/app/dist/migrate.js' : '/app/dist/index.js'], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Unable to start API process.\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => process.exit(code ?? (signal === 'SIGTERM' ? 143 : 1)));
