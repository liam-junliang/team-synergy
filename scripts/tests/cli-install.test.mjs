import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/core-api/package.json'));
const Fastify = require('fastify');
const { registerCliDistributionRoutes } = await import('../../apps/core-api/dist/routes/cli-distribution.js');
const distribution = process.env.TEST_CLI_DIST_DIR;
function execute(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; }); child.on('error', reject); child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
function powershell(args, env = {}) {
  return execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], env);
}
test('Windows platform installation works without source, preserves configuration and rejects corrupt updates', { skip: process.platform !== 'win32' || !distribution, timeout: 180_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'tsp-install-smoke-'));
  const served = path.join(temporary, 'distribution'); await mkdir(served);
  const manifest = JSON.parse(await readFile(path.join(distribution, 'manifest.json'), 'utf8'));
  const artifact = manifest.artifacts.find((item) => item.platform === 'win32' && item.arch === process.arch); assert.ok(artifact, 'build the matching release first');
  await copyFile(path.join(distribution, artifact.filename), path.join(served, artifact.filename));
  await writeFile(path.join(served, 'manifest.json'), JSON.stringify(manifest));
  for (const name of ['install.ps1', 'install.sh']) await copyFile(path.join(root, 'scripts/cli-install', name), path.join(served, name));
  const app = Fastify(); await app.register(async (instance) => registerCliDistributionRoutes(instance, { directory: served }), { prefix: '/api' });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(temporary, { recursive: true, force: true }); });
  const installDir = path.join(temporary, 'installed CLI');
  const downloadedScript = path.join(temporary, 'install.ps1');
  await writeFile(downloadedScript, await (await fetch(`${address}/api/cli/install.ps1`)).text());
  const userPathBefore = await powershell(['-Command', '[Environment]::GetEnvironmentVariable("Path", "User")']);
  const install = () => powershell(['-File', downloadedScript, '-BaseUrl', `${address}/api`, '-InstallDir', installDir, '-NoModifyPath']);
  const first = await install(); assert.equal(first.code, 0, first.stderr);
  const marker = JSON.parse((await readFile(path.join(installDir, '.tsp-install.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const releaseRoot = path.join(installDir, 'versions', marker.directory);
  assert.equal((await powershell(['-Command', '& $env:TSP_TEST_SHIM --version'], { TSP_TEST_SHIM: path.join(installDir, 'bin/tsp.cmd') })).stdout.trim(), manifest.version);
  assert.equal((await powershell(['-Command', '& $env:TSP_TEST_RUNTIME --version'], { TSP_TEST_RUNTIME: path.join(releaseRoot, 'runtime/node.exe') })).stdout.trim(), `v${artifact.node_version}`);
  assert.ok((await readFile(path.join(releaseRoot, 'apps/agentd/dist/index.js'), 'utf8')).length > 100);
  await writeFile(path.join(installDir, 'keep-user-config'), 'preserve');
  const second = await install(); assert.equal(second.code, 0, second.stderr); assert.equal(await readFile(path.join(installDir, 'keep-user-config'), 'utf8'), 'preserve');
  const shimBefore = await readFile(path.join(installDir, 'bin/tsp.cmd'), 'utf8');
  artifact.sha256 = '0'.repeat(64); await writeFile(path.join(served, 'manifest.json'), JSON.stringify(manifest));
  const corrupt = await install(); assert.notEqual(corrupt.code, 0); assert.match(corrupt.stderr, /checksum mismatch/); assert.equal(await readFile(path.join(installDir, 'bin/tsp.cmd'), 'utf8'), shimBefore);
  const unmanaged = path.join(temporary, 'unmanaged'); await mkdir(unmanaged); await writeFile(path.join(unmanaged, 'important'), 'untouched');
  const refused = await powershell(['-File', downloadedScript, '-BaseUrl', `${address}/api`, '-InstallDir', unmanaged, '-NoModifyPath']); assert.notEqual(refused.code, 0); assert.match(refused.stderr, /unmanaged/); assert.equal(await readFile(path.join(unmanaged, 'important'), 'utf8'), 'untouched');
  const userPathAfter = await powershell(['-Command', '[Environment]::GetEnvironmentVariable("Path", "User")']); assert.equal(userPathAfter.stdout, userPathBefore.stdout);
});

test('Unix platform installation uses bundled runtime and preserves a working install on corrupt updates', { skip: !['linux', 'darwin'].includes(process.platform) || !distribution, timeout: 180_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'tsp-install-smoke-'));
  const served = path.join(temporary, 'distribution'); await mkdir(served);
  const manifest = JSON.parse(await readFile(path.join(distribution, 'manifest.json'), 'utf8'));
  const artifact = manifest.artifacts.find((item) => item.platform === process.platform && item.arch === process.arch); assert.ok(artifact, 'build the matching release first');
  await copyFile(path.join(distribution, artifact.filename), path.join(served, artifact.filename));
  await writeFile(path.join(served, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(path.join(root, 'scripts/cli-install/install.sh'), path.join(served, 'install.sh'));
  const app = Fastify(); await app.register(async (instance) => registerCliDistributionRoutes(instance, { directory: served }), { prefix: '/api' });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); await rm(temporary, { recursive: true, force: true }); });
  const installDir = path.join(temporary, 'installed CLI'); const downloadedScript = path.join(temporary, 'install.sh');
  await writeFile(downloadedScript, await (await fetch(`${address}/api/cli/install.sh`)).text());
  const install = () => execute('sh', [downloadedScript, '--base-url', `${address}/api`, '--install-dir', installDir, '--no-modify-path'], { HOME: temporary });
  const first = await install(); assert.equal(first.code, 0, first.stderr);
  assert.equal((await execute(path.join(installDir, 'bin/tsp'), ['--version'], { HOME: temporary })).stdout.trim(), manifest.version);
  const selected = (await readFile(path.join(installDir, '.tsp-install'), 'utf8')).trim().split('\n')[1];
  assert.equal((await execute(path.join(installDir, 'versions', selected, 'runtime/node'), ['--version'])).stdout.trim(), `v${artifact.node_version}`);
  await writeFile(path.join(installDir, 'keep-user-config'), 'preserve');
  const second = await install(); assert.equal(second.code, 0, second.stderr); assert.equal(await readFile(path.join(installDir, 'keep-user-config'), 'utf8'), 'preserve');
  const shimBefore = await readFile(path.join(installDir, 'bin/tsp'), 'utf8');
  artifact.sha256 = '0'.repeat(64); await writeFile(path.join(served, 'manifest.json'), JSON.stringify(manifest));
  const corrupt = await install(); assert.notEqual(corrupt.code, 0); assert.match(corrupt.stderr, /checksum mismatch/); assert.equal(await readFile(path.join(installDir, 'bin/tsp'), 'utf8'), shimBefore);
  const unmanaged = path.join(temporary, 'unmanaged'); await mkdir(unmanaged); await writeFile(path.join(unmanaged, 'important'), 'untouched');
  const refused = await execute('sh', [downloadedScript, '--base-url', `${address}/api`, '--install-dir', unmanaged, '--no-modify-path']); assert.notEqual(refused.code, 0); assert.match(refused.stderr, /unmanaged/); assert.equal(await readFile(path.join(unmanaged, 'important'), 'utf8'), 'untouched');
});
