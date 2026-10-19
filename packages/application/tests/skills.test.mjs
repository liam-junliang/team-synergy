import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createSkillsUseCases, normalizeSkillPackage, captureRunSkills, resolveRunSkillManifest, copyRunSkills } from '../dist/index.js';
import { addProjectMember, addTeamMember, insertFeature, insertProject, insertTeam, insertUser, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
function data(value) { assert.equal(value.ok, true, JSON.stringify(value)); return value.data; }
function rejected(value, code) { assert.equal(value.ok, false, JSON.stringify(value)); if (code) assert.equal(value.error.code, code, JSON.stringify(value)); }
function file(path, content) { return { path, content_base64: Buffer.from(content).toString('base64') }; }
function files(note = 'original', name = 'api-review') { return [file('SKILL.md', `---\nname: ${name}\ndescription: Review API changes\n---\n# Review\n${note}`), file('scripts/check.sh', '#!/bin/sh\necho review')]; }
async function setup() {
  const db = fixture.db; const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'skills.owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'admin', account: 'skills.admin', displayName: 'Admin', teamRole: 'admin', projectRole: 'admin' },
    { key: 'author', account: 'skills.author', displayName: 'Author', projectRole: 'member' },
    { key: 'peer', account: 'skills.peer', displayName: 'Peer', projectRole: 'member' },
    { key: 'viewer', account: 'skills.viewer', displayName: 'Viewer', projectRole: 'viewer' },
  ] });
  await db.update(schema.teams).set({ owner_principal_id: seeded.users.owner.id }).where(eq(schema.teams.id, seeded.team.id));
  await db.update(schema.projects).set({ owner_principal_id: seeded.users.owner.id, member_policy: 'private' }).where(eq(schema.projects.id, seeded.project.id));
  const outsider = await insertUser(db, { account: 'skills.external', displayName: 'External' });
  const targetOwner = await insertUser(db, { account: 'skills.target', displayName: 'Target' });
  const targetTeam = await insertTeam(db, { name: 'Target team' });
  await addTeamMember(db, { teamId: targetTeam.id, principalId: targetOwner.id, role: 'owner', displayName: 'Target' });
  const targetProject = await insertProject(db, { teamId: targetTeam.id, name: 'Target project' });
  await addProjectMember(db, { projectId: targetProject.id, principalId: targetOwner.id, role: 'owner', displayName: 'Target' });
  await db.update(schema.projects).set({ member_policy: 'private' }).where(eq(schema.projects.id, targetProject.id));
  const uc = createSkillsUseCases(db);
  const base = { principalCode: seeded.users.author.code, input: { scope_type: 'team', scope_code: seeded.team.code, files: files() } };
  async function published() { const skill = data(await uc.createSkill(base)); return data(await uc.publishSkill({ code: skill.code, principalCode: seeded.users.owner.code, revision: 1 })); }
  async function grant(skill, extra = {}) { return data(await uc.shareSkill({ code: skill.code, principalCode: seeded.users.owner.code, input: { target_type: 'project', target_code: targetProject.code, revisions: [1], ...extra } })); }
  async function install(skill, extra = {}) { return uc.installSkill({ code: skill.code, projectCode: targetProject.code, principalCode: targetOwner.code, input: { revision: 1, alias: 'api-review', enabled: true, base_generation: 0, ...extra } }); }
  return { db, ...seeded, outsider, targetOwner, targetTeam, targetProject, uc, base, published, grant, install };
}

test('package validation fixes hashes and rejects traversal, case collisions, malformed metadata and oversize', () => {
  const pack = normalizeSkillPackage(files()); assert.equal(pack.files.length, 2); assert.equal(pack.name, 'api-review');
  assert.equal(pack.package_sha256, normalizeSkillPackage(files().reverse()).package_sha256);
  for (const path of ['../escape', 'a/../../b', '/root', 'C:/file', 'a\\b', 'CON.txt', 'a//b', '.git/config', 'a. /x', 'COM¹.txt']) assert.throws(() => normalizeSkillPackage([...files(), file(path, 'x')]));
  for (const extra of [[file('skill.md', 'x')], [file('a', 'x'), file('a/b', 'x')], [file('A/x', 'x'), file('a/y', 'x')], [{ ...file('sym', 'x'), symlink: '../x' }], [{ ...file('x', 'x'), sha256: '0'.repeat(64) }], [{ ...file('x', 'x'), size_bytes: 90 }], [{ path: 'x', content_base64: 'Zh==' }]]) assert.throws(() => normalizeSkillPackage([...files(), ...extra]));
  assert.throws(() => normalizeSkillPackage([file('SKILL.md', '# missing metadata')]));
  assert.throws(() => normalizeSkillPackage([file('SKILL.md', '---\nname: test\nname: duplicate\ndescription: x\n---')]));
  assert.throws(() => normalizeSkillPackage([...files(), file('big', Buffer.alloc(6 * 1024 * 1024))]));
  assert.throws(() => normalizeSkillPackage([...files(), ...Array.from({ length: 199 }, (_, i) => file(`f${i}`, ''))]));
});

