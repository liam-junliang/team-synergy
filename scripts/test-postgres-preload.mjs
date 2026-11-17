import pg from 'pg';
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimSymbol, validateTestConnectionParameters, verifyTestConnection } from './test-database-guard.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const drivers = new Set([pg]);
// pnpm can install different pg versions in separate workspaces. Guard every
// resolved driver, rather than silently depending on hoisting/deduplication.
for (const folder of ['apps','packages']) for (const entry of readdirSync(path.join(root, folder))) {
  const manifest = path.join(root, folder, entry, 'package.json');
  if (!existsSync(manifest)) continue;
  try { drivers.add(createRequire(manifest)('pg')); } catch { /* This package does not use pg. */ }
}
for (const driver of drivers) {
const original = driver.Client.prototype.connect;
driver.Client.prototype.connect = function connect(callback) {
  const verified = async () => {
    const checked = validateTestConnectionParameters(this.connectionParameters, this[claimSymbol]);
    await original.call(this);
    try { await verifyTestConnection(this, checked.lease, checked.config, { fresh: checked.fresh }); }
    catch (error) { await this.end(); throw error; }
  };
  const work = verified();
  if (typeof callback === 'function') { work.then(() => callback(null), callback); return; }
  return work;
};
}
