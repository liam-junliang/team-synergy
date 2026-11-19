import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteMcpTools } from '../dist/remote-mcp-tools.js';

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
const grouped = ['projects', 'materials', 'memory', 'code', 'tasks', 'testing'];

test('search_tools is the first available readonly tool and explains all registered modules', async () => {
  const tools = registry();
  const search = tools[0];
  assert.equal(search.name, 'search_tools');
  assert.equal(search.annotations.readOnlyHint, true);
  const result = await search.execute({});
  assert.deepEqual(result.modules.map(item => item.module), grouped);
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
  const tools = registry();
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
