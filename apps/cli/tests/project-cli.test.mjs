import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { schema } from '@team-synergy/persistence';
import {
  cloneRepository,
  finalizeProjectWorkspaceBinding,
  localRepositoryStatus,
  prepareProjectWorkspace,
} from '../dist/project-workspace.js';
import {
  createHttpTestContext,
  insertMember,
  insertProject,
  insertTeam,
  insertUser,
  testCode,
} from './http-test-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, '../dist/index.js');

test('project bind/current：写入当前目录并可从子目录向上识别', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'acp-project-bind-'));
  try {
    const env = { ...process.env, ACP_API_URL: 'http://127.0.0.1:8080', ACP_PRINCIPAL_CODE: '00000000000000000009' };
    const bound = spawnSync(process.execPath, [cliEntry, 'project', 'bind', '00000000000000000001'], {
      cwd: directory, encoding: 'utf8', env,
    });
    assert.equal(bound.status, 0, bound.stderr || bound.stdout);
    const boundResult = JSON.parse(bound.stdout);
    assert.equal(boundResult.ok, true);
    assert.equal(boundResult.data.binding.project_code, '00000000000000000001');
    assert.equal(boundResult.data.binding.api_url, 'http://127.0.0.1:8080');

    const bindingPath = path.join(directory, '.agent', 'bound-project.yaml');
    assert.equal(existsSync(bindingPath), true);
    const yaml = readFileSync(bindingPath, 'utf8');
    assert.match(yaml, /project_code: "00000000000000000001"/);
    assert.match(yaml, /api_url: "http:\/\/127\.0\.0\.1:8080"/);

    const child = path.join(directory, 'src', 'nested');
    mkdirSync(child, { recursive: true });
    const current = spawnSync(process.execPath, [cliEntry, 'project', 'current'], {
      cwd: child, encoding: 'utf8', env,
    });
    assert.equal(current.status, 0, current.stderr || current.stdout);
    const currentResult = JSON.parse(current.stdout);
    assert.equal(currentResult.ok, true);
    assert.equal(currentResult.data.path, bindingPath);
    assert.deepEqual(currentResult.data.binding, boundResult.data.binding);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('project workspace：根 Git 忽略 code，按需 clone 保留独立代码仓库 Git', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'acp-project-workspace-'));
  const source = mkdtempSync(path.join(os.tmpdir(), 'acp-project-repository-'));
  try {
    const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(git(source, ['init', '-b', 'main']).status, 0);
    assert.equal(git(source, ['config', 'user.email', 'workspace@test']).status, 0);
    assert.equal(git(source, ['config', 'user.name', 'Workspace Test']).status, 0);
    writeFileSync(path.join(source, 'README.md'), '# source\n', 'utf8');
    assert.equal(git(source, ['add', '-A']).status, 0);
    assert.equal(git(source, ['commit', '-m', 'base']).status, 0);

    const prepared = prepareProjectWorkspace(directory);
    assert.equal(prepared.git_initialized, true);
    finalizeProjectWorkspaceBinding(directory, '00000000000000000001', '00000000000000000002', 'http://127.0.0.1:8080');
    const ignoreFile = readFileSync(path.join(directory, '.gitignore'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(ignoreFile, /^\/code\/$/m);
    assert.match(ignoreFile, /^\/\.agent\/bound-project\.yaml$/m);
    assert.equal(git(directory, ['check-ignore', '.tsp/skills/review/SKILL.md']).status, 0);
    assert.equal(git(directory, ['check-ignore', '.tsp/skills.lock.json']).status, 1, 'The metadata lock remains versionable');
    const repository = {
      repository_code: '00000000000000000003',
      project_code: '00000000000000000001',
      name: 'Source Repository',
      purpose: null,
      remote_url: source,
      default_branch: 'main',
      status: 'active',
    };
    assert.throws(
      () => cloneRepository(directory, repository, '../outside-code-space'),
      (error) => error?.code === 'repository_clone_target_outside_code_space',
    );
    const cloned = cloneRepository(directory, repository, 'code/source');
    assert.equal(existsSync(path.join(cloned.clone_path, '.git')), true);
    assert.equal(readFileSync(path.join(cloned.clone_path, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# source\n');
    assert.equal(git(directory, ['status', '--porcelain']).stdout.includes('code/source'), false);
    assert.deepEqual(localRepositoryStatus(directory, [repository]).map(({ checkout_status, dirty }) => ({ checkout_status, dirty })), [
      { checkout_status: 'ready', dirty: false },
    ]);
    assert.equal(git(cloned.clone_path, ['remote', 'set-url', 'origin', 'https://example.com/other.git']).status, 0);
    assert.equal(localRepositoryStatus(directory, [repository])[0]?.checkout_status, 'remote_mismatch');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});

test('handoff upload：通过 HTTP 递归创建云端目录并上传 Markdown 文档', async () => {
  const context = await createHttpTestContext(import.meta.url);
  try {
    const user = await insertUser(context.db, { code: testCode(61), account: 'handoff-uploader', displayName: 'Handoff Uploader' });
    const team = await insertTeam(context.db, { code: testCode(62), name: 'Handoff Team' });
    const project = await insertProject(context.db, { code: testCode(63), teamId: team.id, name: 'Handoff Project' });
    await insertMember(context.db, { principalId: user.id, projectId: project.id, role: 'owner', displayName: user.display_name });

    const source = path.join(context.tmp, '交接资料');
    const apiDirectory = path.join(source, '接口与联调');
    mkdirSync(apiDirectory, { recursive: true });
    writeFileSync(path.join(source, 'README.md'), '# 交接总览\n\n项目交接入口。', 'utf8');
    writeFileSync(path.join(apiDirectory, 'login-api.md'), '# 登录接口\n\nPOST /auth/login', 'utf8');

    const uploaded = await context.runCli(
      ['handoff', 'upload', source, '--project', project.code, '--kind', 'auto'],
      { ACP_PRINCIPAL_CODE: user.code },
    );
    assert.equal(uploaded.status, 0, uploaded.err || uploaded.out);
    const result = JSON.parse(uploaded.out);
    assert.equal(result.ok, true);
    assert.equal(result.data.folders_created, 2);
    assert.equal(result.data.documents_created, 2);

    const folders = await context.db.select().from(schema.projectDocumentFolders);
    const documents = await context.db.select().from(schema.projectDocuments);
    assert.deepEqual(folders.map((item) => item.name).sort(), ['交接资料', '接口与联调', '架构设计', '测试资料', '需求文档', '项目规范']);
    const standardsFolder = folders.find(item => item.system_role === 'standards');
    assert.ok(standardsFolder);
    assert.equal(standardsFolder.parent_id, null);
    assert.ok(documents.every(item => item.folder_id !== standardsFolder.id), '普通上传不得自动变为项目规范');
    const requirementsFolder = folders.find(item => item.system_role === 'requirements');
    assert.ok(requirementsFolder);
    assert.equal(requirementsFolder.parent_id, null);
    assert.ok(documents.every(item => item.folder_id !== requirementsFolder.id), '普通上传不得进入需求文档关联目录');
    const architectureFolder = folders.find(item => item.system_role === 'architecture');
    assert.ok(architectureFolder);
    assert.equal(architectureFolder.parent_id, null);
    assert.ok(documents.every(item => item.folder_id !== architectureFolder.id), '普通上传不得进入架构设计关联目录');
    assert.deepEqual(documents.map((item) => [item.title, item.kind]).sort(), [
      ['交接总览', 'doc'],
      ['登录接口', 'api'],
    ]);
  } finally {
    await context.cleanup();
  }
});
