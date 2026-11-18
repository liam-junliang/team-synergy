import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { schema } from '@team-synergy/persistence';
import { CodeArtifactSchema, validateCodeArtifact } from '@team-synergy/contracts';
import { createCodeUnderstandingUseCases } from '../dist/index.js';
import { seedWorkspaceProject, useTestDb, insertUser } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const bad = (result, code) => { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code); };
async function setup() {
  const db = fixture.db, ctx = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'owner', displayName: 'Owner', projectRole: 'owner' },
    { key: 'member', account: 'member', displayName: 'Member', projectRole: 'member' },
    { key: 'otherMember', account: 'other-member', displayName: 'Other member', projectRole: 'member' },
    { key: 'viewer', account: 'viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  const [repo] = await db.insert(schema.projectRepositories).values({ project_id: ctx.project.id, name: 'Source', remote_url: 'https://example.invalid/repo.git', created_by: ctx.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const uc = createCodeUnderstandingUseCases(db), command = { projectCode: ctx.project.code, principalCode: ctx.users.owner.code };
  const plugins = ['ua', 'codegraph'].map(plugin_id => ({ plugin_id, engine_version: '1', adapter_version: '1', protocol_version: 1 }));
  return { ...ctx, db, uc, repo, command, input: { idempotency_key: 'one', repository_code: repo.code, kind: 'commit', requested_ref: 'HEAD', plugins } };
}
function snapshot(kind = 'commit') {
  const files = [{ path: 'src/auth.ts', sha256: 'c'.repeat(64), line_count: 100, byte_count: 1000 }];
  const identity = { kind, commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifest_sha256: hash(files), scope: ['src'], exclusions: [] };
  return { snapshot_id: hash(identity), ...identity, captured_at: '2026-10-27T00:00:00.000Z', files };
}
function artifact(snap) {
  const node = { evidence_ids: ['e'], verification: 'inferred' };
  return { schema_version: 1, snapshot_id: snap.snapshot_id,
    nodes: [{ ...node, id: 'ua:auth', native_id: 'auth', provider: 'ua', kind: 'module', label: 'Authentication', summary: 'Login capability', layer: 'Services' },
      { ...node, id: 'cg:auth', native_id: 'auth', provider: 'codegraph', kind: 'function', label: 'authenticate', path: 'src/auth.ts', line_start: 2, line_end: 5 }],
    edges: [{ id: 'bridge', source: 'ua:auth', target: 'cg:auth', type: 'implemented_by', provider: 'bridge', provenance: 'agent', evidence_ids: ['e'], verification: 'inferred' }],
    evidence: [{ id: 'e', path: 'src/auth.ts', sha256: 'c'.repeat(64), line_start: 2, line_end: 5, snippet: 'function authenticate() {}' }],
    tour: [{ title: 'Auth', description: 'Authentication flow', node_ids: ['ua:auth'] }],
    coverage: ['ua', 'codegraph'].map(provider => ({ provider, analyzed_files: 1, total_files: 1, limitations: ['Static analysis'] })), semantic_author: { kind: 'agent', model: null, prompt_version: '1' } };
}
function uaGraph(value, snap) {
  const nativeIds = new Map(value.nodes.filter(node => node.provider === 'ua').map(node => [node.id, node.native_id]));
  const layers = [...new Set(value.nodes.filter(node => node.provider === 'ua').map(node => node.layer).filter(Boolean))];
  return { version: '1.0.0', kind: 'codebase', project: { name: 'Example', languages: ['TypeScript'], frameworks: [], description: 'Authentication system', analyzedAt: snap.captured_at, gitCommitHash: snap.commit },
    nodes: value.nodes.filter(node => node.provider === 'ua').map(node => ({ id: node.native_id, type: node.kind, name: node.label, summary: node.summary ?? '', tags: ['auth'], complexity: 'moderate', ...(node.path ? { filePath: node.path } : {}), ...(node.line_start ? { lineRange: [node.line_start, node.line_end] } : {}) })),
    edges: value.edges.filter(edge => edge.provider === 'ua').map(edge => ({ source: nativeIds.get(edge.source), target: nativeIds.get(edge.target), type: edge.type, direction: 'forward', weight: 0.8 })),
    layers: layers.map((name, index) => ({ id: `layer-${index}`, name, description: 'Module responsibilities', nodeIds: value.nodes.filter(node => node.provider === 'ua' && node.layer === name).map(node => node.native_id) })),
    tour: value.tour.map((step, order) => ({ order, title: step.title, description: step.description, nodeIds: step.node_ids.map(id => nativeIds.get(id)) })),
  };
}
async function publish(f, key = 'one', kind = 'commit', edit = value => value) {
  let run = ok(await f.uc.register({ ...f.command, input: { ...f.input, idempotency_key: key, kind } }));
  const snap = snapshot(kind);
  run = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: run.revision, status: 'awaiting_agent', snapshot: snap } }));
  return ok(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: edit(artifact(snap)) } }));
}
async function compose(f, run, base_view_code = null) { return ok(await f.uc.compose({ ...f.command, input: { base_view_code, selections: [{ repository_code: run.repository_code, run_code: run.code }] } })); }

