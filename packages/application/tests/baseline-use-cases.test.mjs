import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createRequirementBaselineUseCases } from '../dist/index.js';
import { insertFeature, insertRequirement, insertTask, seedWorkspaceProject, useTestDb } from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seeded() {
  const db = fixture.db;
  const seed = await seedWorkspaceProject(db, {
    teamName: 'Baseline team', projectName: 'Baselines',
    users: [
      { key: 'owner', account: 'baseline-owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
      { key: 'member', account: 'baseline-member', displayName: 'Member', teamRole: 'member', projectRole: 'member' },
    ],
  });
  const feature = await insertFeature(db, { projectId: seed.project.id, title: 'Handover' });
  const add = async (title, state = 'confirmed', featureId = feature.id) => {
    const requirement = await insertRequirement(db, { featureId, title, state, ownerPrincipalId: seed.users.owner.id });
    const [revision] = await db.insert(schema.requirementRevisions).values({ requirement_id: requirement.id, revision: 1, summary: `${title} body`, acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'works' }]), open_questions: '[]', created_at: 't0' }).returning();
    return { requirement, revision };
  };
  const first = await add('Original title');
  const second = await add('Second requirement');
  const uc = createRequirementBaselineUseCases(db);
  const args = {
    projectCode: seed.project.code, principalCode: seed.users.owner.code,
    name: 'Release 1', scope: 'handover-v1', reason: 'Approve initial delivery scope', parentBaselineCode: null,
    requirements: [{ requirement_code: first.requirement.code, revision: 1 }],
  };
  return { db, ...seed, feature, first, second, add, uc, args };
}

test('基线固定正文和元数据；后续需求修改不改变历史；不可追加、更新或删除', async () => {
  const c = await seeded();
  const created = await c.uc.create(c.args);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.version, 1);
  assert.equal(created.data.parent_baseline_code, null);
  assert.match(created.data.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(created.data.requirements[0].revision_code, c.first.revision.code);
  await c.db.update(schema.requirements).set({ title: 'Renamed later', state: 'implementing' }).where(eq(schema.requirements.id, c.first.requirement.id));
  await c.db.update(schema.requirementRevisions).set({ summary: 'Modified source storage' }).where(eq(schema.requirementRevisions.id, c.first.revision.id));
  const loaded = await c.uc.get({ ...c.args, baselineCode: created.data.baseline_code });
  assert.deepEqual(loaded.data, created.data);
  const [header] = await c.db.select().from(schema.requirementBaselines);
  await assert.rejects(c.db.update(schema.requirementBaselines).set({ name: 'illegal' }).where(eq(schema.requirementBaselines.id, header.id)));
  await assert.rejects(c.db.delete(schema.requirementBaselines).where(eq(schema.requirementBaselines.id, header.id)));
  await assert.rejects(c.db.update(schema.requirementBaselineItems).set({ snapshot: '{}' }).where(eq(schema.requirementBaselineItems.baseline_id, header.id)));
  await assert.rejects(c.db.delete(schema.requirementBaselineItems).where(eq(schema.requirementBaselineItems.baseline_id, header.id)));
  await assert.rejects(c.db.insert(schema.requirementBaselineItems).values({ baseline_id: header.id, requirement_id: c.second.requirement.id, requirement_revision_id: c.second.revision.id, snapshot: '{}' }));
});

