import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createHttpTestContext, insertTeam, insertProject, insertUser, insertMember, testCode } from './http-test-helpers.mjs';

async function setup() {
  const ctx = await createHttpTestContext(import.meta.url);
  const users = {};
  const tokens = {};
  let number = 510;
  for (const key of ['owner', 'admin', 'member', 'next', 'external']) {
    users[key] = await insertUser(ctx.db, { code: testCode(number++), account: `permissions-${key}`, displayName: key });
    tokens[key] = `permissions-cli-test-${key}`;
    await ctx.db.insert(schema.devices).values({ principal_id: users[key].id, credential_hash: createHash('sha256').update(tokens[key]).digest('hex'), created_at: 't0' });
  }
  const team = await insertTeam(ctx.db, { code: testCode(number++), name: 'Permissions team' });
  await ctx.db.update(schema.teams).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.teams.id, team.id));
  for (const key of ['owner', 'admin', 'member', 'next']) await ctx.db.insert(schema.teamMembers).values({ team_id: team.id, principal_id: users[key].id, role: ['owner', 'admin'].includes(key) ? 'admin' : 'member', display_name: key, created_at: 't0' });
  const project = await insertProject(ctx.db, { code: testCode(number++), teamId: team.id, name: 'Permissions project' });
  await ctx.db.update(schema.projects).set({ owner_principal_id: users.owner.id, created_by: users.owner.id, member_policy: 'private' }).where(eq(schema.projects.id, project.id));
  for (const [key, role] of [['owner', 'admin'], ['admin', 'admin'], ['member', 'member']]) await insertMember(ctx.db, { projectId: project.id, principalId: users[key].id, role, displayName: key });
  const raw = (user, args) => ctx.runCli(args, { ACP_TOKEN: tokens[user], ACP_DEVICE_TOKEN: '', ACP_PRINCIPAL_CODE: '' }, { cwd: ctx.tmp });
  const cli = async (user, args) => {
    const result = await raw(user, args);
    assert.ok(result.out.trim(), result.err);
    return { status: result.status, ...JSON.parse(result.out) };
  };
  return { ...ctx, users, team, project, cli, raw };
}

test('tsp team and project role commands use authenticated identity and preserve hierarchy', async () => {
  const ctx = await setup();
  try {
    const list = await ctx.cli('owner', ['team', 'members', ctx.team.code]);
    assert.equal(list.status, 0);
    assert.equal(list.data.filter(member => member.role === 'owner').length, 1);
    const viewer = await ctx.cli('admin', ['project', 'member', 'add', ctx.users.external.code, '--project', ctx.project.code, '--role', 'viewer']);
    assert.equal(viewer.status, 0, JSON.stringify(viewer));
    const roster = await ctx.cli('external', ['project', 'members', ctx.project.code]);
    assert.equal(roster.status, 0, JSON.stringify(roster));
    assert.equal(roster.data.find(member => member.user_code === ctx.users.external.code).is_external, true);
    const promote = await ctx.cli('owner', ['project', 'member', 'role', ctx.users.external.code, '--project', ctx.project.code, '--role', 'admin']);
    assert.equal(promote.status, 0);
    const peer = await ctx.cli('admin', ['project', 'member', 'role', ctx.users.external.code, '--project', ctx.project.code, '--role', 'member']);
    assert.equal(peer.status, 1);
    assert.equal(peer.error.code, 'member_forbidden');
    for (const args of [
      ['team', 'role', ctx.team.code, ctx.users.member.code, '--role', 'viewer'],
      ['team', 'role', ctx.team.code, ctx.users.member.code, '--role', 'owner'],
      ['project', 'member', 'role', ctx.users.member.code, '--project', ctx.project.code, '--role', 'owner'],
    ]) {
      const denied = await ctx.cli('owner', args);
      assert.equal(denied.status, 1);
      assert.equal(denied.error.code, 'member_role_invalid');
    }
    const preview = await ctx.cli('owner', ['team', 'remove', ctx.team.code, ctx.users.member.code, '--preview']);
    assert.equal(preview.status, 0);
    assert.deepEqual(preview.data.projects.map(project => project.project_code), [ctx.project.code]);
    assert.equal((await ctx.cli('owner', ['team', 'role', ctx.team.code, ctx.users.member.code, '--role', 'admin'])).status, 0);
    assert.equal((await ctx.cli('owner', ['team', 'remove', ctx.team.code, ctx.users.member.code])).status, 0);
    assert.equal((await ctx.db.select().from(schema.members).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.member.id)))).length, 0);
  } finally { await ctx.cleanup(); }
});

