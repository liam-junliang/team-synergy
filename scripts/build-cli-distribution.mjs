import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Release builders need the repository; installed clients never do.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const platform = option('--platform', process.platform);
const arch = option('--arch', process.arch);
const nodeVersion = option('--node-version', '22.23.3');
const output = path.resolve(option('--out', path.join(root, 'output/cli-distribution')));
const localRuntime = args.includes('--use-local-runtime');
if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Supported targets: win32/linux/darwin x64/arm64');
if (!/^22\.\d+\.\d+$/.test(nodeVersion)) throw new Error('Pin an exact Node.js 22 runtime version');
if (localRuntime && (platform !== process.platform || arch !== process.arch || process.versions.node !== nodeVersion)) throw new Error('Local runtime must exactly match target and pinned Node version');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, commandArgs, cwd, env = process.env) => { const result = spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`); };
await fs.mkdir(output, { recursive: true });
const stage = await fs.mkdtemp(path.join(output, '.build-'));
const payload = path.join(stage, 'payload');
await fs.mkdir(payload);

// Write portable executable modes even when a Linux/macOS artifact is built on Windows.
async function* tarEntries(directory, prefix = '') {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`;
    const bytes = entry.isDirectory() ? Buffer.alloc(0) : await fs.readFile(path.join(directory, entry.name));
    const header = Buffer.alloc(512); let name = relative; let namePrefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf('/', name.length - 2);
      namePrefix = name.slice(0, split); name = name.slice(split + 1);
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(namePrefix) > 155) throw new Error(`Archive path too long: ${relative}`);
    }
    const text = (value, at, length) => header.write(value, at, length, 'utf8');
    const octal = (value, at, length) => text(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
    text(name, 0, 100); octal(entry.isDirectory() || ['runtime/node', 'tsp', 'agentd'].includes(relative) ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); text(entry.isDirectory() ? '5' : '0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2); text(namePrefix, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0); text(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    yield header;
    if (bytes.length) { yield bytes; const padding = (512 - bytes.length % 512) % 512; if (padding) yield Buffer.alloc(padding); }
    if (entry.isDirectory()) yield* tarEntries(path.join(directory, entry.name), relative);
  }
}