test('基线轨迹与差异包含新增、移除、正文、验收、标题和状态的变化', async () => {
  const c = await seeded();
  const from = await c.uc.create({ ...c.args, requirements: [c.first, c.second].map(value => ({ requirement_code: value.requirement.code, revision: 1 })) });
  assert.equal(from.ok, true, JSON.stringify(from));
  await c.db.insert(schema.requirementRevisions).values({ requirement_id: c.first.requirement.id, revision: 2, summary: 'New body', acceptance_criteria: '[{"id":"AC-2","text":"New acceptance"}]', open_questions: '["Pending question"]', created_at: 't1' });
  await c.db.update(schema.requirements).set({ title: 'New title', current_revision: 2, state: 'implementing' }).where(eq(schema.requirements.id, c.first.requirement.id));
  const third = await c.add('Third requirement');
  const to = await c.uc.create({ ...c.args, parentBaselineCode: from.data.baseline_code, reason: 'Change transfer rules', requirements: [{ requirement_code: c.first.requirement.code, revision: 2 }, { requirement_code: third.requirement.code, revision: 1 }] });
  assert.equal(to.ok, true, JSON.stringify(to));
  assert.equal(to.data.version, 2);
  assert.equal(to.data.parent_baseline_code, from.data.baseline_code);
  const diff = await c.uc.compare({ ...c.args, baselineCode: from.data.baseline_code, compareTo: to.data.baseline_code });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.deepEqual(diff.data.counts, { added: 1, modified: 1, removed: 1 });
  const changed = diff.data.changes.find(change => change.kind === 'modified');
  for (const field of ['revision', 'revision_code', 'body', 'title', 'status', 'acceptance_criteria', 'open_questions']) assert.ok(changed.changed_fields.includes(field), field);
  const history = await c.uc.list(c.args);
  assert.deepEqual(history.data.baselines.map(baseline => baseline.version), [2, 1]);
  const unchanged = await c.uc.compare({ ...c.args, baselineCode: to.data.baseline_code, compareTo: to.data.baseline_code });
  assert.equal(unchanged.data.changes.length, 0);
  const current = await c.uc.compare({ ...c.args, baselineCode: to.data.baseline_code, compareTo: 'current' });
  assert.deepEqual(current.data.counts, { added: 1, modified: 0, removed: 0 });
});

test('基线读取限项目成员；确认限有效 Owner；归档后仍可读历史', async () => {
  const c = await seeded();
  const member = { ...c.args, principalCode: c.users.member.code };
  assert.equal((await c.uc.create(member)).error.code, 'baseline_owner_required');
  assert.equal((await c.uc.list(member)).data.can_create, false);
  const baseline = await c.uc.create(c.args);
  await c.db.delete(schema.members).where(eq(schema.members.principal_id, c.users.member.id));
  assert.equal((await c.uc.get({ ...member, baselineCode: baseline.data.baseline_code })).error.code, 'baseline_access_denied');
  assert.equal((await c.uc.list(member)).error.code, 'baseline_access_denied');
  assert.equal((await c.uc.compare({ ...member, baselineCode: baseline.data.baseline_code, compareTo: 'current' })).error.code, 'baseline_access_denied');
  await c.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, c.project.id));
  assert.equal((await c.uc.create(c.args)).error.code, 'project_archived');
  assert.equal((await c.uc.list(c.args)).data.baselines.length, 1);
  assert.equal((await c.uc.list(c.args)).data.can_create, false);
  await c.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, c.users.owner.id));
  assert.equal((await c.uc.list(c.args)).error.code, 'baseline_access_denied');
});

test('基线拒绝草稿、空选择、重复、未知修订和跨项目内容，失败事务不留记录', async () => {
  const c = await seeded();
  const draft = await c.add('Draft', 'draft');
  assert.equal((await c.uc.create({ ...c.args, name: ' ' })).error.code, 'baseline_invalid_metadata');
  assert.equal((await c.uc.create({ ...c.args, requirements: [] })).error.code, 'baseline_invalid_selection');
  assert.equal((await c.uc.create({ ...c.args, requirements: [...c.args.requirements, ...c.args.requirements] })).error.code, 'baseline_invalid_selection');
  assert.equal((await c.uc.create({ ...c.args, requirements: [{ requirement_code: draft.requirement.code, revision: 1 }] })).error.code, 'baseline_requirement_not_approved');
  assert.equal((await c.uc.create({ ...c.args, requirements: [{ requirement_code: c.first.requirement.code, revision: 99 }] })).error.code, 'baseline_revision_not_found');
  const [otherProject] = await c.db.insert(schema.projects).values({ team_id: c.team.id, name: 'Other', created_at: 't0' }).returning();
  const feature = await insertFeature(c.db, { projectId: otherProject.id, title: 'Other' });
  const other = await c.add('Other requirement', 'confirmed', feature.id);
  assert.equal((await c.uc.create({ ...c.args, requirements: [{ requirement_code: other.requirement.code, revision: 1 }] })).error.code, 'baseline_requirement_project_mismatch');
  assert.equal((await c.db.select().from(schema.requirementBaselines)).length, 0);
  assert.equal((await c.db.select().from(schema.requirementBaselineItems)).length, 0);
});

