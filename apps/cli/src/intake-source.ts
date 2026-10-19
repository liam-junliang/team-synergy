import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_MAX_BYTES, INTAKE_SKILL_VERSION, IntakeBundleSchema, PublicCodeSchema, intakeManifestText, isIntakeSourcePath, type IntakeBundle } from '@team-synergy/contracts';
import { identifyBoundProject } from './project-binding.js';
import { readRepositoryRegistry } from './project-workspace.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;
const excludedDirectory = /^(?:\.git|\.agent|\.tsp|\.ssh|\.aws|\.azure|\.config|node_modules|vendor|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__)$/i;
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

export function intakeBinding(startDir: string, projectCode?: string, apiUrl?: string) {
  const identified = identifyBoundProject(startDir);
  if (!identified) throw new DomainError('project_binding_not_found', '代码规格接入需要先绑定本机项目工作空间');
  if (projectCode && projectCode !== identified.binding.project_code) throw new DomainError('intake_project_mismatch', '候选项目与当前工作空间绑定不一致');
  if (apiUrl && apiUrl.replace(/\/+$/, '') !== identified.binding.api_url.replace(/\/+$/, '')) throw new DomainError('intake_platform_mismatch', '当前 CLI 平台地址与项目绑定不一致，请检查登录和工作空间');
  PublicCodeSchema.parse(identified.binding.project_code);
  const workspace = path.dirname(path.dirname(identified.path));
  assertIntakeRegularPath(identified.path);
  return { workspace, ...identified.binding };
}

function gitProcess(root: string, args: string[], filterOverrides: string[] = []) {
  // Even read-only status can execute fsmonitor or filters from repository config.
  // No optional index refresh, hooks, fsmonitor, or user-defined clean/process filter.
  return spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...filterOverrides, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}
