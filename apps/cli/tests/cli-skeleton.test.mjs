import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, '../dist/index.js');

test('tsp 主入口和 agentctl、acp 兼容入口指向同一 CLI', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.equal(manifest.bin.tsp, 'dist/index.js');
  assert.equal(manifest.bin.agentctl, manifest.bin.tsp);
  assert.equal(manifest.bin.acp, manifest.bin.tsp);
});

test('tsp --version 输出 0.1.0', () => {
  const res = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /0\.1\.0/);
});

test('tsp --help 输出主命令名、docs 文档组与描述', () => {
  const res = spawnSync(process.execPath, [cliEntry, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Usage: tsp /);
  assert.match(res.stdout, /Team Synergy CLI/);
  assert.match(res.stdout, /module\s+项目功能模块/);
  assert.match(res.stdout, /phase\s+项目阶段/);
  assert.match(res.stdout, /milestone\s+项目里程碑/);
  assert.match(res.stdout, /design\s+视觉与交互原型/);
  assert.match(res.stdout, /docs\|handoff\s+项目文档库/);
  assert.match(res.stdout, /idea\s+想法池/);
  assert.match(res.stdout, /topic\s+需求议题/);
});

test('需求发现 CLI 覆盖想法、议题决策与文档 Revision 评审', () => {
  const idea = spawnSync(process.execPath, [cliEntry, 'idea', 'create', '--help'], { encoding: 'utf8' });
  const topic = spawnSync(process.execPath, [cliEntry, 'topic', 'decide', '--help'], { encoding: 'utf8' });
  const feedback = spawnSync(process.execPath, [cliEntry, 'topic', 'feedback', '--help'], { encoding: 'utf8' });
  const review = spawnSync(process.execPath, [cliEntry, 'requirement-doc', 'review-vote', '--help'], { encoding: 'utf8' });
  assert.equal(idea.status, 0);
  assert.match(idea.stdout, /--title <title>/);
  assert.match(idea.stdout, /--source <source>/);
  assert.equal(topic.status, 0);
  assert.match(topic.stdout, /--supersedes <entry_code>/);
  assert.equal(feedback.status, 0);
  assert.match(feedback.stdout, /--source-code <code>/);
  assert.equal(review.status, 0);
  assert.match(review.stdout, /support \/ changes_requested \/ abstain/);
});

test('docs 支持多级文件夹、接口文档上传、检索、修订与导出', () => {
  const folder = spawnSync(process.execPath, [cliEntry, 'docs', 'folder-create', '--help'], { encoding: 'utf8' });
  const create = spawnSync(process.execPath, [cliEntry, 'docs', 'create', '--help'], { encoding: 'utf8' });
  const upload = spawnSync(process.execPath, [cliEntry, 'docs', 'upload', '--help'], { encoding: 'utf8' });
  const revise = spawnSync(process.execPath, [cliEntry, 'docs', 'revise', '--help'], { encoding: 'utf8' });
  const show = spawnSync(process.execPath, [cliEntry, 'docs', 'show', '--help'], { encoding: 'utf8' });
  assert.equal(folder.status, 0);
  assert.match(folder.stdout, /--parent <folder_code>/);
  assert.equal(create.status, 0);
  assert.match(create.stdout, /--folder <folder_code>/);
  assert.match(create.stdout, /--kind <kind>/);
  assert.match(create.stdout, /--file <path>/);
  assert.equal(upload.status, 0);
  assert.match(upload.stdout, /<path>/);
  assert.match(upload.stdout, /递归上传文件夹/);
  assert.match(upload.stdout, /--folder <folder_code>/);
  assert.match(upload.stdout, /auto \/ doc \/ api \/ diagram/);
  assert.match(create.stdout, /doc \/ api \/ diagram/);
  assert.match(create.stdout, /default:\s+"doc"/);
  assert.match(folder.stdout, /系统文件夹不允许子文件夹/);
  assert.equal(revise.status, 0);
  assert.match(revise.stdout, /<document_code>/);
  assert.match(revise.stdout, /--change <summary>/);
  assert.equal(show.status, 0);
  assert.match(show.stdout, /--output <path>/);
});

test('handoff 兼容别名提供与 docs 相同的全部子命令和选项', () => {
  for (const command of [[], ['list'], ['search'], ['show'], ['folder-create'], ['folder-update'], ['create'], ['upload'], ['revise']]) {
    const current = spawnSync(process.execPath, [cliEntry, 'docs', ...command, '--help'], { encoding: 'utf8' });
    const legacy = spawnSync(process.execPath, [cliEntry, 'handoff', ...command, '--help'], { encoding: 'utf8' });
    assert.equal(current.status, 0);
    assert.equal(legacy.status, 0);
    assert.equal(legacy.stdout, current.stdout);
    assert.match(current.stdout, /^Usage: tsp docs/);
  }
});

test('设计原型 CLI 支持视觉 HTML 与配套 Markdown 的上传、修订和导出', () => {
  const create = spawnSync(process.execPath, [cliEntry, 'design', 'create', '--help'], { encoding: 'utf8' });
  const revise = spawnSync(process.execPath, [cliEntry, 'design', 'revise', '--help'], { encoding: 'utf8' });
  const show = spawnSync(process.execPath, [cliEntry, 'design', 'show', '--help'], { encoding: 'utf8' });
  assert.equal(create.status, 0);
  assert.match(create.stdout, /--file <path>/);
  assert.match(create.stdout, /--notes-file <path>/);
  assert.match(create.stdout, /--requirements <codes>/);
  assert.equal(revise.status, 0);
  assert.match(revise.stdout, /<prototype_code>/);
  assert.match(revise.stdout, /--change <summary>/);
  assert.match(revise.stdout, /--notes-file <path>/);
  assert.equal(show.status, 0);
  assert.match(show.stdout, /--output <path>/);
  assert.match(show.stdout, /--notes-output <path>/);
});

test('功能结构与项目计划子命令公开 code-only 参数', () => {
  const feature = spawnSync(process.execPath, [cliEntry, 'feature', 'update', '--help'], { encoding: 'utf8' });
  const requirement = spawnSync(process.execPath, [cliEntry, 'requirement', 'create', '--help'], { encoding: 'utf8' });
  const phase = spawnSync(process.execPath, [cliEntry, 'phase', 'update', '--help'], { encoding: 'utf8' });
  const milestone = spawnSync(process.execPath, [cliEntry, 'milestone', 'update', '--help'], { encoding: 'utf8' });
  assert.equal(feature.status, 0);
  assert.match(feature.stdout, /<feature_code>/);
  assert.match(feature.stdout, /--module <module_code>/);
  assert.match(feature.stdout, /--milestone <milestone_code>/);
  assert.match(feature.stdout, /--start-date <date>/);
  assert.match(feature.stdout, /--end-date <date>/);
  assert.match(feature.stdout, /--clear-start-date/);
  assert.match(feature.stdout, /--clear-end-date/);
  assert.equal(requirement.status, 0);
  assert.match(requirement.stdout, /--module <module_code>/);
  assert.match(requirement.stdout, /--feature <feature_code>/);
  assert.doesNotMatch(requirement.stdout, /required.*--feature/i);
  assert.equal(phase.status, 0);
  assert.match(phase.stdout, /--start-date <date>/);
  assert.match(phase.stdout, /--end-date <date>/);
  assert.match(phase.stdout, /--clear-start-date/);
  assert.equal(milestone.status, 0);
  assert.match(milestone.stdout, /--start-date <date>/);
  assert.match(milestone.stdout, /--target-date <date>/);
  assert.match(milestone.stdout, /--clear-target-date/);
});

test('外部 Agent 可以通过 task attach 绑定平台 Run', () => {
  const attached = spawnSync(process.execPath, [cliEntry, 'task', 'attach', '--help'], { encoding: 'utf8' });
  assert.equal(attached.status, 0);
  assert.match(attached.stdout, /<task_code>/);
  assert.match(attached.stdout, /--profile <profile>/);
  assert.match(attached.stdout, /--workspace <path>/);
  assert.match(attached.stdout, /外部编排器/);
});

test('任务契约支持 brief 文件并在执行前更新', () => {
  const create = spawnSync(process.execPath, [cliEntry, 'task', 'create', '--help'], { encoding: 'utf8' });
  const update = spawnSync(process.execPath, [cliEntry, 'task', 'update', '--help'], { encoding: 'utf8' });
  assert.equal(create.status, 0);
  assert.match(create.stdout, /--brief-file <path>/);
  assert.equal(update.status, 0);
  assert.match(update.stdout, /<task_code>/);
  assert.match(update.stdout, /--brief-file <path>/);
  assert.match(update.stdout, /执行前/);
});
