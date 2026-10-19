import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const releaseName = /^tsp-[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{16}-(?:win32|linux|darwin)-(?:x64|arm64)\.(?:zip|tar\.gz)$/;
type Artifact = { platform: string; arch: string; filename: string; sha256: string; size_bytes: number; format: string; release: string; node_version: string };
type Manifest = { schema_version: 1; version: string; release: string; node_version: string; artifacts: Artifact[] };

/** Exact public download paths only. Never expose a generic static directory. */
export function isCliDistributionPath(urlPath: string): boolean {
  return /^\/cli\/(?:manifest\.json|install\.(?:ps1|sh))$/.test(urlPath)
    || (urlPath.startsWith('/cli/releases/') && releaseName.test(urlPath.slice('/cli/releases/'.length)));
}

async function readManifest(directory: string): Promise<Manifest> {
  const input = JSON.parse(await readFile(await safeFile(directory, 'manifest.json'), 'utf8')) as Manifest;
  if (input.schema_version !== 1 || !/^\d+\.\d+\.\d+$/.test(input.version) || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(input.release)
    || !/^22\.\d+\.\d+$/.test(input.node_version) || !Array.isArray(input.artifacts)) throw new Error('Invalid CLI distribution manifest');
  const artifacts: Artifact[] = []; const targets = new Set<string>();
  for (const artifact of input.artifacts) {
    const target = `${artifact.platform}-${artifact.arch}`;
    if (!['win32', 'linux', 'darwin'].includes(artifact.platform) || !['x64', 'arm64'].includes(artifact.arch)
      || !releaseName.test(artifact.filename) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 1 || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(artifact.release)
      || !/^22\.\d+\.\d+$/.test(artifact.node_version) || !['zip', 'tar.gz'].includes(artifact.format) || targets.has(target)
      || artifact.format !== (artifact.platform === 'win32' ? 'zip' : 'tar.gz') || artifact.filename !== `tsp-${artifact.release}-${target}.${artifact.format}`) throw new Error('Invalid CLI release artifact');
    targets.add(target);
    // Deliberately project public fields; runtime configuration and arbitrary JSON never leak.
    artifacts.push({ platform: artifact.platform, arch: artifact.arch, filename: artifact.filename, sha256: artifact.sha256, size_bytes: artifact.size_bytes, format: artifact.format, release: artifact.release, node_version: artifact.node_version });
  }
  return { schema_version: 1, version: input.version, release: String(input.release), node_version: String(input.node_version), artifacts };
}

async function safeFile(directory: string, filename: string) {
  const resolvedDirectory = await realpath(directory);
  const file = await realpath(path.join(resolvedDirectory, filename));
  if (path.dirname(file) !== resolvedDirectory || !(await stat(file)).isFile()) throw new Error('Invalid distribution file');
  return file;
}

export function registerCliDistributionRoutes(app: FastifyInstance, options: { directory?: string } = {}) {
  const directory = options.directory ?? process.env.ACP_CLI_DIST_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../output/cli-distribution');
  app.get<{ Querystring: { format?: string } }>('/cli/manifest.json', async (request, reply) => {
    try {
      const manifest = await readManifest(directory);
      // A stale manifest must not advertise packages that were not deployed.
      const available = await Promise.all(manifest.artifacts.map(async artifact => {
        try { return (await stat(await safeFile(directory, artifact.filename))).size === artifact.size_bytes ? artifact : null; }
        catch { return null; }
      }));
      manifest.artifacts = available.filter((artifact): artifact is Artifact => artifact !== null);
      reply.header('Cache-Control', 'no-store');
      if (request.query.format === 'tsv') return reply.type('text/plain; charset=utf-8').send(manifest.artifacts.map((item) => [item.platform, item.arch, item.filename, item.sha256, item.size_bytes, item.release].join('\t')).join('\n') + '\n');
      return manifest;
    } catch { return reply.code(503).send({ error: { code: 'cli_distribution_unavailable', message: 'CLI releases have not been published by this platform.' } }); }
  });
  for (const script of ['install.ps1', 'install.sh']) app.get(`/cli/${script}`, async (_request, reply) => {
    try { return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type('text/plain; charset=utf-8').send(await readFile(await safeFile(directory, script), 'utf8')); }
    catch { return reply.code(503).send({ error: { code: 'cli_distribution_unavailable', message: 'CLI installation scripts have not been published.' } }); }
  });
  app.get<{ Params: { file: string } }>('/cli/releases/:file', async (request, reply) => {
    try {
      if (!releaseName.test(request.params.file)) return reply.code(404).send({ error: { code: 'not_found' } });
      const manifest = await readManifest(directory); const artifact = manifest.artifacts.find((item) => item.filename === request.params.file);
      if (!artifact) return reply.code(404).send({ error: { code: 'not_found' } });
      const file = await safeFile(directory, artifact.filename);
      if ((await stat(file)).size !== artifact.size_bytes) throw new Error('Incomplete CLI artifact');
      return reply.header('Cache-Control', 'public, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${artifact.filename}"`).type('application/octet-stream').send(createReadStream(file));
    } catch { return reply.code(404).send({ error: { code: 'cli_release_unavailable', message: 'Requested CLI release is not available.' } }); }
  });
}