test('authors own drafts; source managers publish; viewers and outsiders cannot author or enumerate drafts', async () => {
  const c = await setup(); const skill = data(await c.uc.createSkill(c.base));
  assert.equal(skill.revisions[0].published_at, null); assert.equal(skill.owner_user_code, c.users.author.code);
  rejected(await c.uc.getSkill({ code: skill.code, principalCode: c.users.peer.code }), 'skill_forbidden');
  rejected(await c.uc.getSkill({ code: skill.code, principalCode: c.outsider.code }), 'skill_forbidden');
  rejected(await c.uc.publishSkill({ code: skill.code, principalCode: c.users.author.code, revision: 1 }), 'skill_forbidden');
  rejected(await c.uc.reviseSkill({ code: skill.code, principalCode: c.users.peer.code, input: { base_revision: 1, change_summary: 'steal', files: files('stolen') } }), 'skill_forbidden');
  rejected(await c.uc.createSkill({ principalCode: c.users.viewer.code, input: { scope_type: 'project', scope_code: c.project.code, files: files() } }), 'skill_forbidden');
  data(await c.uc.publishSkill({ code: skill.code, principalCode: c.users.admin.code, revision: 1 }));
  assert.equal(data(await c.uc.getSkill({ code: skill.code, principalCode: c.users.peer.code })).revisions.length, 1);
});

test('published files are immutable, revisions conflict correctly and hidden drafts do not leak newest counters', async () => {
  const c = await setup(); const first = await c.published();
  const revised = data(await c.uc.reviseSkill({ code: first.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Second draft', files: files('second') } }));
  assert.equal(revised.current_revision, 2); assert.equal(revised.revisions[1].package_sha256, first.revisions[0].package_sha256);
  rejected(await c.uc.reviseSkill({ code: first.code, principalCode: c.users.owner.code, input: { base_revision: 1, change_summary: 'Stale', files: files('stale') } }), 'skill_revision_conflict');
  const peer = data(await c.uc.getSkill({ code: first.code, principalCode: c.users.peer.code }));
  assert.equal(peer.current_revision, 1); assert.equal(peer.revisions.length, 1); assert.deepEqual(peer.shares, []);
});

test('team administrators do not gain private project skill rights and project admins cannot share source skills', async () => {
  const c = await setup(); const privateProject = await insertProject(c.db, { teamId: c.team.id, name: 'Private' });
  await c.db.update(schema.projects).set({ owner_principal_id: c.users.author.id, member_policy: 'private' }).where(eq(schema.projects.id, privateProject.id));
  const skill = data(await c.uc.createSkill({ principalCode: c.users.author.code, input: { scope_type: 'project', scope_code: privateProject.code, files: files() } }));
  rejected(await c.uc.publishSkill({ code: skill.code, principalCode: c.users.admin.code, revision: 1 }), 'skill_forbidden');
  const teamSkill = await c.published(); await c.grant(teamSkill); data(await c.install(teamSkill));
  rejected(await c.uc.shareSkill({ code: teamSkill.code, principalCode: c.targetOwner.code, input: { target_type: 'team', target_code: c.targetTeam.code, revisions: [1] } }), 'skill_forbidden');
  rejected(await c.uc.reviseSkill({ code: teamSkill.code, principalCode: c.targetOwner.code, input: { base_revision: 1, change_summary: 'No source edit', files: files() } }), 'skill_forbidden');
});

test('cross-team project adoption requires exact grants and external readers only receive installed versions', async () => {
  const c = await setup(); const skill = await c.published();
  rejected(await c.install(skill), 'skill_delivery_blocked');
  await c.grant(skill, { allow_external: true });
  data(await c.uc.reviseSkill({ code: skill.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'Secret new version', files: files('secret') } }));
  data(await c.uc.publishSkill({ code: skill.code, principalCode: c.users.owner.code, revision: 2 }));
  rejected(await c.install(skill, { revision: 2 }), 'skill_delivery_blocked'); data(await c.install(skill));
  await addProjectMember(c.db, { projectId: c.targetProject.id, principalId: c.outsider.id, role: 'viewer', displayName: 'External' });
  const external = data(await c.uc.getSkill({ code: skill.code, projectCode: c.targetProject.code, principalCode: c.outsider.code }));
  assert.equal(external.revisions.length, 1); assert.equal(external.current_revision, 1); assert.deepEqual(external.shares, []); assert.equal(external.can_manage, false);
  rejected(await c.uc.listSkills({ teamCode: c.team.code, principalCode: c.outsider.code }), 'skill_forbidden');
  rejected(await c.uc.installSkill({ projectCode: c.targetProject.code, code: skill.code, principalCode: c.outsider.code, input: { alias: 'api-review', revision: 1, enabled: true, base_generation: 1 } }), 'project_forbidden');
});

test('team shares default to discovery only; project use and external membership require explicit policy', async () => {
  const c = await setup(); const skill = await c.published();
  const share = data(await c.uc.shareSkill({ code: skill.code, principalCode: c.users.owner.code, input: { target_type: 'team', target_code: c.targetTeam.code, revisions: [1] } }));
  assert.equal(share.shares[0].allow_projects, false); assert.equal(share.shares[0].allow_external, false);
  assert.equal(data(await c.uc.listSkills({ principalCode: c.targetOwner.code, teamCode: c.targetTeam.code, view: 'shared' })).length, 1);
  rejected(await c.install(skill), 'skill_delivery_blocked');
  await c.uc.shareSkill({ code: skill.code, principalCode: c.users.owner.code, input: { target_type: 'team', target_code: c.targetTeam.code, revisions: [1], allow_projects: true } });
  data(await c.install(skill));
  await addProjectMember(c.db, { projectId: c.targetProject.id, principalId: c.outsider.id, role: 'viewer', displayName: 'External' });
  rejected(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code }), 'skill_delivery_blocked');
  assert.equal(data(await c.uc.listProjectSkills({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code })).installations[0].blocked, true);
  await c.grant(skill, { allow_external: true });
  assert.equal(data(await c.uc.getProjectManifest({ principalCode: c.outsider.code, projectCode: c.targetProject.code })).skills.length, 1);
});

