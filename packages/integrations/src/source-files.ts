import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_SKILL_VERSION, intakeManifestText, isIntakeSourcePath, type IntakeBundle } from '@team-synergy/contracts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;
const excludedDirectory = /^(?:\.git|\.agent|\.omx|\.tsp|\.ssh|\.aws|\.azure|\.config|node_modules|vendor|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__)$/i;
const credentialName = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|id_rsa|id_ed25519|known_hosts)$/i;
const textExtensions = new Set('.ts .tsx .js .jsx .mjs .cjs .mts .cts .json .md .mdx .mmd .mermaid .yaml .yml .toml .ini .xml .html .css .scss .less .sql .prisma .graphql .gql .proto .py .pyi .go .rs .java .kt .kts .cs .fs .rb .php .swift .c .h .cc .cpp .hpp .sh .bash .zsh .ps1 .psm1 .bat .cmd .vue .svelte .dart .ex .exs .erl .hrl .scala .clj .cljs .cljc .edn .r .R .lua .pl .pm .hs .ml .mli .tf .tfvars .properties .txt .rst'.toLowerCase().split(' '));
const sensitiveContent = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|\bAKIA[A-Z0-9]{16}\b|https?:\/\/[^\s"/]+:[^\s"/]+@/i;

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Reject links/junctions in every existing ancestor, including output directories. */
export function assertIntakeRegularPath(file: string): void {
  let current = path.resolve(file);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new DomainError('intake_symlink', '代码规格输入和输出不能经过符号链接或目录联接');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function gitProcess(root: string, args: string[], filterOverrides: string[] = []) {
  // Even read-only status can execute fsmonitor or filters from repository config.
  // No optional index refresh, hooks, fsmonitor, or user-defined clean/process filter.
  return spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...filterOverrides, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}
export function readIntakeGit(root: string, args: string[], filterOverrides: string[] = []): string {
  const result = gitProcess(root, args, filterOverrides);
  if (result.error || result.status !== 0) throw new DomainError('intake_git_failed', '无法读取绑定仓库的 Git 状态；请检查仓库是否可用');
  return result.stdout;
}

function disabledFilterOptions(root: string): string[] {
  const result = gitProcess(root, ['config', '-z', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']);
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new DomainError('intake_git_failed', '无法检查仓库 Git 过滤器配置');
  const keys = new Set(result.stdout.split('\0').filter(Boolean));
  return [...keys].flatMap(key => ['-c', `${key}=`, '-c', `${key.replace(/\.(clean|process)$/, '.required')}=false`]);
}

export function normalizeIntakeScopes(scopes: string[]): string[] {
  if (scopes.length === 0 || scopes.length > 50 || scopes.some(value => value !== '.' && !isIntakeSourcePath(value))) throw new DomainError('intake_scope_invalid', '--scope 需要安全的仓库相对路径（用 / 分隔），禁止绝对路径、.. 和敏感文件');
  return [...new Set(scopes)].sort(ordinal);
}

export function isExcludedIntakePath(file: string): boolean {
  return !isIntakeSourcePath(file) || file.split('/').some(part => excludedDirectory.test(part) || credentialName.test(part))
    || /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|\.DS_Store)$/i.test(file)
    || /\.(?:min\.js|map|lock|pem|key|p12|pfx|keystore|jks|sqlite|db)$/i.test(file);
}

function selected(file: string, scopes: string[]) {
  return scopes.some(scope => scope === '.' || file === scope || file.startsWith(`${scope}/`));
}

export function readIntakeSourceFile(root: string, file: string): Buffer | null {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new DomainError('intake_path_escape', '文件路径超出了绑定仓库');
  assertIntakeRegularPath(absolute);
  if (!existsSync(absolute)) return null;
  const info = lstatSync(absolute);
  if (!info.isFile()) return null;
  if (info.size > MAX_FILE_BYTES) return null;
  const resolved = path.relative(realpathSync(root), realpathSync(absolute));
  if (!resolved || resolved.startsWith('..') || path.isAbsolute(resolved)) throw new DomainError('intake_path_escape', '文件真实路径超出了绑定仓库');
  const bytes = readFileSync(absolute);
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (sensitiveContent.test(text)) return null;
  return bytes;
}

function scanOnce(root: string, scopes: string[], filterOverrides: string[], includeUntracked = false) {
  const tree = readIntakeGit(root, ['ls-files', '-z', '--cached', ...(includeUntracked ? ['--others', '--exclude-standard'] : [])], filterOverrides).split('\0').filter(Boolean);
  const candidates = [...new Set(tree.filter(file => selected(file, scopes)))].sort(ordinal);
  if (candidates.length > MAX_FILES) throw new DomainError('intake_source_too_large', '所选范围超过 20000 个跟踪文件，请缩小 --scope');
  const files: Array<{ path: string; sha256: string }> = [];
  let excluded = 0;
  for (const file of candidates) {
    if (isExcludedIntakePath(file) || !isIntakeTextPath(file)) { excluded++; continue; }
    const bytes = readIntakeSourceFile(root, file);
    if (bytes === null) { excluded++; continue; }
    files.push({ path: file, sha256: sha256(bytes) });
  }
  const headResult = gitProcess(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], filterOverrides);
  if (headResult.error || (headResult.status !== 0 && headResult.status !== 1)) throw new DomainError('intake_git_failed', '无法读取仓库 HEAD');
  const status = readIntakeGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], filterOverrides);
  return { files, commit: headResult.status === 0 ? headResult.stdout.trim() : null, dirty: status.length > 0, status, excluded, manifest_sha256: sha256(intakeManifestText(files)) };
}

