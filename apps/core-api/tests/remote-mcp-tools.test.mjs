import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createMemorySliceUseCases, createProjectUseCases, createPublicCode, createTaskService, createTestingUseCases } from '@team-synergy/application';
import { schema } from '@team-synergy/persistence';
import { remoteMcpTools } from '../dist/remote-mcp-tools.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const origin = 'https://workspace.example.test';
const hash = 'ab'.repeat(20);
const artifact = { kind: 'report', uri: 'https://reports.example.test/tests/build-42', content_hash: 'ac'.repeat(32) };
const evidence = { result: 'pass', acceptance_refs: ['AC1'], summary: 'Remote test runner passed the project workflow' };

async function fixture(t) {
  const db = await openTestDb();
  t.after(() => closeTestDb(db));
  const created_at = new Date().toISOString();
  const owner = await insertUser(db, { account: 'connector.owner', display_name: 'Connector owner', created_at });
  const member = await insertUser(db, { account: 'connector.member', display_name: 'Connector member', created_at });
  const viewer = await insertUser(db, { account: 'connector.viewer', display_name: 'Connector viewer', created_at });
  const team = await insertTeam(db, { name: 'Connector team', created_by: owner.id, owner_principal_id: owner.id, created_at });
  const project = await insertProject(db, { name: 'Connector project', team_id: team.id, member_policy: 'private', owner_principal_id: owner.id, created_by: owner.id, created_at });
  const other = await insertProject(db, { name: 'Other project', team_id: team.id, member_policy: 'private', owner_principal_id: owner.id, created_by: owner.id, created_at });
  for (const person of [member, viewer]) {
    await insertProjectMember(db, { project_id: project.id, principal_id: person.id, role: person === viewer ? 'viewer' : 'member', display_name: person.display_name, created_at });
  }
  const feature = await insertFeature(db, { project_id: project.id, title: 'Connector workflow' });
  const outside = await insertFeature(db, { project_id: other.id, title: 'Other workflow' });
  const request = async () => { throw new Error('unexpected bridge use'); };
  const grant = (person = owner, overrides = {}) => ({ connectionCode: createPublicCode(), principalCode: person.code,
    projectCode: project.code, allowPersonalMemory: false, allowTaskWrite: person !== viewer, ...overrides });
  function session(person, overrides, bridge = request) {
    const identity = grant(person, overrides);
    const tools = remoteMcpTools(db, identity, bridge, origin);
    const call = (name, args) => {
      const tool = tools.find(item => item.name === name);
      assert.ok(tool, 'advertises ' + name);
      return tool.execute(args);
    };
    return { identity, tools, call };
  }
  const draft = { feature_code: feature.code, title: 'Verify team workflow', acceptance: [{ id: 'AC1', text: 'A reviewer can open the test report' }], idempotency_key: 'test-1' };
  return { db, owner, member, viewer, project, other, feature, outside, session, draft };
}

test('Connector creation deduplicates concurrent requests and rejects reuse of a key with changed input', async t => {
  const { db, session, draft } = await fixture(t);
  const { call } = session();
  const [first, retry] = await Promise.all([call('create_task_draft', draft), call('create_task_draft', draft)]);
  assert.deepEqual(first, retry);
  assert.equal(first.status, 'draft');
  assert.match(first.url, /\/board\?task=/);
  assert.equal((await db.select().from(schema.tasks)).length, 1);
  await assert.rejects(call('create_task_draft', { ...draft, title: 'Different task' }), { code: 'idempotency_conflict' });
});

test('Previously issued project grants preserve their exact scope', async t => {
  const { db, owner, session, project, other, outside, draft } = await fixture(t);
  const { call } = session();
  const { data: otherTask } = await createProjectUseCases(db).createTask({ principalCode: owner.code,
    featureCode: outside.code, title: 'Other project task', profile: 'builder', source: 'ad-hoc',
    acceptance: [{ id: 'AC1', text: 'Outside' }] });
  await assert.rejects(call('create_task_draft', { ...draft, feature_code: outside.code }), { code: 'connector_object_not_found' });
  await assert.rejects(call('get_task', { task_code: otherTask.task_code }), { code: 'connector_object_not_found' });
  await assert.rejects(call('assign_task', { task_code: otherTask.task_code, assignee_principal_code: owner.code, base_snapshot: 0 }), { code: 'connector_object_not_found' });
  await assert.rejects(call('list_tasks', { projectCode: other.code }), { code: 'connector_project_mismatch' });
  assert.deepEqual((await call('list_projects', {})).items.map(item => item.projectCode), [project.code]);
  assert.deepEqual((await call('list_tasks', { projectCode: project.code })).data, []);
  assert.deepEqual((await call('list_tasks')).data, []);
});

