import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createHandoverUseCases, createTaskService, createRequirementBaselineUseCases, createTaskBaselineUseCases, createDesignPrototypeUseCases, createProjectHomeUseCases, createProjectDocumentUseCases, createAuthUseCases, hashPassword, hashToken } from '../dist/index.js';
import {
  insertFeature,
  insertRequirement,
  insertTask,
  seedWorkspaceProject,
  useTestDb,
} from './test-db.mjs';

const fixture = useTestDb(import.meta.url);
const BASE_COMMIT = 'a'.repeat(40);
const SNAPSHOT_COMMIT = 'b'.repeat(40);
const SNAPSHOT_TREE = 'c'.repeat(40);

function success(result, operation) {
  assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
  return result.data;
}

function rejected(result, operation) {
  assert.equal(result.ok, false, `${operation} must be rejected`);
  assert.notEqual(result.error.code, 'internal_error', `${operation}: ${JSON.stringify(result)}`);
  return result.error;
}

async function seededDb(options = {}) {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-HANDOVER',
    projectLegacyCode: 'PROJECT-HANDOVER',
    users: [
      { key: 'owner', account: 'owner', displayName: 'Owner', teamRole: 'owner', projectRole: 'owner' },
      { key: 'source', account: 'source', displayName: 'Source' },
      { key: 'target', account: 'target', displayName: 'Target' },
      { key: 'observer', account: 'observer', displayName: 'Observer' },
    ],
  });
  const identities = {};
  const devices = {};
  for (const [key, user] of Object.entries(seeded.users)) {
    const [device] = await db.insert(schema.devices).values({
      principal_id: user.id,
      device_name: `${key}-computer`,
      credential_hash: `fixture-${key}`,
      created_at: new Date().toISOString(),
    }).returning();
    devices[key] = device;
    identities[key] = { principalCode: user.code, deviceCode: device.code, authKind: 'bearer' };
  }
  const feature = await insertFeature(db, { projectId: seeded.project.id, title: 'Portable collaboration' });
  const requirement = await insertRequirement(db, {
    featureId: feature.id,
    title: 'Continue on another computer',
    ownerPrincipalId: seeded.users.owner.id,
  });
  const [revision] = await db.insert(schema.requirementRevisions).values({
    requirement_id: requirement.id,
    revision: 1,
    summary: 'Original requirement',
    acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'Restore exact code' }]),
    created_at: new Date().toISOString(),
  }).returning();
  const task = await insertTask(db, {
    featureId: feature.id,
    requirementId: requirement.id,
    title: 'Continue implementation',
    brief: 'Do not lose the original author or immutable baseline.',
    profile: 'builder',
    acceptance: [{ id: 'AC-1', text: 'Restore exact code' }, { id: 'AC-2', text: 'Retain provenance' }],
  });
  await db.update(schema.tasks).set({ source_requirement_revision_id: revision.id }).where(eq(schema.tasks.id, task.id));
  const [repository] = await db.insert(schema.projectRepositories).values({
    project_id: seeded.project.id,
    name: 'backend',
    remote_url: 'https://example.com/team/backend.git',
    default_branch: 'main',
    created_by: seeded.users.owner.id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).returning();
  const tasks = createTaskService(db);
  let baseline = null;
  if (options.baseline) {
    baseline = success(await createRequirementBaselineUseCases(db).create({ projectCode: seeded.project.code,
      principalCode: seeded.users.owner.code, name: 'Cross-person V1', scope: 'handover-v1', reason: 'Approve exact continuation scope',
      requirements: [{ requirement_code: requirement.code, revision: 1 }] }), 'freeze baseline');
    success(await createTaskBaselineUseCases(db).bind({ taskCode: task.code, baselineCode: baseline.baseline_code,
      principalCode: seeded.users.owner.code, baseSnapshot: task.base_snapshot }), 'bind baseline');
  }
  const [beforeAssignment] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
  const assigned = success(await tasks.assignTask({
    taskCode: task.code,
    assigneePrincipalCode: seeded.users.source.code,
    principalCode: seeded.users.owner.code,
    baseSnapshot: beforeAssignment.base_snapshot,
  }), 'assign');
  const claimed = success(await tasks.claimTask({
    taskCode: task.code,
    principalCode: seeded.users.source.code,
    profile: 'builder',
    baseSnapshot: assigned.base_snapshot,
    workspacePath: '/source/workspace',
    gitBase: BASE_COMMIT,
    runCode: '11111111111111111111',
    workspaceCode: '22222222222222222222',
  }), 'claim');
  const [sourceRun] = await db.select().from(schema.runs).where(eq(schema.runs.code, claimed.run_code));
  assert.ok(sourceRun);
  return {
    db, ...seeded, identities, devices, feature, requirement, task, repository, sourceRun, baseline,
    tasks, handovers: createHandoverUseCases(db),
    workspaceManifest: {
      repository_code: repository.code,
      remote_url: repository.remote_url,
      base_commit: BASE_COMMIT,
      snapshot_commit: SNAPSHOT_COMMIT,
      snapshot_tree: SNAPSHOT_TREE,
      snapshot_ref: 'refs/heads/acp-handover-test',
      files: [{ path: 'src/login.ts', hash: 'd'.repeat(64) }],
    },
    summary: {
      goal: 'Continue the login implementation',
      completed: ['Interface implemented'],
      remaining: ['Concurrency tests'],
      decisions_applied: ['Use uniform errors'],
      assumptions: ['Lock duration is still undecided'],
      open_questions: ['Confirm lock duration'],
      failed_attempts: ['Timer-based expiry raced with requests'],
      next_actions: ['Inspect the interface and add tests'],
      evidence_refs: [],
    },
  };
}

