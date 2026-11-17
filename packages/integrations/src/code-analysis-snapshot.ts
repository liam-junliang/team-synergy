import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import type { CodeSnapshot } from '@team-synergy/contracts';
import { assertIntakeRegularPath, isExcludedIntakePath, isIntakeTextPath, normalizeIntakeScopes, readIntakeSourceFile, scanIntakeSource, sha256 } from './source-files.js';

export type CapturedSnapshot = CodeSnapshot;
const LIMIT = 128 * 1024 * 1024;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|https?:\/\/[^\s"/]+:[^\s"/]+@/i;
function git(root: string, args: string[], input?: string, environment?: NodeJS.ProcessEnv): Buffer {
  const result = spawnSync('git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args], {
    cwd: root, input, windowsHide: true, timeout: 60000, maxBuffer: LIMIT + 4 * 1024 * 1024,
    env: { ...(environment ?? process.env), GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
  });
  if (result.error || result.status !== 0) throw new DomainError('code_git_failed', '无法读取固定 Git 提交；请检查本机对象是否完整');
  return result.stdout;
}
function allowed(file: string, scope: string[]): boolean {
  return !file.split('/').some(segment => /^(?:\.codegraph|\.ua|\.understand-anything)$/i.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment) || /[. ]$/.test(segment)) && file.toLowerCase() !== 'codegraph.json' && !isExcludedIntakePath(file) && isIntakeTextPath(file) && scope.some(s => s === '.' || file === s || file.startsWith(`${s}/`));
}
function safeText(bytes: Buffer): boolean {
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) return false;
  try { return !secret.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return false; }
}
export function captureCodeSnapshot(root: string, destination: string, options: { repositoryCode: string; kind: 'commit' | 'draft'; ref?: string; scope?: string[]; includeUntracked?: boolean; gitEnvironment?: NodeJS.ProcessEnv }): CapturedSnapshot {
  assertIntakeRegularPath(root); assertIntakeRegularPath(destination);
  if (existsSync(destination)) throw new DomainError('code_snapshot_exists', '源码副本目录已存在；请新建分析或 resume');
  if (options.kind === 'commit' && options.includeUntracked) throw new DomainError('code_snapshot_options', '--include-untracked 仅用于显式草稿');
  const scope = normalizeIntakeScopes(options.scope ?? ['.']);
  const commit = git(root, ['rev-parse', '--verify', '--end-of-options', `${options.kind === 'draft' ? 'HEAD' : options.ref ?? 'HEAD'}^{commit}`], undefined, options.gitEnvironment).toString().trim();
  const tree = git(root, ['rev-parse', '--verify', `${commit}^{tree}`], undefined, options.gitEnvironment).toString().trim();
  const captured: Array<{ path: string; bytes: Buffer }> = [];
  let excluded = 0;
  if (options.kind === 'draft') {
    const before = scanIntakeSource(root, scope, options.includeUntracked);
    let total = 0;
    for (const file of before.files) {
      if (!allowed(file.path, scope)) { excluded++; continue; }
      const bytes = readIntakeSourceFile(root, file.path);
      if (!bytes || sha256(bytes) !== file.sha256) throw new DomainError('code_snapshot_changed', '捕获期间工作区发生变化，请重试');
      total += bytes.length;
      if (total > LIMIT) throw new DomainError('code_snapshot_too_large', '捕获内容超过 128 MiB，请缩小 --scope');
      captured.push({ path: file.path, bytes });
    }
    const after = scanIntakeSource(root, scope, options.includeUntracked);
    if (before.manifest_sha256 !== after.manifest_sha256 || before.commit !== commit || after.commit !== commit) throw new DomainError('code_snapshot_changed', '捕获期间工作区发生变化，请重试');
  } else {
    const entries = git(root, ['ls-tree', '-r', '-l', '-z', commit], undefined, options.gitEnvironment).toString('utf8').split('\0').filter(Boolean);
    if (entries.length > 20_000) throw new DomainError('code_snapshot_too_large', '仓库超过 20000 个对象，请缩小仓库');
    const blobs: Array<{ path: string; oid: string; size: number }> = [];
    for (const entry of entries) {
      const match = /^([0-9]+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new DomainError('code_git_invalid', 'Git 清单格式无效');
      const file = match[5] ?? '';
      if (!allowed(file, scope) || match[1] === '120000' || match[2] !== 'blob' || Number(match[4]) > 2 * 1024 * 1024) { excluded++; continue; }
      blobs.push({ path: file, oid: match[3] ?? '', size: Number(match[4]) });
    }
    if (blobs.reduce((sum, b) => sum + b.size, 0) > LIMIT) throw new DomainError('code_snapshot_too_large', '捕获内容超过 128 MiB，请缩小 --scope');
    if (blobs.length) {
      const output = git(root, ['cat-file', '--batch'], blobs.map(b => b.oid).join('\n') + '\n', options.gitEnvironment);
      let offset = 0;
      for (const blob of blobs) {
        const end = output.indexOf(10, offset);
        const header = output.subarray(offset, end).toString();
        if (end < 0 || header !== `${blob.oid} blob ${blob.size}`) throw new DomainError('code_git_invalid', 'Git 对象边界无效');
        const bytes = output.subarray(end + 1, end + 1 + blob.size);
        offset = end + 1 + blob.size + 1;
        if (safeText(bytes)) captured.push({ path: blob.path, bytes }); else excluded++;
      }
    }
  }
  if (!captured.length) throw new DomainError('code_snapshot_empty', '所选范围没有可分析的安全文本文件');
  if (captured.reduce((sum, f) => sum + f.bytes.length, 0) > LIMIT) throw new DomainError('code_snapshot_too_large', '捕获内容超过 128 MiB');
  const files = captured.map(f => ({ path: f.path, sha256: sha256(f.bytes), line_count: f.bytes.length ? f.bytes.toString('utf8').split('\n').length : 0, byte_count: f.bytes.length })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest_sha256 = sha256(JSON.stringify(files));
  const exclusions = ['Only allowed UTF-8 text; credentials, generated output, binary, links and submodules excluded.', 'Engine-owned .codegraph, .ua, .understand-anything directories and repository-root codegraph.json are excluded; repository configuration cannot control the analysis engine.', `Excluded entries: ${excluded}`, options.kind === 'commit' ? 'Exact Git blob bytes; working-tree modifications are not included.' : 'Explicit working-tree draft; untracked files require opt-in.'];
  const snapshot_id = sha256(JSON.stringify({ kind: options.kind, commit, tree, manifest_sha256, scope, exclusions }));
  mkdirSync(destination, { recursive: true });
  for (const file of captured) {
    const target = path.join(destination, file.path);
    assertIntakeRegularPath(target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: 'wx', mode: 0o600 });
  }
  return { snapshot_id, kind: options.kind, commit, tree, manifest_sha256, files, scope, captured_at: new Date().toISOString(), exclusions };
}
export function verifyCodeSnapshot(directory: string, snapshot: CapturedSnapshot): void {
  assertIntakeRegularPath(directory);
  const expected = new Set(snapshot.files.map(file => file.path));
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(directory, relative))) {
      const name = relative ? `${relative}/${entry}` : entry;
      const absolute = path.join(directory, name);
      assertIntakeRegularPath(absolute);
      // The native index is generated metadata, never source input.
      if (name === '.codegraph') continue;
      if (lstatSync(absolute).isDirectory()) walk(name);
      else if (!expected.has(name)) throw new DomainError('code_snapshot_changed', '固定副本增加了清单外文件；请创建新分析');
    }
  };
  walk('');
  for (const file of snapshot.files) {
    if (!allowed(file.path, snapshot.scope)) throw new DomainError('code_snapshot_invalid', '快照清单含不安全路径');
    const target = path.join(directory, file.path);
    assertIntakeRegularPath(target);
    if (!existsSync(target) || sha256(readFileSync(target)) !== file.sha256) throw new DomainError('code_snapshot_changed', '固定源码副本已改变；请创建新分析');
  }
  if (sha256(JSON.stringify(snapshot.files)) !== snapshot.manifest_sha256) throw new DomainError('code_snapshot_changed', '快照清单摘要不一致');
  const { kind, commit, tree, manifest_sha256, scope, exclusions } = snapshot;
  if (sha256(JSON.stringify({ kind, commit, tree, manifest_sha256, scope, exclusions })) !== snapshot.snapshot_id) throw new DomainError('code_snapshot_changed', '快照身份摘要不一致');
}
