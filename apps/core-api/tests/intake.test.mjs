import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { intakeManifestText } from '@team-synergy/contracts';
import { hashToken } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertTeamMember, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
const timestamp = '2026-10-18T00:00:00Z';
async function setup() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  fixtures.push({ db, app });
  const users = {};
  for (const name of ['owner', 'admin', 'member', 'external', 'viewer', 'system']) {
    const user = await insertUser(db, { account: `intake.${name}`, display_name: name, status: 'active', is_system_admin: name === 'system', created_at: timestamp });
    const token = `test-intake-${name}`;
    await db.insert(schema.devices).values({ principal_id: user.id, device_name: name, credential_hash: hashToken(token), created_at: timestamp });
    users[name] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Intake team', created_by: users.owner.id, owner_principal_id: users.owner.id, created_at: timestamp });
  const project = await insertProject(db, { team_id: team.id, name: 'Intake project', owner_principal_id: users.owner.id, created_by: users.owner.id, member_policy: 'private', created_at: timestamp });
  for (const name of ['owner', 'admin', 'member', 'viewer']) await insertTeamMember(db, { team_id: team.id, principal_id: users[name].id, role: name === 'owner' ? 'admin' : 'member', display_name: name, created_at: timestamp });
  for (const name of ['owner', 'admin', 'member', 'viewer', 'external']) await insertProjectMember(db, { project_id: project.id, principal_id: users[name].id, role: name === 'owner' ? 'admin' : name === 'external' ? 'member' : name, display_name: name, created_at: timestamp });
  const [repository] = await db.insert(schema.projectRepositories).values({ project_id: project.id, name: 'Application', remote_url: 'https://example.invalid/team/repository.git', created_by: users.owner.id, created_at: timestamp, updated_at: timestamp }).returning();
  const base = `/projects/${project.code}/intake`;
  const request = (method, suffix = '', payload, actor = 'owner') => app.inject({ method, url: base + suffix, headers: users[actor].headers, ...(payload === undefined ? {} : { payload }) });
  const file = { path: 'src/access.ts', sha256: 'a'.repeat(64) };
  const item = { key: 'module.access', kind: 'module', title: 'Account access', summary: 'Observed access behavior', content_markdown: '', evidence: [{ ...file, line_start: 1, line_end: 10 }], assessment: 'observed_in_code', tests: [], gaps: [] };
  const bundle = { schema_version: 1, project_code: project.code, repository_code: repository.code, namespace: 'acceptance', source: { commit: 'b'.repeat(40), dirty: true, scope: ['src'], files: [file], manifest_sha256: createHash('sha256').update(intakeManifestText([file])).digest('hex'), complete: false, exclusions: ['No production observation'], analyzed_at: timestamp, skill_version: '1.0.0' }, items: [item] };
  return { db, app, project, repository, users, base, request, bundle, item };
}
afterEach(async () => { for (const { db, app } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
function data(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().ok, true, response.body); return response.json().data; }

test('material-only HTTP intake publishes readable structured acceptance without a repository or duplicate replay', async () => {
  const f = await setup();
  await f.db.delete(schema.projectRepositories).where(eq(schema.projectRepositories.id, f.repository.id));
  const file = { path: 'materials/team/decisions.md', sha256: 'd'.repeat(64) };
  const module = { ...f.item, assessment: 'documented', evidence: [{ ...file, line_start: 1, line_end: 5 }] };
  const acceptance = [{ id: 'AC-ACCESS-001', text: 'Given a viewer, when changing a document, then reject the change and keep the original revision.' }];
  const bundle = { ...f.bundle, repository_code: null, namespace: 'material-http', source: { ...f.bundle.source,
    mode: 'materials', commit: null, dirty: false, scope: ['materials/team'], files: [file],
    manifest_sha256: createHash('sha256').update(intakeManifestText([file])).digest('hex'),
    inputs: [{ key: 'team', kind: 'team_note', label: 'Access decisions', prefix: 'materials/team' }],
  }, items: [module, { ...module, key: 'requirement.access', kind: 'requirement', module_key: module.key,
    title: 'Restrict document mutation', content_markdown: '# REQ-ACCESS-001\nGiven a viewer, when editing a document, then reject the change.', acceptance_criteria: acceptance }] };
  for (const actor of ['viewer', 'system']) assert.equal((await f.request('POST', '', { bundle, idempotency_key: 'materials-forbidden' }, actor)).statusCode, 403);
  const staged = data(await f.request('POST', '', { bundle, idempotency_key: 'materials-submit' }, 'member'));
  assert.equal(staged.repository_code, null); assert.deepEqual(staged.source.inputs, bundle.source.inputs);
  assert.equal(data(await f.request('GET')).batches[0].repository_code, null);
  const decisions = bundle.items.map(item => ({ key: item.key, action: 'create' }));
  assert.equal((await f.request('POST', `/${staged.code}/review`, { base_revision: staged.revision, decisions }, 'member')).statusCode, 403);
  const frozen = data(await f.request('POST', `/${staged.code}/review`, { base_revision: staged.revision, decisions }));
  const published = data(await f.request('POST', `/${staged.code}/apply`, { plan_hash: frozen.plan_hash, idempotency_key: 'materials-apply' }));
  assert.equal(published.status, 'applied'); assert.equal(published.publication.created, 2);
  const requirementCode = published.items.find(row => row.item.kind === 'requirement').target_code;
  const requirement = data(await f.app.inject({ method: 'GET', url: `/requirements/${requirementCode}`, headers: f.users.owner.headers }));
  assert.deepEqual(requirement.acceptance_criteria, acceptance); assert.deepEqual(requirement.revisions[0].acceptance_criteria, acceptance);
  assert.equal(requirement.state, 'draft');
  assert.equal(data(await f.request('POST', '', { bundle, idempotency_key: 'materials-submit' }, 'member')).code, staged.code);
  assert.equal(data(await f.request('POST', `/${staged.code}/apply`, { plan_hash: frozen.plan_hash, idempotency_key: 'materials-apply' })).code, staged.code);
  assert.equal((await f.db.select().from(schema.requirements)).length, 1);
  const context = data(await f.request('GET', '/context'));
  assert.deepEqual(context.repositories, []); assert.equal(context.bindings.length, 2); assert(context.bindings.every(binding => binding.repository_code === null));
  const invalid = { ...bundle, source: { ...bundle.source, mode: 'repository' } };
  assert.equal((await f.request('POST', '', { bundle: invalid, idempotency_key: 'invalid-source-mode' })).statusCode, 422);
});

test('enterprise draft HTTP preserves quality evidence while direct freeze/apply and profile downgrades are gated', async () => {
  const f = await setup();
  const bundle = { ...f.bundle, profile: 'enterprise' };
  const batch = data(await f.request('POST', '', { bundle, idempotency_key: 'enterprise-gaps' }, 'member'));
  assert.equal(batch.profile, 'enterprise'); assert.equal(batch.quality_gate.status, 'blocked');
  assert(batch.quality_report.summary.blockers > 0); assert.equal(batch.quality_report.batch_revision, batch.revision);
  const decisions = [{ key: f.item.key, action: 'create' }];
  const rejected = await f.request('POST', `/${batch.code}/review`, { base_revision: batch.revision, decisions });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert(rejected.json().error.details.quality_report.summary.blockers > 0);
  for (const profile of ['pilot']) {
    const downgrade = await f.request('POST', `/${batch.code}/review`, { base_revision: batch.revision, decisions, profile });
    assert.equal(downgrade.statusCode, 409, downgrade.body);
    assert.equal((await f.request('PUT', `/${batch.code}`, { base_revision: batch.revision, bundle: { ...bundle, profile } })).statusCode, 409);
  }
  assert.equal((await f.request('POST', `/${batch.code}/apply`, { plan_hash: 'a'.repeat(64), idempotency_key: 'bypass' })).statusCode, 409);
  const current = data(await f.request('GET', `/${batch.code}`));
  assert.equal(current.revision, batch.revision); assert.equal(current.plan_hash, null); assert.equal(current.items[0].decision, null);
  assert.equal(current.approval.status, 'not_requested'); assert.equal(current.dossier.content_verified, false);
  assert.equal((await f.db.select().from(schema.intakeAttempts)).length, 0); assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
});

test('HTTP legacy rows require explicit profile for new review and reject stale persisted report at apply', async () => {
  const f = await setup();
  const batch = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'legacy-profile' }));
  await f.db.update(schema.intakeBatches).set({ profile: null, quality_rule_version: null, quality_report_json: null, frozen_quality_json: null }).where(eq(schema.intakeBatches.code, batch.code));
  const current = data(await f.request('GET', `/${batch.code}`));
  assert.equal(current.profile, null); assert.equal(current.quality_gate.status, 'unknown'); assert.equal(current.quality_report, null);
  const decisions = [{ key: f.item.key, action: 'create' }];
  assert.equal((await f.request('POST', `/${batch.code}/review`, { base_revision: current.revision, decisions })).statusCode, 409);
  const frozen = data(await f.request('POST', `/${batch.code}/review`, { base_revision: current.revision, decisions, profile: 'pilot' }));
  assert.equal(frozen.profile, 'pilot'); assert.equal(frozen.quality_gate.status, 'eligible');
  await f.db.update(schema.intakeBatches).set({ quality_rule_version: 'obsolete' }).where(eq(schema.intakeBatches.code, batch.code));
  assert.equal(data(await f.request('GET', `/${batch.code}`)).quality_gate.status, 'stale');
  assert.equal((await f.request('POST', `/${batch.code}/apply`, { plan_hash: frozen.plan_hash, idempotency_key: 'stale-quality' })).statusCode, 409);
  assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
});

