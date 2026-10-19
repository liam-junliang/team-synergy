import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import type { ProjectSkillManifest, SkillFile, SkillFileInput } from '@team-synergy/contracts';

const MAX_FILES = 200;
const MAX_BYTES = 6 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
type FileDigest = Pick<SkillFile, 'path' | 'sha256' | 'size_bytes'>;
interface LockedSkill { skill_code: string; revision: number; alias: string; package_sha256: string; files: FileDigest[] }
interface SkillLock { format: 1; project_code: string; generation: number; skills: LockedSkill[] }
export interface SkillSyncResult { project_code: string; generation: number; check: boolean; changed: boolean; added: string[]; updated: string[]; removed: string[]; directory: string; skills_directory: string; lock_path: string }

function fail(code: string, message: string): never { throw new DomainError(code, message); }
function stat(file: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function sorted<T extends { path: string }>(files: T[]): T[] { return [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
export function skillPackageHash(files: FileDigest[]): string {
  return digest(Buffer.from(JSON.stringify(sorted(files).map(file => [file.path, file.sha256, file.size_bytes]))));
}

/** Portable paths: reject Windows aliases even when running on Unix. */
export function validateSkillPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.normalize('NFC')
    || /[\\<>:"|?*]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || value.startsWith('/')) fail('skill_path_invalid', '技能文件路径必须是可移植的包内相对路径');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.length > 255 || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) fail('skill_path_invalid', `不安全的技能路径：${value}`);
  }
  return value;
}
function validateAlias(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('skill_alias_invalid', '技能别名必须使用小写字母、数字和连字符，最多 64 字符');
  validateSkillPath(value);
  return value;
}
function validatePaths(files: FileDigest[]): void {
  if (!files.length || files.length > MAX_FILES) fail('skill_package_invalid', `技能包必须包含 1–${MAX_FILES} 个文件`);
  const paths = new Map<string, string>();
  const segments = new Map<string, string>();
  let total = 0;
  for (const file of files) {
    const value = validateSkillPath(file.path);
    const key = value.toLowerCase();
    const components = value.split('/');
    for (let length = 1; length <= components.length; length++) {
      const prefix = components.slice(0, length).join('/');
      const folded = prefix.toLowerCase();
      if (segments.has(folded) && segments.get(folded) !== prefix) fail('skill_path_conflict', `技能目录大小写冲突：${value}`);
      segments.set(folded, prefix);
    }
    if (paths.has(key)) fail('skill_path_conflict', `技能路径重名：${value}`);
    paths.set(key, value);
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || !SHA256.test(file.sha256)) fail('skill_package_invalid', '技能文件摘要或大小无效');
    total += file.size_bytes;
    if (total > MAX_BYTES) fail('skill_package_invalid', '技能包总大小不能超过 6 MiB');
  }
  for (const key of paths.keys()) {
    const parts = key.split('/');
    while (parts.length > 1) { parts.pop(); if (paths.has(parts.join('/'))) fail('skill_path_conflict', '技能文件与目录路径冲突'); }
  }
  if (!files.some(file => file.path === 'SKILL.md')) fail('skill_package_invalid', '技能包必须包含根目录 SKILL.md');
}

/** lstat every ancestor: realpath alone would silently accept junctions and symlinks. */
export function assertSkillPathAncestors(file: string): void {
  const absolute = path.resolve(file);
  const { root } = path.parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = stat(current);
    if (info?.isSymbolicLink()) fail('skill_symlink_forbidden', `技能路径不能经过符号链接或目录联接：${current}`);
    if (info && current !== absolute && !info.isDirectory()) fail('skill_path_invalid', `路径祖先不是目录：${current}`);
  }
}
function walk(root: string, directories?: string[]): string[] {
  assertSkillPathAncestors(root);
  if (!stat(root)?.isDirectory()) fail('skill_directory_invalid', `技能目录不存在或不是普通目录：${root}`);
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const relative = validateSkillPath(prefix ? `${prefix}/${name}` : name);
      const key = relative.toLowerCase();
      if (seen.has(key)) fail('skill_path_conflict', `技能路径大小写冲突：${relative}`);
      seen.add(key);
      const absolute = path.join(directory, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) fail('skill_symlink_forbidden', `技能包不能包含符号链接或目录联接：${relative}`);
      if (info.isDirectory()) { directories?.push(relative); visit(absolute, relative); }
      else if (info.isFile()) { files.push(relative); if (files.length > MAX_FILES) fail('skill_package_invalid', '技能包文件数量过多'); }
      else fail('skill_file_invalid', `技能包只允许普通文件：${relative}`);
    }
  };
  visit(root, '');
  return files;
}

