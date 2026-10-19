import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspace,
  cleanupWorkspace,
  identifyWorkspace,
  parseWorkspaceYaml,
  serializeWorkspaceYaml,
  WORKSPACE_SUBDIRS,
} from '../dist/index.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-ws-test-'));

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** 建一个真实 git 仓库（一个初始 commit），返回 { repo, base } */
function makeRepo(name) {
  const repo = path.join(tmp, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'test@acp.local'], repo);
  git(['config', 'user.name', 'acp-test'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# test\n', 'utf8');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const base = git(['rev-parse', 'HEAD'], repo).stdout.trim();
  return { repo, base };
}

const meta = {
  project_code: '00000000000000000001',
  feature_code: '00000000000000000002',
  task_code: '00000000000000000003',
  run_code: '00000000000000000004',
  workspace_code: '00000000000000000005',
  agent_profile: 'builder',
  project_snapshot: 28,
  git_base: '',
};

test('createWorkspace：目录骨架 + worktree 注册 + workspace.yaml 内容正确', () => {
  const { repo, base } = makeRepo('repo-create');
  const root = path.join(tmp, 'ws-create');
  const result = createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });

  assert.equal(result.repoDir, path.join(root, 'repo'));
  // 标准子目录
  for (const sub of [...WORKSPACE_SUBDIRS]) {
    assert.ok(existsSync(path.join(root, sub)), `缺目录：${sub}`);
  }
  // repo/ 是 git 仓库且位于 base commit
  const isGit = git(['rev-parse', '--is-inside-work-tree'], result.repoDir);
  assert.equal(isGit.status, 0);
  const head = git(['rev-parse', 'HEAD'], result.repoDir).stdout.trim();
  assert.equal(head, base);
  // worktree 已注册（git 输出使用正斜杠，Windows 下统一分隔符比较）
  const list = git(['worktree', 'list'], repo).stdout.replace(/\\/g, '/');
  assert.ok(list.includes(result.repoDir.replace(/\\/g, '/')));
  // workspace.yaml
  const parsed = parseWorkspaceYaml(readFileSync(path.join(root, '.agent', 'workspace.yaml'), 'utf8'));
  assert.equal(parsed.run_code, '00000000000000000004');
  assert.equal(parsed.workspace_code, '00000000000000000005');
  assert.equal(parsed.git_base, base);
  assert.equal(parsed.project_snapshot, 28);
});

test('冲突保护：目录已存在 / 非 git 仓库 / 基线不存在分别拒绝', () => {
  const { repo, base } = makeRepo('repo-conflict');
  const root = path.join(tmp, 'ws-conflict');
  mkdirSync(root, { recursive: true });
  assert.throws(
    () => createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } }),
    (e) => e.code === 'workspace_dir_exists',
  );
  assert.throws(
    () => createWorkspace({ repoPath: tmp, workspaceRoot: path.join(tmp, 'ws-x'), baseCommit: base, meta: { ...meta, git_base: base } }),
    (e) => e.code === 'not_a_git_repo',
  );
  assert.throws(
    () => createWorkspace({ repoPath: repo, workspaceRoot: path.join(tmp, 'ws-y'), baseCommit: 'deadbeef', meta: { ...meta, git_base: 'deadbeef' } }),
    (e) => e.code === 'base_commit_missing',
  );
});

test('identifyWorkspace：从 repo 子目录向上识别 workspace.yaml', () => {
  const { repo, base } = makeRepo('repo-identify');
  const root = path.join(tmp, 'ws-identify');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  const found = identifyWorkspace(path.join(root, 'repo', 'src'));
  assert.ok(found);
  assert.equal(found.workspaceRoot, root);
  assert.equal(found.meta.task_code, '00000000000000000003');
  assert.equal(identifyWorkspace(tmp), null);
});

test('cleanup dry-run：报告动作但不删除、不落 patch', () => {
  const { repo, base } = makeRepo('repo-dryrun');
  const root = path.join(tmp, 'ws-dryrun');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  const recycle = path.join(tmp, 'recycle-dryrun');
  const result = cleanupWorkspace({ workspaceRoot: root, recycleDir: recycle, dryRun: true, isReferenced: () => false });
  assert.equal(result.decision, 'recyclable');
  assert.deepEqual(result.actions, ['move_to_recycle', 'git_worktree_prune']);
  assert.ok(existsSync(root)); // 未删除
  assert.ok(!existsSync(recycle));
});