test('same-team implicit use stops when external member joins; owned project skills remain available', async () => {
  const c = await setup(); const skill = await c.published();
  data(await c.uc.installSkill({ principalCode: c.users.owner.code, projectCode: c.project.code, code: skill.code, input: { revision: 1, alias: 'api-review', enabled: true, base_generation: 0 } }));
  await addProjectMember(c.db, { projectId: c.project.id, principalId: c.outsider.id, role: 'viewer', displayName: 'External' });
  rejected(await c.uc.getProjectManifest({ principalCode: c.users.owner.code, projectCode: c.project.code }), 'skill_delivery_blocked');
  data(await c.uc.shareSkill({ code: skill.code, principalCode: c.users.owner.code, input: { target_type: 'project', target_code: c.project.code, revisions: [1], allow_external: true } }));
  assert.equal(data(await c.uc.getProjectManifest({ principalCode: c.outsider.code, projectCode: c.project.code })).skills.length, 1);
});

test('revocation blocks bytes and new execution but retains metadata and permits disabling', async () => {
  const c = await setup(); const skill = await c.published(); const granted = await c.grant(skill); data(await c.install(skill));
  const duplicate = await c.grant(skill); assert.equal(duplicate.shares.length, 1); assert.equal(duplicate.shares[0].code, granted.shares[0].code);
  data(await c.uc.revokeShare({ code: skill.code, shareCode: granted.shares[0].code, principalCode: c.users.owner.code }));
  rejected(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code }), 'skill_delivery_blocked');
  rejected(await c.uc.getSkill({ code: skill.code, projectCode: c.targetProject.code, principalCode: c.targetOwner.code }), 'skill_forbidden');
  const blocked = data(await c.uc.listProjectSkills({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code }));
  assert.equal(blocked.installations[0].blocked, true); assert.equal(blocked.installations[0].description, '');
  data(await c.install(skill, { enabled: false, base_generation: 1 }));
  assert.equal(data(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code })).skills.length, 0);
});