test('persistent register/progress/publish retries preserve immutable snapshots and require explicit view selection', async () => {
  const f = await setup(), registered = ok(await f.uc.register({ ...f.command, input: f.input }));
  assert.equal(registered.runner, 'member_cli');
  assert.equal(ok(await f.uc.register({ ...f.command, input: f.input })).code, registered.code);
  bad(await f.uc.register({ ...f.command, input: { ...f.input, requested_ref: 'other' } }), 'code_understanding_conflict');
  const progressInput = { expected_revision: 0, status: 'awaiting_agent', snapshot: snapshot() };
  const ready = ok(await f.uc.progress({ ...f.command, code: registered.code, input: progressInput }));
  assert.equal(ok(await f.uc.progress({ ...f.command, code: registered.code, input: progressInput })).revision, ready.revision);
  bad(await f.uc.progress({ ...f.command, code: registered.code, input: { ...progressInput, expected_revision: 1, snapshot: { ...snapshot(), captured_at: '2026-10-28T00:00:00.000Z' } } }), 'code_understanding_conflict');
  const publication = { expected_revision: ready.revision, artifact: artifact(snapshot()) };
  const done = ok(await f.uc.publish({ ...f.command, code: ready.code, input: publication }));
  assert.equal(ok(await f.uc.publish({ ...f.command, code: ready.code, input: publication })).revision, done.revision);
  assert.equal(ok(await f.uc.context(f.command)).current_view, null);
  const view = await compose(f, done);
  ok(await f.uc.select({ ...f.command, code: view.code, input: { expected_current: null } }));
  const graph = ok(await f.uc.graph({ ...f.command, input: {} }));
  assert.equal(graph.view.code, view.code); assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 1); assert.equal(graph.evidence[0].snippet, 'function authenticate() {}');
  assert.equal('files' in graph.runs[0].snapshot, false); assert.equal(graph.runs[0].snapshot.file_count, 1);
  const map = ok(await f.uc.uaMap({ ...f.command, code: done.code }));
  assert.equal(map.graph, null); assert.equal(map.metadata_complete, false); assert.equal(map.projection.nodes.length, 1); assert.deepEqual(map.projection.evidence, []);
  const detail = ok(await f.uc.graph({ ...f.command, input: { run_code: done.code, node_id: 'cg:auth', limit: 1 } }));
  assert.equal(detail.nodes[0].id, 'cg:auth'); assert.equal(detail.total_nodes, 2); assert.equal(detail.truncated, true);
  bad(await f.uc.graph({ ...f.command, input: { run_code: done.code, node_id: 'missing' } }), 'code_understanding_not_found');
  const reopened = createCodeUnderstandingUseCases(f.db);
  assert.equal(ok(await reopened.detail({ ...f.command, code: done.code })).artifact_sha256, done.artifact_sha256);
  bad(await f.uc.publish({ ...f.command, code: ready.code, input: { ...publication, artifact: { ...publication.artifact, tour: [] } } }), 'code_understanding_conflict');
});

test('run metadata reads do not load published artifact JSON', async () => {
  const f = await setup();
  const run = await publish(f);
  const runQueries = [];
  const db = drizzle(f.db.$client, { schema, logger: { logQuery(query) {
    if (query.includes('from "code_understanding_runs"')) runQueries.push(query);
  } } });
  const uc = createCodeUnderstandingUseCases(db);

  assert.deepEqual(ok(await uc.context(f.command)).runs, [run]);
  assert.deepEqual(ok(await uc.detail({ ...f.command, code: run.code })), run);
  const view = await compose({ ...f, uc }, run);
  assert.equal(view.selections[0].run_code, run.code);

  assert.equal(runQueries.length, 4);
  for (const query of runQueries) {
    assert.ok(query.includes('"artifact_sha256"'));
    assert.ok(!query.includes('"artifact_json"'));
  }
});

