import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkillDirectory, skillPackageHash, syncSkillManifest, validateSkillFiles, validateSkillPath } from '../dist/skill-sync.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (name, content) => { const bytes = Buffer.from(content); return { path: name, content_base64: bytes.toString('base64'), size_bytes: bytes.length, sha256: hash(bytes) }; };
function packageEntry(alias = 'review', revision = 1, extra = []) {
  const files = [file('SKILL.md', `---\nname: ${alias}\ndescription: Review changes\n---\nRevision ${revision}\n`), ...extra];
  return { skill_code: `skill-${alias}`, revision, alias, name: alias, description: 'Review changes', scope_type: 'team', scope_code: 'team-one', files, package_sha256: skillPackageHash(files) };
}
const manifest = (skills, generation = 1) => ({ project_code: 'project-one', generation, skills });
function directory(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'tsp-skill-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const skillPath = (root, alias = 'review', name = 'SKILL.md') => path.join(root, '.tsp', 'skills', alias, name);

test('directory import preserves every regular resource byte and sync pins revisions without executing scripts', t => {
  const root = directory(t); const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: review\ndescription: Review changes\n---\n# Instructions');
  fs.writeFileSync(path.join(source, 'scripts', 'never-run.js'), 'throw new Error("Never execute on import or sync")');
  fs.writeFileSync(path.join(source, 'binary.bin'), Buffer.from([0, 255, 10, 3]));
  const files = readSkillDirectory(source);
  assert.equal(files.length, 3);
  const item = { ...packageEntry(), files, package_sha256: skillPackageHash(files) };
  const before = syncSkillManifest(root, manifest([item]), { check: true });
  assert.equal(before.changed, true); assert.deepEqual(before.added, ['review']); assert.equal(fs.existsSync(path.join(root, '.tsp')), false);
  const result = syncSkillManifest(root, manifest([item]));
  assert.equal(result.skills_directory, path.join(root, '.tsp', 'skills'));
  assert.deepEqual(fs.readFileSync(skillPath(root, 'review', 'binary.bin')), fs.readFileSync(path.join(source, 'binary.bin')));
  assert.equal(syncSkillManifest(root, manifest([item])).changed, false);
  const lock = JSON.parse(fs.readFileSync(result.lock_path, 'utf8'));
  assert.equal(lock.skills[0].revision, 1); assert.equal(lock.skills[0].package_sha256, item.package_sha256);
  assert.equal(JSON.stringify(lock).includes('content_base64'), false); assert.equal(JSON.stringify(lock).includes('token'), false);
  const update = syncSkillManifest(root, manifest([packageEntry('review', 3)], 2));
  assert.deepEqual(update.updated, ['review']); assert.match(fs.readFileSync(skillPath(root), 'utf8'), /Revision 3/);
  assert.equal(fs.existsSync(skillPath(root, 'review', 'binary.bin')), false);
});

test('local edits, added files, empty directories and unmanaged aliases are preserved', t => {
  for (const change of ['modified', 'added', 'empty-directory', 'deleted']) {
    const root = path.join(directory(t), change); fs.mkdirSync(root); syncSkillManifest(root, manifest([packageEntry()]));
    if (change === 'modified') fs.appendFileSync(skillPath(root), '\nlocal edits');
    if (change === 'added') fs.writeFileSync(skillPath(root, 'review', 'mine.txt'), 'keep me');
    if (change === 'empty-directory') fs.mkdirSync(skillPath(root, 'review', 'mine'));
    if (change === 'deleted') fs.unlinkSync(skillPath(root));
    const lock = fs.readFileSync(path.join(root, '.tsp', 'skills.lock.json'), 'utf8');
    assert.throws(() => syncSkillManifest(root, manifest([], 2)), { code: 'skill_local_modified' }, change);
    assert.equal(fs.readFileSync(path.join(root, '.tsp', 'skills.lock.json'), 'utf8'), lock);
    assert.equal(fs.existsSync(path.join(root, '.tsp', 'skills.sync.lock')), false);
  }
  const root = directory(t); fs.mkdirSync(skillPath(root), { recursive: true });
  assert.throws(() => syncSkillManifest(root, manifest([packageEntry()])), { code: 'skill_unmanaged_collision' });
  assert.equal(fs.statSync(skillPath(root)).isDirectory(), true);
});

test('empty desired manifest removes only unchanged owned packages and preserves unrelated content', t => {
  const root = directory(t); syncSkillManifest(root, manifest([packageEntry()]));
  const note = path.join(root, '.tsp', 'skills', 'unmanaged.txt'); fs.writeFileSync(note, 'private local notes');
  const result = syncSkillManifest(root, manifest([], 2));
  assert.deepEqual(result.removed, ['review']); assert.equal(fs.existsSync(skillPath(root)), false); assert.equal(fs.readFileSync(note, 'utf8'), 'private local notes');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.lock_path, 'utf8')).skills, []);
});

