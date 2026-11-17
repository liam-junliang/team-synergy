import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const revision = process.argv[3];
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.source_revision, revision);
for (const role of ['api', 'web', 'postgres']) {
  const expected = manifest.images[role].image_id;
  assert.match(expected, /^sha256:[a-f0-9]{64}$/);
  const actual = JSON.parse(execFileSync('docker', ['image', 'inspect', expected], { encoding: 'utf8' }))[0];
  assert.equal(actual.Id, expected);
  if (role !== 'postgres') assert.equal(actual.Config.Labels['org.opencontainers.image.revision'], revision);
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `TSP_${role.toUpperCase()}_IMAGE=${expected}\n`);
}
process.stdout.write('Loaded image IDs and API/Web source revisions verified.\n');
