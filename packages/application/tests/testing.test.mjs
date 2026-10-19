import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTestingUseCases } from '../dist/index.js';
import { insertFeature, insertProject, insertRequirement, insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
function data(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
function rejected(result, code) { assert.equal(result.ok, false, JSON.stringify(result)); if (code) assert.equal(result.error.code, code); }
async function setup() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'testing.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'admin', account: 'testing.admin', displayName: 'Admin', projectRole: 'admin' },
    { key: 'author', account: 'testing.author', displayName: 'Author', projectRole: 'member' },
    { key: 'peer', account: 'testing.peer', displayName: 'Peer', projectRole: 'member' },
    { key: 'viewer', account: 'testing.viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  const outsider = await insertUser(db, { account: 'testing.outside', displayName: 'Outside' });
  const foreign = await insertProject(db, { teamId: seeded.team.id, name: 'Other project' });
  const feature = await insertFeature(db, { projectId: seeded.project.id, title: 'Login' });
  const foreignFeature = await insertFeature(db, { projectId: foreign.id, title: 'Foreign feature' });
  return { db, ...seeded, outsider, foreign, feature, foreignFeature, uc: createTestingUseCases(db),
    base: { projectCode: seeded.project.code, principalCode: seeded.users.author.code } };
}
function caseInput(extra = {}) { return { title: 'Login case', steps: [{ action: 'Submit login', expected: 'Open dashboard' }], ...extra }; }
function runInput(testCase, extra = {}) { return { title: 'Release smoke', environment: 'Staging Chrome', tested_version: 'build-42',
  results: [{ case_code: testCase.code, case_revision: testCase.current_revision, result: 'fail', actual_result: 'HTTP 500', report_urls: ['https://example.com/report/42'] }], ...extra }; }

test('test case edits preserve exact revisions, searchable content and optimistic conflicts', async () => {
  const c = await setup();
  const first = data(await c.uc.createCase({ ...c.base, input: caseInput({ suite: 'Smoke', notes_markdown: 'Search needle', tags: ['login'] }) }));
  const revised = data(await c.uc.reviseCase({ code: first.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'New expected result', steps: [{ action: 'Submit', expected: 'Profile' }] } }));
  assert.equal(revised.current_revision, 2);
  assert.equal(revised.revisions[1].steps[0].expected, 'Open dashboard');
  assert.equal(revised.suite, 'Smoke');
  rejected(await c.uc.reviseCase({ code: first.code, principalCode: c.users.admin.code, input: { base_revision: 1, change_summary: 'Stale', title: 'Overwrite' } }), 'testing_revision_conflict');
  assert.equal(data(await c.uc.getCase(first.code, c.users.owner.code)).revisions.length, 2);
  assert.equal(data(await c.uc.listCases({ ...c.base, query: 'needle', suite: 'Smoke', method: 'manual' })).length, 1);
  assert.equal(data(await c.uc.listCases({ ...c.base, suite: 'Regression' })).length, 0);
});

test('current role and archive guard protect definitions and execution writes; outsiders cannot read', async () => {
  const c = await setup();
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  const asset = data(await c.uc.createAsset({ ...c.base, input: { title: 'Guide', content: '# Instructions' } }));
  rejected(await c.uc.reviseCase({ code: testCase.code, principalCode: c.users.peer.code, input: { base_revision: 1, change_summary: 'Peer edit' } }), 'testing_forbidden');
  data(await c.uc.reviseAsset({ code: asset.code, principalCode: c.users.admin.code, input: { base_revision: 1, change_summary: 'Admin maintenance', content: 'Updated' } }));
  await c.db.update(schema.members).set({ role: 'viewer' }).where(and(eq(schema.members.project_id, c.project.id), eq(schema.members.principal_id, c.users.author.id)));
  rejected(await c.uc.reviseCase({ code: testCase.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Former author' } }), 'project_forbidden');
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase) }), 'project_forbidden');
  assert.equal(data(await c.uc.getCase(testCase.code, c.users.author.code)).can_edit, false);
  for (const result of await Promise.all([c.uc.getCase(testCase.code, c.outsider.code), c.uc.getAsset(asset.code, c.outsider.code), c.uc.listExecutions({ ...c.base, principalCode: c.outsider.code })])) rejected(result, 'project_forbidden');
  await c.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, c.project.id));
  rejected(await c.uc.createCase({ ...c.base, principalCode: c.users.admin.code, input: caseInput() }), 'project_archived');
  rejected(await c.uc.createExecution({ ...c.base, principalCode: c.users.admin.code, input: runInput(testCase) }), 'project_archived');
});

