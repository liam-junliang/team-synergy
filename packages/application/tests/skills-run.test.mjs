import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createTaskService, createPublicCode, createHandoverUseCases } from '../dist/index.js';
import { createSkillsUseCases } from '../dist/skills-use-cases.js';
import { createExecutionUseCases } from '../dist/execution-use-cases.js';
import { copyRunSkills } from '../dist/skills-run.js';
import { addTeamMember, insertTeam, insertFeature, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const files = (revision = 1) => [{ path: 'SKILL.md', content_base64: Buffer.from(`---\nname: run-test\ndescription: Verify the fixed revision\n---\nRevision ${revision}\n`).toString('base64') }];

async function setup() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, { users: [
    { key: 'owner', account: 'owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
    { key: 'member', account: 'member', displayName: 'Member' },
  ] });
  const owner = seeded.users.owner;
  const source = await insertTeam(db, { name: 'Source library' });
  await addTeamMember(db, { teamId: source.id, principalId: owner.id, role: 'owner', displayName: owner.display_name });
  const feature = await insertFeature(db, { projectId: seeded.project.id, title: 'Run pinning' });
  const task = await insertTask(db, { featureId: feature.id, title: 'Execute pinned skill', profile: 'builder', acceptance: [{ id: 'AC-1', text: 'Retain revision' }] });
  const skills = createSkillsUseCases(db);
  const actor = { principalCode: owner.code };
  const skill = ok(await skills.createSkill({ ...actor, input: { scope_type: 'team', scope_code: source.code, files: files() } }));
  ok(await skills.publishSkill({ ...actor, code: skill.code, revision: 1 }));
  const shared = ok(await skills.shareSkill({ ...actor, code: skill.code, input: { target_type: 'project', target_code: seeded.project.code, revisions: [1] } }));
  ok(await skills.installSkill({ ...actor, projectCode: seeded.project.code, code: skill.code, input: { revision: 1, alias: 'verify-run', enabled: true, base_generation: 0 } }));
  return { db, ...seeded, actor, feature, task, skills, skill, share: shared.shares[0], tasks: createTaskService(db) };
}

async function claim(ctx, task = ctx.task) {
  ok(await ctx.tasks.assignTask({ ...ctx.actor, taskCode: task.code, assigneePrincipalCode: ctx.users.member.code, baseSnapshot: 0 }));
  return ctx.tasks.claimTask({ taskCode: task.code, principalCode: ctx.users.member.code, profile: 'builder', baseSnapshot: 1,
    runCode: createPublicCode(), workspaceCode: createPublicCode(), workspacePath: '/workspace/skills-run', gitBase: 'abc123' });
}
async function upgrade(ctx) {
  ok(await ctx.skills.reviseSkill({ ...ctx.actor, code: ctx.skill.code, input: { base_revision: 1, files: files(2), change_summary: 'Second revision' } }));
  ok(await ctx.skills.publishSkill({ ...ctx.actor, code: ctx.skill.code, revision: 2 }));
  ok(await ctx.skills.shareSkill({ ...ctx.actor, code: ctx.skill.code, input: { target_type: 'project', target_code: ctx.project.code, revisions: [2] } }));
  ok(await ctx.skills.installSkill({ ...ctx.actor, projectCode: ctx.project.code, code: ctx.skill.code, input: { revision: 2, alias: 'verify-run', enabled: true, base_generation: 1 } }));
}
const runManifest = (ctx, runCode) => ctx.skills.getRunManifest({ principalCode: ctx.users.member.code, runCode });
const revoke = ctx => ctx.skills.revokeShare({ ...ctx.actor, code: ctx.skill.code, shareCode: ctx.share.code });

test('claim pins exact skill bytes and metadata; project upgrades affect only subsequent Runs', async () => {
  const ctx = await setup();
  const first = ok(await claim(ctx));
  const before = ok(await runManifest(ctx, first.run_code));
  await upgrade(ctx);
  const after = ok(await runManifest(ctx, first.run_code));
  assert.deepEqual(after, before);
  assert.equal(after.skills[0].revision, 1);
  const task = await insertTask(ctx.db, { featureId: ctx.feature.id, title: 'Next run', profile: 'builder', acceptance: [{ id: 'AC-1', text: 'Latest installation' }] });
  const second = ok(await claim(ctx, task));
  assert.equal(ok(await runManifest(ctx, second.run_code)).skills[0].revision, 2);
  const snapshots = await ctx.db.select().from(schema.runSkillManifests);
  assert.equal(snapshots.length, 2);
  for (const snapshot of snapshots) assert.equal('files' in JSON.parse(snapshot.manifest_json).skills[0], false, 'Run snapshot stores references, not package bytes');
});