test('Account grants select projects per call and support concurrent writes across authorized projects', async t => {
  const { db, owner, session, project, other, outside, draft } = await fixture(t);
  const { call, tools } = session(owner, { projectCode: null });
  const initial = await call('get_connection_context');
  assert.equal(initial.connectionScope, 'account');
  assert.equal(initial.projectSelection, 'required');
  assert.equal(initial.projectCode, null);
  const advertised = tools.find(item => item.name === 'create_task_draft').schema.toJSONSchema();
  assert.ok(advertised.required.includes('projectCode'));
  assert.deepEqual(new Set((await call('list_projects', {})).items.map(item => item.projectCode)), new Set([project.code, other.code]));
  assert.deepEqual((await call('list_projects', { query: 'other' })).items.map(item => item.projectCode), [other.code]);
  assert.equal((await call('get_connection_context', { projectCode: other.code })).projectSelection, 'explicit');
  await assert.rejects(call('list_tasks', {}), { code: 'validation_failed' });

  const [first, second] = await Promise.all([
    call('create_task_draft', { ...draft, projectCode: project.code }),
    call('create_task_draft', { ...draft, projectCode: other.code, feature_code: outside.code, title: 'Review the other project', idempotency_key: 'test-2' }),
  ]);
  assert.equal(first.projectCode, project.code);
  assert.equal(second.projectCode, other.code);
  const [primaryTasks, otherTasks] = await Promise.all([call('list_tasks', { projectCode: project.code }), call('list_tasks', { projectCode: other.code })]);
  assert.deepEqual(primaryTasks.data.map(item => item.task_code), [first.task_code]);
  assert.deepEqual(otherTasks.data.map(item => item.task_code), [second.task_code]);
  await assert.rejects(call('get_task', { projectCode: project.code, task_code: second.task_code }), { code: 'connector_object_not_found' });
  assert.equal((await call('get_connection_context')).projectCode, null);

  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, other.id));
  await assert.rejects(call('list_tasks', { projectCode: other.code }), { code: 'project_forbidden' });
  assert.deepEqual((await call('list_projects')).items.map(item => item.projectCode), [project.code]);
});

test('Per-project access and write capability of account grants are reevaluated after a role change', async t => {
  const { db, member, project, other, outside, session, draft } = await fixture(t);
  const { call } = session(member, { projectCode: null });
  await assert.rejects(call('list_tasks', { projectCode: other.code }), { code: 'project_forbidden' });
  await insertProjectMember(db, { project_id: other.id, principal_id: member.id, role: 'viewer', display_name: member.display_name,
    created_at: new Date().toISOString() });
  const projects = (await call('list_projects')).items;
  assert.equal(projects.find(item => item.projectCode === project.code).allowTaskWrite, true);
  assert.equal(projects.find(item => item.projectCode === other.code).allowTaskWrite, false);
  assert.equal((await call('get_connection_context', { projectCode: other.code })).role, 'viewer');
  assert.deepEqual((await call('list_tasks', { projectCode: other.code })).data, []);
  const command = { ...draft, projectCode: other.code, feature_code: outside.code };
  await assert.rejects(call('create_task_draft', command), { code: 'project_forbidden' });
  const membership = and(eq(schema.members.project_id, other.id), eq(schema.members.principal_id, member.id));
  await db.update(schema.members).set({ role: 'member' }).where(membership);
  assert.equal((await call('create_task_draft', command)).projectCode, other.code);
  await db.delete(schema.members).where(membership);
  await assert.rejects(call('list_tasks', { projectCode: other.code }), { code: 'project_forbidden' });
  assert.deepEqual((await call('list_projects')).items.map(item => item.projectCode), [project.code]);
});

test('The tool catalog filters operations by the target project and current role', async t => {
  const { db, owner, member, project, other, session } = await fixture(t);
  const { call } = session(member, { projectCode: null });
  const lookup = projectCode => call('search_tools', { module: 'tasks', projectCode });
  const available = await lookup(project.code);
  assert.ok(available.tools.some(item => item.name === 'create_task_draft'));
  assert.ok(available.tools.every(item => item.name !== 'assign_task'));
  assert.ok((await session(owner, { projectCode: null }).call('search_tools', { module: 'tasks', projectCode: project.code }))
    .tools.some(item => item.name === 'assign_task'));
  await assert.rejects(lookup(other.code), { code: 'project_forbidden' });
  const membership = and(eq(schema.members.project_id, project.id), eq(schema.members.principal_id, member.id));
  await db.update(schema.members).set({ role: 'viewer' }).where(membership);
  const readonly = await lookup(project.code);
  assert.ok(readonly.tools.every(item => item.readOnly));
  assert.ok(readonly.tools.some(item => item.name === 'list_tasks'));
});