async function prepare(ctx, overrides = {}) {
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  return success(await ctx.handovers.prepare({
    identity: ctx.identities.source,
    idempotencyKey: 'prepare-1',
    task_code: ctx.task.code,
    source_run_code: ctx.sourceRun.code,
    target_user_code: ctx.users.target.code,
    base_snapshot: task.base_snapshot,
    ...overrides,
  }), 'prepare');
}

async function detail(ctx, prepared, identity = ctx.identities.source) {
  return success(await ctx.handovers.get({ identity, handover_code: prepared.handover_code }), 'get handover');
}

async function draft(ctx, prepared) {
  const current = await detail(ctx, prepared);
  return success(await ctx.handovers.draft({
    identity: ctx.identities.source,
    handover_code: prepared.handover_code,
    preparation_grant: prepared.preparation_grant,
    version: current.version,
    summary: ctx.summary,
    workspace_manifest: ctx.workspaceManifest,
  }), 'draft');
}

async function published(ctx) {
  const prepared = await prepare(ctx);
  await draft(ctx, prepared);
  success(await ctx.handovers.ackStop({
    identity: ctx.identities.source,
    handover_code: prepared.handover_code,
    preparation_grant: prepared.preparation_grant,
    stopped: true,
    assurance: 'manual_confirmation',
  }), 'ack stop');
  const current = await detail(ctx, prepared);
  success(await ctx.handovers.publish({
    identity: ctx.identities.owner,
    handover_code: prepared.handover_code,
    version: current.version,
  }), 'publish');
  return prepared;
}

async function restored(ctx, prepared = null) {
  const handover = prepared ?? await published(ctx);
  const current = await detail(ctx, handover, ctx.identities.target);
  success(await ctx.handovers.accept({
    identity: ctx.identities.target,
    handover_code: handover.handover_code,
    version: current.version,
  }), 'accept');
  const restoration = success(await ctx.handovers.restore({
    identity: ctx.identities.target,
    idempotencyKey: 'restore-1',
    handover_code: handover.handover_code,
    workspace_path: '/target/independent-worktree',
    git_base: SNAPSHOT_COMMIT,
  }), 'restore');
  return { ...handover, ...restoration, ...(await detail(ctx, handover, ctx.identities.target)) };
}

async function ready(ctx, handover) {
  return success(await ctx.handovers.ready({
    identity: ctx.identities.target,
    handover_code: handover.handover_code,
    attempt_code: handover.attempt_code,
    workspace_digest: 'e'.repeat(64),
    snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash,
    assurance: 'client_reported',
  }), 'ready');
}

function activation(ctx, handover, idempotencyKey = 'activate-1') {
  return ctx.handovers.activate({
    identity: ctx.identities.target,
    idempotencyKey,
    handover_code: handover.handover_code,
    attempt_code: handover.attempt_code,
    context_snapshot_hash: handover.context_snapshot_hash,
  });
}

test('handover: a different person restores a new linked Run without rewriting source authorship', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  const activated = success(await activation(ctx, handover), 'activate');
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  const [target] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, activated.run_code));
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  assert.equal(source.principal_id, ctx.users.source.id);
  assert.equal(source.status, 'transferred');
  assert.equal(target.principal_id, ctx.users.target.id);
  assert.equal(target.continued_from_run_id, source.id);
  assert.equal(target.status, 'active');
  assert.notEqual(target.workspace_id, source.workspace_id);
  assert.equal(task.assignee_principal_id, ctx.users.target.id);
  assert.equal(task.status, 'running');
  assert.ok(activated.execution_epoch > source.execution_epoch);
  assert.ok(activated.lease);
  assert.equal((await detail(ctx, handover, ctx.identities.target)).status, 'completed');
});

test('handover: prepare fences the legacy source submit path immediately', async () => {
  const ctx = await seededDb();
  await prepare(ctx);
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  const result = await ctx.tasks.submitTask({
    taskCode: task.code,
    runCode: ctx.sourceRun.code,
    principalCode: ctx.users.source.code,
    baseSnapshot: task.base_snapshot,
    artifact: { kind: 'patch', uri: 'file:///source/change.patch', contentHash: 'x' },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1', 'AC-2'], command: 'test' },
  });
  rejected(result, 'paused source submit');
  assert.equal((await ctx.db.select().from(schema.artifacts)).length, 0);
  assert.equal((await ctx.db.select().from(schema.evidences)).length, 0);
});

