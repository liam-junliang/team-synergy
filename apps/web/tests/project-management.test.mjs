import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canProject, moveItemByCode, moveItemByOffset, projectCreatePayload, projectUpdatePayload, roleMeta, sortProjects, supportsProjectMemberManagement } from '../src/projectManagement.ts';

test('项目列表：Owner 项目优先，其余按名称稳定排序且不修改原数组', () => {
  const projects = [
    { code: 'PROJECT-B', name: 'Zulu', role: 'member' },
    { code: 'PROJECT-C', name: 'Alpha', role: 'owner' },
    { code: 'PROJECT-A', name: 'Alpha', role: 'member' },
  ];
  const sorted = sortProjects(projects);

  assert.deepEqual(sorted.map((project) => project.code), ['PROJECT-C', 'PROJECT-A', 'PROJECT-B']);
  assert.deepEqual(projects.map((project) => project.code), ['PROJECT-B', 'PROJECT-C', 'PROJECT-A']);
});

test('角色标签：已知角色映射状态色，未知角色保留原值', () => {
  assert.deepEqual(roleMeta('owner'), { label: '负责人', color: 'bg-amber-100 text-amber-800' });
  assert.deepEqual(roleMeta('member'), { label: '成员', color: 'bg-cyan-100 text-cyan-700' });
  assert.equal(roleMeta('observer').label, 'observer');
  assert.equal(roleMeta('').label, '成员');
});

test('项目接口：创建和更新提交名称与简介，成员管理基于 code', () => {
  assert.deepEqual(projectCreatePayload({ team_code: 'ABCDEFGHIJKLMNOPQRST', name: '  Demo  ', description: '  项目简介  ' }), {
    team_code: 'ABCDEFGHIJKLMNOPQRST',
    name: 'Demo',
    description: '项目简介',
    member_policy: 'team_read',
  });
  assert.deepEqual(projectUpdatePayload({ name: '  Demo Renamed  ', description: '  新简介  ' }), { name: 'Demo Renamed', description: '新简介' });
  assert.deepEqual(projectUpdatePayload({ name: 'Demo', description: '   ' }), { name: 'Demo', description: null });
  assert.equal(supportsProjectMemberManagement({ code: 'ABCDEFGHIJKLMNOPQRST' }), true);
  assert.equal(supportsProjectMemberManagement({ project_code: 'TBP8SXKNJ092Y9086176' }), true);
  assert.equal(supportsProjectMemberManagement({ members_count: 0 }), true);
  assert.equal(supportsProjectMemberManagement({}), false);
});

test('团队与项目排序：拖到目标位置或键盘上下移动，不修改原数组', () => {
  const items = [{ code: 'A' }, { code: 'B' }, { code: 'C' }];
  assert.deepEqual(moveItemByCode(items, 'C', 'A').map((item) => item.code), ['C', 'A', 'B']);
  assert.deepEqual(moveItemByOffset(items, 'B', 1).map((item) => item.code), ['A', 'C', 'B']);
  assert.deepEqual(moveItemByOffset(items, 'A', -1).map((item) => item.code), ['A', 'B', 'C']);
  assert.deepEqual(items.map((item) => item.code), ['A', 'B', 'C']);
});

test('项目代码仓库：成员可查看和复制 CLI，Owner 可配置并切换归档状态', async () => {
  const workspaceSource = await readFile(new URL('../src/TeamsWorkspace.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(workspaceSource, /项目代码仓库/);
  assert.match(workspaceSource, /tsp repository clone/);
  assert.match(workspaceSource, /repository\.status === 'active' \? t\("归档"\) : t\("启用仓库"\)/);
  assert.match(apiSource, /projects\/\$\{encodeURIComponent\(projectCode\)\}\/repositories/);
  assert.match(apiSource, /repositories\/\$\{encodeURIComponent\(repositoryCode\)\}/);
});

test('项目归档：使用可恢复的归档语义并仅向 Owner 提供入口', async () => {
  const workspaceSource = await readFile(new URL('../src/TeamsWorkspace.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(workspaceSource, /canProject\(project, 'archive'\)/);
  assert.equal(canProject({ role: 'admin', status: 'active' }, 'archive'), false);
  assert.equal(canProject({ role: 'owner', status: 'archived' }, 'archive'), true);
  assert.match(workspaceSource, /归档项目/);
  assert.match(workspaceSource, /恢复项目/);
  assert.match(workspaceSource, /项目数据不会删除，之后可以随时恢复/);
  assert.match(apiSource, /projects\/\$\{encodeURIComponent\(projectCode\)\}\/status/);
});
