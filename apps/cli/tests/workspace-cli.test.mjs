import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, '../dist/index.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'acp-ws-cli-'));

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

test('CLI：workspace create → identify → cleanup --dry-run 全链路', () => {
  // 建临时主仓库
  const repo = path.join(tmp, 'main');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@acp.local'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(path.join(repo, 'a.txt'), 'x', 'utf8');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  const base = git(['rev-parse', 'HEAD'], repo).stdout.trim();

  const root = path.join(tmp, 'ws');
  const create = spawnSync(
    process.execPath,
    [cliEntry, 'workspace', 'create', '--repo', repo, '--base', base, '--task', '00000000000000000003', '--run', '00000000000000000004', '--workspace', '00000000000000000005', '--feature', '00000000000000000002', '--project', '00000000000000000001', '--profile', 'builder', '--snapshot', '28', '--root', root],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(create.status, 0, create.stderr);
  const created = JSON.parse(create.stdout);
  assert.equal(created.ok, true);
  assert.ok(existsSync(path.join(root, '.agent', 'workspace.yaml')));

  // identify：从 repo 子目录向上识别
  const identify = spawnSync(process.execPath, [cliEntry, 'workspace', 'identify', '--dir', path.join(root, 'repo')], { encoding: 'utf8', env: process.env });
  assert.equal(identify.status, 0);
  const identified = JSON.parse(identify.stdout);
  assert.equal(identified.ok, true);
  assert.equal(identified.data.meta.run_code, '00000000000000000004');

  // cleanup --dry-run：不删除（HTTP-only 时代需 --force 跳过引用检查）
  const dryRun = spawnSync(
    process.execPath,
    [cliEntry, 'workspace', 'cleanup', '--root', root, '--recycle-dir', path.join(tmp, 'recycle'), '--dry-run', '--force'],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dry = JSON.parse(dryRun.stdout);
  assert.equal(dry.ok, true);
  assert.equal(dry.data.decision, 'recyclable');
  assert.ok(existsSync(root));

  // 真实 cleanup：移入回收区
  const cleanup = spawnSync(
    process.execPath,
    [cliEntry, 'workspace', 'cleanup', '--root', root, '--recycle-dir', path.join(tmp, 'recycle'), '--force'],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const cleaned = JSON.parse(cleanup.stdout);
  assert.equal(cleaned.ok, true);
  assert.ok(!existsSync(root), '原目录应消失');
  assert.ok(existsSync(cleaned.data.recycleTarget), '回收区应有目录');
});

test('CLI：workspace create 目录冲突返回结构化错误', () => {
  const dir = path.join(tmp, 'conflict');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'x.txt'), 'x', 'utf8');
  const res = spawnSync(
    process.execPath,
    [cliEntry, 'workspace', 'create', '--repo', dir, '--base', 'deadbeef', '--task', '00000000000000000003', '--run', '00000000000000000004', '--workspace', '00000000000000000005', '--feature', '00000000000000000002', '--project', '00000000000000000001', '--profile', 'builder', '--root', dir],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'workspace_dir_exists');
});

test('teardown：清理临时目录', () => {
  rmSync(tmp, { recursive: true, force: true });
});
