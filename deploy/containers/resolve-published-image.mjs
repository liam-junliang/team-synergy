import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const indexTypes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const docker = args => execFileSync('docker', args, { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });

export function resolvePublishedImage({ manifest, revision, repository, role }, runDocker = docker) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  assert.ok(['api', 'web', 'postgres'].includes(role), 'Invalid published image role');
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.source_revision, revision, 'Release source revision mismatch');
  const expected = manifest.images[role];
  assert.equal(expected.tag, `tsp-${role}:${revision}`);
  assert.match(expected.image_id, digestPattern);
  const source = JSON.parse(runDocker(['image', 'inspect', expected.image_id]))[0];
  assert.equal(source.Id, expected.image_id, 'Loaded source image mismatch');
  assert.equal(source.Os, 'linux');
  assert.equal(source.Architecture, 'amd64');
  assert.ok(source.Config && source.RootFS?.Type === 'layers' && Array.isArray(source.RootFS.Layers), 'Missing source image content');
  if (role !== 'postgres') {
    assert.equal(source.Config.Labels?.['org.opencontainers.image.revision'], revision, 'Image/source revision mismatch');
    assert.equal(source.Config.Labels?.['org.opencontainers.image.source'], `https://github.com/${repository.toLowerCase()}`, 'Image/source repository mismatch');
  }

  const namespace = `ghcr.io/${repository.toLowerCase()}-${role}`;
  // Remote raw bytes preserve the digest; local RepoDigests can retain an index
  // that Docker replaced with its available single-platform manifest on push.
  const raw = runDocker(['buildx', 'imagetools', 'inspect', '--raw', `${namespace}:${revision}`]);
  const remote = JSON.parse(raw);
  assert.equal(remote.schemaVersion, 2);
  if (indexTypes.has(remote.mediaType)) {
    assert.ok(Array.isArray(remote.manifests));
    const variants = remote.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === 'amd64');
    assert.equal(variants.length, 1, 'Expected one published linux/amd64 variant');
    assert.match(variants[0].digest, digestPattern);
    assert.ok(manifestTypes.has(variants[0].mediaType), 'Unsupported platform manifest');
  } else {
    assert.ok(manifestTypes.has(remote.mediaType), 'Unsupported published manifest');
    assert.match(remote.config?.digest, digestPattern);
    assert.ok(Array.isArray(remote.layers), 'Missing published layers');
  }
  const digest = 'sha256:' + createHash('sha256').update(raw).digest('hex');
  const ref = `${namespace}@${digest}`;
  runDocker(['pull', '--platform', 'linux/amd64', ref]);
  const published = JSON.parse(runDocker(['image', 'inspect', ref]))[0];
  assert.ok(published.RepoDigests?.includes(ref), 'Registry digest was not loaded');
  assert.equal(published.Os, source.Os, 'Published OS mismatch');
  assert.equal(published.Architecture, source.Architecture, 'Published architecture mismatch');
  // Docker's containerd store can identify an index and its selected manifest
  // differently. Compare the actual filesystem and full runtime configuration.
  assert.deepEqual(published.RootFS, source.RootFS, 'Published filesystem differs from the verified build');
  assert.deepEqual(published.Config, source.Config, 'Published configuration differs from the verified build');
  return ref;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, revision, repository, role] = process.argv.slice(2);
  const ref = resolvePublishedImage({ manifest: JSON.parse(readFileSync(file, 'utf8')), revision, repository, role });
  process.stdout.write(ref + '\n');
}
