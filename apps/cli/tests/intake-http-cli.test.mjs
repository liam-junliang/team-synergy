import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { schema } from '@team-synergy/persistence';
import { eq } from 'drizzle-orm';
import { bindProject } from '../dist/project-binding.js';
import { createHttpTestContext, insertMember, insertProject, insertTeam, insertUser, testCode } from './http-test-helpers.mjs';

test('real tsp prepare/submit/preview/review/apply crosses HTTP with member/owner/viewer boundaries and preserves existing data', async t => {
  const context = await createHttpTestContext(import.meta.url);
  t.after(() => context.cleanup());
  const timestamp = '2026-10-18T00:00:00Z';
  const users = {};
  for (const [index, name] of ['owner', 'member', 'viewer'].entries()) {
    const user = await insertUser(context.db, { code: testCode(900 + index), account: `intake.e2e.${name}`, displayName: name, createdAt: timestamp });
    const token = `intake-e2e-device-${name}`;
    await context.db.insert(schema.devices).values({ principal_id: user.id, device_name: name, credential_hash: createHash('sha256').update(token).digest('hex'), created_at: timestamp });
    users[name] = { ...user, token };
  }
  const team = await insertTeam(context.db, { code: testCode(910), name: 'Intake team', createdAt: timestamp });
  await context.db.update(schema.teams).set({ owner_principal_id: users.owner.id, created_by: users.owner.id }).where(eq(schema.teams.id, team.id));
  await context.db.insert(schema.teamMembers).values({ team_id: team.id, principal_id: users.owner.id, role: 'admin', display_name: 'owner', created_at: timestamp });
  const project = await insertProject(context.db, { code: testCode(911), teamId: team.id, name: 'Intake project', createdAt: timestamp });
  await context.db.update(schema.projects).set({ owner_principal_id: users.owner.id, created_by: users.owner.id, member_policy: 'private' }).where(eq(schema.projects.id, project.id));
  for (const [name, role] of [['owner', 'admin'], ['member', 'member'], ['viewer', 'viewer']]) await insertMember(context.db, { principalId: users[name].id, projectId: project.id, role, displayName: name, createdAt: timestamp });
  const [repository] = await context.db.insert(schema.projectRepositories).values({ project_id: project.id, name: 'Source', remote_url: 'https://example.invalid/team/source.git', created_by: users.owner.id, created_at: timestamp, updated_at: timestamp }).returning();
  const [existing] = await context.db.insert(schema.projectModules).values({ project_id: project.id, name: 'Existing module', description: 'Keep this', created_at: timestamp, updated_at: timestamp }).returning();
  const workspace = path.join(context.tmp, 'workspace'); mkdirSync(workspace);
  const source = context.makeRepo('source');
  bindProject(workspace, project.code, context.apiUrl);
  writeFileSync(path.join(workspace, '.agent', 'repositories.local.yaml'), `repositories:\n  - repository_code: "${repository.code}"\n    path: ${JSON.stringify(source)}\n    remote_name: "origin"\n`);
  async function run(name, args) {
    const result = await context.runCli(['intake', ...args], { ACP_DEVICE_TOKEN: users[name].token }, { cwd: workspace });
    return { ...result, ...JSON.parse(result.out || assert.fail(result.err)) };
  }
  function success(result) { assert.equal(result.status, 0, result.err || result.out); assert.equal(result.ok, true, result.out); return result.data; }
  const prepared = success(await run('member', ['prepare', '--repository', repository.code, '--scope', '.', '--out', 'out']));
  const bundle = JSON.parse(readFileSync(prepared.bundle_path, 'utf8'));
  const evidence = bundle.source.files.find(file => file.path === 'README.md');
  bundle.items = [{ key: 'module.first', kind: 'module', title: 'Observed capability', summary: 'Local tracked evidence', content_markdown: 'Read the repository README.', evidence: [{ ...evidence, line_start: 1, line_end: 1 }], assessment: 'observed_in_code', tests: [], gaps: ['Runtime not verified'] }];
  writeFileSync(prepared.bundle_path, JSON.stringify(bundle));
  success(await run('member', ['validate', prepared.bundle_path]));
  const staged = success(await run('member', ['submit', prepared.bundle_path, '--idempotency-key', 'e2e-submit-first']));
  assert.equal(staged.status, 'draft'); assert.equal(staged.can_review, false);
  assert.equal((await context.db.select().from(schema.projectModules)).length, 1);
  assert.equal((await run('viewer', ['preview', staged.code])).error.code, 'intake_forbidden');
  const preview = success(await run('owner', ['preview', staged.code])); assert.equal(preview.items[0].item.title, 'Observed capability'); assert.equal(preview.can_review, true);
  const reviewedResponse = await fetch(`${context.apiUrl}/projects/${project.code}/intake/${staged.code}/review`, {
    method: 'POST', headers: { authorization: `Bearer ${users.owner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ base_revision: preview.revision, decisions: [{ key: 'module.first', action: 'create' }] }),
  });
  const reviewed = await reviewedResponse.json(); assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  const apply = ['apply', staged.code, '--plan', reviewed.data.plan_hash, '--idempotency-key', 'e2e-apply-first'];
  assert.equal((await run('member', apply)).error.code, 'project_forbidden');
  const published = success(await run('owner', apply)); assert.equal(published.status, 'applied'); assert.equal(published.applied_count, 1);
  const replay = success(await run('owner', apply)); assert.equal(replay.items[0].target_code, published.items[0].target_code);
  assert.equal((await context.db.select().from(schema.projectModules)).length, 2);
  assert.deepEqual((await context.db.select().from(schema.projectModules).where(eq(schema.projectModules.id, existing.id)))[0], existing);
  assert.equal((await context.db.select().from(schema.tasks)).length, 0);
  await context.db.update(schema.members).set({ role: 'viewer' }).where(eq(schema.members.principal_id, users.member.id));
  assert.equal((await run('member', ['status', staged.code])).error.code, 'intake_forbidden');
});
