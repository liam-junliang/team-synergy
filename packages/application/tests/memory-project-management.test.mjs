import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryProjectManagementUseCases, createProjectDocumentUseCases, createMemorySliceUseCases } from '../dist/index.js';
import { checkDatabaseIntegrity } from '@team-synergy/persistence';
import { withIntegrityFixture } from '../../../scripts/orphan-fixture.mjs';

const baseUrl = process.env.TSP_TEST_DATABASE_URL;

test('automatic provisioning records a system actor and a pause before first provisioning remains durable', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memoryautoactor', async db => {
    const { memory, actor, q, other } = await setup(db);
    const ticket = await memory.prepareAutomatic(actor.projectCode);
    assert.ok(ticket);
    const [binding] = await q('select updated_source,updated_by,enabled from project_memory_bindings');
    assert.deepEqual(binding, { updated_source: 'system', updated_by: null, enabled: true });
    assert.equal((await q("select count(*)::int as n from project_material_index_events where action='binding.automatic_prepared'"))[0].n, 1);
    assert.equal((await q("select count(*)::int as n from audit_events where action='project_memory.enabled'"))[0].n, 0);
    assert.equal(await memory.prepareAutomatic(actor.projectCode), null, 'an active provisioning lease is not reclaimed');
    await memory.pause(actor);
    assert.equal(await memory.completeProvision({ ...ticket, binding: resource('obsolete') }), false);
    assert.equal(await memory.prepareAutomatic(actor.projectCode), null);
    await memory.pause({ ...actor, projectCode: other.code });
    assert.equal(await memory.prepareAutomatic(other.code), null, 'pause before the scheduler first sees a project is durable');
  }));
const resource = suffix => ({ wikiId: 'wiki-' + suffix, teamId: 'team-fixture', userId: 'service-fixture', semanticAgentId: 'semantic-fixture' });
const unwrap = result => { assert.equal(result.ok, true, result.error?.code); return result.data; };
async function setup(db) {
  const q = (text, values = []) => db.$client.query(text, values).then(result => result.rows);
  const [project] = await q("select * from projects where name='Fixture A'");
  const [other] = await q("select * from projects where name='Fixture B'");
  const [user] = await q("select * from users where account='integrity.fixture'");
  const actor = { projectCode: project.code, principalCode: user.code };
  return { q, project, other, user, actor, memory: createMemoryProjectManagementUseCases(db), docs: createProjectDocumentUseCases(db) };
}

test('project memory enable is idempotent, pause fences provisioning, and ready resources survive pause/resume', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrolstate', async db => {
    const { memory, actor, q } = await setup(db);
    assert.equal((await memory.status(actor)).bindingState, 'not_enabled');
    const concurrent = await Promise.all([memory.enable(actor), memory.enable(actor)]);
    assert.equal(concurrent.filter(value => value.provisionRequired).length, 1);
    assert.deepEqual(concurrent.map(value => value.generation), [1, 1]);
    assert.equal((await q("select count(*)::int as count from audit_events where action='project_memory.enabled'"))[0].count, 1);
    const pause = await memory.pause(actor);
    assert.equal(pause.enabled, false);
    assert.equal(await memory.completeProvision({ ...actor, generation: 1, binding: resource('one') }), false);
    const resumed = await memory.enable(actor);
    assert.equal(resumed.provisionRequired, true);
    assert.equal(resumed.generation, 3);
    assert.equal(await memory.failProvision({ ...actor, generation: 1, errorCode: 'provision_failed' }), false);
    assert.equal(await memory.completeProvision({ ...actor, generation: 3, binding: resource('one') }), true);
    assert.equal(await memory.completeProvision({ ...actor, generation: 3, binding: resource('other') }), false);
    const ready = await memory.status(actor);
    assert.equal(ready.retrievalEnabled, true);
    assert.equal(ready.storage, 'native_pg');
    assert.ok(!JSON.stringify(ready).includes('wiki-one'));
    await memory.pause(actor);
    const enabled = await memory.enable(actor);
    assert.equal(enabled.provisionRequired, false);
    assert.equal(enabled.status.bindingState, 'ready');
    assert.equal((await memory.binding(actor.projectCode)).wikiId, 'wiki-one');
    assert.equal((await checkDatabaseIntegrity(db)).total_orphans, 0);
  }));

