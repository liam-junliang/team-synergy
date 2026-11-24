import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile, realpath, symlink, readdir } from 'node:fs/promises';
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

async function exerciseUpdater({ served, manifest, artifact, installDir, temporary, runTsp, runAgentd }) {
  const manifestPath = path.join(served, 'manifest.json');
  const pointerPath = path.join(installDir, '.tsp-current');
  const initialPointer = await readFile(pointerPath, 'utf8');
  const initialSlots = await readdir(path.join(installDir, 'versions'));
  const authDirectory = path.join(temporary, 'account config');
  await mkdir(authDirectory);
  await writeFile(path.join(authDirectory, 'auth.json'), '{}\n');
  await writeFile(path.join(authDirectory, 'project-binding.json'), '{"fixture":"project"}\n');
  const env = { AGENTCTL_HOME: authDirectory };
  const version = await runTsp(['version'], env);
  assert.equal(version.code, 0, version.stderr);
  assert.deepEqual(JSON.parse(version.stdout).data, {
    version: manifest.version,
    release: artifact.release,
    source_revision: process.env.GITHUB_SHA ?? manifest.source_revision ?? null,
  });
  assert.equal((await runAgentd(['--version'], env)).stdout.trim(), manifest.version);
  const unchanged = await runTsp(['update', '--check'], env);
  assert.equal(JSON.parse(unchanged.stdout).data.update_available, false);

  // Repack with a different archive identity, without changing the internal CLI inputs.
  let bytes = await readFile(path.join(served, artifact.filename));
  if (artifact.format === 'zip') {
    assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 2), 0);
    const comment = Buffer.from('release identity test');
    bytes.writeUInt16LE(comment.length, bytes.length - 2);
    bytes = Buffer.concat([bytes, comment]);
  } else {
    bytes.writeUInt32LE(bytes.readUInt32LE(4) ^ 127, 4);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const release = `${manifest.version}-${sha256.slice(0, 16)}`;
  const filename = `tsp-${release}-${artifact.platform}-${artifact.arch}.${artifact.format}`;
  await writeFile(path.join(served, filename), bytes);
  const alternate = { ...artifact, release, filename, sha256, size_bytes: bytes.length };
  await writeFile(manifestPath, JSON.stringify({ ...manifest, release, artifacts: [alternate] }));

  const check = await runTsp(['update', '--check'], env);
  assert.equal(check.code, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).data.available, release);
  assert.equal(JSON.parse(check.stdout).data.update_available, true);
  const refused = await runTsp(['update'], env);
  assert.equal(JSON.parse(refused.stdout).error.code, 'cli_update_confirmation_required');
  assert.equal(await readFile(pointerPath, 'utf8'), initialPointer);

  const upgraded = await runTsp(['update', '--yes'], env);
  assert.equal(upgraded.code, 0, upgraded.stderr || upgraded.stdout);
  assert.equal(JSON.parse(upgraded.stdout).data.updated, true);
  const [current, previous] = (await readFile(pointerPath, 'utf8')).split(/\r?\n/);
  assert.ok(current.startsWith(release + '-'));
  assert.equal(previous, initialPointer.split(/\r?\n/)[0]);
  assert.equal(JSON.parse((await runTsp(['version'], env)).stdout).data.release, release);
  assert.equal((await runAgentd(['--version'], env)).stdout.trim(), manifest.version);
  assert.deepEqual(await readdir(path.join(installDir, 'versions')), [...initialSlots, current].sort());

  const rollback = await runTsp(['update', '--rollback', '--yes'], env);
  assert.equal(rollback.code, 0, rollback.stderr || rollback.stdout);
  assert.equal(JSON.parse(rollback.stdout).data.rolled_back, true);
  assert.equal(JSON.parse((await runTsp(['version'], env)).stdout).data.release, artifact.release);
  assert.equal((await runAgentd(['--version'], env)).stdout.trim(), manifest.version);
  assert.equal(await readFile(path.join(authDirectory, 'auth.json'), 'utf8'), '{}\n');
  assert.equal(await readFile(path.join(authDirectory, 'project-binding.json'), 'utf8'), '{"fixture":"project"}\n');
  await writeFile(manifestPath, JSON.stringify(manifest));
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
  const runShim = (shim) => (args, env) => powershell(['-Command', '$tspArgs = $env:TSP_TEST_ARGS -split " "; & $env:TSP_TEST_SHIM @tspArgs'], {
    ...env, TSP_TEST_SHIM: path.join(installDir, `bin/${shim}.cmd`), TSP_TEST_ARGS: args.join(' '),
  });
  await exerciseUpdater({ served, manifest, artifact, installDir, temporary, runTsp: runShim('tsp'), runAgentd: runShim('agentd') });
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
  // macOS can expose the system temporary directory through the /var symlink.
  const temporaryParent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(temporaryParent, 'tsp-install-smoke-'));
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
  const install = (destination = installDir) => execute('sh', [downloadedScript, '--base-url', `${address}/api`, '--install-dir', destination, '--no-modify-path'], { HOME: temporary });
  const first = await install(); assert.equal(first.code, 0, first.stderr);
  assert.equal((await execute(path.join(installDir, 'bin/tsp'), ['--version'], { HOME: temporary })).stdout.trim(), manifest.version);
  const selected = (await readFile(path.join(installDir, '.tsp-install'), 'utf8')).trim().split('\n')[1];
  assert.equal((await execute(path.join(installDir, 'versions', selected, 'runtime/node'), ['--version'])).stdout.trim(), `v${artifact.node_version}`);
  const runShim = (shim) => (args, env) => execute(path.join(installDir, `bin/${shim}`), args, { HOME: temporary, ...env });
  await exerciseUpdater({ served, manifest, artifact, installDir, temporary, runTsp: runShim('tsp'), runAgentd: runShim('agentd') });
  await writeFile(path.join(installDir, 'keep-user-config'), 'preserve');
  const second = await install(); assert.equal(second.code, 0, second.stderr); assert.equal(await readFile(path.join(installDir, 'keep-user-config'), 'utf8'), 'preserve');
  const shimBefore = await readFile(path.join(installDir, 'bin/tsp'), 'utf8');
  const linkedInstallDir = path.join(temporary, 'linked CLI');
  await symlink(installDir, linkedInstallDir);
  const linked = await install(linkedInstallDir);
  assert.notEqual(linked.code, 0);
  assert.match(linked.stderr, /Installation path contains a link/);
  assert.equal(await readFile(path.join(installDir, 'bin/tsp'), 'utf8'), shimBefore);
  artifact.sha256 = '0'.repeat(64); await writeFile(path.join(served, 'manifest.json'), JSON.stringify(manifest));
  const corrupt = await install(); assert.notEqual(corrupt.code, 0); assert.match(corrupt.stderr, /checksum mismatch/); assert.equal(await readFile(path.join(installDir, 'bin/tsp'), 'utf8'), shimBefore);
  const unmanaged = path.join(temporary, 'unmanaged'); await mkdir(unmanaged); await writeFile(path.join(unmanaged, 'important'), 'untouched');
  const refused = await install(unmanaged); assert.notEqual(refused.code, 0); assert.match(refused.stderr, /unmanaged/); assert.equal(await readFile(path.join(unmanaged, 'important'), 'utf8'), 'untouched');
});