test('intake requires bearer project write access and rejects viewer and unrelated system admin', async () => {
  const f = await setup();
  for (const suffix of ['', '/context']) {
    assert.equal((await f.app.inject({ method: 'GET', url: f.base + suffix })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: f.base + suffix, headers: { 'x-principal-code': f.users.owner.code } })).statusCode, 401);
    for (const name of ['viewer', 'system']) assert.equal((await f.request('GET', suffix, undefined, name)).statusCode, 403);
    for (const name of ['member', 'external', 'admin']) data(await f.request('GET', suffix, undefined, name));
  }
  const submitted = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'submit-access' }, 'external'));
  assert.equal(submitted.can_review, false);
  assert.equal(submitted.created_by, f.users.external.code);
  for (const name of ['member', 'viewer', 'system']) assert.equal((await f.request('POST', `/${submitted.code}/review`, { base_revision: submitted.revision, decisions: [{ key: f.item.key, action: 'create' }] }, name)).statusCode, 403);
  assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
});

test('submission is staging only; malformed packages cannot write business entities or claim completion', async () => {
  const f = await setup();
  const bad = [
    { ...f.bundle, schema_version: 2 },
    { ...f.bundle, items: [{ ...f.item, status: 'closed' }] },
    { ...f.bundle, source: { ...f.bundle.source, files: [{ path: '../secret', sha256: 'a'.repeat(64) }] } },
    { ...f.bundle, source: { ...f.bundle.source, manifest_sha256: 'c'.repeat(64) } },
  ];
  for (const bundle of bad) {
    const response = await f.request('POST', '', { bundle, idempotency_key: 'bad-input' });
    assert.equal(response.statusCode, 422, response.body);
  }
  const staged = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'stage-only' }, 'member'));
  assert.equal(staged.status, 'draft');
  assert.equal(staged.plan_hash, null);
  assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
  assert.equal((await f.db.select().from(schema.requirements)).length, 0);
  assert.equal((await f.db.select().from(schema.tasks)).length, 0);
  const replay = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'stage-only' }, 'member'));
  assert.equal(replay.code, staged.code);
  const different = { ...f.bundle, items: [{ ...f.item, title: 'Changed title' }] };
  assert.equal((await f.request('POST', '', { bundle: different, idempotency_key: 'stage-only' }, 'member')).statusCode, 409);
});