test('case, requirement, module, repository, asset and task references stay inside one project', async () => {
  const c = await setup();
  const [module] = await c.db.insert(schema.projectModules).values({ project_id: c.foreign.id, name: 'Foreign module', status: 'active', created_at: 't0', updated_at: 't0' }).returning();
  const requirement = await insertRequirement(c.db, { featureId: c.foreignFeature.id, title: 'Foreign requirement', ownerPrincipalId: c.users.owner.id });
  const [asset] = await c.db.insert(schema.testAssets).values({ project_id: c.foreign.id, title: 'Foreign asset', summary: '', current_revision: 1, owner_principal_id: c.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const [repository] = await c.db.insert(schema.projectRepositories).values({ project_id: c.foreign.id, name: 'Foreign repo', remote_url: 'https://example.com/foreign.git', created_by: c.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  const [task] = await c.db.insert(schema.tasks).values({ feature_id: c.foreignFeature.id, title: 'Foreign task', profile: 'builder', source: 'ad-hoc', status: 'draft', acceptance: '[]', base_snapshot: 0, created_at: 't0' }).returning();
  const [foreignCase] = await c.db.insert(schema.testCases).values({ project_id: c.foreign.id, title: 'Foreign case', summary: '', current_revision: 1, owner_principal_id: c.users.owner.id, created_at: 't0', updated_at: 't0' }).returning();
  for (const input of [{ module_code: module.code }, { requirement_codes: [requirement.code] }, { asset_codes: [asset.code] }]) rejected(await c.uc.createCase({ ...c.base, input: caseInput(input) }));
  rejected(await c.uc.createAsset({ ...c.base, input: { title: 'Foreign Git', storage_kind: 'git', git: { repository_code: repository.code } } }), 'testing_invalid');
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { task_code: task.code }) }), 'testing_invalid');
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { asset_refs: [{ asset_code: asset.code, revision: 1 }] }) }), 'testing_invalid');
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(foreignCase) }), 'testing_invalid');
});

test('execution snapshots retain historical content, report evidence and actual authenticated executor', async () => {
  const c = await setup();
  const asset = data(await c.uc.createAsset({ ...c.base, input: { title: 'Setup', content: 'Original preparation' } }));
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput({ asset_codes: [asset.code], preconditions: 'Account exists' }) }));
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase) }), 'testing_invalid');
  const recorded = data(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { source: 'agent', asset_refs: [{ asset_code: asset.code, revision: 1 }], executor_user_code: c.users.owner.code }) }));
  assert.equal(recorded.executor_user_code, c.users.author.code);
  assert.equal(recorded.counts.fail, 1);
  assert.equal(recorded.results[0].snapshot.steps[0].expected, 'Open dashboard');
  data(await c.uc.reviseCase({ code: testCase.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Change', steps: [{ action: 'Changed', expected: 'Changed' }] } }));
  data(await c.uc.reviseAsset({ code: asset.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Change', content: 'Changed setup' } }));
  const reread = data(await c.uc.getExecution(recorded.code, c.users.viewer.code));
  assert.equal(reread.results[0].snapshot.steps[0].expected, 'Open dashboard');
  assert.equal(reread.results[0].is_outdated, true);
  assert.equal(reread.assets[0].snapshot.content, 'Original preparation');
  assert.deepEqual(reread.results[0].report_urls, ['https://example.com/report/42']);
  rejected(await c.uc.getExecution(recorded.code, c.outsider.code), 'project_forbidden');
});

test('execution requires exact existing case revision and unique results', async () => {
  const c = await setup(); const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { results: [{ case_code: testCase.code, case_revision: 9, result: 'pass' }] }) }), 'testing_revision_not_found');
  const result = runInput(testCase).results[0];
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { results: [result, result] }) }), 'testing_invalid');
  assert.equal(data(await c.uc.listExecutions(c.base)).length, 0);
});

test('Git execution fixes commit and refuses an ambiguous shared commit across repositories', async () => {
  const c = await setup(); const repositories = [];
  for (const name of ['client', 'server']) {
    const [repo] = await c.db.insert(schema.projectRepositories).values({ project_id: c.project.id, name, remote_url: `https://example.com/${name}.git`, created_by: c.users.owner.id, created_at: 't0', updated_at: 't0' }).returning(); repositories.push(repo);
  }
  const assets = [];
  for (const repo of repositories) assets.push(data(await c.uc.createAsset({ ...c.base, input: { title: repo.name, storage_kind: 'git', git: { repository_code: repo.code, path: 'tests', ref: 'main' } } })));
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  const refs = assets.map(asset => ({ asset_code: asset.code, revision: 1 }));
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { asset_refs: refs.slice(0, 1) }) }), 'testing_invalid');
  const fixed = data(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { commit_sha: 'a'.repeat(40), asset_refs: refs.slice(0, 1) }) }));
  assert.equal(fixed.assets[0].snapshot.git.commit, 'a'.repeat(40));
  assert.equal(fixed.assets[0].snapshot.git.remote_url, 'https://example.com/client.git');
  await c.db.update(schema.projectRepositories).set({ remote_url: 'https://example.com/moved.git' }).where(eq(schema.projectRepositories.id, repositories[0].id));
  assert.equal(data(await c.uc.getExecution(fixed.code, c.users.author.code)).assets[0].snapshot.git.remote_url, 'https://example.com/client.git');
  rejected(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { commit_sha: 'a'.repeat(40), asset_refs: refs }) }), 'testing_invalid');
  assert.equal(data(await c.uc.getAsset(assets[0].code, c.users.author.code)).git.commit, '');
});