test('并发确认必须匹配最新父基线；首次显式空父级也防止重复确认', async () => {
  const c = await seeded();
  const first = await Promise.all([c.uc.create(c.args), c.uc.create(c.args)]);
  assert.equal(first.filter(result => result.ok).length, 1);
  assert.equal(first.find(result => !result.ok).error.code, 'baseline_parent_conflict');
  const parent = first.find(result => result.ok).data;
  const next = await Promise.all([c.uc.create({ ...c.args, parentBaselineCode: parent.baseline_code }), c.uc.create({ ...c.args, parentBaselineCode: parent.baseline_code })]);
  assert.equal(next.filter(result => result.ok).length, 1);
  assert.equal(next.find(result => !result.ok).error.code, 'baseline_parent_conflict');
  assert.deepEqual((await c.uc.list(c.args)).data.baselines.map(value => value.version), [2, 1]);
});

test('项目隔离：基线代码不能越项目读取或比较；内容哈希检测存储损坏', async () => {
  const c = await seeded();
  const created = await c.uc.create(c.args);
  const [otherProject] = await c.db.insert(schema.projects).values({ team_id: c.team.id, name: 'Other', created_at: 't0' }).returning();
  await c.db.insert(schema.members).values({ project_id: otherProject.id, principal_id: c.users.owner.id, role: 'owner', display_name: 'Owner', created_at: 't0' });
  const otherArgs = { ...c.args, projectCode: otherProject.code, baselineCode: created.data.baseline_code };
  assert.equal((await c.uc.get(otherArgs)).error.code, 'baseline_not_found');
  assert.equal((await c.uc.compare({ ...otherArgs, compareTo: 'current' })).error.code, 'baseline_not_found');
  // Superuser tampering deliberately bypasses the trigger; reads must still reject altered content.
  await c.db.execute(sql`alter table requirement_baseline_items disable trigger immutable_requirement_baseline_items`);
  try {
    await c.db.update(schema.requirementBaselineItems).set({ snapshot: JSON.stringify({ ...created.data.requirements[0], body: 'Corrupt' }) });
  } finally {
    await c.db.execute(sql`alter table requirement_baseline_items enable trigger immutable_requirement_baseline_items`);
  }
  assert.equal((await c.uc.get({ ...c.args, baselineCode: created.data.baseline_code })).error.code, 'baseline_integrity_error');
});