test('handover: only the Owner publishes and only the selected person accepts', async () => {
  const ctx = await seededDb();
  const prepared = await prepare(ctx);
  await draft(ctx, prepared);
  success(await ctx.handovers.ackStop({ identity: ctx.identities.source, handover_code: prepared.handover_code,
    preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation' }), 'ack stop');
  rejected(await ctx.handovers.publish({ identity: ctx.identities.source, handover_code: prepared.handover_code }), 'source publish');
  success(await ctx.handovers.publish({ identity: ctx.identities.owner, handover_code: prepared.handover_code }), 'Owner publish');
  rejected(await ctx.handovers.accept({ identity: ctx.identities.observer, handover_code: prepared.handover_code }), 'observer accept');
  success(await ctx.handovers.accept({ identity: ctx.identities.target, handover_code: prepared.handover_code }), 'target accept');
});

test('handover: publication requires an explicit source stop acknowledgement', async () => {
  const ctx = await seededDb();
  const prepared = await prepare(ctx);
  await draft(ctx, prepared);
  rejected(await ctx.handovers.publish({ identity: ctx.identities.owner, handover_code: prepared.handover_code }), 'publish before stop');
  assert.equal((await detail(ctx, prepared)).status, 'preparing');
});

test('handover: unpublished summaries and context are not visible to the selected recipient', async () => {
  const ctx = await seededDb();
  const prepared = await prepare(ctx);
  await draft(ctx, prepared);
  const own = await detail(ctx, prepared);
  rejected(await ctx.handovers.get({ identity: ctx.identities.target, handover_code: prepared.handover_code }), 'target read draft');
  rejected(await ctx.handovers.getContext({ identity: ctx.identities.target, snapshot_code: own.context_snapshot_code }), 'target read draft context');
});

test('handover: published context remains byte-for-byte fixed when upstream requirements change', async () => {
  const ctx = await seededDb();
  const prepared = await published(ctx);
  const current = await detail(ctx, prepared, ctx.identities.target);
  const request = { identity: ctx.identities.target, snapshot_code: current.context_snapshot_code };
  const before = success(await ctx.handovers.getContext(request), 'context before change');
  await ctx.db.insert(schema.requirementRevisions).values({ requirement_id: ctx.requirement.id, revision: 2,
    summary: 'Changed requirement', acceptance_criteria: '[{"id":"AC-NEW","text":"New contract"}]', created_at: new Date().toISOString() });
  await ctx.db.update(schema.requirements).set({ current_revision: 2 }).where(eq(schema.requirements.id, ctx.requirement.id));
  const after = success(await ctx.handovers.getContext(request), 'context after change');
  assert.deepEqual(after, before);
  assert.ok(current.context_snapshot_hash);
  const drift = success(await ctx.handovers.diffContext({ identity: ctx.identities.target, handover_code: prepared.handover_code }), 'context drift');
  assert.match(JSON.stringify(drift), /requirement/);
});

test('handover: prototype sources freeze URL and file revision metadata without embedding file bytes', async () => {
  const ctx = await seededDb();
  const prototypes = createDesignPrototypeUseCases(ctx.db);
  const file = success(await prototypes.createPrototype({ projectCode: ctx.project.code, title: 'Source design', contentKind: 'file',
    fileName: 'source.fig', fileContentBase64: Buffer.from('original design').toString('base64'), principalCode: ctx.users.source.code }), 'file prototype');
  const url = success(await prototypes.createPrototype({ projectCode: ctx.project.code, title: 'Online design', contentKind: 'url',
    externalUrl: 'https://example.com/prototype#frame', principalCode: ctx.users.source.code }), 'URL prototype');
  const prepared = await published(ctx);
  const current = await detail(ctx, prepared, ctx.identities.target);
  const request = { identity: ctx.identities.target, snapshot_code: current.context_snapshot_code };
  const before = success(await ctx.handovers.getContext(request), 'frozen context');
  const fileSource = before.manifest.sources.find(source => source.kind === 'prototype' && source.code === file.prototype_code);
  assert.equal(fileSource.content_kind, 'file');
  assert.equal(fileSource.download_path, `/design-prototypes/${file.prototype_code}/file?revision=1`);
  assert.equal(fileSource.file_sha256, file.file_sha256);
  assert.equal(fileSource.file_name, 'source.fig');
  assert.equal('file_content_base64' in fileSource, false);
  assert.equal(before.manifest.sources.find(source => source.code === url.prototype_code).external_url, url.external_url);
  success(await prototypes.revisePrototype({ prototypeCode: file.prototype_code, title: file.title, summary: '', changeSummary: 'New source',
    contentKind: 'file', fileContentBase64: Buffer.from('new design').toString('base64'), principalCode: ctx.users.source.code }), 'replace file');
  const after = success(await ctx.handovers.getContext(request), 'unchanged frozen context');
  assert.deepEqual(after, before);
  const original = success(await prototypes.getPrototypeFile(file.prototype_code, ctx.users.target.code, 1), 'original source download');
  assert.equal(original.bytes.toString(), 'original design');
});

test('handover: home document roles freeze in context and reassignment produces project drift', async () => {
  const ctx = await seededDb();
  const documents = createProjectDocumentUseCases(ctx.db);
  const home = createProjectHomeUseCases(ctx.db);
  const homeView = success(await home.getHome(ctx.project.code, ctx.users.owner.code), 'standards folder');
  const overview = success(await documents.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    title: 'Overview and onboarding', content: 'Approved project introduction', kind: 'general' }), 'overview document');
  const standards = success(await documents.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    title: 'Standards', content: 'Approved working rules', kind: 'general', folderCode: homeView.standards_folder_code }), 'standards document');
  // Preserve coverage of standards trees created before system folders disallowed children.
  const [standardsRoot] = await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.code, homeView.standards_folder_code));
  const [legacyChild] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, parent_id: standardsRoot.id,
    name: 'Frontend', created_by: ctx.users.owner.id, created_at: 'legacy', updated_at: 'legacy' }).returning();
  const child = { ...legacyChild, folder_code: legacyChild.code };
  const second = success(await documents.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    title: 'Web UI', content: 'Approved UI rules', kind: 'general', folderCode: child.folder_code }), 'nested standards document');
  success(await home.updateHome({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, bindings: {
    overview_document_code: overview.document_code, guide_document_code: overview.document_code,
  } }), 'home binding');
  const prepared = await published(ctx);
  const current = await detail(ctx, prepared, ctx.identities.target);
  const request = { identity: ctx.identities.target, snapshot_code: current.context_snapshot_code };
  const frozen = success(await ctx.handovers.getContext(request), 'frozen home context');
  const sources = frozen.manifest.sources.filter(source => source.kind === 'project_document');
  assert.deepEqual(sources.find(source => source.code === overview.document_code).home_roles, ['overview', 'guide']);
  assert.deepEqual(sources.find(source => source.code === standards.document_code).home_roles, ['standards']);
  assert.deepEqual(sources.find(source => source.code === second.document_code).home_roles, ['standards']);
  assert.equal(sources.find(source => source.code === second.document_code).revision, 1);
  success(await home.updateHome({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code, bindings: {
    guide_document_code: standards.document_code,
  } }), 'reassign home without changing document content');
  assert.deepEqual(success(await ctx.handovers.getContext(request), 'frozen home unchanged'), frozen);
  const drift = success(await ctx.handovers.diffContext({ identity: ctx.identities.target, handover_code: prepared.handover_code }), 'home drift');
  assert.match(JSON.stringify(drift), /"source":"project"/);
});

