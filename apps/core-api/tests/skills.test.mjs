import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
import { createPublicCode, createTaskService } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { closeTestDb, insertProject, insertProjectMember, insertTeam, insertUser, openTestDb } from './test-db.mjs';

const fixtures = [];
async function fixture() {
  const db = await openTestDb(); const app = await buildServer({ db, logger: false }); fixtures.push({ app, db });
  const users = {}; const created_at = '2026-10-18T00:00:00Z';
  for (const name of ['owner', 'member', 'viewer', 'outside']) {
    const user = await insertUser(db, { account: `skills.http.${name}`, display_name: name, status: 'active', created_at });
    const token = `skills-http-${name}`; await db.insert(schema.devices).values({ principal_id: user.id, device_name: name, credential_hash: createHash('sha256').update(token).digest('hex'), created_at });
    users[name] = { ...user, headers: { authorization: `Bearer ${token}` } };
  }
  const team = await insertTeam(db, { name: 'Skills team', owner_principal_id: users.owner.id, created_at });
  const project = await insertProject(db, { team_id: team.id, name: 'Skills project', owner_principal_id: users.owner.id, member_policy: 'private', created_at });
  for (const name of ['member', 'viewer']) await insertProjectMember(db, { project_id: project.id, principal_id: users[name].id, role: name, display_name: name, created_at });
  return { db, app, users, team, project };
}
afterEach(async () => { for (const { app, db } of fixtures.splice(0)) { await app.close(); await closeTestDb(db); } });
const packageFiles = [{ path: 'SKILL.md', content_base64: Buffer.from('---\nname: sample\ndescription: Sample skill\n---\nDo not execute on import.').toString('base64') }];
function request(c, actor, method, url, payload) { return c.app.inject({ method, url, headers: actor?.headers ?? {}, ...(payload === undefined ? {} : { payload }) }); }
function data(response) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().ok, true, response.body); return response.json().data; }
function status(response, expected, code) { assert.equal(response.statusCode, expected, response.body); if (code) assert.equal(response.json().error.code, code); }

function readSkill(c, actor, projectCode, params = {}) {
  return request(c, actor, 'GET', `/projects/${projectCode}/skills/reader?${new URLSearchParams(params)}`);
}

async function claimRun(c, project, actor) {
  const [feature] = await c.db.insert(schema.features).values({ project_id: project.id, title: 'Skill reader' }).returning();
  const [task] = await c.db.insert(schema.tasks).values({ feature_id: feature.id, title: 'Read the adopted skill', profile: 'builder',
    status: 'draft', source: 'ad-hoc', acceptance: JSON.stringify([{ id: 'AC-1', text: 'Read the pinned skill revision' }]),
    base_snapshot: 0, created_at: '2026-11-12T00:00:00Z' }).returning();
  const tasks = createTaskService(c.db);
  const command = { taskCode: task.code, principalCode: actor.code };
  const assigned = await tasks.assignTask({ ...command, assigneePrincipalCode: actor.code, baseSnapshot: 0 });
  assert.equal(assigned.ok, true, JSON.stringify(assigned));
  const claimed = await tasks.claimTask({ ...command, profile: 'builder', baseSnapshot: 1, runCode: createPublicCode(),
    workspaceCode: createPublicCode(), workspacePath: '/workspace/skill-reader-fixture', gitBase: 'abc123' });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  return claimed.data.run_code;
}