test('tsp project policy supports bound project preview, owner-only writes and default restoration', async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.cli('owner', ['project', 'bind', ctx.project.code])).status, 0);
    const preview = await ctx.cli('owner', ['project', 'policy', 'team_write', '--preview']);
    assert.equal(preview.status, 0, JSON.stringify(preview));
    assert.equal(preview.data.proposed_policy, 'team_write');
    assert.equal(preview.data.impact.gained_write, 1);
    assert.equal((await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id)))[0].member_policy, 'private');
    const denied = await ctx.cli('admin', ['project', 'policy', 'team_write']);
    assert.equal(denied.status, 1);
    assert.equal(denied.error.code, 'project_forbidden');
    assert.equal((await ctx.cli('owner', ['project', 'policy', 'team_write'])).status, 0);
    assert.equal((await ctx.cli('owner', ['project', 'member', 'role', ctx.users.member.code, '--role', 'viewer'])).status, 0);
    const restored = await ctx.cli('owner', ['project', 'member', 'remove', ctx.users.member.code]);
    assert.equal(restored.status, 0);
    assert.equal(restored.data.effective_role, 'member');
    assert.equal(restored.data.access_source, 'team');
    const invalid = await ctx.cli('owner', ['project', 'policy', 'public']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.error.code, 'project_policy_invalid');
  } finally { await ctx.cleanup(); }
});

test('tsp ownership transfer is visible only to participants and requires recipient acceptance', async () => {
  const ctx = await setup();
  try {
    const transfer = await ctx.cli('owner', ['ownership', 'transfer', 'project', ctx.project.code, ctx.users.next.code]);
    assert.equal(transfer.status, 0, JSON.stringify(transfer));
    assert.equal((await ctx.cli('member', ['ownership', 'list'])).data.length, 0);
    assert.equal((await ctx.cli('next', ['ownership', 'list'])).data[0].code, transfer.data.code);
    const wrong = await ctx.cli('owner', ['ownership', 'accept', transfer.data.code]);
    assert.equal(wrong.status, 1);
    assert.equal(wrong.error.code, 'ownership_recipient_required');
    assert.equal((await ctx.cli('next', ['ownership', 'accept', transfer.data.code])).status, 0);
    const [project] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id));
    assert.equal(project.owner_principal_id, ctx.users.next.id);
    assert.equal(project.created_by, ctx.users.owner.id);
    const another = await ctx.cli('next', ['ownership', 'transfer', 'project', ctx.project.code, ctx.users.member.code]);
    assert.equal(another.status, 0);
    assert.equal((await ctx.cli('next', ['ownership', 'cancel', another.data.code])).status, 0);
    assert.equal((await ctx.cli('member', ['ownership', 'accept', another.data.code])).error.code, 'ownership_transfer_not_pending');
  } finally { await ctx.cleanup(); }
});

test('tsp ownership resolve and recover distinguish legacy responsibility from inactive-owner recovery', async () => {
  const ctx = await setup();
  try {
    await ctx.db.update(schema.projects).set({ owner_principal_id: null }).where(eq(schema.projects.id, ctx.project.id));
    await ctx.db.update(schema.members).set({ role: 'owner' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.owner.id)));
    await ctx.db.update(schema.members).set({ role: 'owner' }).where(and(eq(schema.members.project_id, ctx.project.id), eq(schema.members.principal_id, ctx.users.admin.id)));
    const resolution = await ctx.cli('owner', ['ownership', 'resolve', 'project', ctx.project.code, ctx.users.admin.code]);
    assert.equal(resolution.status, 0, JSON.stringify(resolution));
    await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, ctx.users.admin.id));
    const missingReason = await ctx.raw('owner', ['ownership', 'recover', 'project', ctx.project.code, ctx.users.next.code]);
    assert.equal(missingReason.status, 1);
    const recovery = await ctx.cli('owner', ['ownership', 'recover', 'project', ctx.project.code, ctx.users.next.code, '--reason', 'Owner account compromised']);
    assert.equal(recovery.status, 0, JSON.stringify(recovery));
    assert.equal(recovery.data.is_recovery, true);
    assert.equal((await ctx.cli('next', ['ownership', 'accept', recovery.data.code])).status, 0);
    assert.equal((await ctx.db.select().from(schema.projects).where(eq(schema.projects.id, ctx.project.id)))[0].owner_principal_id, ctx.users.next.id);
  } finally { await ctx.cleanup(); }
});

test('tsp account closure requires explicit completion and revokes the current bearer credential', async () => {
  const ctx = await setup();
  try {
    const status = await ctx.cli('external', ['account', 'closure', 'status']);
    assert.equal(status.status, 0);
    assert.equal(status.data.pending_deletion, false);
    assert.equal((await ctx.cli('external', ['account', 'closure', 'begin'])).data.pending_deletion, true);
    assert.equal((await ctx.cli('external', ['account', 'closure', 'cancel'])).data.pending_deletion, false);
    assert.equal((await ctx.cli('external', ['account', 'closure', 'begin'])).status, 0);
    const missingConfirmation = await ctx.raw('external', ['account', 'closure', 'complete']);
    assert.equal(missingConfirmation.status, 1);
    assert.equal((await ctx.db.select().from(schema.users).where(eq(schema.users.id, ctx.users.external.id)))[0].status, 'active');
    const completed = await ctx.cli('external', ['account', 'closure', 'complete', '--confirm']);
    assert.equal(completed.status, 0, JSON.stringify(completed));
    assert.equal(completed.data.closed, true);
    const staleCredential = await ctx.cli('external', ['ownership', 'list']);
    assert.equal(staleCredential.status, 1);
    assert.equal(staleCredential.error.code, 'unauthorized');
  } finally { await ctx.cleanup(); }
});