test('handover: standards folder membership changes block readiness while frozen roles and bodies stay unchanged', async () => {
  const ctx = await seededDb();
  const documents = createProjectDocumentUseCases(ctx.db);
  const home = createProjectHomeUseCases(ctx.db);
  const homeView = success(await home.getHome(ctx.project.code, ctx.users.owner.code), 'standards folder');
  // Preserve coverage of standards trees created before system folders disallowed children.
  const [standardsRoot] = await ctx.db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.code, homeView.standards_folder_code));
  const [legacyChild] = await ctx.db.insert(schema.projectDocumentFolders).values({ project_id: ctx.project.id, parent_id: standardsRoot.id,
    name: 'Frontend', created_by: ctx.users.owner.id, created_at: 'legacy', updated_at: 'legacy' }).returning();
  const child = { ...legacyChild, folder_code: legacyChild.code };
  const standard = success(await documents.createDocument({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    title: 'Web UI', content: 'Fixed UI rules', kind: 'general', folderCode: child.folder_code }), 'nested standard');
  const handover = await restored(ctx);
  const request = { identity: ctx.identities.target, snapshot_code: handover.context_snapshot_code };
  const frozen = success(await ctx.handovers.getContext(request), 'frozen standards');
  assert.deepEqual(frozen.manifest.sources.find(source => source.code === standard.document_code).home_roles, ['standards']);
  success(await documents.updateFolder({ folderCode: child.folder_code, principalCode: ctx.users.owner.code,
    parentFolderCode: null }), 'move branch out of standards without changing document revision');
  const current = success(await home.getHome(ctx.project.code, ctx.users.owner.code), 'current standards');
  assert.deepEqual(current.standards, []);
  const unchanged = success(await documents.getDocument(standard.document_code, ctx.users.owner.code), 'same document');
  assert.equal(unchanged.current_revision, 1);
  assert.deepEqual(success(await ctx.handovers.getContext(request), 'frozen standards unchanged'), frozen);
  const drift = success(await ctx.handovers.diffContext({ identity: ctx.identities.target, handover_code: handover.handover_code }), 'folder drift');
  assert.ok(JSON.stringify(drift).includes('project_standards'));
  const error = rejected(await ctx.handovers.ready({ identity: ctx.identities.target,
    handover_code: handover.handover_code, attempt_code: handover.attempt_code,
    workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' }), 'ready after standards membership change');
  assert.equal(error.code, 'context_source_changed');
});

test('handover: provisioning an empty standards directory does not invalidate the frozen context', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  const home = success(await createProjectHomeUseCases(ctx.db).getHome(ctx.project.code, ctx.users.owner.code), 'open home for the first time');
  assert.ok(home.standards_folder_code);
  assert.deepEqual(home.standards, []);
  await ready(ctx, handover);
  const activated = success(await activation(ctx, handover), 'activate after harmless directory provisioning');
  assert.ok(activated.run_code);
});

test('handover: named requirement baseline survives another person activating an independent Run', async () => {
  const ctx = await seededDb({ baseline: true });
  await ctx.db.update(schema.requirementRevisions).set({ summary: 'Maintenance changed old revision text',
    acceptance_criteria: '[]', open_questions: '["Unrelated maintenance note"]' }).where(eq(schema.requirementRevisions.requirement_id, ctx.requirement.id));
  const handover = await restored(ctx);
  const frozen = success(await ctx.handovers.getContext({ identity: ctx.identities.target, snapshot_code: handover.context_snapshot_code }), 'frozen context');
  assert.deepEqual(frozen.manifest.requirement_baseline, ctx.baseline);
  assert.equal(frozen.manifest.task_contract.requirement_baseline_code, ctx.baseline.baseline_code);
  const baselineSource = frozen.manifest.sources.find(item => item.kind === 'requirement_baseline');
  assert.deepEqual(JSON.parse(baselineSource.content), ctx.baseline);
  const requirementSource = frozen.manifest.sources.find(item => item.kind === 'requirement');
  assert.equal(requirementSource.content, ctx.baseline.requirements[0].body);
  assert.deepEqual(requirementSource.acceptance, ctx.baseline.requirements[0].acceptance_criteria);
  assert.deepEqual(JSON.parse(requirementSource.open_questions), ctx.baseline.requirements[0].open_questions);
  assert.equal(handover.requirement_baseline_code, ctx.baseline.baseline_code);
  await ready(ctx, handover);
  const activated = success(await activation(ctx, handover), 'activation with baseline');
  const task = success(await ctx.tasks.getTaskStatus(ctx.task.code, ctx.users.target.code), 'task after activation');
  assert.deepEqual(task.requirement_baseline, ctx.baseline);
  assert.equal(task.runs.find(run => run.run_code === activated.run_code).principal_code, ctx.users.target.code);
});

