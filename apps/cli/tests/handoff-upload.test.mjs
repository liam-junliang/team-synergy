import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectHandoffUploadPlan, inferHandoffKind } from '../dist/handoff-upload.js';

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'acp-handoff-upload-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test('交接上传计划递归保留文件夹结构并只收集文档文件', () => {
  const source = path.join(fixtureRoot, '交接资料');
  const apiDirectory = path.join(source, '接口与联调', '前后端对接');
  const deployDirectory = path.join(source, '部署与环境');
  mkdirSync(apiDirectory, { recursive: true });
  mkdirSync(deployDirectory, { recursive: true });
  mkdirSync(path.join(source, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(path.join(apiDirectory, 'login.md'), '# 登录接口协议\n\n说明登录与刷新令牌约定。', 'utf8');
  writeFileSync(path.join(deployDirectory, 'production.markdown'), '# 生产部署\n\n部署前先完成数据库迁移。', 'utf8');
  writeFileSync(path.join(source, 'not-a-document.json'), '{}', 'utf8');
  writeFileSync(path.join(source, 'node_modules', 'ignored', 'bad.md'), '# 不应上传', 'utf8');

  const plan = collectHandoffUploadPlan(source);

  assert.equal(plan.source_type, 'directory');
  assert.equal(plan.root_name, '交接资料');
  assert.equal(plan.directories.length, 3);
  assert.equal(plan.documents.length, 2);
  assert.deepEqual(plan.documents.map((item) => item.title).sort(), ['生产部署', '登录接口协议']);
  assert.equal(plan.documents.find((item) => item.title === '登录接口协议')?.inferred_kind, 'api');
  assert.equal(plan.documents.find((item) => item.title === '生产部署')?.inferred_kind, 'doc');
});

test('单文件上传从一级标题生成标题并自动识别类型', () => {
  const file = path.join(fixtureRoot, 'release-notes.md');
  writeFileSync(file, '# 版本交付清单\n\n包含发布步骤与回滚提醒。', 'utf8');

  const plan = collectHandoffUploadPlan(file);

  assert.equal(plan.source_type, 'file');
  assert.equal(plan.documents[0].title, '版本交付清单');
  assert.equal(plan.documents[0].inferred_kind, 'doc');
  assert.match(plan.documents[0].summary, /发布步骤/);
  assert.equal(inferHandoffKind('接口与联调/前后端对接/login.md'), 'api');
});

test('上传按内容类型归类，原部署运维用途不再作为文档类型', () => {
  for (const file of ['integration.md', 'deployment.md', 'database.md', 'operations.md', 'release.md']) {
    assert.equal(inferHandoffKind(file), 'doc');
  }
  assert.equal(inferHandoffKind('architecture/diagram.md'), 'diagram');
  assert.equal(inferHandoffKind('系统架构图.md'), 'diagram');
  assert.equal(inferHandoffKind('notes.md', '# 架构\n\n```mermaid\nflowchart LR\nA --> B\n```'), 'diagram');
  assert.equal(inferHandoffKind('api.md', '```mermaid\nsequenceDiagram\nA->>B: Login\n```'), 'api');
  const file = path.join(fixtureRoot, 'flow.md');
  writeFileSync(file, '# 流程\n\n```mermaid\nflowchart LR\nA --> B\n```', 'utf8');
  assert.equal(collectHandoffUploadPlan(file).documents[0].inferred_kind, 'diagram');
});

test('原始图源引导使用架构命令，不当作 Markdown 丢失格式', () => {
  const file = path.join(fixtureRoot, 'system.mmd');
  writeFileSync(file, 'flowchart LR\nA --> B', 'utf8');
  assert.throws(() => collectHandoffUploadPlan(file), /tsp architecture create/);
});