test('expired provisioning can be reclaimed and raw errors or resource identities never enter management output', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrollease', async db => {
    const { memory, actor, q } = await setup(db);
    const first = await memory.enable(actor);
    await q("update project_memory_bindings set provision_lease_until=now()-interval '1 second'");
    const next = await memory.enable(actor);
    assert.equal(next.provisionRequired, true);
    assert.equal(next.generation, first.generation + 1);
    assert.equal(await memory.completeProvision({ ...actor, generation: first.generation, binding: resource('old') }), false);
    const privateError = 'Bearer should-never-persist-token';
    assert.equal(await memory.failProvision({ ...actor, generation: next.generation, errorCode: privateError }), true);
    const failed = await memory.status(actor);
    assert.equal(failed.bindingState, 'failed');
    assert.equal(failed.lastError, 'provision_failed');
    assert.equal(JSON.stringify(failed).includes(privateError), false);
    assert.equal((await q('select last_error from project_memory_bindings'))[0].last_error, 'provision_failed');
    const retry = await memory.enable(actor);
    assert.equal(retry.provisionRequired, true);
    assert.equal(await memory.completeProvision({ ...actor, generation: retry.generation, binding: resource('new') }), true);
    const offline = await memory.status(actor, { serviceConfigured: false });
    assert.equal(offline.enabled, true);
    assert.equal(offline.serviceConfigured, false);
    assert.equal(offline.retrievalEnabled, false);
  }));

test('guarded repair cannot enable a paused connection or overtake a newer resource generation', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrolrepairguard', async db => {
    const { memory, actor, q } = await setup(db);
    const first = await memory.enable(actor);
    await memory.pause(actor);
    const paused = await memory.binding(actor.projectCode);
    const auditsBefore = (await q('select count(*)::int as count from audit_events'))[0].count;
    for (const expectedGeneration of [first.generation, paused.generation]) {
      const result = await memory.enable(actor, {}, { expectedGeneration, onlyIfEnabled: true });
      assert.equal(result.provisionRequired, false);
      assert.equal(result.generation, paused.generation);
      assert.equal(result.status.enabled, false);
    }
    assert.equal((await q('select count(*)::int as count from audit_events'))[0].count, auditsBefore);
    const resumed = await memory.enable(actor);
    await memory.completeProvision({ ...actor, generation: resumed.generation, binding: resource('guard') });
    await memory.invalidateBinding({ ...actor, generation: resumed.generation, errorCode: 'resource_unavailable' });
    const failed = await memory.binding(actor.projectCode);
    const stale = await memory.enable(actor, {}, { expectedGeneration: resumed.generation, onlyIfEnabled: true });
    assert.equal(stale.provisionRequired, false);
    assert.equal(stale.status.bindingState, 'failed');
    const repair = await memory.enable(actor, {}, { expectedGeneration: failed.generation, onlyIfEnabled: true });
    assert.equal(repair.provisionRequired, true);
    assert.equal(repair.generation, failed.generation + 1);
    const duplicate = await memory.enable(actor, {}, { expectedGeneration: repair.generation, onlyIfEnabled: true });
    assert.equal(duplicate.provisionRequired, false);
    assert.equal(duplicate.generation, repair.generation);
  }));

test('guarded legacy repair requires an enabled mapping and never overrides a newly persisted pause', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrollegacyguard', async db => {
    const { memory, actor } = await setup(db);
    const guard = { expectedGeneration: null, onlyIfEnabled: true };
    const unconfigured = await memory.enable(actor, {}, guard);
    assert.equal(unconfigured.provisionRequired, false);
    assert.equal(unconfigured.status.enabled, false);
    assert.equal(await memory.binding(actor.projectCode), null);
    const options = { legacyConfigured: true };
    const ticket = await memory.enable(actor, options, guard);
    assert.equal(ticket.provisionRequired, true);
    await memory.completeProvision({ ...actor, generation: ticket.generation, binding: resource('legacyguard') });
    await memory.pause(actor, options);
    const late = await memory.enable(actor, options, guard);
    assert.equal(late.provisionRequired, false);
    assert.equal(late.status.enabled, false);
  }));

test('a newly bound Wiki requeues only current synced documents and an obsolete completion cannot reset them', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrolimport', async db => {
    const { memory, actor, docs, q, other } = await setup(db);
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Legacy source', content: 'Old.' }));
    unwrap(await docs.reviseDocument({ documentCode: created.document_code, principalCode: actor.principalCode,
      title: 'Legacy source', content: 'Current.', changeSummary: 'Current version', baseRevision: 1 }));
    unwrap(await docs.createDocument({ ...actor, projectCode: other.code, kind: 'doc', title: 'Other project', content: 'Keep.' }));
    await q("update memory_projection_jobs set status='synced',attempts=7,external_ref='wiki:legacy/source'");
    const first = await memory.enable(actor, { legacyConfigured: true });
    assert.equal(await memory.completeProvision({ ...actor, generation: first.generation, binding: resource('imported') }), true);
    assert.equal((await memory.status(actor)).counts.pending, 1);
    const rows = await q('select j.status,j.attempts,d.code,r.revision from memory_projection_jobs j join project_material_index_versions v on v.id=j.material_index_id join project_document_revisions r on r.code=v.revision_code join project_documents d on d.id=r.document_id');
    assert.equal(rows.find(row => row.code === created.document_code && row.revision === 1).status, 'synced');
    assert.equal(rows.find(row => row.code === created.document_code && row.revision === 2).status, 'pending');
    assert.equal(rows.find(row => row.code !== created.document_code).status, 'synced');
    assert.ok(rows.every(row => row.attempts === 7));
    await q("update memory_projection_jobs set status='synced'");
    assert.equal(await memory.completeProvision({ ...actor, generation: first.generation, binding: resource('obsolete') }), false);
    assert.equal((await memory.status(actor)).counts.synced, 1);
    await memory.pause(actor);
    assert.equal((await memory.enable(actor)).provisionRequired, false);
    assert.equal((await memory.status(actor)).counts.synced, 1);
  }));

