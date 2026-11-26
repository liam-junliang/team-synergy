import assert from 'node:assert/strict';
import { test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { createAuthUseCases, createMemorySliceUseCases, hashPassword } from '@team-synergy/application';
import { schema } from '@team-synergy/persistence';
import { configuredRemoteMcpUrl } from '../dist/remote-mcp.js';
import { remoteMcpRelease, serviceVersion } from '../dist/remote-mcp-release.js';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertFeature, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const origin = 'http://127.0.0.1:5173';
const resource = `${origin}/api/mcp`;
const connectionPath = '/account/mcp-connections';
const password = 'ConnectorFixturePassword123!';

async function fixture(t) {
  const db = await openTestDb();
  t.after(() => closeTestDb(db));
  const old = process.env.TSP_REMOTE_MCP_URL;
  process.env.TSP_REMOTE_MCP_URL = resource;
  const savedOrigin = process.env.TSP_WEB_ORIGIN;
  process.env.TSP_WEB_ORIGIN = origin;
  t.after(() => {
    if (old === undefined) delete process.env.TSP_REMOTE_MCP_URL; else process.env.TSP_REMOTE_MCP_URL = old;
    if (savedOrigin === undefined) delete process.env.TSP_WEB_ORIGIN; else process.env.TSP_WEB_ORIGIN = savedOrigin;
  });
  const app = await buildServer({ db, logger: false });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const timestamp = new Date().toISOString();
  const password_hash = await hashPassword(password);
  const owner = await insertUser(db, { account: 'connector.owner', display_name: 'Connector owner', password_hash, created_at: timestamp });
  const member = await insertUser(db, { account: 'connector.member', display_name: 'Connector member', password_hash, created_at: timestamp });
  const team = await insertTeam(db, { name: 'Connector team', owner_principal_id: owner.id, created_by: owner.id, created_at: timestamp });
  const project = await insertProject(db, { name: 'Connector project', team_id: team.id, owner_principal_id: owner.id, created_by: owner.id, created_at: timestamp });
  const other = await insertProject(db, { name: 'Another connector project', team_id: team.id, owner_principal_id: owner.id, created_by: owner.id, created_at: timestamp });
  const feature = await insertFeature(db, { project_id: project.id, title: 'Agent integration', status: 'active' });
  const otherFeature = await insertFeature(db, { project_id: other.id, title: 'Other project feature', status: 'active' });
  await insertProjectMember(db, { project_id: project.id, principal_id: member.id, display_name: member.display_name, role: 'member', created_at: timestamp });

  async function grant(actor, options) {
    const headers = { host: '127.0.0.1:5173', origin };
    const login = await app.inject({ method: 'POST', url: '/auth/web/login', headers,
      payload: { account: actor.account, password, device_name: 'Connector test browser' } });
    assert.equal(login.statusCode, 200);
    headers.cookie = login.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
    headers['x-csrf-token'] = login.json().data.csrf_token;
    const issued = await app.inject({ method: 'POST', url: connectionPath, headers,
      payload: { name: 'HTTP test client', projectCode: project.code, ...options } });
    assert.equal(issued.statusCode, 201, issued.body);
    return { ...issued.json().data, headers };
  }

  async function mcp(token, method, params, headers = {}) {
    const res = await fetch(address + '/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const raw = await res.text();
    const data = res.headers.get('content-type')?.includes('text/event-stream') ? raw.split(/\r?\n/).find(line => line.startsWith('data: '))?.slice(6) : raw;
    return { status: res.status, headers: res.headers, body: data ? JSON.parse(data) : undefined };
  }

  return { app, db, owner, member, team, project, other, feature, otherFeature, grant, mcp };
}

async function claimFixtureTask({ owner, member, project, feature, grant, mcp }, acceptance) {
  async function connect(actor) {
    const { token } = await grant(actor, { projectCode: null, allowTaskWrite: true });
    const invoke = async (name, args) => {
      const response = await mcp(token, 'tools/call', { name, arguments: { projectCode: project.code, ...args } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.ok(response.body.result, JSON.stringify(response.body));
      return response.body.result;
    };
    return {
      async call(name, args) {
        const result = await invoke(name, args);
        assert.equal(result.isError, false, JSON.stringify(result));
        return result.structuredContent;
      },
      async rejects(name, args, code) {
        const result = await invoke(name, args);
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
      },
    };
  }
  const manager = await connect(owner);
  const builder = await connect(member);
  const created = await manager.call('create_task_draft', { feature_code: feature.code, title: 'Exercise task completion',
    idempotency_key: 'fixture-task', acceptance });
  const assigned = await manager.call('assign_task', { task_code: created.task_code,
    base_snapshot: created.base_snapshot, assignee_principal_code: member.code });
  const active = await builder.call('claim_task', { task_code: assigned.task_code, base_snapshot: assigned.base_snapshot,
    workspace_url: 'https://executor.example.test/approval-fixture', git_base: 'a'.repeat(40) });
  return { manager, builder, active };
}

test('HTTP MCP cancellation invalidates the old Run and preserves prior evidence', async t => {
  const f = await fixture(t);
  const { app, db, member, owner, project } = f;
  const { manager, builder, active } = await claimFixtureTask(f, [{ id: 'AC-1', text: 'Open the report' }]);
  const { task_code, run_code } = active;
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.code, task_code));
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.code, run_code));
  const auth = await createAuthUseCases(db).loginWithPassword(member.account, password, 'Run fixture device');
  assert.equal(auth.ok, true, JSON.stringify(auth.error));
  const deviceCall = (url, payload) => app.inject({
    method: 'POST', url, headers: { authorization: 'Bearer ' + auth.data.device_token }, payload,
  }).then(response => response.json());
  const issued = await deviceCall(`/runs/${run_code}/lease`, { execution_epoch: run.execution_epoch });
  assert.equal(issued.ok, true, JSON.stringify(issued.error));
  const execution = { lease_token: issued.data.lease_token, execution_epoch: issued.data.execution_epoch };
  const started = await deviceCall(`/runs/${run_code}/sessions`, {
    ...execution, start_key: 'cancel-fixture', agent_command: 'fixture command',
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const stateUrl = `/agent-sessions/${started.data.session_code}/state`;
  const heartbeat = await deviceCall(stateUrl, { ...execution, status: 'running', last_output: 'Retained output' });
  assert.equal(heartbeat.ok, true, JSON.stringify(heartbeat));
  const now = new Date().toISOString();
  const [priorEvidence] = await db.insert(schema.evidences).values({
    task_id: task.id, run_id: run.id, type: 'manual', result: 'pass', summary: 'Evidence from before cancellation', recorded_at: now,
  }).returning();

  const before = await manager.call('get_task_workflow', { task_code });
  assert.equal(before.status, 'running');
  assert.equal(before.base_snapshot, before.execution.base_snapshot);
  assert.equal(before.url, origin + '/projects/' + project.code + '/board?task=' + task_code);
  assert.equal(before.execution.run_code, run_code);
  assert.equal(before.execution.can_cancel_execution, true);
  assert.equal(before.execution.cancellation_requires_confirmation, true);
  const cancel = { task_code, base_snapshot: before.execution.base_snapshot, reason: 'Work no longer required',
    idempotency_key: 'cancel-old-run' };
  await builder.rejects('cancel_task', { ...cancel, confirm_active: true }, 'project_forbidden');
  await manager.rejects('cancel_task', { ...cancel, base_snapshot: cancel.base_snapshot - 1, confirm_active: true }, 'base_snapshot_mismatch');
  await manager.rejects('cancel_task', cancel, 'task_execution_confirmation_required');
  assert.equal((await manager.call('get_task', { task_code })).status, 'running');

  assert.equal(run.execution_epoch, 0);
  await db.update(schema.runLeases).set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .where(eq(schema.runLeases.run_id, run.id));
  const expired = await manager.call('get_task_workflow', { task_code });
  assert.equal(expired.execution.execution_health, 'expired');
  assert.equal(expired.execution.cancellation_requires_confirmation, true);
  await manager.rejects('cancel_task', cancel, 'task_execution_confirmation_required');

  const request = { ...cancel, confirm_active: true };
  const cancelled = await manager.call('cancel_task', request);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.base_snapshot, before.execution.base_snapshot + 1);
  assert.deepEqual(await manager.call('cancel_task', request), cancelled);

  const after = await manager.call('get_task', { task_code });
  assert.equal(after.status, 'cancelled');
  assert.equal(after.runs.find(row => row.run_code === run_code)?.status, 'cancelled');
  assert.deepEqual(after.evidences.map(row => row.evidence_code), [priorEvidence.code]);

  await builder.rejects('submit_task_evidence', {
    task_code, run_code, base_snapshot: after.base_snapshot,
    artifact: { kind: 'report', uri: 'https://executor.example.test/approval-fixture/report', content_hash: 'a'.repeat(64) },
    evidence: { result: 'pass', acceptance_refs: ['AC-1'], summary: 'Delayed result from the cancelled Run' },
  }, 'run_inactive');
  const lateHeartbeat = await deviceCall(stateUrl, { ...execution, status: 'finished', last_output: 'Late output' });
  assert.equal(lateHeartbeat.ok, false);
  assert.equal(lateHeartbeat.error.code, 'run_inactive');
  const afterLateSubmit = await manager.call('get_task', { task_code });
  assert.equal(afterLateSubmit.status, 'cancelled');
  assert.equal(afterLateSubmit.base_snapshot, after.base_snapshot);
  assert.deepEqual(afterLateSubmit.artifacts, []);
  assert.deepEqual(afterLateSubmit.evidences.map(row => row.evidence_code), [priorEvidence.code]);

  const [retainedTask] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  const [stoppedSession] = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.code, started.data.session_code));
  const [revokedLease] = await db.select().from(schema.runLeases).where(eq(schema.runLeases.run_id, run.id));
  assert.equal(retainedTask.execution_epoch, task.execution_epoch + 1);
  assert.equal(stoppedSession.status, 'cancelled');
  assert.equal(stoppedSession.last_output, 'Retained output');
  assert.ok(revokedLease.revoked_at);
  const audit = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entity_type, 'task'),
    eq(schema.auditEvents.entity_id, task.id), eq(schema.auditEvents.to_state, 'cancelled')));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].principal_id, owner.id);
});

