import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schema } from '@team-synergy/persistence';
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
  const target = await insertProject(c.db, { team_id: targetTeam.id, name: 'Foreign project', owner_principal_id: targetActor.id, member_policy: 'private', created_at: 't0' });
  const skill = data(await request(c, actor, 'POST', '/skills', { scope_type: 'project', scope_code: c.project.code, files: packageFiles }));
  data(await request(c, actor, 'POST', `/skills/${skill.code}/publish`, { revision: 1 }));
  const installPath = `/projects/${target.code}/skills/${skill.code}`;
  const install = { alias: 'sample', revision: 1, enabled: true, base_generation: 0 };
  status(await request(c, targetActor, 'PUT', installPath, install), 403, 'skill_delivery_blocked');
  const shared = data(await request(c, actor, 'POST', `/skills/${skill.code}/shares`, { target_type: 'project', target_code: target.code, revisions: [1] }));
  data(await request(c, targetActor, 'PUT', installPath, install));
  data(await request(c, actor, 'PATCH', `/skills/${skill.code}`, { base_revision: 1, change_summary: 'Private draft', files: packageFiles }));
  const received = data(await request(c, targetActor, 'GET', `/skills/${skill.code}?project_code=${target.code}`));
  assert.equal(received.revisions.length, 1); assert.equal(received.current_revision, 1); assert.deepEqual(received.shares, []);
  data(await request(c, actor, 'DELETE', `/skills/${skill.code}/shares/${shared.shares[0].code}`));
  status(await request(c, targetActor, 'GET', `/projects/${target.code}/skills/manifest`), 403, 'skill_delivery_blocked');
  status(await request(c, targetActor, 'GET', `/skills/${skill.code}?project_code=${target.code}`), 403, 'skill_forbidden');
});