function git(root: string, args: string[], filterOverrides: string[] = []): string {
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

export function intakeRepository(startDir: string, projectCode: string, repositoryCode: string): string {
  PublicCodeSchema.parse(repositoryCode);
  const { workspace } = intakeBinding(startDir, projectCode);
  assertIntakeRegularPath(path.join(workspace, '.agent', 'repositories.local.yaml'));
  const registered = readRepositoryRegistry(workspace).filter(item => item.repository_code === repositoryCode);
  const repository = registered[0];
  if (registered.length !== 1 || !repository) throw new DomainError('intake_repository_not_bound', '仓库尚未绑定到当前工作空间，请先执行 tsp repository attach 或 clone');
  const root = path.resolve(workspace, repository.path);
  assertIntakeRegularPath(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new DomainError('intake_repository_missing', '本机绑定仓库目录不存在');
  if (path.resolve(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new DomainError('intake_repository_invalid', '绑定路径必须是 Git 仓库根目录');
  return root;
}

export function normalizeIntakeScopes(scopes: string[]): string[] {
  if (scopes.length === 0 || scopes.length > 50 || scopes.some(value => value !== '.' && !isIntakeSourcePath(value))) throw new DomainError('intake_scope_invalid', '--scope 需要安全的仓库相对路径（用 / 分隔），禁止绝对路径、.. 和敏感文件');
  return [...new Set(scopes)].sort(ordinal);
}

function isExcluded(file: string): boolean {
  return !isIntakeSourcePath(file) || file.split('/').some(part => excludedDirectory.test(part) || credentialName.test(part))
    || /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|\.DS_Store)$/i.test(file)
    || /\.(?:min\.js|map|lock|pem|key|p12|pfx|keystore|jks|sqlite|db)$/i.test(file);
}

function selected(file: string, scopes: string[]) {
  return scopes.some(scope => scope === '.' || file === scope || file.startsWith(`${scope}/`));
}

function readSourceFile(root: string, file: string): Buffer | null {
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

function scanOnce(root: string, scopes: string[], filterOverrides: string[]) {
  const tree = git(root, ['ls-files', '-z', '--cached'], filterOverrides).split('\0').filter(Boolean);
  const candidates = [...new Set(tree.filter(file => selected(file, scopes)))].sort(ordinal);
  if (candidates.length > MAX_FILES) throw new DomainError('intake_source_too_large', '所选范围超过 20000 个跟踪文件，请缩小 --scope');
  const files: Array<{ path: string; sha256: string }> = [];
  let excluded = 0;
  for (const file of candidates) {
    if (isExcluded(file) || (!textExtensions.has(path.posix.extname(file).toLowerCase()) && !/^(?:Dockerfile|Makefile|CMakeLists\.txt|Gemfile|Rakefile|Procfile|Jenkinsfile)$/i.test(path.posix.basename(file)))) { excluded++; continue; }
    const bytes = readSourceFile(root, file);
    if (bytes === null) { excluded++; continue; }
    files.push({ path: file, sha256: sha256(bytes) });
  }
  const headResult = gitProcess(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], filterOverrides);
  if (headResult.error || (headResult.status !== 0 && headResult.status !== 1)) throw new DomainError('intake_git_failed', '无法读取仓库 HEAD');
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], filterOverrides);
  return { files, commit: headResult.status === 0 ? headResult.stdout.trim() : null, dirty: status.length > 0, status, excluded, manifest_sha256: sha256(intakeManifestText(files)) };
}

export function scanIntakeSource(root: string, rawScopes: string[]): IntakeBundle['source'] {
  const filterOverrides = disabledFilterOptions(root);
  const scope = normalizeIntakeScopes(rawScopes);
  for (const value of scope) {
    if (value !== '.' && isExcluded(value)) throw new DomainError('intake_scope_invalid', '所选目录被安全规则排除，请选择业务源码目录');
    const absolute = path.join(root, value);
    assertIntakeRegularPath(absolute);
    if (!existsSync(absolute)) throw new DomainError('intake_scope_missing', '所选范围不存在于绑定仓库');
  }
  const before = scanOnce(root, scope, filterOverrides);
  const after = scanOnce(root, scope, filterOverrides);
  if (before.manifest_sha256 !== after.manifest_sha256 || before.commit !== after.commit || before.status !== after.status) throw new DomainError('intake_source_changed', '采集期间代码发生变化，请停止修改后重新 prepare');
  if (after.files.length === 0) throw new DomainError('intake_source_empty', '所选范围没有可读取的 Git 跟踪文本文件；请确认范围并显式 git add 源码');
  return {
    commit: after.commit, dirty: after.dirty, scope, files: after.files, manifest_sha256: after.manifest_sha256,
    complete: false, analyzed_at: new Date().toISOString(), skill_version: INTAKE_SKILL_VERSION,
    exclusions: [
      'Only Git-tracked UTF-8 text files are included; untracked files are not analyzed.',
      'Credentials, environment files, private keys, dependencies, generated output, lock files, binaries and files over 2 MiB are excluded.',
      'Git hooks, fsmonitor and custom clean/process filters are disabled during capture; dirty reflects the unfiltered working files.',
      `Excluded tracked files in selected scope: ${after.excluded}.`,
    ],
  };
}

export function intakeNamespace(workspace: string, repositoryCode: string): string {
  const file = path.join(workspace, '.agent', 'intake', `${PublicCodeSchema.parse(repositoryCode)}.json`);
  assertIntakeRegularPath(file);
  mkdirSync(path.dirname(file), { recursive: true });
  try { writeFileSync(file, JSON.stringify({ namespace: `source-${randomUUID()}` }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('namespace' in parsed) || typeof parsed.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(parsed.namespace)) throw new DomainError('intake_namespace_invalid', '本机接入来源记录损坏，请保留文件并检查');
  return parsed.namespace;
}

export function readIntakeBundle(file: string): IntakeBundle {
  const absolute = path.resolve(file);
  assertIntakeRegularPath(absolute);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.size > INTAKE_MAX_BYTES) throw new DomainError('intake_input_invalid', '候选包必须是至多 10 MiB 的普通 JSON 文件');
  let input: unknown;
  try { input = JSON.parse(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new DomainError('intake_input_invalid', '候选包不是有效 JSON'); }
  if (input && typeof input === 'object' && 'items' in input && Array.isArray(input.items) && input.items.length === 0) throw new DomainError('intake_candidates_required', 'prepare 只生成清单。请让本机 Agent 阅读 SKILL.md、按真实源码填写 items，再 validate；不会自动调用模型');
  const result = IntakeBundleSchema.safeParse(input);
  if (!result.success) throw new DomainError('intake_bundle_invalid', '候选包不符合代码规格协议', { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  if (sha256(intakeManifestText(result.data.source.files)) !== result.data.source.manifest_sha256) throw new DomainError('intake_manifest_invalid', '文件清单摘要不匹配，不能修改源码指纹来绕过重新分析');
  return result.data;
}

export function validateIntakeSource(bundle: IntakeBundle, startDir: string): void {
  const root = intakeRepository(startDir, bundle.project_code, bundle.repository_code);
  const current = scanIntakeSource(root, bundle.source.scope);
  if (current.manifest_sha256 !== bundle.source.manifest_sha256 || current.commit !== bundle.source.commit || current.dirty !== bundle.source.dirty) throw new DomainError('intake_source_changed', '本机源码或 Git 状态与候选快照不一致，请重新 prepare 并复核候选；未上传任何资料');
  for (const item of bundle.items) {
    for (const evidence of item.evidence) {
      const bytes = readSourceFile(root, evidence.path);
      if (!bytes || evidence.line_end > bytes.toString('utf8').split(/\r?\n/).length) throw new DomainError('intake_evidence_invalid', '候选证据行号超出当前源码文件');
    }
  }
}