test('a lock-only clone bootstraps the absent managed root even when the desired manifest is unchanged', t => {
  const original = directory(t); const desired = manifest([packageEntry('review', 3, [file('data/bytes.bin', Buffer.from([0, 255, 3]))])], 7);
  const source = syncSkillManifest(original, desired);
  const clone = directory(t); fs.mkdirSync(path.join(clone, '.tsp'));
  const lock = fs.readFileSync(source.lock_path); const copiedLock = path.join(clone, '.tsp', 'skills.lock.json'); fs.writeFileSync(copiedLock, lock);
  const planned = syncSkillManifest(clone, desired, { check: true });
  assert.equal(planned.changed, true); assert.deepEqual(planned.added, ['review']); assert.deepEqual(planned.updated, []);
  assert.equal(fs.existsSync(path.join(clone, '.tsp', 'skills')), false); assert.deepEqual(fs.readFileSync(copiedLock), lock);
  const applied = syncSkillManifest(clone, desired);
  assert.equal(applied.changed, true); assert.match(fs.readFileSync(skillPath(clone), 'utf8'), /Revision 3/);
  assert.deepEqual(fs.readFileSync(skillPath(clone, 'review', 'data/bytes.bin')), Buffer.from([0, 255, 3]));
  assert.deepEqual(fs.readFileSync(copiedLock), lock); assert.equal(syncSkillManifest(clone, desired).changed, false);
});

test('lock-only bootstrap uses current authorized manifest while partial missing trees remain protected', t => {
  const original = directory(t); const originalManifest = manifest([packageEntry('review'), packageEntry('retired')]);
  const source = syncSkillManifest(original, originalManifest); const oldLock = fs.readFileSync(source.lock_path);
  const clone = directory(t); fs.mkdirSync(path.join(clone, '.tsp')); fs.writeFileSync(path.join(clone, '.tsp', 'skills.lock.json'), oldLock);
  const restored = syncSkillManifest(clone, manifest([packageEntry('review', 2)], 2));
  assert.deepEqual(restored.added, ['review']); assert.deepEqual(restored.removed, ['retired']);
  assert.match(fs.readFileSync(skillPath(clone), 'utf8'), /Revision 2/); assert.equal(fs.existsSync(skillPath(clone, 'retired')), false);
  const emptyClone = directory(t); fs.mkdirSync(path.join(emptyClone, '.tsp'));
  fs.writeFileSync(path.join(emptyClone, '.tsp', 'skills.lock.json'), oldLock);
  const emptied = syncSkillManifest(emptyClone, manifest([], 2));
  assert.deepEqual(emptied.removed.sort(), ['retired', 'review']); assert.deepEqual(JSON.parse(fs.readFileSync(emptied.lock_path, 'utf8')).skills, []);
  assert.deepEqual(fs.readdirSync(emptied.skills_directory), []);
  const partial = directory(t); fs.mkdirSync(path.join(partial, '.tsp', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(partial, '.tsp', 'skills.lock.json'), oldLock);
  fs.mkdirSync(path.dirname(skillPath(partial)));
  const survivingPackage = fs.readFileSync(skillPath(original)); fs.writeFileSync(skillPath(partial), survivingPackage);
  fs.writeFileSync(path.join(partial, '.tsp', 'skills', 'mine.txt'), 'keep my data');
  assert.throws(() => syncSkillManifest(partial, originalManifest), { code: 'skill_local_modified' });
  assert.deepEqual(fs.readFileSync(skillPath(partial)), survivingPackage);
  assert.equal(fs.readFileSync(path.join(partial, '.tsp', 'skills', 'mine.txt'), 'utf8'), 'keep my data');
  assert.deepEqual(fs.readFileSync(path.join(partial, '.tsp', 'skills.lock.json')), oldLock);
});

test('lock-only bootstrap still validates ownership and hashes and restores absence after transaction failure', t => {
  const original = directory(t); const desired = manifest([packageEntry()]); const source = syncSkillManifest(original, desired);
  const clone = directory(t); fs.mkdirSync(path.join(clone, '.tsp'));
  const lockPath = path.join(clone, '.tsp', 'skills.lock.json'); const lock = fs.readFileSync(source.lock_path, 'utf8');
  const tampered = JSON.parse(lock); tampered.skills[0].package_sha256 = '0'.repeat(64); fs.writeFileSync(lockPath, JSON.stringify(tampered));
  assert.throws(() => syncSkillManifest(clone, desired), { code: 'skill_lock_invalid' });
  fs.writeFileSync(lockPath, lock);
  assert.throws(() => syncSkillManifest(clone, { ...desired, project_code: 'other-project' }), { code: 'skill_lock_invalid' });
  assert.equal(fs.existsSync(path.join(clone, '.tsp', 'skills')), false);
  const rename = fs.renameSync; let failed = false;
  fs.renameSync = (from, to) => { if (!failed && path.basename(from) === 'lock.json') { failed = true; throw new Error('bootstrap commit failed'); } return rename(from, to); };
  syncBuiltinESMExports();
  try { assert.throws(() => syncSkillManifest(clone, desired), /bootstrap commit failed/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(path.join(clone, '.tsp', 'skills')), false); assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
  assert.deepEqual(fs.readdirSync(path.join(clone, '.tsp')), ['skills.lock.json']);
  assert.equal(syncSkillManifest(clone, desired).changed, true); assert.match(fs.readFileSync(skillPath(clone), 'utf8'), /Revision 1/);
});

test('all packages are validated before writes: tampered file/size/package hash and conflicting paths', t => {
  const root = directory(t); const original = manifest([packageEntry()]); syncSkillManifest(root, original);
  const before = fs.readFileSync(skillPath(root), 'utf8');
  for (const mutate of [
    item => { item.files[0].sha256 = '0'.repeat(64); },
    item => { item.files[0].size_bytes += 1; },
    item => { item.package_sha256 = '0'.repeat(64); },
    item => { item.files.push(file('SKILL.md/child', 'conflict')); item.package_sha256 = skillPackageHash(item.files); },
    item => { item.files.push(file('Docs/one', 'a'), file('docs/two', 'b')); item.package_sha256 = skillPackageHash(item.files); },
    item => { item.alias = '../outside'; },
  ]) {
    const bad = packageEntry('second'); mutate(bad);
    assert.throws(() => syncSkillManifest(root, manifest([packageEntry('review', 2), bad], 2)));
    assert.equal(fs.readFileSync(skillPath(root), 'utf8'), before);
    assert.equal(fs.existsSync(skillPath(root, 'second')), false);
  }
  assert.throws(() => validateSkillFiles([{ path: 'SKILL.md', content_base64: 'Zh==' }]), { code: 'skill_hash_mismatch' });
});

test('portable paths reject traversal, device names, ADS, UNC, controls and ambiguous names', () => {
  for (const name of ['../outside', '/etc/passwd', 'C:/file', '\\\\host\\share', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a:stream', 'nul.txt', 'COM1/file', 'LPT¹.txt', 'a. ', 'a\x00b', '.git/config', 'e\u0301.md']) {
    assert.throws(() => validateSkillPath(name), { code: 'skill_path_invalid' }, name);
  }
  assert.equal(validateSkillPath('references/说明.md'), 'references/说明.md');
});

test('import and destination reject symlinks/junctions including ancestor paths without touching external files', t => {
  const root = directory(t); const external = path.join(root, 'external'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'untouched'), 'safe');
  const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'SKILL.md'), 'test');
  const link = path.join(source, 'references');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readSkillDirectory(source), { code: 'skill_symlink_forbidden' });
  assert.throws(() => readSkillDirectory(link), { code: 'skill_symlink_forbidden' });
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace); fs.symlinkSync(external, path.join(workspace, '.tsp'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => syncSkillManifest(workspace, manifest([packageEntry()])), { code: 'skill_symlink_forbidden' });
  const clean = path.join(root, 'clean'); fs.mkdirSync(clean); syncSkillManifest(clean, manifest([packageEntry()]));
  fs.symlinkSync(external, skillPath(clean, 'review', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => syncSkillManifest(clean, manifest([], 2)), { code: 'skill_symlink_forbidden' });
  assert.equal(fs.readFileSync(path.join(external, 'untouched'), 'utf8'), 'safe');
});

