import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteMcpTools } from '../dist/remote-mcp-tools.js';
import { agentWorkspaceActions, AgentToolModuleSchema } from '@team-synergy/contracts';

const origin = 'https://workspace.example.test';
const grant = {
  connectionCode: '00000000000000000001',
  principalCode: '00000000000000000002',
  projectCode: null,
  allowPersonalMemory: false,
  allowTaskWrite: true,
};
const unavailable = () => { throw Error('Account-level tool discovery must not fetch business data'); };
const db = new Proxy({}, { get: unavailable });
const registry = options => remoteMcpTools(db, { ...grant, ...options }, unavailable, origin);
const grouped = AgentToolModuleSchema.options;

test('search_tools is the first available readonly tool and explains all registered modules', async () => {
  const tools = registry();
  const search = tools[0];
  assert.equal(search.name, 'search_tools');
  assert.equal(search.annotations.readOnlyHint, true);
  const result = await search.execute({});
  assert.deepEqual(result.modules.map(item => item.module), grouped.filter(module => tools.some(tool => tool.module === module)));
  assert.ok(result.modules.every(item => item.title && item.description));
  assert.equal(result.modules.reduce((total, item) => total + item.toolCount, 0), tools.length);
  assert.deepEqual(Object.keys(result), ['modules']);
});

test('tool search combines module filtering with Chinese and English keywords', async () => {
  const search = registry()[0];
  const assignments = await search.execute({ module: 'tasks', query: '分派', limit: 1 });
  assert.equal(assignments.tools[0].name, 'assign_task');
  assert.equal(assignments.tools[0].readOnly, false);
  assert.equal(assignments.truncated, true);
  assert.deepEqual(assignments.modules.map(item => item.module), ['tasks']);
  const memory = await search.execute({ query: '记忆', module: 'memory' });
  assert.equal(memory.tools.length, 4);
  assert.ok(memory.tools.every(item => item.module === 'memory' && item.readOnly));
  const status = await search.execute({ module: 'tasks', query: 'task status' });
  assert.ok(status.tools.some(item => item.name === 'get_task'));
  const exact = await search.execute({ query: 'grep_project_materials', limit: 1 });
  assert.equal(exact.tools[0].name, 'grep_project_materials');
  assert.deepEqual(Object.keys(exact.tools[0]), ['name', 'module', 'description', 'readOnly']);
  const missing = await search.execute({ query: 'unregistered-service' });
  assert.deepEqual(missing.tools, []);
  assert.equal(missing.total, 0);
  assert.ok(missing.modules.length > 0);
});

test('a readonly grant can only discover the tools its Connector registers', async () => {
  const tools = registry({ allowTaskWrite: false });
  const search = tools[0];
  const results = await search.execute({ module: 'tasks' });
  assert.ok(results.tools.some(item => item.name === 'list_tasks'));
  assert.ok(results.tools.every(item => item.readOnly && tools.some(active => active.name === item.name)));
  assert.deepEqual((await search.execute({ query: 'create_task_draft' })).tools, []);
  const skill = await search.execute({ module: 'projects', query: 'read_connector_skill' });
  assert.equal(skill.tools[0].name, 'read_connector_skill');
  assert.equal(skill.tools[0].readOnly, true);
  await assert.rejects(search.execute({ limit: 21 }), { code: 'validation_failed' });
  await assert.rejects(search.execute({ module: 'unavailable' }), { code: 'validation_failed' });
});

test('the Connector skill index and module references cover every registered tool', async () => {
  const tools = registry({ allowWorkspaceWrite: true });
  const skill = tools.find(tool => tool.name === 'read_connector_skill');
  assert.equal(skill.annotations.readOnlyHint, true);
  const index = await skill.execute({});
  assert.equal(index.path, 'SKILL.md');
  for (const module of grouped) {
    const reference = await skill.execute({ module });
    assert.equal(reference.path, `references/${module}.md`);
    assert.ok(index.markdown.includes(`](${reference.path})`));
    const headings = [...reference.markdown.matchAll(/^## `([a-z_]+)`$/gm)].map(match => match[1]).sort();
    assert.deepEqual(headings, tools.filter(tool => tool.module === module).map(tool => tool.name).sort(), module);
  }
  await assert.rejects(skill.execute({ module: 'unavailable' }), { code: 'validation_failed' });
});

test('workspace permissions control team tools and new writes independently from tasks:write', async () => {
  const previous = registry();
  const workspace = registry({ allowTaskWrite: false, allowWorkspaceWrite: true });
  const pinned = registry({ allowWorkspaceWrite: true, projectCode: '00000000000000000003' });
  assert.ok(previous.some(tool => tool.name === 'create_task_draft'));
  assert.ok(!previous.some(tool => tool.name === 'list_teams' || tool.name === 'create_team' || tool.name === 'create_project'));
  assert.ok(!previous.some(tool => tool.name === 'preview_project_access_policy'));
  assert.ok(workspace.some(tool => tool.name === 'create_team'));
  assert.ok(workspace.some(tool => tool.name === 'preview_project_access_policy'));
  assert.ok(!workspace.some(tool => tool.name === 'create_task_draft'));
  assert.ok(!pinned.some(tool => tool.name === 'create_team' || tool.name === 'create_project'));
  const names = workspace.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  const result = await workspace[0].execute({ module: 'teams', query: '创建团队' });
  assert.ok(result.tools.some(tool => tool.name === 'create_team'));
  assert.equal(new Set(agentWorkspaceActions.map(action => action.name)).size, agentWorkspaceActions.length);
});

test('a completed workspace write returns a compact success when revision history exceeds the response cap', async () => {
  const project_code = '00000000000000000003';
  const tools = remoteMcpTools(db, { ...grant, allowWorkspaceWrite: true }, unavailable, origin, async () => ({
    ok: true, data: { project_code, current_revision: 9, history: '旧'.repeat(50_000) },
  }));
  const write = await tools.find(tool => tool.name === 'update_project').execute({ projectCode: project_code, name: 'Updated' });
  assert.deepEqual(write, {
    applied: true, resultOmitted: true, project_code, current_revision: 9,
    nextStep: '已保存。请读取目标对象或查看最新修订，无需重复提交。',
  });
  await assert.rejects(tools.find(tool => tool.name === 'get_project').execute({ projectCode: project_code }), { code: 'agent_output_too_large' });
});