async function copyTree(source, destination, filter = () => true) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!filter(entry.name)) continue;
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in release input: ${from}`);
    if (entry.isDirectory()) await copyTree(from, to, filter);
    else if (entry.isFile()) await fs.copyFile(from, to);
  }
}
const dependencies = new Map();
async function copyDependencies(packageDirectory) {
  const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@team-synergy/')) continue;
    const require = createRequire(path.join(packageDirectory, 'package.json'));
    let directory = path.dirname(require.resolve(name));
    for (;;) {
      try { if (JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).name === name) break; } catch { /* ascend to package root */ }
      const parent = path.dirname(directory); if (parent === directory) throw new Error(`Cannot resolve production dependency ${name}`); directory = parent;
    }
    const dependency = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    if (dependencies.has(name)) { if (dependencies.get(name) !== dependency.version) throw new Error(`Conflicting versions for ${name}`); continue; }
    dependencies.set(name, dependency.version);
    await copyTree(directory, path.join(payload, 'node_modules', name), (entry) => !['node_modules', '.git', 'test', 'tests', '__tests__'].includes(entry));
    await copyDependencies(directory);
  }
}

try {
  const workspacePackages = ['apps/cli', 'apps/agentd', 'packages/contracts', 'packages/domain', 'packages/integrations'];
  for (const relative of workspacePackages) {
    const source = path.join(root, relative); const destination = path.join(payload, relative);
    await copyTree(path.join(source, 'dist'), path.join(destination, 'dist'), (name) => !name.endsWith('.map'));
    await fs.copyFile(path.join(source, 'package.json'), path.join(destination, 'package.json'));
    await copyDependencies(source);
  }
  // Real directories, not pnpm symlinks: archives remain portable across platforms.
  for (const name of ['contracts', 'domain', 'integrations']) await copyTree(path.join(payload, 'packages', name), path.join(payload, 'node_modules/@team-synergy', name));
  await fs.mkdir(path.join(payload, 'runtime'));
  let runtimeSource = 'official-nodejs.org-sha256';
  if (localRuntime) {
    await fs.copyFile(process.execPath, path.join(payload, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
    runtimeSource = 'local-exact-version';
  } else {
    const nodePlatform = platform === 'win32' ? 'win' : platform;
    const archive = `node-v${nodeVersion}-${nodePlatform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const base = `https://nodejs.org/dist/v${nodeVersion}/`;
    const sumsResponse = await fetch(`${base}SHASUMS256.txt`, { signal: AbortSignal.timeout(120_000) });
    if (!sumsResponse.ok) throw new Error(`Cannot fetch official Node checksums (${sumsResponse.status})`);
    const line = (await sumsResponse.text()).split('\n').find((item) => item.trim().endsWith(`  ${archive}`));
    const expected = line?.split(/\s+/)[0]; if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Official Node runtime unavailable: ${archive}`);
    const cache = path.join(root, '.cache/cli-runtime'); await fs.mkdir(cache, { recursive: true });
    const archivePath = path.join(cache, archive);
    let bytes; try { bytes = await fs.readFile(archivePath); } catch { /* first download */ }
    if (!bytes || sha256(bytes) !== expected) { const response = await fetch(`${base}${archive}`, { signal: AbortSignal.timeout(120_000) }); if (!response.ok) throw new Error(`Node download failed (${response.status})`); bytes = Buffer.from(await response.arrayBuffer()); if (sha256(bytes) !== expected) throw new Error('Official Node runtime checksum mismatch'); await fs.writeFile(archivePath, bytes); }
    const extracted = path.join(stage, 'node'); await fs.mkdir(extracted);
    if (platform === 'win32') {
      if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:TSP_NODE_ARCHIVE -DestinationPath $env:TSP_NODE_EXTRACT'], undefined, { ...process.env, TSP_NODE_ARCHIVE: archivePath, TSP_NODE_EXTRACT: extracted });
      else run('unzip', ['-q', archivePath, '-d', extracted]);
    } else run('tar', ['-xzf', archivePath, '-C', extracted, `node-v${nodeVersion}-${nodePlatform}-${arch}/bin/node`, `node-v${nodeVersion}-${nodePlatform}-${arch}/LICENSE`]);
    const nodeRoot = path.join(extracted, `node-v${nodeVersion}-${nodePlatform}-${arch}`);
    await fs.copyFile(path.join(nodeRoot, platform === 'win32' ? 'node.exe' : 'bin/node'), path.join(payload, 'runtime', platform === 'win32' ? 'node.exe' : 'node'));
    await fs.copyFile(path.join(nodeRoot, 'LICENSE'), path.join(payload, 'runtime/LICENSE'));
  }
  if (platform !== 'win32') await fs.chmod(path.join(payload, 'runtime/node'), 0o755);
  for (const [command, app] of [['tsp', 'cli'], ['agentd', 'agentd']]) {
    await fs.writeFile(path.join(payload, `${command}.cmd`), `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0apps\\${app}\\dist\\index.js" %*\r\n`);
    await fs.writeFile(path.join(payload, command), `#!/bin/sh\nTSP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$TSP_ROOT/runtime/node" "$TSP_ROOT/apps/${app}/dist/index.js" "$@"\n`, { mode: 0o755 });
  }
  const version = JSON.parse(await fs.readFile(path.join(root, 'apps/cli/package.json'), 'utf8')).version;
  const format = platform === 'win32' ? 'zip' : 'tar.gz';
  const archivePath = path.join(stage, `release.${format}`);
  if (format === 'zip') {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -Path (Join-Path $env:TSP_PAYLOAD "*") -DestinationPath $env:TSP_ARCHIVE -Force'], { env: { ...process.env, TSP_PAYLOAD: payload, TSP_ARCHIVE: archivePath }, encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(`Compress-Archive failed: ${result.stderr}`);
    } else run('zip', ['-qr', archivePath, '.'], payload);
  } else {
    async function* archiveEntries() { yield* tarEntries(payload); yield Buffer.alloc(1024); }
    await pipeline(Readable.from(archiveEntries()), createGzip(), createWriteStream(archivePath));
  }
  const bytes = await fs.readFile(archivePath);
  // Archive timestamps can differ between builds. The URL identifies the exact downloaded bytes.
  const archiveHash = sha256(bytes);
  const release = `${version}-${archiveHash.slice(0, 16)}`;
  const filename = `tsp-${release}-${platform}-${arch}.${format}`;
  await fs.rename(archivePath, path.join(output, filename));
  const artifact = { platform, arch, filename, sha256: archiveHash, size_bytes: bytes.length, format, release, node_version: nodeVersion, runtime_source: runtimeSource };
  let old = { artifacts: [] }; try { old = JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')); } catch { /* first release */ }
  const manifest = { schema_version: 1, version, release, node_version: nodeVersion, artifacts: [...old.artifacts.filter((item) => item.platform !== platform || item.arch !== arch), artifact] };
  const manifestTemp = path.join(stage, 'manifest.json'); await fs.writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`); await fs.rename(manifestTemp, path.join(output, 'manifest.json'));
  for (const script of ['install.ps1', 'install.sh']) await fs.copyFile(path.join(root, 'scripts/cli-install', script), path.join(output, script));
  process.stdout.write(`${JSON.stringify({ output, artifact })}\n`);
} finally {
  // mkdtemp is resolved under our explicit output directory; never clean user paths.
  if (path.dirname(path.resolve(stage)) !== output) throw new Error('Unsafe build stage cleanup');
  await fs.rm(stage, { recursive: true, force: true });
}