test('handover: later baselines never rewrite a published handover or its requirement metadata', async () => {
  const ctx = await seededDb({ baseline: true });
  const prepared = await published(ctx);
  const original = await detail(ctx, prepared, ctx.identities.target);
  const request = { identity: ctx.identities.target, snapshot_code: original.context_snapshot_code };
  const frozen = success(await ctx.handovers.getContext(request), 'before revision');
  await ctx.db.insert(schema.requirementRevisions).values({ requirement_id: ctx.requirement.id, revision: 2,
    summary: 'New scope', acceptance_criteria: '[{"id":"AC-NEW","text":"New scope"}]', created_at: new Date().toISOString() });
  await ctx.db.update(schema.requirements).set({ current_revision: 2, title: 'Renamed future requirement' }).where(eq(schema.requirements.id, ctx.requirement.id));
  const next = success(await createRequirementBaselineUseCases(ctx.db).create({ projectCode: ctx.project.code, principalCode: ctx.users.owner.code,
    name: 'Future V2', scope: 'handover-v2', reason: 'Change the requirement target', parentBaselineCode: ctx.baseline.baseline_code,
    requirements: [{ requirement_code: ctx.requirement.code, revision: 2 }] }), 'next baseline');
  assert.notEqual(next.content_hash, ctx.baseline.content_hash);
  assert.deepEqual(success(await ctx.handovers.getContext(request), 'after revision'), frozen);
  const task = success(await ctx.tasks.getTaskStatus(ctx.task.code, ctx.users.source.code), 'task remains bound');
  assert.equal(task.requirement_baseline_code, ctx.baseline.baseline_code);
  assert.equal(task.requirement_title, ctx.baseline.requirements[0].title);
  assert.equal(task.requirement_body, 'Original requirement');
  assert.equal(task.requirement_source_changed, true);
  const drift = success(await ctx.handovers.diffContext({ identity: ctx.identities.target, handover_code: prepared.handover_code }), 'baseline drift');
  assert.ok(drift.changes.some(change => change.source === `baseline_requirement:${ctx.requirement.code}`));
  const denied = await createTaskBaselineUseCases(ctx.db).bind({ taskCode: ctx.task.code, baselineCode: next.baseline_code,
    principalCode: ctx.users.owner.code, baseSnapshot: task.base_snapshot });
  assert.equal(denied.ok, false);
});

test('handover: upstream revision drift blocks readiness without silently refreshing the package', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ctx.db.update(schema.requirements).set({ current_revision: 2 }).where(eq(schema.requirements.id, ctx.requirement.id));
  rejected(await ctx.handovers.ready({ identity: ctx.identities.target, handover_code: handover.handover_code,
    attempt_code: handover.attempt_code, workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' }), 'ready after requirement drift');
  const [target] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, handover.target_run_code));
  assert.equal(target.status, 'preparing');
});

test('handover: drift occurring after ready is checked again during activation', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  await ctx.db.update(schema.requirements).set({ current_revision: 2 }).where(eq(schema.requirements.id, ctx.requirement.id));
  rejected(await activation(ctx, handover), 'activate after drift');
  assert.equal((await ctx.db.select().from(schema.runs).where(and(eq(schema.runs.task_id, ctx.task.id), eq(schema.runs.status, 'active')))).length, 0);
});

test('handover: ready requires exact attempt, code snapshot and context hash', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  const command = { identity: ctx.identities.target, handover_code: handover.handover_code,
    attempt_code: handover.attempt_code, workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' };
  for (const override of [{ attempt_code: 'not-the-attempt' }, { snapshot_commit: BASE_COMMIT }, { context_snapshot_hash: '0'.repeat(64) }]) {
    rejected(await ctx.handovers.ready({ ...command, ...override }), 'mismatching readiness proof');
  }
  success(await ctx.handovers.ready(command), 'ready with matching client report');
});