test('failed results create one audited defect using saved reproduction and evidence, with cross-project/link guards', async () => {
  const c = await setup();
  const requirement = await insertRequirement(c.db, { featureId: c.feature.id, title: 'Login requirement', ownerPrincipalId: c.users.owner.id });
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput({ preconditions: 'Login available', requirement_codes: [requirement.code] }) }));
  const execution = data(await c.uc.createExecution({ ...c.base, input: runInput(testCase) }));
  const cmd = { code: execution.code, resultCode: execution.results[0].result_code, principalCode: c.users.author.code };
  rejected(await c.uc.linkResultDefect({ ...cmd, input: { feature_code: c.foreignFeature.code } }), 'testing_invalid');
  const [foreignDefect] = await c.db.insert(schema.defects).values({ feature_id: c.foreignFeature.id, title: 'Foreign issue', severity: 'low', reported_by: c.users.owner.id, description: 'Private', status: 'reported' }).returning();
  rejected(await c.uc.linkResultDefect({ ...cmd, input: { defect_code: foreignDefect.code } }), 'testing_invalid');
  assert.equal(data(await c.uc.getExecution(execution.code, c.users.author.code)).results[0].defect_code, null);
  data(await c.uc.reviseCase({ code: testCase.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Changed', steps: [{ action: 'New action', expected: 'New expectation' }] } }));
  const linked = data(await c.uc.linkResultDefect({ ...cmd, input: { feature_code: c.feature.code, severity: 'high' } }));
  const [defect] = await c.db.select().from(schema.defects).where(eq(schema.defects.code, linked.results[0].defect_code));
  assert.match(defect.description, /Submit login/); assert.match(defect.description, /Open dashboard/); assert.match(defect.description, /HTTP 500/); assert.match(defect.description, /https:\/\/example.com\/report\/42/);
  assert.doesNotMatch(defect.description, /New action/);
  assert.equal(defect.related_requirement, requirement.id);
  assert.ok(defect.description.includes(requirement.code));
  rejected(await c.uc.linkResultDefect({ ...cmd, input: { feature_code: c.feature.code } }), 'testing_defect_conflict');
  data(await c.uc.linkResultDefect({ ...cmd, input: { defect_code: defect.code } }));
  assert.equal((await c.db.select().from(schema.defects)).length, 2);
  const events = await c.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entity_id, defect.id));
  assert.ok(events.some(event => event.action === 'defect.reported'));
  const passed = data(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { results: [{ case_code: testCase.code, case_revision: 1, result: 'pass' }] }) }));
  rejected(await c.uc.linkResultDefect({ code: passed.code, resultCode: passed.results[0].result_code, principalCode: c.users.author.code, input: { defect_code: defect.code } }), 'testing_invalid');
  rejected(await c.uc.linkResultDefect({ ...cmd, resultCode: passed.results[0].result_code, input: { defect_code: defect.code } }), 'test_result_not_found');
});

test('file metadata is derived and bytes only returned for authenticated detail reads', async () => {
  const c = await setup(); const bytes = Buffer.from('test fixture\n');
  const asset = data(await c.uc.createAsset({ ...c.base, input: { title: 'Fixture', storage_kind: 'file', purpose: 'data', file: { file_name: 'fixture.txt', mime_type: 'text/plain', content_base64: bytes.toString('base64') } } }));
  assert.equal(asset.file.size_bytes, bytes.length); assert.equal(asset.file.sha256.length, 64);
  const list = data(await c.uc.listAssets(c.base)); assert.equal('content_base64' in list[0].file, false);
  const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  const execution = data(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { asset_refs: [{ asset_code: asset.code, revision: 1 }] }) }));
  assert.equal('content_base64' in execution.assets[0].snapshot.file, false);
  rejected(await c.uc.createAsset({ ...c.base, input: { title: 'Wrong size', storage_kind: 'file', file: { ...asset.file, size_bytes: 999 } } }), 'testing_invalid');
});

test('simultaneous case revision attempts create exactly one next revision', async () => {
  const c = await setup(); const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  const results = await Promise.all(['First editor', 'Second editor'].map(title => c.uc.reviseCase({ code: testCase.code, principalCode: c.users.author.code,
    input: { base_revision: 1, change_summary: title, title } })));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok && result.error.code === 'testing_revision_conflict').length, 1);
  assert.equal(data(await c.uc.getCase(testCase.code, c.users.author.code)).revisions.length, 2);
});

test('recording test evidence never verifies or closes the associated task', async () => {
  const c = await setup(); const testCase = data(await c.uc.createCase({ ...c.base, input: caseInput() }));
  const [task] = await c.db.insert(schema.tasks).values({ feature_id: c.feature.id, title: 'Linked task', profile: 'builder', source: 'ad-hoc', status: 'running', acceptance: '[]', base_snapshot: 0, created_at: 't0' }).returning();
  data(await c.uc.createExecution({ ...c.base, input: runInput(testCase, { task_code: task.code, results: [{ case_code: testCase.code, case_revision: 1, result: 'pass' }] }) }));
  const [current] = await c.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  assert.equal(current.status, 'running'); assert.equal(current.base_snapshot, 0);
});