export function isIntakeTextPath(file: string): boolean {
  return textExtensions.has(path.posix.extname(file).toLowerCase()) || /^(?:Dockerfile|Makefile|CMakeLists\.txt|Gemfile|Rakefile|Procfile|Jenkinsfile)$/i.test(path.posix.basename(file));
}

export function scanIntakeSource(root: string, rawScopes: string[], includeUntracked = false): IntakeBundle['source'] {
  const filterOverrides = disabledFilterOptions(root);
  const scope = normalizeIntakeScopes(rawScopes);
  for (const value of scope) {
    if (value !== '.' && isExcludedIntakePath(value)) throw new DomainError('intake_scope_invalid', '所选目录被安全规则排除，请选择业务源码目录');
    const absolute = path.join(root, value);
    assertIntakeRegularPath(absolute);
    if (!existsSync(absolute)) throw new DomainError('intake_scope_missing', '所选范围不存在于绑定仓库');
  }
  const before = scanOnce(root, scope, filterOverrides, includeUntracked);
  const after = scanOnce(root, scope, filterOverrides, includeUntracked);
  if (before.manifest_sha256 !== after.manifest_sha256 || before.commit !== after.commit || before.status !== after.status) throw new DomainError('intake_source_changed', '采集期间代码发生变化，请停止修改后重新 prepare');
  if (after.files.length === 0) throw new DomainError('intake_source_empty', '所选范围没有可读取的 Git 跟踪文本文件；请确认范围并显式 git add 源码');
  return {
    commit: after.commit, dirty: after.dirty, scope, files: after.files, manifest_sha256: after.manifest_sha256,
    complete: false, analyzed_at: new Date().toISOString(), skill_version: INTAKE_SKILL_VERSION,
    exclusions: [
      includeUntracked ? 'Git-tracked and explicitly requested non-ignored untracked UTF-8 text files are included.' : 'Only Git-tracked UTF-8 text files are included; untracked files are not analyzed.',
      'Credentials, environment files, private keys, dependencies, generated output, lock files, binaries and files over 2 MiB are excluded.',
      'Git hooks, fsmonitor and custom clean/process filters are disabled during capture; dirty reflects the unfiltered working files.',
      `Excluded tracked files in selected scope: ${after.excluded}.`,
    ],
  };
}