test('management ACL and project fences reject unprivileged, inactive and archived mutations without creating state', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrolaccess', async db => {
    const { memory, actor, project, q } = await setup(db);
    for (const role of ['viewer', 'member']) {
      const [user] = await q('insert into users(account,display_name,created_at) values($1,$1,$2) returning id,code', ['memory.' + role, new Date().toISOString()]);
      await q('insert into members(project_id,principal_id,role,display_name,created_at) values($1,$2,$3,$3,$4)', [project.id, user.id, role, new Date().toISOString()]);
      const caller = { ...actor, principalCode: user.code };
      assert.equal((await memory.status(caller)).canManage, false);
      for (const method of ['enable', 'pause', 'retry']) await assert.rejects(memory[method](caller), { code: 'project_forbidden' });
    }
    await assert.rejects(memory.enable(actor, { serviceConfigured: false }), { code: 'memory_service_unavailable' });
    assert.equal(await memory.binding(actor.projectCode), null);
    await q('update users set pending_deletion=true where code=$1', [actor.principalCode]);
    await assert.rejects(memory.status(actor), { code: 'project_forbidden' });
    await q('update users set pending_deletion=false where code=$1', [actor.principalCode]);
    await q("update projects set status='archived' where id=$1", [project.id]);
    assert.equal((await memory.status(actor)).canManage, false);
    await assert.rejects(memory.enable(actor), { code: 'project_archived' });
    assert.equal(await memory.binding(actor.projectCode), null);
  }));

test('status and retry include only current public document jobs, preserving private memories and attempt fences', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontroljobs', async db => {
    const { memory, actor, other, docs, q, user, project } = await setup(db);
    const created = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Current source', content: 'Do not include full body in management.' }));
    unwrap(await docs.reviseDocument({ documentCode: created.document_code, principalCode: actor.principalCode, title: 'Current source', content: 'Latest source body.', changeSummary: 'Revise', baseRevision: 1 }));
    const revisions = await q('select r.id,r.code,r.revision from project_document_revisions r join project_documents d on d.id=r.document_id where d.code=$1 order by r.revision', [created.document_code]);
    const topic = (await q("insert into requirement_topics(project_id,title,created_by,created_at,updated_at) values($1,'Private test',$2,'t0','t0') returning code", [project.id, user.id]))[0];
    const feature = (await q('select id from features where project_id=(select id from projects where code=$1)', [actor.projectCode]))[0];
    const requirement = (await q("insert into requirements(feature_id,title,current_revision,state,owner_principal_id) values($1,'Private test',1,'draft',$2) returning id,code", [feature.id, user.id]))[0];
    await q("insert into requirement_revisions(requirement_id,revision,summary,acceptance_criteria,created_at) values($1,1,'Private','[]','t0')", [requirement.id]);
    const captured = createMemorySliceUseCases(db);
    const target = { ...actor, topicCode: topic.code, requirementCode: requirement.code };
    await captured.capture({ ...target, ...await captured.inspect(target), sessionId: 'private', eventId: 'style',
      sourceText: '我习惯私人工作笔记绝不公开。', parts: [{ kind: 'preference', text: '我习惯私人工作笔记绝不公开。' }] });
    await q("update memory_projection_jobs set status='needs_reconcile', attempts=7,last_error='SECRET_JOB_ERROR'");
    const enabled = await memory.enable(actor);
    await memory.completeProvision({ ...actor, generation: enabled.generation, binding: resource('current') });
    const status = await memory.status(actor);
    assert.deepEqual(status.counts, { total: 1, pending: 0, processing: 0, synced: 0, needsReconcile: 1, notQueued: 0 });
    assert.equal(status.documents[0].source, revisions[1].code);
    assert.equal(status.documents[0].lastError, 'delivery_not_verified');
    assert.equal(JSON.stringify(status).includes('Latest source body.'), false);
    assert.equal(JSON.stringify(status).includes('私人'), false);
    assert.equal(JSON.stringify(status).includes('SECRET_JOB_ERROR'), false);
    const retried = await memory.retry(actor);
    assert.equal(retried.retried, 2, 'retry includes the retired index cleanup and current upsert, never a private fragment');
    assert.equal(retried.status.counts.pending, 1);
    const rows = await q('select j.fragment_id,r.id as project_document_revision_id,j.status,j.attempts from memory_projection_jobs j left join project_material_index_versions v on v.id=j.material_index_id left join project_document_revisions r on r.code=v.revision_code order by j.id');
    assert.equal(rows.find(row => row.project_document_revision_id === revisions[0].id).status, 'pending');
    assert.equal(rows.find(row => row.fragment_id !== null).status, 'needs_reconcile');
    assert.ok(rows.every(row => row.attempts === 7));
    assert.equal((await memory.status({ ...actor, projectCode: other.code })).counts.total, 0);
    await memory.pause(actor);
    await assert.rejects(memory.retry(actor), { code: 'memory_not_enabled' });
  }));