test('skill reader pages the index without file bodies, and reads one fingerprinted Unicode file at a time', async () => {
  const c = await fixture();
  const { owner, viewer, outside } = c.users;
  const project = c.project.code;
  const file = (path, bytes) => ({ path, content_base64: Buffer.from(bytes).toString('base64') });
  const entry = '---\nname: sample\ndescription: Sample skill\n---\nRead the reference when needed.';
  const reference = '中🙂文\nEOF';
  const script = 'UNLISTED_SCRIPT_BODY_42';
  const files = [file('SKILL.md', entry), file('references/example.md', reference), file('scripts/check.sh', script), file('assets/image.bin', [0xff, 0xfe])];
  const codes = [];
  for (const [generation, alias] of ['first', 'second'].entries()) {
    const skill = data(await request(c, owner, 'POST', '/skills', { scope_type: 'project', scope_code: project, files }));
    data(await request(c, owner, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
    data(await request(c, owner, 'PUT', `/projects/${project}/skills/${skill.code}`, { alias, revision: 1, enabled: true, base_generation: generation }));
    codes.push(skill.code);
  }
  status(await readSkill(c, null, project), 401);
  status(await readSkill(c, outside, project), 403, 'project_forbidden');
  const first = data(await readSkill(c, viewer, project, { limit: 1 }));
  const second = data(await readSkill(c, viewer, project, { limit: 1, offset: first.nextOffset }));
  assert.deepEqual([first.total, first.nextOffset, second.nextOffset], [2, 1, null]);
  assert.deepEqual([...first.items, ...second.items].map(row => row.skill_code), codes);
  assert.equal(first.items[0].revision, 1);
  assert.equal(first.items[0].description, 'Sample skill');
  assert.match(first.items[0].package_sha256, /^[0-9a-f]{64}$/);
  for (const page of [first, second]) {
    assert.equal('files' in page.items[0], false);
    const serialized = JSON.stringify(page);
    for (const body of [script, 'scripts/check.sh', files[2].content_base64, 'content_base64']) assert.ok(!serialized.includes(body));
  }

  const selected = { skill: codes[0], revision: 1 };
  const guide = data(await readSkill(c, viewer, project, selected));
  assert.equal(guide.content, entry);
  assert.deepEqual(guide.paths.slice().sort(), files.map(item => item.path).sort());
  assert.equal(guide.scope_code, project);
  assert.equal(guide.package_sha256, first.items[0].package_sha256);
  assert.ok(!JSON.stringify(guide).includes(script));
  const readReference = params => readSkill(c, viewer, project, { ...selected, path: files[1].path, ...params });
  const start = data(await readReference({ limit: 2 }));
  const rest = data(await readReference({ offset: start.nextOffset }));
  assert.equal(start.content, '中🙂');
  assert.equal(start.offset, 0);
  assert.equal(start.nextOffset, 2);
  assert.equal(rest.nextOffset, null);
  assert.equal(start.content + rest.content, reference);
  assert.equal(start.sha256, createHash('sha256').update(reference).digest('hex'));
  assert.equal(start.size_bytes, Buffer.byteLength(reference));
  assert.equal('paths' in start, false);
  const binary = data(await readSkill(c, viewer, project, { ...selected, path: files[3].path }));
  assert.equal(binary.encoding, 'binary');
  assert.equal(binary.size_bytes, 2);
  assert.equal(binary.nextOffset, null);
  assert.equal(binary.download, `tsp skill sync --project ${project}`);
  assert.ok(!('content' in binary) && !('content_base64' in binary));
  status(await readSkill(c, viewer, project, { ...selected, path: 'missing.md' }), 404, 'skill_not_found');
});

test('a project upgrade rejects the older skill revision while a same-project Run still reads its pinned revision', async () => {
  const c = await fixture();
  const { owner, viewer } = c.users;
  const project = c.project.code;
  const binaryFile = bytes => ({ path: 'assets/file.bin', content_base64: Buffer.from(bytes).toString('base64') });
  const skill = data(await request(c, owner, 'POST', '/skills', { scope_type: 'project', scope_code: project, files: [...packageFiles, binaryFile([0xff, 1])] }));
  const install = (revision, base_generation) => request(c, owner, 'PUT', `/projects/${project}/skills/${skill.code}`, { alias: 'sample', revision, enabled: true, base_generation });
  data(await request(c, owner, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  data(await install(1, 0));
  const run = await claimRun(c, c.project, owner);
  const v1 = { skill: skill.code, revision: 1 };
  const original = data(await readSkill(c, viewer, project, v1));
  const revisedEntry = original.content + '\nRevised instructions.';
  const files = [{ path: 'SKILL.md', content_base64: Buffer.from(revisedEntry).toString('base64') }, binaryFile([0xff, 2])];
  data(await request(c, owner, 'PATCH', `/skills/${skill.code}`, { base_revision: 1, files, change_summary: 'Update instructions' }));
  data(await request(c, owner, 'POST', `/skills/${skill.code}/publish`, { revision: 2 }));
  data(await install(2, 1));
  status(await readSkill(c, viewer, project, v1), 409, 'skill_revision_conflict');
  assert.equal(data(await readSkill(c, viewer, project, { skill: skill.code, revision: 2 })).content, revisedEntry);
  const pinned = data(await readSkill(c, viewer, project, { run }));
  assert.equal(pinned.items[0].revision, 1);
  assert.deepEqual(data(await readSkill(c, viewer, project, { ...v1, run })), original);
  const pinnedBinary = data(await readSkill(c, viewer, project, { ...v1, run, path: 'assets/file.bin' }));
  const currentBinary = data(await readSkill(c, viewer, project, { skill: skill.code, revision: 2, path: 'assets/file.bin' }));
  assert.notEqual(currentBinary.sha256, pinnedBinary.sha256);
  assert.equal(currentBinary.download, `tsp skill sync --project ${project}`);
  assert.equal(pinnedBinary.download, `tsp skill sync --run ${run}`);
  status(await readSkill(c, viewer, project, { skill: skill.code, revision: 2, run }), 409, 'skill_revision_conflict');
  const other = await insertProject(c.db, { team_id: c.team.id, name: 'Other private project', owner_principal_id: owner.id,
    member_policy: 'private', created_at: '2026-11-12T00:00:00Z' });
  status(await readSkill(c, owner, other.code, { run }), 403, 'skill_forbidden');
  status(await readSkill(c, owner, other.code, { ...v1, run }), 403, 'skill_forbidden');
  status(await readSkill(c, owner, other.code, v1), 404, 'skill_not_found');
});

test('skill HTTP authentication, source ownership and forged actor fields never widen privileges', async () => {
  const c = await fixture(); const { owner, member, viewer, outside } = c.users;
  const payload = { scope_type: 'project', scope_code: c.project.code, files: packageFiles };
  status(await request(c, null, 'POST', '/skills', payload), 401);
  status(await request(c, viewer, 'POST', '/skills', { ...payload, principalCode: owner.code }), 403, 'skill_forbidden');
  const skill = data(await request(c, member, 'POST', '/skills', { ...payload, principal_code: owner.code, principalCode: owner.code }));
  assert.equal(skill.owner_user_code, member.code);
  status(await request(c, member, 'POST', `/skills/${skill.code}/publish`, { revision: 1, principalCode: owner.code }), 403, 'skill_forbidden');
  status(await request(c, outside, 'GET', `/skills/${skill.code}?principalCode=${owner.code}`), 403, 'skill_forbidden');
  status(await request(c, outside, 'GET', `/skills?project_code=${c.project.code}&principalCode=${owner.code}`), 403, 'project_forbidden');
  data(await request(c, owner, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  assert.equal(data(await request(c, viewer, 'GET', `/skills/${skill.code}`)).revisions.length, 1);
});

test('skill HTTP exposes immutable versions, conflict statuses and exact project manifest', async () => {
  const c = await fixture(); const actor = c.users.owner;
  const skill = data(await request(c, actor, 'POST', '/skills', { scope_type: 'project', scope_code: c.project.code, files: packageFiles }));
  data(await request(c, actor, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  const path = `/projects/${c.project.code}/skills`;
  data(await request(c, actor, 'PUT', `${path}/${skill.code}`, { alias: 'sample', revision: 1, enabled: true, base_generation: 0 }));
  status(await request(c, actor, 'PUT', `${path}/${skill.code}`, { alias: 'sample', revision: 1, enabled: true, base_generation: 0 }), 409, 'skill_generation_conflict');
  const manifest = data(await request(c, c.users.viewer, 'GET', `${path}/manifest`));
  assert.equal(manifest.generation, 1); assert.equal(manifest.skills[0].files[0].content_base64, packageFiles[0].content_base64);
  status(await request(c, c.users.outside, 'GET', `${path}/manifest?principalCode=${actor.code}`), 403, 'project_forbidden');
  data(await request(c, actor, 'PATCH', `/skills/${skill.code}`, { base_revision: 1, change_summary: 'Draft 2', files: packageFiles }));
  status(await request(c, actor, 'PATCH', `/skills/${skill.code}`, { base_revision: 1, change_summary: 'Stale', files: packageFiles }), 409, 'skill_revision_conflict');
  data(await request(c, actor, 'POST', `/skills/${skill.code}/archive`, { archived: true }));
  status(await request(c, c.users.viewer, 'GET', `${path}/manifest`), 403, 'skill_delivery_blocked');
});

test('skill HTTP rejects unsafe packages and missing optimistic guards; only source manager grants exact published revisions', async () => {
  const c = await fixture(); const actor = c.users.owner;
  status(await request(c, actor, 'POST', '/skills', { scope_type: 'project', scope_code: c.project.code, files: [...packageFiles, { path: '../escape', content_base64: 'eA==' }] }), 422, 'skill_invalid');
  const skill = data(await request(c, actor, 'POST', '/skills', { scope_type: 'project', scope_code: c.project.code, files: packageFiles }));
  status(await request(c, actor, 'PUT', `/projects/${c.project.code}/skills/${skill.code}`, { alias: 'sample', revision: 1, enabled: true }), 400);
  status(await request(c, actor, 'POST', `/skills/${skill.code}/shares`, { target_type: 'team', target_code: c.team.code, revisions: [1] }), 422, 'skill_invalid');
  data(await request(c, actor, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  const granted = data(await request(c, actor, 'POST', `/skills/${skill.code}/shares`, { target_type: 'team', target_code: c.team.code, revisions: [1] }));
  status(await request(c, c.users.member, 'DELETE', `/skills/${skill.code}/shares/${granted.shares[0].code}`), 403, 'skill_forbidden');
  const revoked = data(await request(c, actor, 'DELETE', `/skills/${skill.code}/shares/${granted.shares[0].code}`));
  assert.ok(revoked.shares[0].revoked_at);
});

test('skill HTTP cross-team grants deliver only selected revision and revoked share blocks new downloads', async () => {
  const c = await fixture(); const actor = c.users.owner; const targetActor = c.users.outside;
  const targetTeam = await insertTeam(c.db, { name: 'Foreign team', owner_principal_id: targetActor.id, created_at: 't0' });
  const target = await insertProject(c.db, { team_id: targetTeam.id, name: 'Foreign project', owner_principal_id: targetActor.id, member_policy: 'private', created_at: '2026-01-01T00:00:00.000Z' });
  const skill = data(await request(c, actor, 'POST', '/skills', { scope_type: 'project', scope_code: c.project.code, files: packageFiles }));
  data(await request(c, actor, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  const installPath = `/projects/${target.code}/skills/${skill.code}`;
  const install = { alias: 'sample', revision: 1, enabled: true, base_generation: 0 };
  status(await request(c, targetActor, 'PUT', installPath, install), 403, 'skill_delivery_blocked');
  const shared = data(await request(c, actor, 'POST', `/skills/${skill.code}/shares`, { target_type: 'project', target_code: target.code, revisions: [1] }));
  data(await request(c, targetActor, 'PUT', installPath, install));
  const run = await claimRun(c, target, targetActor);
  const read = { skill: skill.code, revision: 1 };
  assert.equal(data(await readSkill(c, targetActor, target.code, { ...read, run })).scope_code, c.project.code);
  data(await request(c, actor, 'PATCH', `/skills/${skill.code}`, { base_revision: 1, change_summary: 'Private draft', files: packageFiles }));
  const received = data(await request(c, targetActor, 'GET', `/skills/${skill.code}?project_code=${target.code}`));
  assert.equal(received.revisions.length, 1); assert.equal(received.current_revision, 1); assert.deepEqual(received.shares, []);
  data(await request(c, actor, 'DELETE', `/skills/${skill.code}/shares/${shared.shares[0].code}`));
  for (const params of [{}, { run }, read, { ...read, run }]) {
    status(await readSkill(c, targetActor, target.code, params), 403, 'skill_delivery_blocked');
  }
  status(await request(c, targetActor, 'GET', `/projects/${target.code}/skills/manifest`), 403, 'skill_delivery_blocked');
  status(await request(c, targetActor, 'GET', `/skills/${skill.code}?project_code=${target.code}`), 403, 'skill_forbidden');
});