test('sync rejects concurrent operation and mismatched project lock without stealing lock', t => {
  const root = directory(t); syncSkillManifest(root, manifest([packageEntry()]));
  const mutex = path.join(root, '.tsp', 'skills.sync.lock'); fs.writeFileSync(mutex, 'other process');
  for (const check of [true, false]) assert.throws(() => syncSkillManifest(root, manifest([], 2), { check }), { code: 'skill_sync_locked' });
  assert.equal(fs.readFileSync(mutex, 'utf8'), 'other process'); fs.unlinkSync(mutex);
  assert.throws(() => syncSkillManifest(root, { ...manifest([], 2), project_code: 'other-project' }), { code: 'skill_lock_invalid' });
  assert.equal(fs.existsSync(skillPath(root)), true);
});

test('failed transaction rolls back replaced package and lock; success leaves no staging debris', t => {
  const root = directory(t); syncSkillManifest(root, manifest([packageEntry()]));
  const previous = fs.readFileSync(skillPath(root), 'utf8');
  const lockPath = path.join(root, '.tsp', 'skills.lock.json'); const previousLock = fs.readFileSync(lockPath, 'utf8');
  const rename = fs.renameSync; let failed = false;
  fs.renameSync = (from, to) => { if (!failed && path.basename(from) === 'lock.json') { failed = true; throw Object.assign(new Error('simulated replacement failure'), { code: 'EACCES' }); } return rename(from, to); };
  syncBuiltinESMExports();
  try { assert.throws(() => syncSkillManifest(root, manifest([packageEntry('review', 2)], 2)), /simulated replacement failure/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(skillPath(root), 'utf8'), previous); assert.equal(fs.readFileSync(lockPath, 'utf8'), previousLock);
  assert.deepEqual(fs.readdirSync(path.join(root, '.tsp')).sort(), ['skills', 'skills.lock.json']);
});