test('Only a collaborating Connector can write tasks; assignment still requires a project manager', async t => {
  const { member, viewer, session, draft } = await fixture(t);
  const reader = session(viewer);
  const privateReader = session(undefined, { allowTaskWrite: false });
  for (const connection of [reader, privateReader]) {
    assert.equal(connection.tools.every(tool => tool.annotations.readOnlyHint), true);
    assert.equal(connection.tools.some(tool => /capture|withdraw|edit_personal/.test(tool.name)), false);
  }
  const memberConnection = session(member);
  const created = await memberConnection.call('create_task_draft', draft);
  await assert.rejects(memberConnection.call('assign_task', { task_code: created.task_code, assignee_principal_code: member.code, base_snapshot: 0 }), { code: 'assign_forbidden' });
});

test('Connector submits real external artifacts only for its own run and preserves project execution transitions', async t => {
  const { session, member, draft } = await fixture(t);
  const owner = session();
  const runner = session(member);
  const sibling = session(member);
  const created = await owner.call('create_task_draft', draft);
  const assigned = await owner.call('assign_task', { task_code: created.task_code, assignee_principal_code: member.code, base_snapshot: created.base_snapshot });
  const active = await runner.call('claim_task', { task_code: assigned.task_code, base_snapshot: assigned.base_snapshot,
    workspace_url: 'https://executor.example.test/workspaces/run-5', git_base: hash });
  assert.equal(active.status, 'running');
  const status = await runner.call('get_task', { task_code: active.task_code });
  const submission = { task_code: active.task_code, run_code: active.run_code, base_snapshot: status.base_snapshot, artifact, evidence };
  await assert.rejects(runner.call('submit_task_evidence', {
    ...submission, evidence: { ...evidence, result: 'fail' },
  }), { code: 'validation_failed' });
  await assert.rejects(sibling.call('submit_task_evidence', submission), { code: 'connector_run_forbidden' });
  const submitted = await runner.call('submit_task_evidence', submission);
  assert.equal(submitted.status, 'submitted');
  const after = await runner.call('get_task', { task_code: active.task_code });
  assert.equal(after.evidences[0].result, 'pass');
  assert.equal(after.artifacts[0].uri, artifact.uri);
  assert.equal(after.runs[0].status, 'completed');
  assert.equal('workspace_path' in after.runs[0], false);
});

test('Connector cannot submit a local run even if the account matches', async t => {
  const { db, session, member, draft } = await fixture(t);
  const owner = session();
  const runner = session(member);
  const created = await owner.call('create_task_draft', draft);
  const assigned = await owner.call('assign_task', { task_code: created.task_code, assignee_principal_code: member.code, base_snapshot: created.base_snapshot });
  const runCode = createPublicCode();
  const local = await createTaskService(db).claimTask({ taskCode: assigned.task_code, baseSnapshot: assigned.base_snapshot,
    principalCode: member.code, runCode, workspaceCode: createPublicCode(), workspacePath: 'F:/local/test-fixture', gitBase: hash, profile: 'builder' });
  assert.equal(local.ok, true);
  const status = await runner.call('get_task', { task_code: assigned.task_code });
  await assert.rejects(runner.call('submit_task_evidence', {
    task_code: assigned.task_code, run_code: runCode, base_snapshot: status.base_snapshot, artifact, evidence,
  }), { code: 'connector_run_forbidden' });
});

test('Connector disallows new remote claims when a task already requires a device lease', async t => {
  const { db, session, member, draft } = await fixture(t);
  const owner = session();
  const runner = session(member);
  const created = await owner.call('create_task_draft', draft);
  const assigned = await owner.call('assign_task', { task_code: created.task_code, assignee_principal_code: member.code, base_snapshot: 0 });
  await db.update(schema.tasks).set({ execution_epoch: 1 }).where(eq(schema.tasks.code, assigned.task_code));
  await assert.rejects(runner.call('claim_task', { task_code: assigned.task_code, base_snapshot: 1,
    workspace_url: 'https://executor.example.test/workspaces/run-5', git_base: hash }), { code: 'connector_local_execution_required' });
});