test('reviewed publication creates all supported entity types once and preserves unrelated data', async () => {
  const f = await setup();
  const [old] = await f.db.insert(schema.projectModules).values({ project_id: f.project.id, name: 'Existing content', description: 'keep', created_at: timestamp, updated_at: timestamp }).returning();
  f.bundle.items.push(
    { ...f.item, key: 'feature.login', kind: 'feature', module_key: f.item.key, title: 'Login' },
    { ...f.item, key: 'doc.login', kind: 'requirement_document', module_key: f.item.key, title: 'Login specification', content_markdown: '# Login\nVerify credentials.' },
    { ...f.item, key: 'req.login', kind: 'requirement', module_key: f.item.key, feature_key: 'feature.login', document_key: 'doc.login', title: 'Reject invalid credentials', content_markdown: 'Given an invalid password, reject the login.' },
    { ...f.item, key: 'architecture.login', kind: 'architecture', title: 'Login architecture', content_markdown: 'Request flow', diagram_source: 'flowchart LR\n  Browser --> API' },
  );
  const staged = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'five-types' }, 'member'));
  const decisions = f.bundle.items.map(item => ({ key: item.key, action: 'create' }));
  const reviewed = data(await f.request('POST', `/${staged.code}/review`, { base_revision: staged.revision, decisions }, 'admin'));
  assert.ok(reviewed.plan_hash);
  const published = data(await f.request('POST', `/${staged.code}/apply`, { plan_hash: reviewed.plan_hash, idempotency_key: 'apply-five' }, 'admin'));
  assert.equal(published.status, 'applied');
  assert.equal(published.applied_count, 5);
  assert.equal(published.items.every(item => item.target_code), true);
  const replay = data(await f.request('POST', `/${staged.code}/apply`, { plan_hash: reviewed.plan_hash, idempotency_key: 'apply-five' }, 'admin'));
  assert.deepEqual(replay.items.map(item => item.target_code), published.items.map(item => item.target_code));
  assert.equal((await f.db.select().from(schema.projectModules)).length, 2);
  const [preserved] = await f.db.select().from(schema.projectModules).where(eq(schema.projectModules.id, old.id));
  assert.deepEqual(preserved, old);
  assert.equal((await f.db.select().from(schema.features)).length, 1);
  assert.equal((await f.db.select().from(schema.requirementDocuments)).length, 1);
  assert.equal((await f.db.select().from(schema.architectureDocuments)).length, 1);
  assert.equal((await f.db.select().from(schema.requirements))[0].state, 'draft');
  assert.equal((await f.db.select().from(schema.tasks)).length, 0);
});