export function validateSkillFiles(input: SkillFileInput[]): SkillFile[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_FILES) fail('skill_package_invalid', '技能包文件清单无效');
  let total = 0;
  const files = input.map(file => {
    if (!file || typeof file.content_base64 !== 'string' || file.content_base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !BASE64.test(file.content_base64)) fail('skill_package_invalid', '技能文件不是有效 Base64');
    const bytes = Buffer.from(file.content_base64, 'base64');
    total += bytes.length;
    if (total > MAX_BYTES) fail('skill_package_invalid', '技能包总大小不能超过 6 MiB');
    const sha256 = digest(bytes);
    if (bytes.toString('base64') !== file.content_base64 || file.size_bytes !== undefined && file.size_bytes !== bytes.length || file.sha256 !== undefined && file.sha256 !== sha256) fail('skill_hash_mismatch', `技能文件校验失败：${file.path}`);
    return { path: file.path, content_base64: file.content_base64, size_bytes: bytes.length, sha256 };
  });
  validatePaths(files);
  return sorted(files);
}

export function readSkillDirectory(directory: string): SkillFileInput[] {
  const root = path.resolve(directory);
  let total = 0;
  const files = walk(root).map(relative => {
    const absolute = path.join(root, ...relative.split('/'));
    const info = lstatSync(absolute);
    total += info.size;
    if (total > MAX_BYTES) fail('skill_package_invalid', '技能包总大小不能超过 6 MiB');
    const bytes = readFileSync(absolute);
    return { path: relative, content_base64: bytes.toString('base64'), size_bytes: bytes.length, sha256: digest(bytes) };
  });
  validatePaths(files);
  return sorted(files);
}

function validateManifest(manifest: ProjectSkillManifest): SkillLock {
  if (!manifest || typeof manifest.project_code !== 'string' || !manifest.project_code.trim()
    || !Number.isSafeInteger(manifest.generation) || manifest.generation < 0 || !Array.isArray(manifest.skills) || manifest.skills.length > 256) fail('skill_manifest_invalid', '服务端技能清单无效');
  const aliases = new Set<string>();
  const skills = new Set<string>();
  return {
    format: 1, project_code: manifest.project_code, generation: manifest.generation,
    skills: manifest.skills.map(item => {
      const alias = validateAlias(item.alias);
      if (aliases.has(alias) || skills.has(item.skill_code)) fail('skill_manifest_invalid', '技能清单包含重复别名或编码');
      aliases.add(alias); skills.add(item.skill_code);
      if (typeof item.skill_code !== 'string' || !item.skill_code || !Number.isSafeInteger(item.revision) || item.revision < 1 || !Array.isArray(item.files) || item.files.length > MAX_FILES) fail('skill_manifest_invalid', '技能清单的版本或文件无效');
      let total = 0;
      const files = item.files.map(file => {
        if (!file || typeof file.content_base64 !== 'string' || file.content_base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !BASE64.test(file.content_base64)) fail('skill_package_invalid', '技能文件不是有效 Base64');
        const bytes = Buffer.from(file.content_base64, 'base64');
        total += bytes.length;
        if (total > MAX_BYTES) fail('skill_package_invalid', '技能包总大小不能超过 6 MiB');
        if (bytes.toString('base64') !== file.content_base64 || bytes.length !== file.size_bytes || digest(bytes) !== file.sha256) fail('skill_hash_mismatch', `技能文件校验失败：${file.path}`);
        return { path: file.path, sha256: file.sha256, size_bytes: file.size_bytes };
      });
      validatePaths(files);
      if (skillPackageHash(files) !== item.package_sha256) fail('skill_hash_mismatch', `技能包校验失败：${alias}`);
      return { skill_code: item.skill_code, revision: item.revision, alias, package_sha256: item.package_sha256, files: sorted(files) };
    }).sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0),
  };
}
function readLock(file: string, projectCode: string): SkillLock | null {
  const info = stat(file);
  if (!info) return null;
  assertSkillPathAncestors(file);
  if (!info.isFile() || info.size > MAX_BYTES) fail('skill_lock_invalid', '本机技能锁文件无效，请保留现场后手工检查');
  let lock: SkillLock;
  try { lock = JSON.parse(readFileSync(file, 'utf8')) as SkillLock; } catch { fail('skill_lock_invalid', '本机技能锁文件不是有效 JSON'); }
  if (lock.format !== 1 || lock.project_code !== projectCode || !Number.isSafeInteger(lock.generation) || lock.generation < 0 || !Array.isArray(lock.skills)) fail('skill_lock_invalid', '本机技能锁文件格式或项目不匹配');
  const aliases = new Set<string>();
  for (const item of lock.skills) {
    const alias = validateAlias(item.alias);
    if (aliases.has(alias) || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.skill_code !== 'string' || !Array.isArray(item.files)) fail('skill_lock_invalid', '本机技能锁文件包含无效安装项');
    aliases.add(alias); validatePaths(item.files);
    if (skillPackageHash(item.files) !== item.package_sha256) fail('skill_lock_invalid', '本机技能锁文件摘要不匹配');
  }
  return lock;
}
function validateLocal(root: string, previous: SkillLock | null, desired: SkillLock): void {
  const names = new Map((stat(root) ? readdirSync(root) : []).map(name => [name.toLowerCase(), name]));
  const owned = new Map(previous?.skills.map(skill => [skill.alias, skill]) ?? []);
  for (const skill of previous?.skills ?? []) {
    const absolute = path.join(root, skill.alias);
    if (names.get(skill.alias) !== skill.alias || !stat(absolute)?.isDirectory()) fail('skill_local_modified', `已同步技能目录缺失或改变：${skill.alias}`);
    const directories: string[] = [];
    const files = walk(absolute, directories);
    if (files.length !== skill.files.length) fail('skill_local_modified', `技能有新增或删除的本地文件：${skill.alias}`);
    const expected = new Map(skill.files.map(file => [file.path, file]));
    const expectedDirectories = new Set(skill.files.flatMap(file => {
      const parts = file.path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
    }));
    if (directories.some(directory => !expectedDirectories.has(directory))) fail('skill_local_modified', `技能含有新增的本地目录：${skill.alias}`);
    for (const relative of files) {
      const file = expected.get(relative);
      const local = path.join(absolute, ...relative.split('/'));
      if (!file || lstatSync(local).size !== file.size_bytes || digest(readFileSync(local)) !== file.sha256) fail('skill_local_modified', `技能有本地修改，已保留：${skill.alias}/${relative}`);
    }
  }
  for (const skill of desired.skills) {
    if (!owned.has(skill.alias) && names.has(skill.alias)) fail('skill_unmanaged_collision', `目标别名已有非受管内容，已保留：${skill.alias}`);
  }
}