test('run creator owns progress and publication while project collaborators retain reads and view selection', async () => {
  const f = await setup(), creator = { ...f.command, principalCode: f.users.member.code }, colleague = { ...f.command, principalCode: f.users.otherMember.code };
  const run = ok(await f.uc.register({ ...creator, input: f.input }));
  const progress = { expected_revision: 0, status: 'awaiting_agent', snapshot: snapshot() };
  for (const actor of [colleague, f.command]) {
    bad(await f.uc.progress({ ...actor, code: run.code, input: progress }), 'code_understanding_forbidden');
    bad(await f.uc.progress({ ...actor, code: run.code, input: { expected_revision: 0, status: 'cancelled' } }), 'code_understanding_forbidden');
  }
  const ready = ok(await f.uc.progress({ ...creator, code: run.code, input: progress }));
  const publication = { expected_revision: ready.revision, artifact: artifact(snapshot()) };
  for (const actor of [colleague, f.command]) bad(await f.uc.publish({ ...actor, code: run.code, input: publication }), 'code_understanding_forbidden');
  assert.equal(ok(await f.uc.detail({ ...colleague, code: run.code })).revision, ready.revision);
  const done = ok(await f.uc.publish({ ...creator, code: run.code, input: publication }));
  // A byte-identical retry by another user must not impersonate the creator either.
  bad(await f.uc.publish({ ...colleague, code: run.code, input: publication }), 'code_understanding_forbidden');
  assert.equal(ok(await f.uc.graph({ ...colleague, input: { run_code: run.code } })).nodes.length, 2);
  const view = ok(await f.uc.compose({ ...colleague, input: { base_view_code: null, selections: [{ repository_code: done.repository_code, run_code: done.code }] } }));
  assert.equal(ok(await f.uc.select({ ...colleague, code: view.code, input: { expected_current: null } })).code, view.code);
});

test('ACL denies viewer, unrelated system admin and cross-project run IDs; archives preserve read only', async () => {
  const f = await setup(), run = await publish(f), system = await insertUser(f.db, { account: 'ops', displayName: 'Ops', isSystemAdmin: true });
  for (const principalCode of [f.users.viewer.code, system.code]) {
    bad(await f.uc.context({ ...f.command, principalCode }));
    bad(await f.uc.detail({ ...f.command, principalCode, code: run.code }));
    bad(await f.uc.graph({ ...f.command, principalCode, input: { run_code: run.code } }));
    bad(await f.uc.uaMap({ ...f.command, principalCode, code: run.code }));
    bad(await f.uc.register({ ...f.command, principalCode, input: { ...f.input, idempotency_key: principalCode } }));
  }
  const [otherProject] = await f.db.insert(schema.projects).values({ team_id: f.project.team_id, name: 'Other', owner_principal_id: f.users.owner.id }).returning();
  const otherCommand = { ...f.command, projectCode: otherProject.code };
  bad(await f.uc.register({ ...otherCommand, input: { ...f.input, idempotency_key: 'foreign-repo' } }), 'code_understanding_invalid');
  bad(await f.uc.detail({ ...otherCommand, code: run.code }), 'code_understanding_not_found');
  bad(await f.uc.graph({ ...otherCommand, input: { run_code: run.code } }), 'code_understanding_not_found');
  bad(await f.uc.uaMap({ ...otherCommand, code: run.code }), 'code_understanding_not_found');
  bad(await f.uc.compose({ ...otherCommand, input: { base_view_code: null, selections: [{ repository_code: run.repository_code, run_code: run.code }] } }), 'code_understanding_not_found');
  await f.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, f.project.id));
  assert.equal(ok(await f.uc.detail({ ...f.command, code: run.code })).code, run.code);
  assert.equal(ok(await f.uc.context(f.command)).can_write, false);
  bad(await f.uc.register({ ...f.command, input: { ...f.input, idempotency_key: 'archived' } }), 'project_archived');
});