test('stale review, unreviewed apply, revoked access and archived writes are blocked', async () => {
  const f = await setup();
  const staged = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'freeze' }));
  assert.equal((await f.request('POST', `/${staged.code}/apply`, { plan_hash: 'a'.repeat(64), idempotency_key: 'unreviewed' })).statusCode, 409);
  const input = { base_revision: staged.revision, decisions: [{ key: f.item.key, action: 'create' }] };
  const reviewed = data(await f.request('POST', `/${staged.code}/review`, input));
  assert.equal((await f.request('POST', `/${staged.code}/review`, input)).statusCode, 409);
  await f.db.update(schema.members).set({ role: 'viewer' }).where(eq(schema.members.principal_id, f.users.admin.id));
  assert.equal((await f.request('POST', `/${staged.code}/apply`, { plan_hash: reviewed.plan_hash, idempotency_key: 'revoked' }, 'admin')).statusCode, 403);
  await f.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, f.project.id));
  assert.equal((await f.request('POST', `/${staged.code}/apply`, { plan_hash: reviewed.plan_hash, idempotency_key: 'archived' })).statusCode, 403);
  data(await f.request('GET', `/${staged.code}`));
  assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
});

test('cross-project batch and repository references never reveal or mutate candidates', async () => {
  const f = await setup();
  const staged = data(await f.request('POST', '', { bundle: f.bundle, idempotency_key: 'project-only' }));
  const other = await insertProject(f.db, { team_id: f.project.team_id, name: 'Other', owner_principal_id: f.users.owner.id, created_by: f.users.owner.id, member_policy: 'private', created_at: timestamp });
  const response = await f.app.inject({ method: 'GET', url: `/projects/${other.code}/intake/${staged.code}`, headers: f.users.owner.headers });
  assert.equal(response.statusCode, 404, response.body);
  const wrong = { ...f.bundle, project_code: other.code };
  const submitted = await f.app.inject({ method: 'POST', url: `/projects/${other.code}/intake`, headers: f.users.owner.headers, payload: { bundle: wrong, idempotency_key: 'wrong-repo' } });
  assert.ok([403, 404, 422].includes(submitted.statusCode), submitted.body);
  assert.equal((await f.db.select().from(schema.projectModules)).length, 0);
});