test('Memory scope defaults to project and personal content requires explicit grant and tool scope', async t => {
  const { project, session } = await fixture(t);
  const observed = [];
  const bridge = async req => { observed.push(req); return { ok: true, data: [] }; };
  const reader = session(undefined, { allowTaskWrite: false }, bridge);
  const hasPersonal = session(undefined, { allowTaskWrite: false, allowPersonalMemory: true }, bridge);
  await assert.rejects(reader.call('search_memory', { query: 'preferences', scope: 'personal' }), { code: 'connector_personal_memory_forbidden' });
  const source = createPublicCode();
  await assert.rejects(reader.call('read_memory_sources', { scope: 'personal', sources: [source] }), { code: 'connector_personal_memory_forbidden' });
  await assert.rejects(reader.call('read_memory_brief', { scope: 'personal' }), { code: 'connector_personal_memory_forbidden' });
  assert.deepEqual(observed, []);
  await reader.call('read_memory_sources', { sources: [source] });
  await reader.call('read_memory_brief', { scope: 'project' });
  await hasPersonal.call('search_memory', { query: 'session', scope: 'personal' });
  assert.deepEqual(observed, [
    { method: 'POST', url: '/projects/' + project.code + '/memory/sources', projectCode: project.code, payload: { sources: [source], scope: 'project' } },
    { method: 'POST', url: '/projects/' + project.code + '/memory/brief', projectCode: project.code, payload: { scope: 'project' } },
    { method: 'POST', url: '/projects/' + project.code + '/memory/search', projectCode: project.code, payload: { query: 'session', scope: 'personal' } },
  ]);
});

test('The memory bridge uses only the scoped project from each account connection call', async t => {
  const { owner, project, other, session } = await fixture(t);
  const { call } = session(owner, { projectCode: null }, async req => ({ ok: true, data: req }));
  const [first, second] = await Promise.all([
    call('read_memory_brief', { projectCode: project.code, scope: 'project' }),
    call('search_memory', { projectCode: other.code, query: 'other project topic' }),
  ]);
  assert.deepEqual(first, { method: 'POST', url: '/projects/' + project.code + '/memory/brief', projectCode: project.code, payload: { scope: 'project' } });
  assert.deepEqual(second, { method: 'POST', url: '/projects/' + other.code + '/memory/search', projectCode: other.code,
    payload: { query: 'other project topic', scope: 'project' } });
  await assert.rejects(call('search_memory', { projectCode: other.code, scope: 'personal', query: 'example' }), { code: 'connector_personal_memory_forbidden' });
});

test('Project memory source lookup cannot reveal a personal preference even when the source code is known', async t => {
  const { db, owner, member, project } = await fixture(t);
  const memory = createMemorySliceUseCases(db);
  const actor = { projectCode: project.code, principalCode: owner.code };
  const text = '我习惯先核对来源。';
  await memory.capture({ ...actor, sessionId: 'fixture', eventId: 'personal', sourceText: text, parts: [{ kind: 'preference', text }] });
  const [item] = await memory.search({ ...actor, query: '核对来源', scope: 'personal' });
  assert.equal(item.text, text);
  assert.deepEqual(await memory.readSources({ ...actor, scope: 'project', sources: [item.source] }), []);
  assert.deepEqual(await memory.readSources({ ...actor, principalCode: member.code, scope: 'personal', sources: [item.source] }), []);
  assert.equal((await memory.readSources({ ...actor, scope: 'personal', sources: [item.source] }))[0].text, text);
});

test('An authorized Agent can record an existing test case result and link the platform evidence without changing task state', async t => {
  const { db, owner, project, session, draft } = await fixture(t);
  const { call } = session();
  const task = await call('create_task_draft', draft);
  const useCases = createTestingUseCases(db);
  const testCase = await useCases.createCase({ projectCode: project.code, principalCode: owner.code, input: { title: 'Open the delivered test report' } });
  assert.equal(testCase.ok, true);
  const execution = await call('record_test_execution', {
    task_code: task.task_code, title: 'Connector acceptance run', environment: 'External CI',
    tested_version: 'Build 42', commit_sha: hash,
    results: [{ case_code: testCase.data.code, case_revision: 1, result: 'pass', actual_result: 'Report loaded', report_urls: [artifact.uri] }],
  });
  assert.equal(execution.counts.pass, 1);
  assert.equal(execution.url, origin + '/projects/' + project.code + '/testing?tab=executions&item=' + execution.code);
  const linked = await useCases.getExecution(execution.code, owner.code);
  assert.equal(linked.data.task_code, task.task_code);
  assert.equal(linked.data.source, 'agent');
  assert.deepEqual(linked.data.results[0].report_urls, [artifact.uri]);
  assert.equal((await call('get_task', { task_code: task.task_code })).status, 'draft');
});
