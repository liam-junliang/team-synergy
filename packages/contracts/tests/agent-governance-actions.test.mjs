import assert from 'node:assert/strict';
import test from 'node:test';
import { agentWorkspaceRequest } from '../dist/agent-actions.js';
import { governanceActions } from '../dist/agent-governance-actions.js';

const scopeCode = '00000000000000000001';
const userCode = '00000000000000000002';
const byName = new Map(governanceActions.map(action => [action.name, action]));

test('项目创建使用账号范围，并保留名称、说明和指定访问方式', () => {
  const action = byName.get('create_project');
  assert.equal(action.scope, 'account');
  assert.equal(action.path, '/projects');
  assert.deepEqual(action.schema.parse({ team_code: scopeCode, name: ' 新项目 ', description: ' 项目说明 ', member_policy: 'private' }),
    { team_code: scopeCode, name: '新项目', description: '项目说明', member_policy: 'private' });
  assert.equal(action.schema.safeParse({ team_code: scopeCode, name: '新项目', principal_code: userCode }).success, false);
});

test('普通成员授权拒绝 owner，移出团队有独立预览且标注影响', () => {
  const teamAction = byName.get('add_team_member');
  const projectAction = byName.get('update_project_member_role');
  assert.equal(teamAction.schema.safeParse({ team_code: scopeCode, user_code: userCode, role: 'owner' }).success, false);
  assert.equal(teamAction.schema.safeParse({ team_code: scopeCode, user_code: userCode, role: 'viewer' }).success, false);
  assert.equal(projectAction.schema.safeParse({ user_code: userCode, role: 'owner' }).success, false);
  assert.deepEqual(projectAction.roles, ['owner', 'admin']);
  assert.equal(byName.get('preview_team_member_removal').method, 'GET');
  assert.equal(byName.get('remove_team_member').destructive, true);
});

test('项目归档和仓库变更保留范围限制，并拒绝空更新', () => {
  const archive = byName.get('archive_project');
  assert.deepEqual(archive.roles, ['owner']);
  assert.deepEqual(archive.schema.parse({}), { status: 'archived' });
  assert.equal(archive.schema.safeParse({ force_archive: true }).success, false);
  const update = byName.get('update_project_repository');
  assert.deepEqual(update.projectObject, { kind: 'repository', key: 'repository_code' });
  assert.equal(update.schema.safeParse({ repository_code: scopeCode }).success, false);
  assert.deepEqual(update.schema.parse({ repository_code: scopeCode, purpose: null }), { repository_code: scopeCode, purpose: null });
  assert.deepEqual(byName.get('restore_project_repository').schema.parse({ repository_code: scopeCode }),
    { repository_code: scopeCode, status: 'active' });
});

test('参数按已登记的路径、查询和请求体传递', () => {
  assert.deepEqual(agentWorkspaceRequest(byName.get('reorder_projects'), { team_code: scopeCode, project_codes: [userCode] }), {
    method: 'PUT', url: '/projects/order', payload: { team_code: scopeCode, project_codes: [userCode] },
  });
  assert.deepEqual(agentWorkspaceRequest(byName.get('preview_project_access_policy'), { projectCode: scopeCode, member_policy: 'team_write' }), {
    method: 'GET', url: `/projects/${scopeCode}/access-policy?member_policy=team_write`,
  });
  assert.deepEqual(agentWorkspaceRequest(byName.get('update_project_member_role'), { projectCode: scopeCode, user_code: userCode, role: 'member' }), {
    method: 'PATCH', url: `/projects/${scopeCode}/members/${userCode}`, payload: { role: 'member' },
  });
});