test('native UA map preserves all nodes and relationships across ordinary query pages', async () => {
  const f = await setup();
  const run = await publish(f, 'ua-map', 'commit', value => {
    for (let index = 0; index < 250; index++) value.nodes.push({ id: `ua:n${index}`, native_id: `n${index}`, provider: 'ua', kind: 'module', label: `Module ${index}`, summary: 'Component responsibility', layer: 'Services', evidence_ids: [], verification: 'inferred' });
    value.edges.push({ id: 'ua:cross-page', source: 'ua:auth', target: 'ua:n249', type: 'depends_on', provider: 'ua', provenance: 'agent', evidence_ids: [], verification: 'inferred' });
    value.ua_graph = uaGraph(value, snapshot()); value.ua_graph.nodes[0].domainMeta = { entities: ['Account'], businessRules: ['Validate account credentials'], entryType: 'http', entryPoint: '/api/login' };
    return value;
  });
  const regular = ok(await f.uc.graph({ ...f.command, input: { run_code: run.code, provider: 'ua', limit: 200 } }));
  assert.equal(regular.nodes.length, 200); assert.equal(regular.truncated, true); assert(!regular.edges.some(edge => edge.id === 'ua:cross-page'));
  const full = ok(await f.uc.uaMap({ ...f.command, code: run.code }));
  assert.equal(full.metadata_complete, true); assert.equal(full.graph.nodes.length, 251); assert.equal(full.projection.nodes.length, 251); assert.equal(full.projection.truncated, false);
  assert(full.projection.edges.some(edge => edge.id === 'ua:cross-page')); assert.equal(full.graph.edges[0].target, 'n249');
  assert.deepEqual(full.graph.nodes[0].domainMeta.entities, ['Account']); assert.deepEqual(full.projection.evidence, []);
  assert(full.projection.nodes.every(node => node.run_code === run.code && node.provider === 'ua'));
});

test('native metadata cannot introduce mismatched identities, references, unsafe fields or exact complete source bytes', async () => {
  const f = await setup(); let run = ok(await f.uc.register({ ...f.command, input: f.input }));
  const snap = snapshot(), source = 'export const privateSource = 42;';
  snap.files[0].sha256 = createHash('sha256').update(source).digest('hex'); snap.files[0].byte_count = Buffer.byteLength(source);
  snap.manifest_sha256 = hash(snap.files); snap.snapshot_id = hash({ kind: snap.kind, commit: snap.commit, tree: snap.tree, manifest_sha256: snap.manifest_sha256, scope: snap.scope, exclusions: snap.exclusions });
  run = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: 0, status: 'awaiting_agent', snapshot: snap } }));
  const base = artifact(snap); base.evidence[0].sha256 = snap.files[0].sha256; base.ua_graph = uaGraph(base, snap);
  for (const mutate of [
    graph => { graph.project.gitCommitHash = 'f'.repeat(40); },
    graph => { graph.nodes[0].id = 'missing'; },
    graph => { graph.nodes[0].summary = 'Different semantic claim'; },
    graph => { graph.nodes[0].filePath = 'src/missing.ts'; },
    graph => { graph.layers[0].nodeIds.push('missing'); },
    graph => { graph.tour[0].nodeIds.push('missing'); },
    graph => { graph.edges.push({ source: 'auth', target: 'missing', type: 'calls', direction: 'forward', weight: 1 }); },
    graph => { graph.nodes[0].domainMeta = { businessRules: ['Read F:/private/repository'] }; },
    graph => { graph.nodes[0].knowledgeMeta = { content: source }; },
    graph => { graph.nodes[0].languageNotes = source; },
  ]) {
    const candidate = structuredClone(base); mutate(candidate.ua_graph);
    bad(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: candidate } }), 'code_understanding_invalid');
  }
  bad(await f.uc.uaMap({ ...f.command, code: run.code }), 'code_understanding_conflict');
  const done = ok(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: base } }));
  assert.equal(ok(await f.uc.uaMap({ ...f.command, code: done.code })).metadata_complete, true);
});

