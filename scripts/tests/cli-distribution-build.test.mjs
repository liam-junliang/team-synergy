import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsp-release-merge-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'parts'); const output = path.join(directory, 'published'); await mkdir(input);
  async function part(name, platform, content = platform) {
    const partDirectory = path.join(input, name); await mkdir(partDirectory);
    const bytes = Buffer.from(content); const hash = createHash('sha256').update(bytes).digest('hex'); const release = `0.1.0-${hash.slice(0, 16)}`;
    const filename = `tsp-${release}-${platform}-x64.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const manifest = { schema_version: 1, version: '0.1.0', node_version: '22.23.3', release, artifacts: [{ platform, arch: 'x64', filename, release, sha256: hash, size_bytes: bytes.length, format: platform === 'win32' ? 'zip' : 'tar.gz', node_version: '22.23.3' }] };
    await writeFile(path.join(partDirectory, filename), bytes); await writeFile(path.join(partDirectory, 'manifest.json'), JSON.stringify(manifest));
    for (const installer of ['install.ps1', 'install.sh']) await writeFile(path.join(partDirectory, installer), 'same installer');
    return { directory: partDirectory, manifest };
  }
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/merge-cli-distribution.mjs'), input, output], { encoding: 'utf8' });
  return { input, output, part, run };
}
test('release assembly merges only verified target archives', async (t) => {
  const { output, part, run } = await fixture(t); await part('linux', 'linux'); await part('windows', 'win32');
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')); assert.equal(published.artifacts.length, 2);
  for (const artifact of published.artifacts) assert.equal((await readFile(path.join(output, artifact.filename))).length, artifact.size_bytes);
});
test('release assembly rejects checksum mismatches', async (t) => {
  const { part, run } = await fixture(t); const item = await part('linux', 'linux');
  await writeFile(path.join(item.directory, item.manifest.artifacts[0].filename), 'modified');
  const result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Corrupt artifact/);
});
test('release assembly rejects duplicate targets and different installer versions', async (t) => {
  const { part, run } = await fixture(t); const first = await part('first', 'linux'); const second = await part('second', 'linux');
  assert.match(run().stderr, /Duplicate target/);
  const artifact = second.manifest.artifacts[0]; const previousName = artifact.filename;
  artifact.platform = 'darwin'; artifact.filename = artifact.filename.replace('-linux-', '-darwin-');
  await writeFile(path.join(second.directory, artifact.filename), await readFile(path.join(second.directory, previousName)));
  await writeFile(path.join(second.directory, 'manifest.json'), JSON.stringify(second.manifest));
  await writeFile(path.join(second.directory, 'install.sh'), 'different installer'); assert.match(run().stderr, /Installer version mismatch/);
  assert.ok(first.directory);
});