test('handover: cancellation invalidates preparation grant and resume is explicit', async () => {
  const ctx = await seededDb();
  const prepared = await prepare(ctx);
  success(await ctx.handovers.cancel({ identity: ctx.identities.source, handover_code: prepared.handover_code }), 'cancel');
  const [suspended] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  assert.equal(suspended.status, 'suspended');
  rejected(await ctx.handovers.ackStop({ identity: ctx.identities.source, handover_code: prepared.handover_code,
    preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation' }), 'cancelled preparation grant');
  const resumed = success(await ctx.handovers.resume({ identity: ctx.identities.source, idempotencyKey: 'resume-1', run_code: ctx.sourceRun.code }), 'resume');
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  assert.equal(source.status, 'active');
  assert.ok(resumed.execution_epoch > prepared.source_epoch);
  assert.ok(resumed.lease);
});

test('handover: concurrent activation never creates two active Runs', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  const results = await Promise.all([activation(ctx, handover, 'activate-a'), activation(ctx, handover, 'activate-b')]);
  assert.ok(results.some((result) => result.ok), JSON.stringify(results));
  const active = await ctx.db.select().from(schema.runs).where(and(eq(schema.runs.task_id, ctx.task.id), eq(schema.runs.status, 'active')));
  assert.equal(active.length, 1);
  assert.equal(active[0].principal_id, ctx.users.target.id);
  const leases = await ctx.db.select().from(schema.runLeases).where(and(eq(schema.runLeases.run_id, active[0].id)));
  assert.equal(leases.filter((lease) => lease.revoked_at === null).length, 1);
});

test('handover: restore and activate retries reuse their original attempt and Run', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  const repeatedRestore = success(await ctx.handovers.restore({
    identity: ctx.identities.target,
    idempotencyKey: 'restore-1',
    handover_code: handover.handover_code,
    workspace_path: '/target/independent-worktree',
    git_base: SNAPSHOT_COMMIT,
  }), 'restore retry');
  assert.equal(repeatedRestore.attempt_code, handover.attempt_code);
  assert.equal(repeatedRestore.target_run_code, handover.target_run_code);
  await ready(ctx, handover);
  const first = success(await activation(ctx, handover), 'activation first');
  const repeated = success(await activation(ctx, handover), 'activation retry');
  assert.equal(repeated.run_code, first.run_code);
  assert.equal(repeated.execution_epoch, first.execution_epoch);
  assert.deepEqual(repeated.lease, first.lease, 'an activation retry must not rotate an unexpired lease');
  const [receipt] = await ctx.db.select().from(schema.commandReceipts).where(eq(schema.commandReceipts.operation, 'handover.activate'));
  assert.ok(receipt);
  assert.equal(receipt.result.includes(first.lease.lease_token), false, 'the replay receipt must not persist the bearer token');
  assert.equal((await ctx.db.select().from(schema.runs).where(eq(schema.runs.task_id, ctx.task.id))).length, 2);
});

test('handover: a ready receipt cannot be submitted by another device of the recipient', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  const [otherDevice] = await ctx.db.insert(schema.devices).values({
    principal_id: ctx.users.target.id,
    device_name: 'target-second-computer',
    credential_hash: 'fixture-target-second',
    created_at: new Date().toISOString(),
  }).returning();
  rejected(await ctx.handovers.ready({
    identity: { ...ctx.identities.target, deviceCode: otherDevice.code },
    handover_code: handover.handover_code,
    attempt_code: handover.attempt_code,
    workspace_digest: 'e'.repeat(64),
    snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash,
    assurance: 'client_reported',
  }), 'ready from another target device');
  assert.equal((await detail(ctx, handover, ctx.identities.target)).status, 'restoring');
});

test('handover: identical prepare retries are safe and reusing a key for another request is rejected', async () => {
  const ctx = await seededDb();
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  const command = { identity: ctx.identities.source, idempotencyKey: 'prepare-retry', task_code: task.code,
    source_run_code: ctx.sourceRun.code, target_user_code: ctx.users.target.code, base_snapshot: task.base_snapshot };
  const first = success(await ctx.handovers.prepare(command), 'prepare first');
  const second = success(await ctx.handovers.prepare(command), 'prepare retry');
  assert.equal(second.handover_code, first.handover_code);
  assert.equal(second.preparation_grant, first.preparation_grant, 'retry must not revoke the grant held by the first client');
  assert.equal((await ctx.db.select().from(schema.taskHandovers)).length, 1);
  rejected(await ctx.handovers.prepare({ ...command, target_user_code: ctx.users.observer.code }), 'changed prepare with same key');
});

test('handover: legacy authentication cannot prepare a device-bound transfer', async () => {
  const ctx = await seededDb();
  const [task] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  rejected(await ctx.handovers.prepare({ identity: { principalCode: ctx.users.source.code, authKind: 'legacy' },
    idempotencyKey: 'legacy-prepare', task_code: task.code, source_run_code: ctx.sourceRun.code,
    target_user_code: ctx.users.target.code, base_snapshot: task.base_snapshot }), 'legacy prepare');
  assert.equal((await ctx.db.select().from(schema.taskHandovers)).length, 0);
});

async function advanceRequirement(ctx, revision) {
  await ctx.db.insert(schema.requirementRevisions).values({
    requirement_id: ctx.requirement.id,
    revision,
    summary: `Requirement revision ${revision}`,
    acceptance_criteria: JSON.stringify([{ id: 'AC-NEW', text: `Changed at r${revision}` }]),
    created_at: new Date().toISOString(),
  });
  await ctx.db.update(schema.requirements).set({ current_revision: revision, title: `Changed requirement r${revision}` })
    .where(eq(schema.requirements.id, ctx.requirement.id));
}