test('concurrent view select uses CAS; draft pointer never replaces committed pointer; base composition preserves other repos', async () => {
  const f = await setup(), first = await publish(f), second = await publish(f, 'second'), draft = await publish(f, 'draft', 'draft');
  const firstView = await compose(f, first), secondView = await compose(f, second), draftView = await compose(f, draft);
  const outcomes = await Promise.all([firstView, secondView].map(view => f.uc.select({ ...f.command, code: view.code, input: { expected_current: null } })));
  assert.equal(outcomes.filter(item => item.ok).length, 1); assert.equal(outcomes.filter(item => !item.ok).length, 1);
  const before = ok(await f.uc.context(f.command)).current_view;
  ok(await f.uc.select({ ...f.command, code: draftView.code, input: { expected_current: null } }));
  const after = ok(await f.uc.context(f.command)); assert.equal(after.current_view, before); assert.equal(after.current_draft_view, draftView.code);
  const [repo] = await f.db.insert(schema.projectRepositories).values({ project_id: f.project.id, name: 'Second', remote_url: 'https://example.invalid/second.git', created_by: f.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  f.input.repository_code = repo.code;
  const other = await publish(f, 'other'), aggregate = await compose(f, other, firstView.code);
  assert.equal(aggregate.selections.length, 2);
  const graph = ok(await f.uc.graph({ ...f.command, input: { view_code: aggregate.code } }));
  assert.equal(graph.nodes.length, 4); assert.equal(new Set(graph.nodes.map(node => node.run_code + ':' + node.id)).size, 4);
  const last = ok(await f.uc.graph({ ...f.command, input: { view_code: aggregate.code, offset: 3, limit: 1 } }));
  assert.equal(last.nodes.length, 1); assert.equal(last.total_nodes, 4); assert.equal(last.nodes[0].run_code, graph.nodes[3].run_code); assert.equal(last.truncated, false);
});

test('cancel rejects late publication; invalid snapshot digests, graph refs and raw extras cannot enter storage', async () => {
  const f = await setup(); let run = ok(await f.uc.register({ ...f.command, input: f.input }));
  bad(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: 0, status: 'indexing', snapshot: { ...snapshot(), manifest_sha256: 'f'.repeat(64) } } }), 'code_understanding_invalid');
  run = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: 0, status: 'awaiting_agent', snapshot: snapshot() } }));
  for (const edit of [a => ({ ...a, source_code: 'raw secret' }), a => ({ ...a, edges: [{ ...a.edges[0], target: 'absent' }] }), a => ({ ...a, nodes: [{ ...a.nodes[0], path: 'C:/private/source.ts' }] }), a => ({ ...a, nodes: [{ ...a.nodes[0], summary: 'See C:/private/source.ts' }] }), a => ({ ...a, tour: [{ title: 'Read', description: 'Bearer ' + 'secret'.repeat(8), node_ids: [] }] })]) {
    bad(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: edit(artifact(snapshot())) } }), 'code_understanding_invalid');
  }
  const cancelled = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: run.revision, status: 'cancelled' } }));
  bad(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: cancelled.revision, artifact: artifact(snapshot()) } }), 'code_understanding_conflict');
  assert.equal((await f.db.select().from(schema.codeUnderstandingExcerptBudgets)).length, 0);
});

test('excerpt budget spans repeated runs and renamed paths for identical source bytes', async () => {
  const f = await setup();
  const edit = start => a => ({ ...a, evidence: [{ ...a.evidence[0], line_start: start, line_end: start + 29, snippet: 'x'.repeat(1100) }] });
  await publish(f, 'one', 'commit', edit(1)); await publish(f, 'two', 'commit', edit(31));
  let run = ok(await f.uc.register({ ...f.command, input: { ...f.input, idempotency_key: 'three' } }));
  const renamed = snapshot(); renamed.files[0].path = 'src/renamed.ts'; renamed.manifest_sha256 = hash(renamed.files);
  renamed.snapshot_id = hash({ kind: renamed.kind, commit: renamed.commit, tree: renamed.tree, manifest_sha256: renamed.manifest_sha256, scope: renamed.scope, exclusions: renamed.exclusions });
  run = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: 0, status: 'awaiting_agent', snapshot: renamed } }));
  const next = edit(61)(artifact(renamed)); next.evidence[0].path = 'src/renamed.ts'; next.nodes[1].path = 'src/renamed.ts';
  bad(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: next } }), 'code_understanding_invalid');
  assert.equal(ok(await f.uc.detail({ ...f.command, code: run.code })).status, 'awaiting_agent');
});

