import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTAKE_SKILL_VERSION } from '@team-synergy/contracts';
import { intakeSkillReferences, intakeSkillText } from '../dist/intake-skill.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const canonical = path.join(root, 'skills/spec-production');
const cliRoot = path.join(root, 'apps/cli');
const require = createRequire(import.meta.url);
const read = file => readFileSync(file, 'utf8');

function relocated(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'tsp-skill-portable-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cli = path.join(directory, 'apps/cli');
  mkdirSync(path.join(cli, 'dist'), { recursive: true });
  for (const name of ['intake-skill.js', 'spec-production.json']) copyFileSync(path.join(cliRoot, 'dist', name), path.join(cli, 'dist', name));
  copyFileSync(path.join(cliRoot, 'package.json'), path.join(cli, 'package.json'));
  const contracts = path.join(directory, 'node_modules/@team-synergy/contracts');
  mkdirSync(contracts, { recursive: true });
  cpSync(path.join(root, 'packages/contracts/dist'), path.join(contracts, 'dist'), { recursive: true });
  copyFileSync(path.join(root, 'packages/contracts/package.json'), path.join(contracts, 'package.json'));
  cpSync(path.dirname(require.resolve('zod/package.json')), path.join(directory, 'node_modules/zod'), { recursive: true });
  return { directory, cli, bundlePath: path.join(cli, 'dist/spec-production.json') };
}

test('bundled instructions and references exactly match the canonical skill for both profiles', () => {
  const source = read(path.join(canonical, 'SKILL.md')).trimEnd();
  assert.match(source, new RegExp(`version: ${INTAKE_SKILL_VERSION.replaceAll('.', '\\.')}`));
  assert.equal(intakeSkillText(), `${source}\n\nThis pack uses the pilot profile: report its declared limits; do not call it a full enterprise dossier.\n`);
  assert.equal(intakeSkillText('enterprise'), `${source}\n\nThis pack uses the enterprise profile: resolve capability and dossier blockers before publication.\n`);
  const expected = Object.fromEntries(readdirSync(path.join(canonical, 'references')).map(name => [name, read(path.join(canonical, 'references', name))]));
  assert.deepEqual(intakeSkillReferences(), expected);
  for (const name of ['scope.md', 'increments.md', 'method-sources.md', 'evaluation.schema.json']) assert.ok(expected[name], `Missing workflow resource ${name}`);
});

test('relocated distribution reads its own resources and fails clearly for missing or incompatible bundles', async t => {
  const { cli, bundlePath } = relocated(t);
  const relocatedSkill = await import(pathToFileURL(path.join(cli, 'dist/intake-skill.js')).href);
  assert.equal(relocatedSkill.intakeSkillText('enterprise'), intakeSkillText('enterprise'));
  assert.deepEqual(relocatedSkill.intakeSkillReferences(), intakeSkillReferences());
  const original = JSON.parse(read(bundlePath));
  const invalidVersion = structuredClone(original);
  invalidVersion.text = invalidVersion.text.replace(`version: ${INTAKE_SKILL_VERSION}`, 'version: 99.0.0');
  writeFileSync(bundlePath, JSON.stringify(invalidVersion));
  assert.throws(() => relocatedSkill.intakeSkillText(), /Skill version 99\.0\.0 does not match CLI/);
  const missingReference = structuredClone(original);
  delete missingReference.references['inventory.md'];
  writeFileSync(bundlePath, JSON.stringify(missingReference));
  assert.throws(() => relocatedSkill.intakeSkillReferences(), /Missing reference inventory\.md/);
  rmSync(bundlePath);
  assert.throws(() => relocatedSkill.intakeSkillText(), /Bundled specification skill is unavailable or invalid; rebuild or reinstall the CLI/);
});

test('build replaces removed reference entries and excludes evaluation fixtures', t => {
  const { directory, cli, bundlePath } = relocated(t);
  const source = path.join(directory, 'skills/spec-production');
  cpSync(canonical, source, { recursive: true });
  mkdirSync(path.join(cli, 'scripts'));
  copyFileSync(path.join(cliRoot, 'scripts/bundle-intake-skill.mjs'), path.join(cli, 'scripts/bundle-intake-skill.mjs'));
  const obsolete = path.join(source, 'references/obsolete.md');
  writeFileSync(obsolete, 'Temporary reference\n');
  mkdirSync(path.join(source, 'evals'), { recursive: true });
  writeFileSync(path.join(source, 'evals/private-fixture.txt'), 'This is not a runtime resource.');
  const run = () => spawnSync(process.execPath, [path.join(cli, 'scripts/bundle-intake-skill.mjs')], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(read(bundlePath)).references['obsolete.md'], 'Temporary reference\n');
  rmSync(obsolete);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(read(bundlePath)).references, intakeSkillReferences());
  assert.equal(read(bundlePath).includes('This is not a runtime resource.'), false);
});