test('installation optimistic generation serializes concurrent updates and explicit aliases prevent collisions', async () => {
  const c = await setup(); const first = await c.published(); const second = await c.published(); await c.grant(first); await c.grant(second);
  const results = await Promise.all([c.install(first), c.install(second, { alias: 'review-two' })]);
  assert.equal(results.filter(value => value.ok).length, 1); assert.equal(results.find(value => !value.ok).error.code, 'skill_generation_conflict');
  const installed = data(await c.uc.listProjectSkills({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code }));
  const other = installed.installations[0].skill_code === first.code ? second : first;
  rejected(await c.install(other, { alias: installed.installations[0].alias, base_generation: 1 }), 'skill_alias_conflict');
  assert.equal(installed.generation, 1);
});

test('archive blocks delivery without deleting published history; role downgrade invalidates maintenance', async () => {
  const c = await setup(); const skill = await c.published(); await c.grant(skill); data(await c.install(skill));
  data(await c.uc.archiveSkill({ code: skill.code, principalCode: c.users.admin.code, archived: true }));
  rejected(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code }), 'skill_delivery_blocked');
  assert.equal(data(await c.uc.getSkill({ code: skill.code, principalCode: c.users.owner.code })).revisions.length, 1);
  await c.db.update(schema.teamMembers).set({ role: 'member' }).where(and(eq(schema.teamMembers.team_id, c.team.id), eq(schema.teamMembers.principal_id, c.users.admin.id)));
  rejected(await c.uc.archiveSkill({ code: skill.code, principalCode: c.users.admin.code, archived: false }), 'skill_forbidden');
  data(await c.uc.archiveSkill({ code: skill.code, principalCode: c.users.owner.code, archived: false }));
  assert.equal(data(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code })).skills[0].package_sha256, skill.revisions[0].package_sha256);
});

test('Run snapshots freeze versions, handover copies exact source, revocation rechecks current grants and legacy stays empty', async () => {
  const c = await setup(); const skill = await c.published(); const granted = await c.grant(skill); data(await c.install(skill));
  const feature = await insertFeature(c.db, { projectId: c.targetProject.id, title: 'Task' });
  const [task] = await c.db.insert(schema.tasks).values({ feature_id: feature.id, title: 'Task', profile: 'builder', source: 'ad-hoc', status: 'draft', acceptance: '[]', base_snapshot: 0, created_at: 't0' }).returning();
  async function run() { const [row] = await c.db.insert(schema.runs).values({ task_id: task.id, principal_id: c.targetOwner.id, profile: 'builder', status: 'suspended', workspace_id: 1n, base_snapshot: 0, started_at: 't0' }).returning(); return row; }
  const first = await run(); const next = await run(); const legacy = await run();
  await c.db.transaction(tx => captureRunSkills(tx, { projectId: c.targetProject.id, principalId: c.targetOwner.id, runId: first.id }));
  const [saved] = await c.db.select().from(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, first.id));
  assert.equal(saved.manifest_json.includes('content_base64'), false);
  data(await c.uc.reviseSkill({ code: skill.code, principalCode: c.users.author.code, input: { base_revision: 1, change_summary: 'New', files: files('new') } }));
  data(await c.uc.publishSkill({ code: skill.code, principalCode: c.users.owner.code, revision: 2 }));
  await c.grant(skill, { revisions: [2] }); data(await c.install(skill, { revision: 2, base_generation: 1 }));
  const historical = await c.db.transaction(tx => resolveRunSkillManifest(tx, { runId: first.id, principalId: c.targetOwner.id }));
  assert.equal(historical.skills[0].revision, 1);
  await c.db.transaction(tx => copyRunSkills(tx, { sourceRunId: first.id, targetRunId: next.id, projectId: c.targetProject.id, principalId: c.targetOwner.id }));
  assert.equal((await c.db.transaction(tx => resolveRunSkillManifest(tx, { runId: next.id, principalId: c.targetOwner.id }))).skills[0].revision, 1);
  assert.equal((await c.db.transaction(tx => resolveRunSkillManifest(tx, { runId: legacy.id, principalId: c.targetOwner.id }))).skills.length, 0);
  data(await c.uc.revokeShare({ code: skill.code, shareCode: granted.shares[0].code, principalCode: c.users.owner.code }));
  await assert.rejects(c.db.transaction(tx => resolveRunSkillManifest(tx, { runId: first.id, principalId: c.targetOwner.id })), error => error.code === 'skill_delivery_blocked');
  assert.equal(data(await c.uc.getProjectManifest({ principalCode: c.targetOwner.code, projectCode: c.targetProject.code })).skills[0].revision, 2);
});