test('handover: saving the draft retains prepare-time sources and does not approve upstream changes', async () => {
  const ctx = await seededDb();
  const prepared = await prepare(ctx);
  const initial = await detail(ctx, prepared);
  const original = success(await ctx.handovers.getContext({ identity: ctx.identities.source,
    snapshot_code: initial.context_snapshot_code }), 'prepare context');
  await advanceRequirement(ctx, 2);
  await draft(ctx, prepared);
  const saved = await detail(ctx, prepared);
  const drafted = success(await ctx.handovers.getContext({ identity: ctx.identities.source,
    snapshot_code: saved.context_snapshot_code }), 'draft context');
  assert.deepEqual(drafted.manifest.sources, original.manifest.sources);
  assert.deepEqual(drafted.material_revision_vector, original.material_revision_vector);
  assert.equal(drafted.manifest.sources.find((source) => source.kind === 'requirement').revision, 1);
  assert.deepEqual(drafted.summary, ctx.summary);
  success(await ctx.handovers.ackStop({ identity: ctx.identities.source, handover_code: prepared.handover_code,
    preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation' }), 'stop source');
  const error = rejected(await ctx.handovers.publish({ identity: ctx.identities.owner,
    handover_code: prepared.handover_code }), 'publish stale draft');
  assert.equal(error.code, 'context_source_changed');
  assert.equal((await detail(ctx, prepared)).status, 'preparing');
});

test('handover: Owner drift approval applies only to the explicitly reviewed source versions', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await advanceRequirement(ctx, 2);
  rejected(await ctx.handovers.ready({ identity: ctx.identities.target, handover_code: handover.handover_code,
    attempt_code: handover.attempt_code, workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' }), 'ready before approval');
  rejected(await ctx.handovers.approveDrift({ identity: ctx.identities.target, handover_code: handover.handover_code,
    reason: 'I would like to continue' }), 'recipient approving their own drift');
  const approved = success(await ctx.handovers.approveDrift({ identity: ctx.identities.owner,
    handover_code: handover.handover_code, reason: 'Finish the existing r1 contract; r2 is a separate task.' }), 'Owner drift approval');
  assert.equal(approved.drift_approval.actor_code, ctx.users.owner.code);
  assert.equal(approved.context_snapshot_hash, handover.context_snapshot_hash);
  await ready(ctx, handover);
  await advanceRequirement(ctx, 3);
  const error = rejected(await activation(ctx, handover), 'activation after another upstream change');
  assert.equal(error.code, 'context_source_changed');
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  assert.equal(source.status, 'suspended');
});

test('handover: expiry blocks activation and never automatically resumes the source Run', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  await ctx.db.update(schema.taskHandovers).set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .where(eq(schema.taskHandovers.code, handover.handover_code));
  rejected(await activation(ctx, handover), 'expired activation');
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  const [target] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, handover.target_run_code));
  assert.equal(source.status, 'suspended');
  assert.equal(target.status, 'cancelled');
  assert.equal((await detail(ctx, handover, ctx.identities.owner)).status, 'expired');
  const cancelled = success(await ctx.handovers.cancel({ identity: ctx.identities.owner,
    handover_code: handover.handover_code }), 'resolve expired handover');
  assert.equal(cancelled.status, 'expired');
  assert.equal((await ctx.db.select().from(schema.runs).where(and(eq(schema.runs.task_id, ctx.task.id),
    eq(schema.runs.status, 'active')))).length, 0);
});

test('handover: removed project membership invalidates an existing restoration attempt', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ctx.db.delete(schema.members).where(and(eq(schema.members.project_id, ctx.project.id),
    eq(schema.members.principal_id, ctx.users.target.id)));
  const error = rejected(await ctx.handovers.ready({ identity: ctx.identities.target, handover_code: handover.handover_code,
    attempt_code: handover.attempt_code, workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
    context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' }), 'revoked member ready');
  assert.equal(error.code, 'handover_forbidden');
  assert.equal((await detail(ctx, handover, ctx.identities.owner)).status, 'restoring');
});

test('handover: a revoked device cannot activate a previously ready Run', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  await ctx.db.delete(schema.devices).where(eq(schema.devices.id, ctx.devices.target.id));
  const error = rejected(await activation(ctx, handover), 'revoked device activation');
  assert.equal(error.code, 'handover_forbidden');
  assert.equal((await detail(ctx, handover, ctx.identities.owner)).status, 'ready');
  assert.equal((await ctx.db.select().from(schema.runLeases)).length, 0);
});

test('handover: the target submit path requires its current lease and preserves both authors', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  await ready(ctx, handover);
  const activated = success(await activation(ctx, handover), 'activate');
  const command = {
    taskCode: ctx.task.code,
    runCode: activated.run_code,
    principalCode: ctx.users.target.code,
    baseSnapshot: activated.base_snapshot,
    artifact: { kind: 'commit', uri: `git:${SNAPSHOT_COMMIT}`, contentHash: 'f'.repeat(64) },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1', 'AC-2'], command: 'pnpm test' },
  };
  const error = rejected(await ctx.tasks.submitTask(command), 'target submit without lease');
  assert.equal(error.code, 'execution_lease_invalid');
  assert.equal((await ctx.db.select().from(schema.artifacts)).length, 0);
  const submitted = success(await ctx.tasks.submitTask({ ...command, deviceCode: ctx.devices.target.code,
    executionEpoch: activated.execution_epoch, leaseToken: activated.lease.lease_token }), 'target submit with lease');
  assert.equal(submitted.status, 'submitted');
  const [source] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.id, ctx.sourceRun.id));
  const [target] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, activated.run_code));
  assert.equal(source.principal_id, ctx.users.source.id);
  assert.equal(source.status, 'transferred');
  assert.equal(target.principal_id, ctx.users.target.id);
  assert.equal(target.status, 'completed');
  const [evidence] = await ctx.db.select().from(schema.evidences);
  assert.equal(evidence.run_id, target.id);
  assert.deepEqual(JSON.parse(evidence.acceptance_refs), ['AC-1', 'AC-2']);
});

