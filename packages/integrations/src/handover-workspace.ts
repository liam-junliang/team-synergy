import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import type { WorkspaceManifest } from '@team-synergy/contracts';

export type HandoverWorkspaceManifest = WorkspaceManifest;

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, input, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new DomainError('handover_git_failed', `Git 操作失败：${args[0]}`, { stderr: result.stderr?.trim() });
  return result.stdout.trimEnd();
}

function safeRemote(remote: string): string {
  if (/^https?:\/\//i.test(remote)) {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new DomainError('handover_remote_credentials', '远端 URL 不得包含凭据、查询参数或片段');
  }
  if (!remote || remote.startsWith('-')) throw new DomainError('handover_remote_invalid', 'Git 远端无效');
  return remote;
}

function normalizedRemote(remote: string): string {
  const value = safeRemote(remote);
  return (existsSync(value) ? realpathSync(value) : value).replace(/\\/g, '/').replace(/\/$/, '').replace(/\.git$/, '');
}

function safePath(repo: string, file: string): string {
  const normalized = file.replace(/\\/g, '/');
  if (!normalized || [...file].some((character) => character.charCodeAt(0) < 32) || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || normalized.split('/').some((part) => part === '..' || part === '.' || part === '.git' || part === '')) {
    throw new DomainError('handover_path_invalid', `交接文件必须为仓库内相对路径：${file}`);
  }
  const absolute = path.resolve(repo, normalized);
  const root = realpathSync(repo);
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolved = realpathSync(ancestor);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DomainError('handover_path_invalid', `文件路径越出仓库：${file}`);
  if (existsSync(absolute) && (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())) throw new DomainError('handover_path_invalid', `只支持普通文件：${file}`);
  return normalized;
}

