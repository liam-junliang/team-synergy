import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DomainError } from '@team-synergy/domain';
import { bindProject, identifyBoundProject, type IdentifiedBoundProject } from './project-binding.js';

export interface RemoteProjectRepository {
  repository_code: string;
  project_code: string;
  name: string;
  purpose: string | null;
  remote_url: string;
  default_branch: string | null;
  status: string;
}

export interface LocalRepositoryBinding {
  repository_code: string;
  path: string;
  remote_name: string;
}

const DEFAULT_IGNORE_LINES = [
  '/code/',
  '/.agent/bound-project.yaml',
  '/.agent/project-state/',
  '/.agent/runs/',
  '/.agent/cache/',
  '/.agent/logs/',
  '/.agent/repositories.local.yaml',
  '/.tsp/skills/',
  '/.tsp/skills.sync.lock',
  '/.tsp/.skills-stage-*/',
];

function runGit(args: string[], cwd?: string) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function gitRoot(directory: string): string | null {
  const result = runGit(['rev-parse', '--show-toplevel'], directory);
  return result.status === 0 ? path.resolve(result.stdout.trim()) : null;
}

export function prepareProjectWorkspace(directory: string) {
  const root = path.resolve(directory);
  mkdirSync(root, { recursive: true });
  const existingRoot = gitRoot(root);
  if (existingRoot && existingRoot !== root) {
    throw new DomainError('project_workspace_nested_git', '项目工作空间不能初始化在另一个 Git 工作树内部', {
      requested_path: root,
      containing_git_root: existingRoot,
    });
  }
  let gitInitialized = false;
  if (!existingRoot) {
    const initialized = runGit(['init'], root);
    if (initialized.status !== 0) {
      throw new DomainError('project_workspace_git_init_failed', '无法初始化项目工作空间 Git', { stderr: initialized.stderr.trim() });
    }
    gitInitialized = true;
  }
  mkdirSync(path.join(root, '.agent'), { recursive: true });
  mkdirSync(path.join(root, 'work'), { recursive: true });
  mkdirSync(path.join(root, 'outbox'), { recursive: true });
  mkdirSync(path.join(root, 'code'), { recursive: true });
  const ignorePath = path.join(root, '.gitignore');
  const current = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8').replace(/\r\n/g, '\n') : '';
  const currentLines = new Set(current.split('\n').map((line) => line.trim()).filter(Boolean));
  const additions = DEFAULT_IGNORE_LINES.filter((line) => !currentLines.has(line));
  if (additions.length > 0) {
    const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`;
    writeFileSync(ignorePath, `${prefix}${additions.join('\n')}\n`, 'utf8');
  }
  return { root, git_initialized: gitInitialized, gitignore_path: ignorePath };
}

export function finalizeProjectWorkspaceBinding(
  directory: string,
  projectCode: string,
  projectWorkspaceCode: string,
  apiUrl: string,
): IdentifiedBoundProject {
  return bindProject(directory, projectCode, apiUrl, { projectWorkspaceCode, schemaVersion: 2 });
}

function registryPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent', 'repositories.local.yaml');
}

function scalar(value: string): string {
  if (!value.startsWith('"')) return value;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'string') throw new DomainError('repository_registry_invalid', '本地代码仓库注册表字段格式无效');
  return parsed;
}

export function readRepositoryRegistry(workspaceRoot: string): LocalRepositoryBinding[] {
  const file = registryPath(workspaceRoot);
  if (!existsSync(file)) return [];
  const result: LocalRepositoryBinding[] = [];
  let current: Partial<LocalRepositoryBinding> | null = null;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'repositories:') continue;
    const match = line.match(/^-?\s*(repository_code|path|remote_name):\s*(.+)$/);
    if (!match) throw new DomainError('repository_registry_invalid', 'repositories.local.yaml 格式无效');
    const key = match[1] as 'repository_code' | 'path' | 'remote_name';
    const rawValue = match[2];
    if (!rawValue) throw new DomainError('repository_registry_invalid', '本地代码仓库注册表字段为空');
    if (key === 'repository_code') {
      if (current) {
        if (!current.repository_code || !current.path || !current.remote_name) throw new DomainError('repository_registry_invalid', '本地代码仓库注册表缺少字段');
        result.push(current as LocalRepositoryBinding);
      }
      current = { repository_code: scalar(rawValue) };
    } else {
      if (!current) throw new DomainError('repository_registry_invalid', '本地代码仓库注册表顺序无效');
      if (key === 'path') current.path = scalar(rawValue);
      if (key === 'remote_name') current.remote_name = scalar(rawValue);
    }
  }
  if (current) {
    if (!current.repository_code || !current.path || !current.remote_name) throw new DomainError('repository_registry_invalid', '本地代码仓库注册表缺少字段');
    result.push(current as LocalRepositoryBinding);
  }
  return result;
}

function writeRepositoryRegistry(workspaceRoot: string, bindings: LocalRepositoryBinding[]): string {
  const file = registryPath(workspaceRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['repositories:'];
  for (const binding of [...bindings].sort((a, b) => a.repository_code.localeCompare(b.repository_code))) {
    lines.push(`  - repository_code: ${JSON.stringify(binding.repository_code)}`);
    lines.push(`    path: ${JSON.stringify(binding.path)}`);
    lines.push(`    remote_name: ${JSON.stringify(binding.remote_name)}`);
  }
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

function normalizeRemote(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = trimmed.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  if (scp?.[1] && scp[2] && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`;
  try {
    const url = new URL(trimmed);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, '')}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

function workspaceFromCurrent(startDir: string) {
  const identified = identifyBoundProject(startDir);
  if (!identified) throw new DomainError('project_binding_not_found', '未找到 .agent/bound-project.yaml，请先初始化或绑定项目工作空间');
  return { identified, root: path.dirname(path.dirname(identified.path)) };
}

function relativeOrAbsolute(workspaceRoot: string, repositoryRoot: string): string {
  const relative = path.relative(workspaceRoot, repositoryRoot);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replaceAll('\\', '/') : repositoryRoot;
}

export function attachRepository(startDir: string, repository: RemoteProjectRepository, directory: string, remoteName = 'origin') {
  const { root: workspaceRoot } = workspaceFromCurrent(startDir);
  if (repository.status !== 'active') throw new DomainError('repository_archived', `代码仓库已归档：${repository.repository_code}`);
  const repositoryRoot = path.resolve(workspaceRoot, directory);
  const actualRoot = gitRoot(repositoryRoot);
  if (!actualRoot || actualRoot !== repositoryRoot) {
    throw new DomainError('repository_git_root_invalid', '绑定目录必须是独立 Git 仓库根目录', { path: repositoryRoot, detected_root: actualRoot });
  }
  const remote = runGit(['remote', 'get-url', remoteName], repositoryRoot);
  if (remote.status !== 0) throw new DomainError('repository_remote_missing', `本地仓库缺少 remote：${remoteName}`);
  const actualRemote = remote.stdout.trim();
  if (normalizeRemote(actualRemote) !== normalizeRemote(repository.remote_url)) {
    throw new DomainError('repository_remote_mismatch', '本地 Git remote 与云端项目仓库不匹配', {
      repository_code: repository.repository_code,
      expected: repository.remote_url,
      actual: actualRemote,
    });
  }
  const bindings = readRepositoryRegistry(workspaceRoot).filter((item) => item.repository_code !== repository.repository_code);
  const binding = { repository_code: repository.repository_code, path: relativeOrAbsolute(workspaceRoot, repositoryRoot), remote_name: remoteName };
  const file = writeRepositoryRegistry(workspaceRoot, [...bindings, binding]);
  const head = runGit(['rev-parse', 'HEAD'], repositoryRoot);
  return { binding, registry_path: file, git_head: head.status === 0 ? head.stdout.trim() : null };
}

function safeDirectoryName(repository: RemoteProjectRepository): string {
  const slug = repository.name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
  return slug || repository.repository_code.toLowerCase();
}

export function cloneRepository(startDir: string, repository: RemoteProjectRepository, target?: string) {
  const { root: workspaceRoot } = workspaceFromCurrent(startDir);
  const codeRoot = path.join(workspaceRoot, 'code');
  const destination = path.resolve(workspaceRoot, target?.trim() || path.join('code', safeDirectoryName(repository)));
  const relativeToCode = path.relative(codeRoot, destination);
  if (!relativeToCode || relativeToCode.startsWith('..') || path.isAbsolute(relativeToCode)) {
    throw new DomainError('repository_clone_target_outside_code_space', '代码仓库只能检出到项目工作空间的 code/ 目录中；外部仓库请使用 repository attach', {
      path: destination,
      code_root: codeRoot,
    });
  }
  if (existsSync(destination)) throw new DomainError('repository_clone_target_exists', '代码仓库检出目录已经存在', { path: destination });
  mkdirSync(path.dirname(destination), { recursive: true });
  const args = ['clone'];
  if (repository.default_branch) args.push('--branch', repository.default_branch);
  args.push(repository.remote_url, destination);
  const cloned = runGit(args, workspaceRoot);
  if (cloned.status !== 0) {
    throw new DomainError('repository_clone_failed', 'Git clone 失败', { repository_code: repository.repository_code, stderr: cloned.stderr.trim() });
  }
  return { clone_path: destination, ...attachRepository(workspaceRoot, repository, destination) };
}

export function localRepositoryStatus(startDir: string, repositories: RemoteProjectRepository[]) {
  const { root: workspaceRoot } = workspaceFromCurrent(startDir);
  const registry = readRepositoryRegistry(workspaceRoot);
  const byCode = new Map(registry.map((item) => [item.repository_code, item]));
  return repositories.map((repository) => {
    const binding = byCode.get(repository.repository_code);
    if (!binding) return { ...repository, checkout_status: 'not_checked_out', local_path: null, git_head: null, dirty: null };
    const localPath = path.resolve(workspaceRoot, binding.path);
    if (!existsSync(localPath)) return { ...repository, checkout_status: 'missing', local_path: binding.path, git_head: null, dirty: null };
    const root = gitRoot(localPath);
    if (root !== localPath) return { ...repository, checkout_status: 'invalid', local_path: binding.path, git_head: null, dirty: null };
    const remote = runGit(['remote', 'get-url', binding.remote_name], localPath);
    if (remote.status !== 0) return { ...repository, checkout_status: 'remote_missing', local_path: binding.path, git_head: null, dirty: null };
    if (normalizeRemote(remote.stdout.trim()) !== normalizeRemote(repository.remote_url)) {
      return { ...repository, checkout_status: 'remote_mismatch', local_path: binding.path, git_head: null, dirty: null };
    }
    const head = runGit(['rev-parse', 'HEAD'], localPath);
    const status = runGit(['status', '--porcelain'], localPath);
    return {
      ...repository,
      checkout_status: 'ready',
      local_path: binding.path,
      git_head: head.status === 0 ? head.stdout.trim() : null,
      dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    };
  });
}