test('HTTP MCP review requires every acceptance criterion before the manager can close the task', async t => {
  const f = await fixture(t);
  const ids = ['AC-1', 'AC-2'];
  const { manager, builder, active } = await claimFixtureTask(f, [
    { id: ids[0], text: 'Open the report' }, { id: ids[1], text: 'Confirm the regression did not recur' },
  ]);
  const { task_code, run_code } = active;
  const running = await builder.call('get_task', { task_code });
  const submitted = await builder.call('submit_task_evidence', {
    task_code, run_code, base_snapshot: running.base_snapshot,
    artifact: { kind: 'report', uri: 'https://executor.example.test/approval-fixture/report', content_hash: 'a'.repeat(64) },
    evidence: { result: 'pass', acceptance_refs: ids, summary: 'Builder checked both criteria' },
  });
  assert.equal(submitted.status, 'submitted');
  const { delivery } = await manager.call('get_task_workflow', { task_code });
  assert.equal(delivery.can_start_review, true);
  assert.equal(delivery.submission_author_code, f.member.code);
  assert.ok(delivery.submission_code);
  const start = { task_code, base_snapshot: delivery.base_snapshot };
  await builder.rejects('start_task_review', start, 'task_review_self');
  const started = await manager.call('start_task_review', start);
  const inReview = await manager.call('get_task_workflow', { task_code });
  assert.equal(inReview.delivery.can_finish_review, true);
  assert.equal(inReview.delivery.reviewer_code, f.owner.code);
  const review = { task_code, base_snapshot: started.base_snapshot, submission_code: delivery.submission_code,
    result: 'pass', acceptance_refs: ids, summary: 'Independent reviewer confirmed the report and regression result' };
  await manager.rejects('finish_task_review', { ...review, base_snapshot: start.base_snapshot }, 'base_snapshot_mismatch');
  await manager.rejects('finish_task_review', { ...review, submission_code: '0'.repeat(20) }, 'task_review_submission_changed');
  await manager.rejects('finish_task_review', { ...review, acceptance_refs: [ids[0]] }, 'acceptance_coverage_incomplete');
  await manager.rejects('finish_task_review', { ...review, acceptance_refs: [ids[0], ids[0]] }, 'acceptance_coverage_incomplete');
  const incomplete = await manager.call('get_task', { task_code });
  assert.equal(incomplete.status, 'submitted');
  assert.equal(incomplete.base_snapshot, started.base_snapshot);
  assert.equal(incomplete.evidences.filter(row => row.type === 'verifier_review').length, 0);
  await manager.rejects('close_task', { task_code, base_snapshot: started.base_snapshot }, 'close_not_verified');

  const verified = await manager.call('finish_task_review', review);
  assert.equal(verified.status, 'verified');
  const closed = await manager.call('close_task', { task_code, base_snapshot: verified.base_snapshot });
  assert.equal(closed.status, 'closed');
  const complete = await manager.call('get_task', { task_code });
  assert.equal(complete.status, 'closed');
  const independent = complete.evidences.filter(row => row.type === 'verifier_review');
  assert.equal(independent.length, 1);
  assert.equal(independent[0].result, 'pass');
  assert.deepEqual(independent[0].acceptance_refs, ids);
});