test('ready-resource invalidation is generation fenced and cannot reactivate or overwrite a paused connection', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrolinvalidate', async db => {
    const { memory, actor, docs, q, other } = await setup(db);
    const document = unwrap(await docs.createDocument({ ...actor, kind: 'doc', title: 'Repair source', content: 'One.' }));
    unwrap(await docs.reviseDocument({ documentCode: document.document_code, principalCode: actor.principalCode,
      title: 'Repair source', content: 'Two.', changeSummary: 'Current version', baseRevision: 1 }));
    unwrap(await docs.createDocument({ ...actor, projectCode: other.code, kind: 'doc', title: 'Other project', content: 'Keep.' }));
    const first = await memory.enable(actor);
    await memory.completeProvision({ ...actor, generation: first.generation, binding: resource('repair') });
    await q("update memory_projection_jobs set status='synced',attempts=7");
    assert.equal(await memory.invalidateBinding({ ...actor, generation: first.generation + 1, errorCode: 'engine_unavailable' }), false);
    assert.equal(await memory.invalidateBinding({ ...actor, generation: first.generation, errorCode: 'resource_unavailable' }), true);
    const failed = await memory.binding(actor.projectCode);
    assert.equal(failed.generation, first.generation + 1);
    assert.equal(failed.state, 'failed');
    assert.equal((await memory.status(actor)).lastError, 'resource_unavailable');
    assert.equal((await memory.status(actor)).counts.needsReconcile, 1);
    const jobs = await q('select j.status,j.attempts,d.code,r.revision from memory_projection_jobs j join project_material_index_versions v on v.id=j.material_index_id join project_document_revisions r on r.code=v.revision_code join project_documents d on d.id=r.document_id');
    assert.equal(jobs.find(row => row.code === document.document_code && row.revision === 1).status, 'synced');
    assert.equal(jobs.find(row => row.code !== document.document_code).status, 'synced');
    assert.ok(jobs.every(row => row.attempts === 7));
    assert.equal(await memory.invalidateBinding({ ...actor, generation: first.generation, errorCode: 'identity_mismatch' }), false);
    const repair = await memory.enable(actor);
    assert.equal(repair.provisionRequired, true);
    await memory.completeProvision({ ...actor, generation: repair.generation, binding: resource('repaired') });
    assert.equal((await memory.retry(actor)).retried, 1);
    await memory.pause(actor);
    assert.equal(await memory.invalidateBinding({ ...actor, generation: repair.generation, errorCode: 'engine_unavailable' }), false);
    assert.equal((await memory.binding(actor.projectCode)).enabled, false);
  }));

test('a persisted pause overrides legacy configuration, while absent rows retain legacy compatibility', { skip: !baseUrl }, async () =>
  withIntegrityFixture(baseUrl, 'memorycontrollegacy', async db => {
    const { memory, actor } = await setup(db);
    const options = { legacyConfigured: true, serviceConfigured: true };
    assert.equal((await memory.status(actor, options)).retrievalEnabled, true);
    const paused = await memory.pause(actor, options);
    assert.equal(paused.enabled, false);
    assert.equal((await memory.status(actor, options)).retrievalEnabled, false);
    assert.equal((await memory.binding(actor.projectCode)).enabled, false);
    const resumed = await memory.enable(actor, options);
    assert.equal(resumed.provisionRequired, true);
    assert.equal(await memory.completeProvision({ ...actor, generation: resumed.generation, binding: resource('legacy') }), true);
    assert.equal((await memory.status(actor, options)).retrievalEnabled, true);
  }));