export function isPrivateHandoverPath(file: string): boolean {
  return file.split('/').some((part) => /^\.env(?:\.|$)/i.test(part) || /^(\.agent|\.tsp|\.git|\.cache|cache|node_modules|credentials?|secrets?|\.ssh|\.aws|\.codex|\.claude|\.kube|\.docker|\.npmrc|\.netrc|auth\.json)$/i.test(part))
    || /(?:^|\/)(?:id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/i.test(file);
}

export function preflightHandoverWorkspace(opts: { repoPath: string; remoteName?: string; selectedPaths?: string[] }) {
  const repo = path.resolve(opts.repoPath);
  const root = path.resolve(git(repo, ['rev-parse', '--show-toplevel']));
  if (root !== repo) throw new DomainError('handover_repo_root_required', '必须指定 Git 工作树根目录');
  const baseCommit = git(repo, ['rev-parse', 'HEAD']);
  const remoteName = opts.remoteName ?? 'origin';
  const remoteUrl = safeRemote(git(repo, ['remote', 'get-url', remoteName]));
  const tree = git(repo, ['ls-tree', '-r', baseCommit]);
  if (/^160000 /m.test(tree)) throw new DomainError('handover_submodule_unsupported', '首版交接不支持 submodule');
  const candidates = opts.selectedPaths ?? [...new Set([
    ...git(repo, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
    ...git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
  const files = candidates.map((file) => safePath(repo, file));
  const excluded = files.filter(isPrivateHandoverPath);
  if (opts.selectedPaths && excluded.length) throw new DomainError('handover_private_path', '所选文件含默认禁止发布的私人或凭据路径', { files: excluded });
  const selected = files.filter((file) => !isPrivateHandoverPath(file)).sort();
  const attributePaths = [...new Set([...git(repo, ['ls-files', '-z']).split('\0').filter(Boolean), ...selected])];
  if (attributePaths.length) {
    const attributes = git(repo, ['check-attr', '-z', '--stdin', 'filter'], undefined, attributePaths.join('\0') + '\0');
    if (attributes.split('\0').includes('lfs')) throw new DomainError('handover_lfs_unsupported', '首版交接不支持 LFS');
  }
  for (const file of selected) {
    const absolute = path.join(repo, file);
    if (existsSync(absolute) && readFileSync(absolute).includes(0)) throw new DomainError('handover_binary_unsupported', `首版交接不支持二进制文件：${file}`);
  }
  return { repoPath: repo, baseCommit, remoteName, remoteUrl, files: selected, excluded };
}

/** Construct a commit from a private index. Source HEAD, index and worktree are never changed. */
export function publishHandoverWorkspace(opts: { repoPath: string; repositoryCode: string; handoverCode: string; remoteName?: string; selectedPaths?: string[] }): HandoverWorkspaceManifest {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.handoverCode)) throw new DomainError('handover_code_invalid', '交接编号无效');
  const plan = preflightHandoverWorkspace(opts);
  const temporary = mkdtempSync(path.join(tmpdir(), 'acp-handover-index-'));
  const environment = { GIT_INDEX_FILE: path.join(temporary, 'index'), GIT_LITERAL_PATHSPECS: '1' };
  try {
    git(plan.repoPath, ['read-tree', plan.baseCommit], environment);
    if (plan.files.length) {
      const pathspec = path.join(temporary, 'paths');
      writeFileSync(pathspec, plan.files.join('\0') + '\0');
      git(plan.repoPath, ['add', '--all', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'], environment);
    }
    const snapshotTree = git(plan.repoPath, ['write-tree'], environment);
    if (/^-\t-\t/m.test(git(plan.repoPath, ['diff', '--numstat', plan.baseCommit, snapshotTree]))) throw new DomainError('handover_binary_unsupported', '首版交接不支持二进制文件变更');
    const snapshotRef = `refs/heads/acp/handover/${opts.handoverCode}`;
    const existing = git(plan.repoPath, ['ls-remote', '--refs', '--', plan.remoteName, snapshotRef]).split(/\s/)[0];
    let snapshotCommit: string;
    if (existing) {
      git(plan.repoPath, ['fetch', '--no-tags', '--', plan.remoteName, snapshotRef]);
      if (git(plan.repoPath, ['rev-parse', `${existing}^{tree}`]) !== snapshotTree || git(plan.repoPath, ['rev-parse', `${existing}^`]) !== plan.baseCommit) throw new DomainError('handover_snapshot_already_published', '此交接代码快照已经发布，无法替换；请取消并重新准备');
      snapshotCommit = existing;
    } else {
      snapshotCommit = git(plan.repoPath, ['commit-tree', snapshotTree, '-p', plan.baseCommit], {
        ...environment, GIT_AUTHOR_NAME: 'ACP Handover', GIT_AUTHOR_EMAIL: 'handover@acp.local', GIT_COMMITTER_NAME: 'ACP Handover', GIT_COMMITTER_EMAIL: 'handover@acp.local',
      }, `Preserve a portable continuation point for ${opts.handoverCode}\n`);
      git(plan.repoPath, ['push', '--porcelain', '--', plan.remoteName, `${snapshotCommit}:${snapshotRef}`]);
    }
    return { repository_code: opts.repositoryCode, remote_url: plan.remoteUrl, base_commit: plan.baseCommit, snapshot_commit: snapshotCommit, snapshot_tree: snapshotTree, snapshot_ref: snapshotRef, files: plan.files.map((file) => ({ path: file })) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyHandoverWorkspace(repo: string, manifest: HandoverWorkspaceManifest): string {
  if (git(repo, ['rev-parse', 'HEAD']) !== manifest.snapshot_commit || git(repo, ['rev-parse', 'HEAD^{tree}']) !== manifest.snapshot_tree) throw new DomainError('handover_snapshot_mismatch', '恢复工作区的 Commit 或 Tree 与交接包不一致');
  // Skills are redelivered under current authorization after restoring the code tree.
  // Ignore only their untracked Run-local namespace; tracked edits remain dirty.
  const tracked = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const unmanaged = untracked.filter(file => !/^\.agent\/runs\/[0-9A-HJKMNP-TV-Z]{20}\/\.tsp\/(?:skills\/|skills\.lock\.json$)/.test(file));
  if (tracked || unmanaged.length) throw new DomainError('handover_workspace_dirty', '交接工作区已被修改，拒绝就绪或启动');
  for (const artifact of manifest.required_artifacts ?? []) {
    let content: Buffer;
    if (artifact.kind === 'git') {
      const file = safePath(repo, artifact.path ?? '');
      if (!existsSync(path.join(repo, file))) throw new DomainError('handover_artifact_missing', `必要 Git 材料缺失：${file}`);
      content = readFileSync(path.join(repo, file));
    } else {
      if (artifact.content === undefined) throw new DomainError('handover_artifact_missing', '必要内联材料缺失');
      content = Buffer.from(artifact.content, 'utf8');
    }
    if (artifact.hash && createHash('sha256').update(content).digest('hex') !== artifact.hash.replace(/^sha256:/, '')) throw new DomainError('handover_artifact_mismatch', '必要交接材料的内容哈希不匹配');
  }
  return createHash('sha256').update(`${manifest.repository_code}\n${manifest.snapshot_commit}\n${manifest.snapshot_tree}`).digest('hex');
}

/** Restore into a new detached worktree. A local journal permits only matching, clean retries. */
export function restoreHandoverWorkspace(opts: { repoPath: string; workspacePath: string; manifest: HandoverWorkspaceManifest; attemptCode: string; remoteName?: string }) {
  const repo = path.resolve(opts.repoPath);
  const destination = path.resolve(opts.workspacePath);
  const remote = opts.remoteName ?? 'origin';
  if (normalizedRemote(git(repo, ['remote', 'get-url', remote])) !== normalizedRemote(opts.manifest.remote_url)) throw new DomainError('handover_repository_mismatch', '本地仓库远端与交接仓库不一致');
  if (!/^[a-f0-9]{40,64}$/.test(opts.manifest.snapshot_commit) || !/^[a-f0-9]{40,64}$/.test(opts.manifest.snapshot_tree) || !/^refs\/heads\/acp\/handover\/[A-Za-z0-9_-]+$/.test(opts.manifest.snapshot_ref)) throw new DomainError('handover_manifest_invalid', '交接 Commit、Tree 或引用无效');
  const journal = `${destination}.acp-handover.json`;
  if (existsSync(destination)) {
    if (!existsSync(journal)) throw new DomainError('handover_directory_exists', '目标目录已存在，拒绝覆盖');
    const existing = JSON.parse(readFileSync(journal, 'utf8')) as { attempt_code?: string; snapshot_commit?: string };
    if (existing.attempt_code !== opts.attemptCode || existing.snapshot_commit !== opts.manifest.snapshot_commit) throw new DomainError('handover_journal_conflict', '目录属于另一恢复尝试，拒绝覆盖');
    return { workspace_path: destination, workspace_digest: verifyHandoverWorkspace(destination, opts.manifest), journal_path: journal };
  }
  if (existsSync(journal)) {
    const existing = JSON.parse(readFileSync(journal, 'utf8')) as { attempt_code?: string; snapshot_commit?: string; status?: string };
    if (existing.attempt_code !== opts.attemptCode || existing.snapshot_commit !== opts.manifest.snapshot_commit || existing.status !== 'restoring') throw new DomainError('handover_journal_conflict', '恢复记录属于其他尝试或工作区已丢失，请检查失败现场');
  }
  git(repo, ['fetch', '--no-tags', '--', remote, opts.manifest.snapshot_ref]);
  if (git(repo, ['rev-parse', 'FETCH_HEAD']) !== opts.manifest.snapshot_commit || git(repo, ['rev-parse', `${opts.manifest.snapshot_commit}^{tree}`]) !== opts.manifest.snapshot_tree) throw new DomainError('handover_snapshot_mismatch', '远端交接引用已移动或 Tree 不匹配');
  mkdirSync(path.dirname(destination), { recursive: true });
  if (!existsSync(journal)) writeFileSync(journal, JSON.stringify({ attempt_code: opts.attemptCode, snapshot_commit: opts.manifest.snapshot_commit, status: 'restoring' }, null, 2), { flag: 'wx' });
  git(repo, ['worktree', 'add', '--detach', destination, opts.manifest.snapshot_commit]);
  const digest = verifyHandoverWorkspace(destination, opts.manifest);
  writeFileSync(journal, JSON.stringify({ attempt_code: opts.attemptCode, snapshot_commit: opts.manifest.snapshot_commit, status: 'ready', workspace_digest: digest }, null, 2));
  return { workspace_path: destination, workspace_digest: digest, journal_path: journal };
}