test('revoked sharing rolls claim back without a Run, workspace or task transition', async () => {
  const ctx = await setup();
  ok(await revoke(ctx));
  const denied = await claim(ctx);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'skill_delivery_blocked');
  assert.deepEqual(await ctx.db.select().from(schema.runs), []);
  assert.deepEqual(await ctx.db.select().from(schema.workspaces), []);
  assert.deepEqual(await ctx.db.select().from(schema.runSkillManifests), []);
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal(task.status, 'assigned');
  assert.equal(task.base_snapshot, 1);
});

test('revocation blocks pinned downloads, session launch and suspended Run resume', async () => {
  const ctx = await setup();
  const claimed = ok(await claim(ctx));
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimed.run_code));
  const [device] = await ctx.db.insert(schema.devices).values({ principal_id: ctx.users.member.id, device_name: 'Skill test', credential_hash: 'skills-device', created_at: new Date().toISOString() }).returning();
  const identity = { principalId: ctx.users.member.id, deviceId: device.id };
  const execution = createExecutionUseCases(ctx.db);
  const lease = await execution.lease(run.code, identity);
  ok(await revoke(ctx));
  const denied = await runManifest(ctx, run.code);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'skill_delivery_blocked');
  await assert.rejects(execution.start(run.code, identity, { start_key: 'launch', agent_command: 'agent', ...lease }), { code: 'skill_delivery_blocked' });
  assert.deepEqual(await ctx.db.select().from(schema.agentSessions), []);
  await ctx.db.update(schema.runs).set({ status: 'suspended' }).where(eq(schema.runs.id, run.id));
  const resumed = await createHandoverUseCases(ctx.db).resume({ identity: { principalCode: ctx.users.member.code, deviceCode: device.code, authKind: 'bearer' }, request_key: 'resume-skill', run_code: run.code });
  assert.equal(resumed.ok, false);
  assert.equal(resumed.error.code, 'skill_delivery_blocked');
  assert.equal((await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, run.id)))[0].status, 'suspended');
});

test('handover snapshot copies source revision rather than current installation and rechecks the source grant', async () => {
  const ctx = await setup();
  const claimed = ok(await claim(ctx));
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimed.run_code));
  await upgrade(ctx);
  const { id: _id, code: _code, ...values } = source;
  const [target] = await ctx.db.insert(schema.runs).values({ ...values, code: createPublicCode(), status: 'preparing', continued_from_run_id: source.id }).returning();
  const copied = await ctx.db.transaction(tx => copyRunSkills(tx, { sourceRunId: source.id, targetRunId: target.id, projectId: ctx.project.id, principalId: ctx.users.member.id }));
  assert.equal(copied.skills[0].revision, 1);
  assert.deepEqual(ok(await runManifest(ctx, target.code)), ok(await runManifest(ctx, source.code)));
  ok(await revoke(ctx));
  const [another] = await ctx.db.insert(schema.runs).values({ ...values, code: createPublicCode(), status: 'preparing', continued_from_run_id: source.id }).returning();
  await assert.rejects(ctx.db.transaction(tx => copyRunSkills(tx, { sourceRunId: source.id, targetRunId: another.id, projectId: ctx.project.id, principalId: ctx.users.member.id })), { code: 'skill_delivery_blocked' });
  assert.deepEqual(await ctx.db.select().from(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, another.id)), []);
});

test('legacy Runs without a skill snapshot remain empty even when the project has installations', async () => {
  const ctx = await setup();
  const claimed = ok(await claim(ctx));
  const [run] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimed.run_code));
  await ctx.db.delete(schema.runSkillManifests).where(eq(schema.runSkillManifests.run_id, run.id));
  assert.deepEqual(ok(await runManifest(ctx, run.code)).skills, []);
  assert.equal(ok(await ctx.skills.getProjectManifest({ ...ctx.actor, projectCode: ctx.project.code })).skills.length, 1);
});