test('演进图绑定保留未绑定任务和交接，交接采用冻结基线并遵守草稿可见性和项目隔离', async () => {
  const c = await seeded();
  const first = await c.uc.create(c.args);
  const second = await c.uc.create({ ...c.args, parentBaselineCode: first.data.baseline_code });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  const headers = await c.db.select().from(schema.requirementBaselines);
  const latest = headers.find(row => row.code === second.data.baseline_code);
  const [device] = await c.db.insert(schema.devices).values({ principal_id: c.users.owner.id, device_name: 'Source', credential_hash: 'fixture', created_at: 't0' }).returning();
  const make = async ({ title, project = c.project, feature = c.feature, principal = c.users.owner, frozen, contextProject = project, bound = false, published = false }) => {
    const task = await insertTask(c.db, { featureId: feature.id, title, profile: 'builder', acceptance: [] });
    if (bound) await c.db.update(schema.tasks).set({ requirement_baseline_id: latest.id }).where(eq(schema.tasks.id, task.id));
    const [run] = await c.db.insert(schema.runs).values({ task_id: task.id, principal_id: principal.id, profile: 'builder', workspace_id: 1n, status: 'completed', base_snapshot: 0, started_at: 't0' }).returning();
    const [context] = await c.db.insert(schema.contextSnapshots).values({ project_id: contextProject.id, task_id: task.id, source_run_id: run.id, created_by: principal.id,
      manifest: JSON.stringify({ requirement_baseline: frozen ?? null }), summary: '', material_versions: '{}', content_hash: 'fixture', created_at: 't0' }).returning();
    const [handover] = await c.db.insert(schema.taskHandovers).values({ task_id: task.id, source_run_id: run.id, target_principal_id: c.users.member.id, source_device_id: device.id,
      context_snapshot_id: context.id, status: published ? 'completed' : 'preparing', published_by: published ? c.users.owner.id : null,
      source_epoch: 0, preparation_grant_hash: 'fixture', preparation_expires_at: 't1', expires_at: 't1', created_at: 't0', updated_at: 't0' }).returning();
    return { task, handover };
  };
  const historical = await make({ title: 'Historical baseline', frozen: first.data, bound: true, published: true });
  const unbound = await make({ title: 'No baseline', published: true });
  const hidden = await make({ title: 'Private owner draft', frozen: first.data });
  const own = await make({ title: 'Private source draft', principal: c.users.member, frozen: first.data });
  const [otherProject] = await c.db.insert(schema.projects).values({ team_id: c.team.id, name: 'Other', created_at: 't0' }).returning();
  const otherFeature = await insertFeature(c.db, { projectId: otherProject.id, title: 'Other' });
  const other = await make({ title: 'Other project', project: otherProject, feature: otherFeature, frozen: first.data, published: true });
  const foreignContext = await make({ title: 'Mismatched context', contextProject: otherProject, frozen: first.data, published: true });
  const ownerView = await c.uc.bindings(c.args);
  assert.equal(ownerView.ok, true, JSON.stringify(ownerView));
  assert.equal(ownerView.data.tasks.find(row => row.task_code === historical.task.code).baseline_code, second.data.baseline_code);
  assert.equal(ownerView.data.handovers.find(row => row.handover_code === historical.handover.code).baseline_code, first.data.baseline_code);
  assert.equal(ownerView.data.handovers.find(row => row.handover_code === historical.handover.code).baseline_version, 1);
  assert.equal(ownerView.data.tasks.find(row => row.task_code === unbound.task.code).baseline_code, null);
  assert.equal(ownerView.data.handovers.find(row => row.handover_code === unbound.handover.code).baseline_code, null);
  assert.equal(ownerView.data.handovers.find(row => row.handover_code === foreignContext.handover.code).baseline_code, null);
  assert.ok(ownerView.data.handovers.some(row => row.handover_code === hidden.handover.code));
  assert.ok(!ownerView.data.tasks.some(row => row.task_code === other.task.code));
  assert.ok(!ownerView.data.handovers.some(row => row.handover_code === other.handover.code));
  const memberArgs = { ...c.args, principalCode: c.users.member.code };
  const memberView = await c.uc.bindings(memberArgs);
  assert.equal(memberView.ok, true, JSON.stringify(memberView));
  assert.ok(!memberView.data.handovers.some(row => row.handover_code === hidden.handover.code));
  assert.ok(memberView.data.handovers.some(row => row.handover_code === own.handover.code));
  assert.ok(memberView.data.handovers.some(row => row.handover_code === historical.handover.code));
  await c.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, c.project.id));
  assert.equal((await c.uc.bindings(memberArgs)).ok, true);
  await c.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, c.users.member.id));
  assert.equal((await c.uc.bindings(memberArgs)).error.code, 'baseline_access_denied');
  await c.db.delete(schema.members).where(eq(schema.members.principal_id, c.users.owner.id));
  assert.equal((await c.uc.bindings(c.args)).error.code, 'baseline_access_denied');
});
