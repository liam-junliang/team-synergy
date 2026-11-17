import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const revision = process.argv[2];
const directory = path.resolve(process.argv[3]);
if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid source revision');
const inspect = name => JSON.parse(execFileSync('docker', ['image', 'inspect', name], { encoding: 'utf8' }))[0];
const images = {};
for (const role of ['api', 'web', 'postgres']) {
  const tag = `tsp-${role}:${revision}`;
  const value = inspect(tag);
  if (!/^sha256:[a-f0-9]{64}$/.test(value.Id)) throw Error('Invalid image ID');
  if (role !== 'postgres' && value.Config.Labels['org.opencontainers.image.revision'] !== revision) throw Error('Image/source mismatch');
  images[role] = { tag, image_id: value.Id, registry_digests: value.RepoDigests ?? [] };
}
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ schema_version: 1, source_revision: revision, archive: 'images.tar.gz', images }, null, 2) + '\n');
