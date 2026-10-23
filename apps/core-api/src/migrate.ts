import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, resolveMigrationsFolder } from '@team-synergy/persistence';
import { startupFailure } from './lifecycle.js';

try {
  const db = await openDb({ migrationsFolder: resolveMigrationsFolder(path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')) });
  await closeDb(db);
  process.stdout.write('Database migrations applied.\n');
} catch (error) {
  process.stderr.write(`${startupFailure(error)}\n`);
  process.exitCode = 1;
}
