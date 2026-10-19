import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { DomainError, cleanupDecision, type CleanupDecision } from '@team-synergy/domain';
import { serializeWorkspaceYaml, parseWorkspaceYaml, type WorkspaceMeta } from './workspace-yaml.js';

/**
 * 原生 Git Worktree 工作区（docs/04/07）：
 * - 创建：worktree add --detach + 标准目录骨架 + .agent/workspace.yaml + 冲突保护；
 * - 清理：引用检查 → 未提交变更 Patch 保护 → 移入回收区（可恢复删除，架构不变量 7）。
 */

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

export const WORKSPACE_SUBDIRS = ['project-state', 'inputs', 'private', 'outbox', 'cache', 'logs', '.agent'] as const;

export interface CreateWorkspaceOptions {
  /** 主仓库路径（必须已是 git 仓库） */
  repoPath: string;
  /** Run 工作区根目录（必须不存在——冲突保护） */
  workspaceRoot: string;
  /** git 基线提交（必须存在） */
  baseCommit: string;
  /** workspace.yaml 元数据 */
  meta: WorkspaceMeta;
}

export interface CreateWorkspaceResult {
  workspaceRoot: string;
  repoDir: string;
  meta: WorkspaceMeta;
}

export function createWorkspace(opts: CreateWorkspaceOptions): CreateWorkspaceResult {
  // 冲突保护 1：目标目录已存在
  if (existsSync(opts.workspaceRoot)) {
    throw new DomainError('workspace_dir_exists', '工作区目录已存在，拒绝覆盖（冲突保护）', {
      path: opts.workspaceRoot,
    });
  }
  // 主仓库校验
  const isRepo = git(['rev-parse', '--is-inside-work-tree'], opts.repoPath);
  if (!isRepo.ok) {
    throw new DomainError('not_a_git_repo', `不是 git 仓库：${opts.repoPath}`);
  }
  // 基线提交存在
  const hasCommit = git(['cat-file', '-e', `${opts.baseCommit}^{commit}`], opts.repoPath);
  if (!hasCommit.ok) {
    throw new DomainError('base_commit_missing', `基线提交不存在：${opts.baseCommit}`);
  }

  mkdirSync(opts.workspaceRoot, { recursive: true });
  const repoDir = path.join(opts.workspaceRoot, 'repo');

  const wt = git(['worktree', 'add', '--detach', repoDir, opts.baseCommit], opts.repoPath);
  if (!wt.ok) {
    // 回滚：不留半成品目录
    rmSync(opts.workspaceRoot, { recursive: true, force: true });
    throw new DomainError('worktree_add_failed', `git worktree add 失败：${wt.stderr.trim()}`);
  }

  for (const sub of WORKSPACE_SUBDIRS) {
    mkdirSync(path.join(opts.workspaceRoot, sub), { recursive: true });
  }
  writeFileSync(path.join(opts.workspaceRoot, '.agent', 'workspace.yaml'), serializeWorkspaceYaml(opts.meta), 'utf8');

  return { workspaceRoot: opts.workspaceRoot, repoDir, meta: opts.meta };
}

export interface CleanupWorkspaceOptions {
  workspaceRoot: string;
  recycleDir: string;
  dryRun?: boolean;
  /**
   * 引用检查：返回 true 表示工作区仍被引用（活动 Run/发布/人工固定），禁止清理。
   * 查询失败必须抛异常（fail closed）——调用方（CLI）用显式 --force 覆盖。
   */
  isReferenced: () => boolean;
  /** 显式高风险覆盖：跳过引用检查（仅在 db 不可用时由人确认） */
  force?: boolean;
}

export interface CleanupWorkspaceResult {
  decision: CleanupDecision;
  actions: string[];
  patchPath?: string;
  recycleTarget?: string;
}

export function cleanupWorkspace(opts: CleanupWorkspaceOptions): CleanupWorkspaceResult {
  if (!existsSync(opts.workspaceRoot)) {
    throw new DomainError('workspace_not_found', `工作区不存在：${opts.workspaceRoot}`);
  }

  // workspace marker 校验（review 阻断 6）：只清理真正的 ACP 工作区
  const markerPath = path.join(opts.workspaceRoot, '.agent', 'workspace.yaml');
  if (!existsSync(markerPath)) {
    throw new DomainError('workspace_marker_missing', '目录不是 ACP 工作区（缺少 .agent/workspace.yaml），拒绝清理');
  }
  try {
    parseWorkspaceYaml(readFileSync(markerPath, 'utf8'));
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('workspace_marker_invalid', 'workspace.yaml 无法解析，拒绝清理');
  }
  // 回收区越界防护：recycleDir 不得位于 workspaceRoot 内部（rename 循环/吞没）
  const rel = path.relative(path.resolve(opts.workspaceRoot), path.resolve(opts.recycleDir));
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new DomainError('recycle_dir_inside_workspace', '回收区不能位于工作区内部', {
      workspaceRoot: opts.workspaceRoot,
      recycleDir: opts.recycleDir,
    });
  }

  const repoDir = path.join(opts.workspaceRoot, 'repo');
  const status = git(['status', '--porcelain'], repoDir);
  const dirty = status.ok && status.stdout.trim().length > 0;

  // 主仓库定位（--git-common-dir 输出 <mainRepo>/.git；prune 需以主仓库为 cwd）
  const common = git(['rev-parse', '--git-common-dir'], repoDir);
  const mainRepo = common.ok ? path.resolve(common.stdout.trim(), '..') : repoDir;

  // 架构不变量 7：引用检查 → Patch 保护 → 可恢复删除（三段判定来自 domain）。
  // 引用检查异常直接传播（fail closed），--force 显式覆盖。
  let referenced = false;
  if (!opts.force) {
    referenced = opts.isReferenced(); // 抛异常则 fail closed
  }
  const decision = cleanupDecision({
    referencedByActive: referenced ? ['active'] : [],
    hasUncommittedChanges: dirty,
    patchSaved: false,
  });

  if (decision === 'block') {
    return { decision, actions: ['blocked_by_reference'] };
  }

  const actions: string[] = [];
  let patchPath: string | undefined;

  if (dirty) {
    actions.push('save_patch');
    if (!opts.dryRun) {
      mkdirSync(opts.recycleDir, { recursive: true });
      const base = path.basename(opts.workspaceRoot);
      patchPath = path.join(opts.recycleDir, `${base}.patch`);
      const diff = git(['diff', '--binary'], repoDir);
      writeFileSync(patchPath, diff.stdout, 'utf8');
    }
  }

  actions.push('move_to_recycle', 'git_worktree_prune');
  if (opts.dryRun) {
    return { decision: 'recyclable', actions, patchPath };
  }

  // 可恢复删除：先整体移入回收区（同卷 rename，保留全部内容包括 untracked），
  // 再注销 worktree 注册（git worktree prune 自动清理已消失路径）。
  mkdirSync(opts.recycleDir, { recursive: true });
  const recycleTarget = path.join(opts.recycleDir, `${path.basename(opts.workspaceRoot)}-${Date.now()}`);
  renameSync(opts.workspaceRoot, recycleTarget);
  git(['worktree', 'prune'], mainRepo);

  return { decision: 'recyclable', actions, patchPath, recycleTarget };
}

/** 便捷读取：回收区里的 patch 内容 */
export function readPatch(patchPath: string): string {
  return readFileSync(patchPath, 'utf8');
}