/** Sync only project-scoped managed packages. No script or Agent configuration is executed/modified. */
export function syncSkillManifest(workspaceRoot: string, manifest: ProjectSkillManifest, options: { check?: boolean; createRoot?: boolean } = {}): SkillSyncResult {
  const desired = validateManifest(manifest); // Reject every unsafe/tampered entry before touching local state.
  const workspace = path.resolve(workspaceRoot);
  assertSkillPathAncestors(workspace);
  const workspaceInfo = stat(workspace);
  if (workspaceInfo ? !workspaceInfo.isDirectory() : !options.createRoot) fail('skill_directory_invalid', '工作区目录不存在或不是普通目录');
  if (!workspaceInfo && options.createRoot && !options.check) mkdirSync(workspace, { recursive: true });
  const home = path.join(workspace, '.tsp');
  const root = path.join(home, 'skills');
  const lockPath = path.join(home, 'skills.lock.json');
  const mutexPath = path.join(home, 'skills.sync.lock');
  for (const target of [home, root, lockPath, mutexPath]) assertSkillPathAncestors(target);
  if (stat(home) && !stat(home)?.isDirectory() || stat(root) && !stat(root)?.isDirectory()) fail('skill_directory_invalid', '.tsp 和 .tsp/skills 必须是普通目录');
  const check = options.check === true;
  let descriptor: number | undefined;
  let stage: string | undefined;
  const movedOld: string[] = [];
  const movedNew: string[] = [];
  let oldLockMoved = false;
  let newLockMoved = false;
  let createdManagedRoot = false;
  let committed = false;
  let recoveryFailed = false;
  try {
    if (check) { if (stat(mutexPath)) fail('skill_sync_locked', '另一个同步正在运行；请等待完成后重试'); }
    else {
      mkdirSync(home, { recursive: true });
      try { descriptor = openSync(mutexPath, 'wx', 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('skill_sync_locked', '另一个同步正在运行，或上次同步中断；核实进程后再处理 .tsp/skills.sync.lock');
        throw error;
      }
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    }
    const previous = readLock(lockPath, desired.project_code);
    // A version-controlled lock can arrive before any packages on a fresh clone.
    // Only an entirely absent managed root is a bootstrap; partial trees remain protected.
    const bootstrap = previous !== null && stat(root) === null;
    validateLocal(root, bootstrap ? null : previous, desired);
    const before = new Map(previous?.skills.map(item => [item.alias, item]) ?? []);
    const after = new Map(desired.skills.map(item => [item.alias, item]));
    const added = desired.skills.filter(item => bootstrap || !before.has(item.alias)).map(item => item.alias);
    const updated = desired.skills.filter(item => !bootstrap && before.has(item.alias) && JSON.stringify(before.get(item.alias)) !== JSON.stringify(item)).map(item => item.alias);
    const removed = (previous?.skills ?? []).filter(item => !after.has(item.alias)).map(item => item.alias);
    const changed = added.length > 0 || JSON.stringify(previous) !== JSON.stringify(desired);
    const result: SkillSyncResult = { project_code: desired.project_code, generation: desired.generation, check, changed, added, updated, removed, directory: root, skills_directory: root, lock_path: lockPath };
    if (check || !changed) return result;
    stage = path.join(home, `.skills-stage-${randomUUID()}`);
    mkdirSync(stage); mkdirSync(path.join(stage, 'new')); mkdirSync(path.join(stage, 'old'));
    const packages = new Map(manifest.skills.map(item => [item.alias, item]));
    for (const alias of [...added, ...updated]) {
      const item = packages.get(alias);
      if (!item) fail('skill_manifest_invalid', '技能清单缺少安装项');
      const target = path.join(stage, 'new', alias);
      mkdirSync(target);
      for (const file of item.files) {
        const destination = path.join(target, ...file.path.split('/'));
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, Buffer.from(file.content_base64, 'base64'), { flag: 'wx', mode: 0o600 });
      }
    }
    writeFileSync(path.join(stage, 'lock.json'), JSON.stringify(desired, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Recheck after staging, before the first replacement. Any failure leaves the old tree intact.
    for (const target of [home, root, lockPath]) assertSkillPathAncestors(target);
    if (bootstrap && stat(root)) fail('skill_unmanaged_collision', '同步期间出现了技能目录，已保留其内容');
    validateLocal(root, bootstrap ? null : previous, desired);
    createdManagedRoot = stat(root) === null;
    mkdirSync(root, { recursive: true });
    for (const alias of bootstrap ? [] : [...updated, ...removed]) {
      assertSkillPathAncestors(path.join(root, alias));
      renameSync(path.join(root, alias), path.join(stage, 'old', alias)); movedOld.push(alias);
    }
    for (const alias of [...added, ...updated]) {
      if (stat(path.join(root, alias))) fail('skill_unmanaged_collision', `同步期间目标出现新内容：${alias}`);
      renameSync(path.join(stage, 'new', alias), path.join(root, alias)); movedNew.push(alias);
    }
    if (previous) { renameSync(lockPath, path.join(stage, 'previous-lock.json')); oldLockMoved = true; }
    renameSync(path.join(stage, 'lock.json'), lockPath); newLockMoved = true;
    committed = true;
    return result;
  } catch (error) {
    if (stage && !committed) {
      // Restore only paths moved by this operation. Keep recovery files if rollback cannot finish.
      try {
        if (newLockMoved) renameSync(lockPath, path.join(stage, 'lock.json'));
        if (oldLockMoved) renameSync(path.join(stage, 'previous-lock.json'), lockPath);
        for (const alias of movedNew.reverse()) renameSync(path.join(root, alias), path.join(stage, 'new', alias));
        for (const alias of movedOld.reverse()) renameSync(path.join(stage, 'old', alias), path.join(root, alias));
        if (createdManagedRoot && stat(root)?.isDirectory()) {
          assertSkillPathAncestors(root);
          if (readdirSync(root).length === 0) rmdirSync(root);
        }
      } catch { recoveryFailed = true; fail('skill_sync_recovery_required', `同步回滚未完成；旧内容保存在 ${stage}，请保留现场并人工恢复`); }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) { closeSync(descriptor); if (!recoveryFailed) rmSync(mutexPath); }
    if (stage && !recoveryFailed) {
      // stage is a freshly generated, checked child of .tsp; never recursively delete a server path.
      assertSkillPathAncestors(stage);
      if (path.dirname(stage) !== home) fail('skill_path_invalid', '临时目录越界');
      rmSync(stage, { recursive: true });
    }
  }
}
