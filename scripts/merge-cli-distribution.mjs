import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node scripts/merge-cli-distribution.mjs <artifact-directories> <output>');
const output = path.resolve(destination); await fs.mkdir(output, { recursive: true });
let manifest; const artifacts = []; const targets = new Set();
for (const entry of await fs.readdir(input, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = path.join(input, entry.name);
  const next = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (next.schema_version !== 1 || !/^\d+\.\d+\.\d+$/.test(next.version) || !/^22\.\d+\.\d+$/.test(next.node_version)
    || !Array.isArray(next.artifacts) || (manifest && (manifest.version !== next.version || manifest.node_version !== next.node_version))) throw new Error('Release version mismatch');
  manifest ??= next;
  for (const artifact of next.artifacts) {
    const format = artifact.platform === 'win32' ? 'zip' : 'tar.gz';
    if (!['win32', 'linux', 'darwin'].includes(artifact.platform) || !['x64', 'arm64'].includes(artifact.arch)
      || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(artifact.release) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || artifact.format !== format || artifact.node_version !== next.node_version
      || artifact.filename !== `tsp-${artifact.release}-${artifact.platform}-${artifact.arch}.${format}`) throw new Error('Invalid artifact metadata');
    const target = `${artifact.platform}-${artifact.arch}`; if (targets.has(target)) throw new Error(`Duplicate target: ${target}`); targets.add(target);
    const bytes = await fs.readFile(path.join(directory, artifact.filename));
    if (bytes.length !== artifact.size_bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error(`Corrupt artifact: ${artifact.filename}`);
    await fs.writeFile(path.join(output, artifact.filename), bytes); artifacts.push(artifact);
  }
  for (const name of ['install.ps1', 'install.sh']) {
    const bytes = await fs.readFile(path.join(directory, name));
    try { if (!(await fs.readFile(path.join(output, name))).equals(bytes)) throw new Error('Installer version mismatch'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.writeFile(path.join(output, name), bytes);
  }
}
if (!manifest || artifacts.length === 0) throw new Error('No release artifacts');
await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify({ ...manifest, artifacts }, null, 2)}\n`);
process.stdout.write(`Published ${artifacts.length} CLI targets in ${output}\n`);