test('only exposes a configured same-origin HTTPS resource outside local development', () => {
  assert.equal(configuredRemoteMcpUrl({}), undefined);
  assert.equal(configuredRemoteMcpUrl({ TSP_REMOTE_MCP_URL: resource }), resource);
  assert.throws(() => configuredRemoteMcpUrl({ NODE_ENV: 'production', TSP_REMOTE_MCP_URL: resource }));
  assert.throws(() => configuredRemoteMcpUrl({ TSP_REMOTE_MCP_URL: 'https://workspace.example.com/api/mcp?key=secret' }));
  assert.throws(() => configuredRemoteMcpUrl({ TSP_REMOTE_MCP_URL: 'https://other.example.com/api/mcp', TSP_WEB_ORIGIN: 'https://workspace.example.com' }));
});

test('remote MCP advertises OAuth, returns project tool context and enforces revocation on a live HTTP connection', async t => {
  const { app, member, project, grant, mcp } = await fixture(t);
  const anonymous = await mcp(null, 'tools/list', {});
  assert.equal(anonymous.status, 401);
  const metadataUri = /resource_metadata="([^"]+)"/.exec(anonymous.headers.get('www-authenticate'))?.[1];
  assert.ok(metadataUri);
  assert.equal(new URL(metadataUri).origin, origin);
  const metadata = await app.inject({ url: new URL(metadataUri).pathname.replace(/^\/api\//, '/') });
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.json().resource, resource);

  const { connection, headers, token } = await grant(member);
  const config = await app.inject({ url: '/platform/client-config', headers });
  assert.equal(config.json().data.remote_mcp_url, resource);
  assert.equal(config.headers['cache-control'], 'no-store');
  assert.deepEqual(config.json().data.remote_mcp_release, remoteMcpRelease());
  const init = await mcp(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Connector test host', version: '1' } });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.body.result.serverInfo.version, serviceVersion);
  assert.equal(init.body.result.capabilities.tools.listChanged, false);
  assert.match(init.body.result.instructions, /search_tools/);
  assert.match(init.body.result.instructions, /read_connector_skill/);
  const catalog = await mcp(token, 'tools/call', { name: 'search_tools', arguments: {} });
  assert.equal(catalog.body.result.isError, false, JSON.stringify(catalog.body));
  assert.ok(catalog.body.result.structuredContent.modules.some(module => module.module === 'memory' && module.description));
  const context = await mcp(token, 'tools/call', { name: 'get_connection_context', arguments: {} });
  assert.equal(context.body.result.isError, false, JSON.stringify(context.body));
  assert.ok(JSON.stringify(context.body.result.structuredContent).includes(project.code));
  const release = context.body.result.structuredContent.connector;
  assert.equal(release.serviceVersion, serviceVersion);
  assert.match(release.toolsetRevision, /^[0-9a-f]{64}$/);
  assert.equal(release.toolsetChanged, null);
  const connectionList = await app.inject({ url: connectionPath, headers });
  assert.equal(connectionList.json().data.find(item => item.code === connection.code).toolsetRevision, release.toolsetRevision);

  const modern = await mcp(token, 'tools/list', { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' });
  assert.equal(modern.status, 200, JSON.stringify(modern.body));
  assert.ok(modern.body.result.tools.some(tool => tool.name === 'get_connection_context'));

  assert.equal((await mcp(token, 'tools/list', {}, { origin: 'https://unapproved.example' })).status, 403);
  assert.equal((await app.inject({ url: '/auth/whoami', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: `${connectionPath}/${connection.code}`, headers })).statusCode, 200);
  assert.equal((await mcp(token, 'tools/list', {})).status, 401);
});

test('remote MCP preserves project boundaries, task idempotency and current project write permissions', async t => {
  const { app, db, member, project, feature, otherFeature, grant, mcp } = await fixture(t);
  const { connection, headers, token } = await grant(member, { allowTaskWrite: true });
  const call = (name, args) => mcp(token, 'tools/call', { name, arguments: args });
  const before = (await call('get_connection_context', {})).body.result.structuredContent.connector;
  const previous = { knownToolsetRevision: before.toolsetRevision };
  assert.equal((await call('get_connection_context', previous)).body.result.structuredContent.connector.toolsetChanged, false);
  const initial = await mcp(token, 'tools/list', {});
  const names = initial.body.result.tools.map(tool => tool.name);
  assert.ok(names.includes('create_task_draft'));
  assert.ok(!names.some(name => /(?:capture|save_memory|update_memory|edit_memory)/u.test(name)));
  const create = { feature_code: feature.code, title: 'Verify the Connector workflow', idempotency_key: 'connector-test-draft-1',
    acceptance: [{ id: 'AC-1', text: 'A member can see the task.' }] };
  const first = (await call('create_task_draft', create)).body.result;
  assert.equal(first.isError, false, JSON.stringify(first));
  const again = (await call('create_task_draft', create)).body.result;
  assert.equal(again.isError, false, JSON.stringify(again));
  assert.equal((await db.select().from(schema.tasks).where(eq(schema.tasks.feature_id, feature.id))).length, 1);
  const foreign = (await call('create_task_draft', { ...create, feature_code: otherFeature.code, idempotency_key: 'connector-test-draft-2' })).body.result;
  assert.equal(foreign.isError, true);
  assert.equal((await db.select().from(schema.tasks).where(eq(schema.tasks.feature_id, otherFeature.id))).length, 0);
  await db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, project.id), eq(schema.members.principal_id, member.id)));
  const current = await mcp(token, 'tools/list', {});
  assert.ok(!current.body.result.tools.some(tool => tool.name === 'create_task_draft'));
  const changed = (await call('get_connection_context', previous)).body.result.structuredContent;
  assert.equal(changed.connector.toolsetChanged, true);
  assert.notEqual(changed.connector.toolsetRevision, before.toolsetRevision);
  assert.match(changed.toolsetNextStep, /tools\/list/);
  const connectionList = await app.inject({ url: connectionPath, headers });
  assert.equal(connectionList.json().data.find(item => item.code === connection.code).toolsetRevision, changed.connector.toolsetRevision);
  const blocked = await call('create_task_draft', { ...create, idempotency_key: 'connector-test-draft-after-downgrade' });
  assert.ok(blocked.body.error || blocked.body.result.isError);
});