test('handover: the material statement trigger fences real concurrent writes until the context reader commits', async () => {
  const ctx = await seededDb();
  const handover = await restored(ctx);
  const reader = await ctx.db.$client.connect();
  const writer = await ctx.db.$client.connect();
  let readerTransaction = false;
  let writerTransaction = false;
  let pendingWrite;
  try {
    const installed = await reader.query(`
      select rel.relname as table_name, t.tgtype, t.tgenabled
      from pg_trigger t
      join pg_class rel on rel.oid = t.tgrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_proc proc on proc.oid = t.tgfoid
      where ns.nspname = 'public'
        and t.tgname = 'acp_context_material_fence'
        and proc.proname = 'acp_lock_context_materials'
        and not t.tgisinternal
      order by rel.relname
    `);
    assert.deepEqual(installed.rows.map((row) => row.table_name), [
      'design_prototype_revisions', 'design_prototypes', 'project_document_folders', 'project_document_revisions', 'project_documents',
      'project_repositories', 'projects', 'requirement_document_revisions', 'requirement_documents',
      'requirement_revisions', 'requirement_topic_entries', 'requirement_topics', 'requirements',
    ]);
    assert.equal(installed.rows.length, 13);
    for (const trigger of installed.rows) {
      assert.equal(trigger.tgtype, 30, `${trigger.table_name} must use BEFORE STATEMENT INSERT/UPDATE/DELETE`);
      assert.equal(trigger.tgenabled, 'O');
    }

    await reader.query('begin');
    readerTransaction = true;
    await reader.query('select pg_advisory_xact_lock_shared(1094930512::bigint)');
    const baseline = await reader.query('select current_revision from requirements where id = $1', [ctx.requirement.id.toString()]);
    assert.equal(baseline.rows[0].current_revision, 1);
    const readerPid = (await reader.query('select pg_backend_pid() as pid')).rows[0].pid;

    await writer.query('begin');
    writerTransaction = true;
    await writer.query("set local statement_timeout = '15000ms'");
    const writerPid = (await writer.query('select pg_backend_pid() as pid')).rows[0].pid;
    const exclusiveProbe = await writer.query('select pg_try_advisory_xact_lock(1094930512::bigint) as acquired');
    assert.equal(exclusiveProbe.rows[0].acquired, false, 'the material writer lock must conflict with the context read lock');

    let writeSettled = false;
    pendingWrite = writer.query('update requirements set current_revision = 2 where id = $1 returning current_revision',
      [ctx.requirement.id.toString()]).then(
      (value) => { writeSettled = true; return { value }; },
      (error) => { writeSettled = true; return { error }; },
    );
    // Wait for PostgreSQL to report the actual UPDATE waiting in the trigger.
    // This observes a database barrier, rather than assuming a slow UPDATE after a fixed sleep.
    let waiting = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const lock = await reader.query(`
        select pg_blocking_pids($1::integer) as blockers
        from pg_locks
        where pid = $1::integer and locktype = 'advisory'
          and objid = 1094930512::oid and not granted
      `, [writerPid]);
      if (lock.rows.some((row) => row.blockers.includes(readerPid))) {
        waiting = true;
        break;
      }
      assert.equal(writeSettled, false, 'the real material UPDATE must not finish while the shared lock is held');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'PostgreSQL must report the UPDATE blocked by the context reader');
    assert.equal(writeSettled, false);
    const unchanged = await reader.query('select current_revision from requirements where id = $1', [ctx.requirement.id.toString()]);
    assert.equal(unchanged.rows[0].current_revision, 1);

    await reader.query('commit');
    readerTransaction = false;
    const written = await pendingWrite;
    assert.equal(written.error, undefined, written.error?.message);
    assert.equal(written.value.rows[0].current_revision, 2);
    await writer.query('commit');
    writerTransaction = false;

    const drift = rejected(await ctx.handovers.ready({ identity: ctx.identities.target,
      handover_code: handover.handover_code, attempt_code: handover.attempt_code,
      workspace_digest: 'e'.repeat(64), snapshot_commit: SNAPSHOT_COMMIT,
      context_snapshot_hash: handover.context_snapshot_hash, assurance: 'client_reported' }),
    'ready after the serialized material update');
    assert.equal(drift.code, 'context_source_changed');
  } finally {
    // Release the barrier before awaiting the writer, including assertion failures.
    if (readerTransaction) await reader.query('rollback');
    if (pendingWrite) await pendingWrite;
    if (writerTransaction) await writer.query('rollback');
    reader.release();
    writer.release();
  }
});

test('handover preparation retains its device and signed grant across session logout/relogin and rejects device revocation', async () => {
  const ctx = await seededDb();
  const auth = createAuthUseCases(ctx.db);
  const legacyToken = 'source-original-bearer';
  await ctx.db.update(schema.devices).set({ credential_hash: hashToken(legacyToken) }).where(eq(schema.devices.id, ctx.devices.source.id));
  await ctx.db.update(schema.users).set({ password_hash: await hashPassword('SourcePassword123!') }).where(eq(schema.users.id, ctx.users.source.id));
  const identity = { installation_id: randomUUID(), installation_secret: randomBytes(32).toString('base64url'), client_type: 'cli', platform: 'win32' };
  success(await auth.bindIdentity(legacyToken, identity), 'bind existing installation');
  const [before] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.id, ctx.task.id));
  const prepared = await prepare(ctx);
  const login = success(await auth.loginWithPassword('source', 'SourcePassword123!', 'Source computer', identity), 'relogin');
  assert.equal(login.device_code, ctx.devices.source.code);
  success(await auth.logout(legacyToken), 'logout original session');
  const retry = await prepare(ctx, { base_snapshot: before.base_snapshot });
  assert.equal(retry.preparation_grant, prepared.preparation_grant);
  await draft(ctx, retry);
  success(await auth.revokeDevice(login.device_code), 'revoke installation');
  const denied = await ctx.handovers.ackStop({ identity: ctx.identities.source, handover_code: prepared.handover_code, preparation_grant: prepared.preparation_grant, stopped: true, assurance: 'manual_confirmation' });
  assert.equal(rejected(denied, 'revoked preparation').code, 'handover_forbidden');
});