test('cleanup：未提交变更先 Patch 保护再移入回收区（不变量 7）', () => {
  const { repo, base } = makeRepo('repo-patch');
  const root = path.join(tmp, 'ws-patch');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  // 制造未提交变更（修改已跟踪文件，diff 可捕获；untracked 文件由回收区目录整体保留）
  writeFileSync(path.join(root, 'repo', 'README.md'), '# test\nuncommitted\n', 'utf8');
  writeFileSync(path.join(root, 'repo', 'dirty-untracked.txt'), 'untracked', 'utf8');
  const recycle = path.join(tmp, 'recycle-patch');
  const result = cleanupWorkspace({ workspaceRoot: root, recycleDir: recycle, isReferenced: () => false });
  assert.equal(result.decision, 'recyclable');
  assert.ok(result.actions.includes('save_patch'));
  assert.ok(result.patchPath);
  assert.ok(existsSync(result.patchPath), 'patch 应已保存');
  assert.match(readFileSync(result.patchPath, 'utf8'), /uncommitted/);
  assert.ok(result.recycleTarget && existsSync(result.recycleTarget), '工作区应移入回收区');
  assert.ok(!existsSync(root), '原目录应消失');
  // 回收区里保留了文件（可恢复）
  assert.ok(existsSync(path.join(result.recycleTarget, 'repo', 'dirty-untracked.txt')));
});

test('cleanup：被引用时 block 且不删除（不变量 7 引用检查）', () => {
  const { repo, base } = makeRepo('repo-referenced');
  const root = path.join(tmp, 'ws-referenced');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  const result = cleanupWorkspace({ workspaceRoot: root, recycleDir: path.join(tmp, 'r'), isReferenced: () => true });
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.actions, ['blocked_by_reference']);
  assert.ok(existsSync(root));
});

test('cleanup：引用检查抛异常 fail closed（review 阻断 6），--force 显式覆盖', () => {
  const { repo, base } = makeRepo('repo-failclosed');
  const root = path.join(tmp, 'ws-failclosed');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  const recycle = path.join(tmp, 'recycle-failclosed');
  // db 不可用：查询抛异常 → 清理被拒绝
  assert.throws(
    () => cleanupWorkspace({ workspaceRoot: root, recycleDir: recycle, isReferenced: () => { throw new Error('db down'); } }),
    /db down/,
  );
  assert.ok(existsSync(root), 'fail closed：不得继续清理');
  // --force 显式覆盖
  const forced = cleanupWorkspace({ workspaceRoot: root, recycleDir: recycle, isReferenced: () => { throw new Error('db down'); }, force: true });
  assert.equal(forced.decision, 'recyclable');
  assert.ok(!existsSync(root));
});

test('cleanup：非 ACP 目录（缺 marker）拒绝清理（review 阻断 6）', () => {
  const plain = path.join(tmp, 'plain-dir');
  mkdirSync(plain, { recursive: true });
  assert.throws(
    () => cleanupWorkspace({ workspaceRoot: plain, recycleDir: path.join(tmp, 'r'), isReferenced: () => false }),
    (e) => e.code === 'workspace_marker_missing',
  );
  assert.ok(existsSync(plain));
});

test('cleanup：回收区位于工作区内部被拒绝（rename 循环防护）', () => {
  const { repo, base } = makeRepo('repo-recycle-inside');
  const root = path.join(tmp, 'ws-recycle-inside');
  createWorkspace({ repoPath: repo, workspaceRoot: root, baseCommit: base, meta: { ...meta, git_base: base } });
  assert.throws(
    () => cleanupWorkspace({ workspaceRoot: root, recycleDir: path.join(root, 'cache'), isReferenced: () => false }),
    (e) => e.code === 'recycle_dir_inside_workspace',
  );
});

test('workspace.yaml 序列化/解析往返', () => {
  const yaml = serializeWorkspaceYaml({ ...meta, git_base: 'abc123' });
  assert.ok(yaml.includes('run_code: 00000000000000000004'));
  const parsed = parseWorkspaceYaml(yaml);
  assert.equal(parsed.run_code, '00000000000000000004');
  assert.equal(parsed.git_base, 'abc123');
  assert.throws(() => parseWorkspaceYaml('run_code: X'), (e) => e.code === 'workspace_yaml_invalid');
});

test('workspace.yaml：可读取历史 *_id 文件但新序列化只写 *_code', () => {
  const legacy = [
    'project_id: PROJECT-A',
    'feature_id: FEATURE-12',
    'task_id: TASK-301',
    'run_id: RUN-201',
    'workspace_id: WS-301',
    'agent_profile: builder',
    'project_snapshot: 28',
    'git_base: abc123',
    '',
  ].join('\n');
  const parsed = parseWorkspaceYaml(legacy);
  assert.equal(parsed.project_code, 'PROJECT-A');
  assert.equal(parsed.run_code, 'RUN-201');
});

test('teardown：清理临时目录', () => {
  rmSync(tmp, { recursive: true, force: true });
  assert.ok(!existsSync(tmp));
});
