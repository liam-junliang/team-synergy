import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRunSkillContext, renderRunSkillIndex } from '../dist/skill-context.js';
import { skillPackageHash, syncSkillManifest } from '../dist/skill-sync.js';

const runOne = 'A'.repeat(20); const runTwo = 'B'.repeat(20);
function manifest(revision) {
  const bytes = Buffer.from(`---\nname: review\ndescription: Review safely\n---\n# Revision ${revision}`);
  const files = [{ path: 'SKILL.md', content_base64: bytes.toString('base64'), size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  return { project_code: 'project-one', generation: revision, skills: [{ skill_code: 'skill-one', revision, alias: 'review', name: 'review', description: 'Review safely', scope_type: 'team', scope_code: 'team-one', package_sha256: skillPackageHash(files), files }] };
}
function workspace(t) { const root = mkdtempSync(path.join(tmpdir(), 'tsp-run-skill-context-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('Run context downloads frozen revision to isolated directory and exposes only metadata in the index', async t => {
  const root = workspace(t); const requests = [];
  const api = { request: async (method, route) => { requests.push({ method, route }); return { ok: true, data: manifest(route.includes(runOne) ? 1 : 2) }; } };
  const first = await prepareRunSkillContext(api, root, runOne);
  const firstFile = path.join(first.directory, 'review', 'SKILL.md');
  assert.equal(existsSync(firstFile), true); assert.match(readFileSync(firstFile, 'utf8'), /Revision 1/);
  assert.equal(first.manifest.skills[0].revision, 1);
  assert.equal(JSON.stringify(first).includes('content_base64'), false); assert.equal('files' in first.manifest.skills[0], false);
  const index = renderRunSkillIndex(first);
  assert.ok(index.includes(firstFile.replaceAll('\\', '/'))); assert.match(index, /skill-one · r1/); assert.match(index, /Review safely/);
  assert.equal(index.includes('Revision 1'), false, 'Index should not inline the package source');
  syncSkillManifest(root, manifest(3));
  const second = await prepareRunSkillContext(api, root, runTwo);
  assert.match(readFileSync(path.join(second.directory, 'review', 'SKILL.md'), 'utf8'), /Revision 2/);
  assert.match(readFileSync(path.join(root, '.tsp', 'skills', 'review', 'SKILL.md'), 'utf8'), /Revision 3/);
  assert.match(readFileSync(firstFile, 'utf8'), /Revision 1/, 'Ordinary project sync and a new Run cannot overwrite the active Run');
  assert.deepEqual(requests, [{ method: 'GET', route: `/runs/${runOne}/skills` }, { method: 'GET', route: `/runs/${runTwo}/skills` }]);
});

test('revoked delivery and invalid Run code fail before creating local execution state', async t => {
  const root = workspace(t); let requests = 0;
  const api = { request: async () => { requests++; return { ok: false, error: { code: 'skill_delivery_blocked', message: 'Grant revoked' } }; } };
  await assert.rejects(prepareRunSkillContext(api, root, runOne), { code: 'skill_delivery_blocked' });
  assert.equal(existsSync(path.join(root, '.agent')), false);
  await assert.rejects(prepareRunSkillContext(api, root, '../outside'), { code: 'skill_run_invalid' });
  assert.equal(requests, 1);
});