test('an account grant alternates between two projects and rechecks each project role on every call', async t => {
  const { db, owner, member, team, project, other, feature, otherFeature, grant, mcp } = await fixture(t);
  const created_at = new Date().toISOString();
  const hidden = await insertProject(db, { name: 'Private project', team_id: team.id, member_policy: 'private', owner_principal_id: owner.id, created_by: owner.id, created_at });
  await insertProjectMember(db, { project_id: other.id, principal_id: member.id, display_name: member.display_name, role: 'member', created_at });
  const memory = createMemorySliceUseCases(db);
  const discussions = ['发布前核对验收证据', '发布前核对数据库兼容性'];
  for (const [index, selected] of [project, other].entries()) {
    const text = discussions[index];
    await memory.capture({ principalCode: owner.code, projectCode: selected.code, sessionId: 'fixture', eventId: `discussion-${index}`,
      sourceText: text, parts: [{ kind: 'discussion', text }] });
  }

  const { connection, token } = await grant(member, { projectCode: null, allowTaskWrite: true });
  assert.equal(connection.projectCode, null);
  const result = async (name, args) => (await mcp(token, 'tools/call', { name, arguments: args })).body;
  async function call(name, args) {
    const body = await result(name, args);
    assert.equal(body.result?.isError, false, JSON.stringify(body));
    return body.result.structuredContent;
  }
  const context = await call('get_connection_context', {});
  assert.equal(context.projectCode, null);
  const skill = await call('read_connector_skill', {});
  assert.equal(skill.name, 'team-synergy-connector');
  assert.match(skill.markdown, /^---\nname: team-synergy-connector\n/);
  const materialsReference = await call('read_connector_skill', { module: 'materials' });
  assert.equal(materialsReference.path, 'references/materials.md');
  assert.match(materialsReference.markdown, /^## `read_project_material`$/m);
  const available = await call('list_projects', {});
  assert.deepEqual(new Set(available.items.map(item => item.projectCode)), new Set([project.code, other.code]));
  assert.match(available.nextStep, /search_tools/);
  const absent = await result('list_tasks', {});
  assert.ok(absent.error || absent.result?.isError === true);
  const unauthorized = await result('list_tasks', { projectCode: hidden.code });
  assert.ok(unauthorized.error || unauthorized.result?.isError === true);

  const create = (projectCode, feature_code, index) => ({ projectCode, feature_code, title: `Draft ${index}`, idempotency_key: `multi-project-${index}`,
    acceptance: [{ id: 'AC-1', text: 'The task is created on its chosen project.' }] });
  const [first, second] = await Promise.all([
    call('create_task_draft', create(project.code, feature.code, 1)),
    call('create_task_draft', create(other.code, otherFeature.code, 2)),
  ]);
  assert.match(first.url, new RegExp(`/projects/${project.code}/board`));
  assert.match(second.url, new RegExp(`/projects/${other.code}/board`));
  assert.equal((await call('get_task', { projectCode: project.code, task_code: first.task_code })).title, 'Draft 1');
  assert.equal((await call('get_task', { projectCode: other.code, task_code: second.task_code })).title, 'Draft 2');
  const foreign = await result('get_task', { projectCode: other.code, task_code: first.task_code });
  assert.ok(foreign.error || foreign.result?.isError === true);

  for (const [index, selected] of [project, other].entries()) {
    const brief = await call('read_memory_brief', { projectCode: selected.code, scope: 'project' });
    assert.ok(brief.data.some(item => item.text === discussions[index]));
    assert.ok(!brief.data.some(item => item.text === discussions[1 - index]));
  }
  await db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, other.id), eq(schema.members.principal_id, member.id)));
  const blocked = await result('create_task_draft', create(other.code, otherFeature.code, 3));
  assert.ok(blocked.error || blocked.result?.isError === true);
  const retained = await call('create_task_draft', create(project.code, feature.code, 4));
  assert.equal((await call('get_task', { projectCode: project.code, task_code: retained.task_code })).title, 'Draft 4');

  await db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, other.id));
  const current = await call('list_projects', {});
  assert.deepEqual(current.items.map(item => item.projectCode), [project.code]);
});