test('rules, entities, purposes, open questions and interactions are searchable with source identities and evidence', async () => {
  const f = await setup();
  const done = await publish(f, 'domain-search', 'commit', value => {
    value.ua_graph = uaGraph(value, snapshot());
    value.ua_graph.nodes[0].domainMeta = { businessRules: ['退款超过七天转人工审核'], entities: ['RefundApproval'], userPurposes: ['减少跨成员接手成本'], unknowns: ['退款审批并发行为待验证'], crossDomainInteractions: ['审批完成后通知财务系统'] };
    value.nodes[0].domain_meta = structuredClone(value.ua_graph.nodes[0].domainMeta);
    return value;
  });
  for (const query of ['超过七天', 'refundapproval', '通知财务', '跨成员接手', '并发行为待验证']) {
    const result = ok(await f.uc.graph({ ...f.command, input: { run_code: done.code, provider: 'ua', query } }));
    assert.equal(result.total_nodes, 1); assert.equal(result.nodes[0].id, 'ua:auth');
    assert.equal(result.nodes[0].run_code, done.code); assert.equal(result.nodes[0].snapshot_id, snapshot().snapshot_id);
    assert.deepEqual(result.nodes[0].domain_meta.businessRules, ['退款超过七天转人工审核']);
    assert.deepEqual(result.nodes[0].domain_meta.userPurposes, ['减少跨成员接手成本']);
    assert.deepEqual(result.nodes[0].domain_meta.unknowns, ['退款审批并发行为待验证']);
    assert.equal(result.evidence[0].path, 'src/auth.ts'); assert.equal(result.evidence[0].sha256, 'c'.repeat(64));
  }
  assert.equal(ok(await f.uc.graph({ ...f.command, input: { run_code: done.code, provider: 'codegraph', query: 'RefundApproval' } })).total_nodes, 0);
  assert.equal(ok(await f.uc.graph({ ...f.command, input: { run_code: done.code, query: 'unknown-domain-rule' } })).total_nodes, 0);
});

test('legacy normalized UA metadata remains searchable without a retained native graph', async () => {
  const f = await setup();
  const done = await publish(f, 'projected-metadata-search', 'commit', value => {
    value.nodes[0].domain_meta = { userPurposes: ['支持旧投影的接手用途'], unknowns: ['旧投影的未知项仍可查询'] };
    return value;
  });
  for (const query of ['旧投影的接手', '未知项仍可查询']) {
    const result = ok(await f.uc.graph({ ...f.command, input: { run_code: done.code, provider: 'ua', query } }));
    assert.equal(result.total_nodes, 1); assert.equal(result.nodes[0].id, 'ua:auth');
    assert.deepEqual(result.nodes[0].domain_meta, { userPurposes: ['支持旧投影的接手用途'], unknowns: ['旧投影的未知项仍可查询'] });
  }
});

test('member CLI publications cannot claim server full semantic analysis even with a structurally valid report', async () => {
  const f = await setup(), snap = snapshot();
  let run = ok(await f.uc.register({ ...f.command, input: { ...f.input, idempotency_key: 'member-full-report' } }));
  run = ok(await f.uc.progress({ ...f.command, code: run.code, input: { expected_revision: 0, status: 'awaiting_agent', snapshot: snap } }));
  const value = artifact(snap);
  Object.assign(value.nodes[0], { path: 'src/auth.ts', line_start: 2, line_end: 5 }); value.ua_graph = uaGraph(value, snap);
  value.semantic_analysis = {
    protocol_version: 2, mode: 'full', snapshot_id: snap.snapshot_id, manifest_sha256: snap.manifest_sha256, prompt_version: 'full-test',
    file_coverage: [{ path: 'src/auth.ts', sha256: 'c'.repeat(64), total_bytes: 1000, covered_bytes: 1000, segments: [{ id: `segment:${'1'.repeat(32)}`, input_sha256: '1'.repeat(64), byte_start: 0, byte_end: 1000, line_start: 1, line_end: 100, completed: true }] }],
    node_evidence: [{ node_id: 'ua:auth', evidence_ids: ['e'] }], relation_evidence: [],
    counts: { total_files: 1, total_bytes: 1000, covered_bytes: 1000, total_segments: 1, completed_segments: 1, supported_nodes: 1, supported_relations: 0, native_dependency_relations: 0, semantic_inference_relations: 0, unresolved_items: 0 },
    uncertainty: { semantic_correctness: 'requires_independent_evaluation', unresolved_items: 0, limitations: ['Server input-processing declaration, not model reasoning proof'] },
  };
  assert(CodeArtifactSchema.safeParse(value).success); assert.deepEqual(validateCodeArtifact(value, snap), []);
  const rejected = await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: value } });
  bad(rejected, 'code_understanding_forbidden'); assert.match(rejected.error.message, /server hosted analysis/);
  assert.equal(ok(await f.uc.detail({ ...f.command, code: run.code })).status, 'awaiting_agent');
  delete value.semantic_analysis;
  assert.equal(ok(await f.uc.publish({ ...f.command, code: run.code, input: { expected_revision: run.revision, artifact: value } })).status, 'succeeded');
});
