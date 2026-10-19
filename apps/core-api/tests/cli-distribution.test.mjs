import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { registerCliDistributionRoutes, isCliDistributionPath } from '../dist/routes/cli-distribution.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsp-distribution-'));
  const bytes = Buffer.from('test archive');
  const artifact = { platform: 'win32', arch: 'x64', filename: 'tsp-0.1.0-123456789abcdef0-win32-x64.zip', sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, format: 'zip', release: '0.1.0-123456789abcdef0', node_version: '22.21.1', internal_secret: 'never public' };
  const manifest = { schema_version: 1, version: '0.1.0', release: artifact.release, node_version: artifact.node_version, artifacts: [artifact], api_password: 'never public' };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, artifact.filename), bytes);
  await writeFile(path.join(directory, 'install.ps1'), '# install script');
  await writeFile(path.join(directory, 'install.sh'), '#!/bin/sh');
  const app = Fastify(); registerCliDistributionRoutes(app, { directory });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, app, artifact, manifest, bytes };
}

test('only the precise distribution routes are public', () => {
  for (const value of ['/cli/manifest.json', '/cli/install.ps1', '/cli/install.sh', '/cli/releases/tsp-0.1.0-123456789abcdef0-win32-x64.zip']) assert.equal(isCliDistributionPath(value), true, value);
  for (const value of ['/cli', '/cli/config.json', '/cli/../.env', '/cli/releases/manifest.json', '/cli/releases/%2e%2e', '/cli/install.ps1/more', '/cli/manifest.json?x=1']) assert.equal(isCliDistributionPath(value), false, value);
});
test('public manifest projects approved fields and shell TSV uses the same artifacts', async (t) => {
  const { app, artifact } = await fixture(t);
  const result = await app.inject('/cli/manifest.json'); assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.body.includes('never public'), false);
  assert.equal(result.json().artifacts[0].filename, artifact.filename);
  const text = await app.inject('/cli/manifest.json?format=tsv'); assert.equal(text.statusCode, 200);
  assert.equal(text.body, `win32\tx64\t${artifact.filename}\t${artifact.sha256}\t${artifact.size_bytes}\t${artifact.release}\n`);
});
test('release downloads are restricted to published manifest files', async (t) => {
  const { app, bytes, artifact, directory } = await fixture(t);
  const result = await app.inject(`/cli/releases/${artifact.filename}`); assert.equal(result.statusCode, 200); assert.deepEqual(result.rawPayload, bytes);
  assert.match(result.headers['content-disposition'], /^attachment;/);
  await writeFile(path.join(directory, '.env'), 'PRIVATE=secret');
  for (const url of ['/cli/releases/.env', '/cli/releases/%2E%2E%2F.env', '/cli/releases/tsp-0.1.0-ffffffffffffffff-win32-x64.zip']) assert.notEqual((await app.inject(url)).statusCode, 200);
  assert.equal((await app.inject('/cli/install.ps1')).body, '# install script');
});

test('install pages never advertise missing or incomplete artifacts from a stale manifest', async (t) => {
  const { app, directory, artifact } = await fixture(t);
  await rm(path.join(directory, artifact.filename));
  assert.deepEqual((await app.inject('/cli/manifest.json')).json().artifacts, []);
  assert.equal((await app.inject('/cli/manifest.json?format=tsv')).body.trim(), '');
  await writeFile(path.join(directory, artifact.filename), 'incomplete');
  assert.deepEqual((await app.inject('/cli/manifest.json')).json().artifacts, []);
});
test('missing, duplicate and malformed releases fail closed', async (t) => {
  const { app, directory, manifest } = await fixture(t);
  manifest.artifacts.push(manifest.artifacts[0]); await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await app.inject('/cli/manifest.json')).statusCode, 503);
  await rm(path.join(directory, 'manifest.json'));
  assert.equal((await app.inject('/cli/manifest.json')).json().error.code, 'cli_distribution_unavailable');
});
test('release symlinks cannot expose files outside the distribution directory', async (t) => {
  const { app, directory, artifact } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'tsp-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret'), 'test archive'); await rm(path.join(directory, artifact.filename));
  try { await symlink(path.join(outside, 'secret'), path.join(directory, artifact.filename)); } catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit creating a test symlink'); return; } throw error; }
  assert.equal((await app.inject(`/cli/releases/${artifact.filename}`)).statusCode, 404);
  assert.equal(await readFile(path.join(outside, 'secret'), 'utf8'), 'test archive');
});
