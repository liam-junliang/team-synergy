import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { buildServer } from '../dist/server.js';
import {
  closeTestDb,
  insertFeature,
  insertProjectMilestone,
  insertProjectModule,
  insertProjectPhase,
  insertProject,
  insertProjectMember,
  insertTeam,
  insertTeamMember,
  insertUser,
  openTestDb,
  publicCode,
} from './test-db.mjs';

const fixtures = [];
let fixtureSequence = 0;

async function createFixture() {
  const db = await openTestDb();
  const app = await buildServer({ db, logger: false });
  const createdAt = '2026-08-13T00:00:00.000Z';
  const codeOffset = fixtureSequence * 1000;
  fixtureSequence += 1;

  const owner = await insertUser(db, {
    code: publicCode(codeOffset + 1),
    account: `owner.${codeOffset}`,
    display_name: 'Owner',
    status: 'active',
    created_at: createdAt,
  });
  const builder = await insertUser(db, {
    code: publicCode(codeOffset + 2),
    account: `builder.${codeOffset}`,
    display_name: 'Builder',
    status: 'active',
    created_at: createdAt,
  });
  const verifier = await insertUser(db, {
    code: publicCode(codeOffset + 3),
    account: `verifier.${codeOffset}`,
    display_name: 'Verifier',
    status: 'active',
    created_at: createdAt,
  });
  const other = await insertUser(db, {
    code: publicCode(codeOffset + 4),
    account: `other.${codeOffset}`,
    display_name: 'Other',
    status: 'active',
    created_at: createdAt,
  });

  const team = await insertTeam(db, {
    code: publicCode(codeOffset + 11),
    name: `Primary Team ${codeOffset}`,
    created_at: createdAt,
  });
  for (const [principal, role] of [[owner, 'owner'], [builder, 'member'], [verifier, 'member']]) {
    await insertTeamMember(db, {
      team_id: team.id,
      principal_id: principal.id,
      role,
      display_name: principal.display_name,
      created_at: createdAt,
    });
  }

  const project = await insertProject(db, {
    code: publicCode(codeOffset + 21),
    team_id: team.id,
    name: `Core API Project ${codeOffset}`,
    current_snapshot: 1,
    created_at: createdAt,
  });
  for (const [principal, role] of [[owner, 'owner'], [builder, 'member'], [verifier, 'member']]) {
    await insertProjectMember(db, {
      principal_id: principal.id,
      project_id: project.id,
      role,
      display_name: principal.display_name,
      created_at: createdAt,
    });
  }

  const feature = await insertFeature(db, {
    code: publicCode(codeOffset + 31),
    project_id: project.id,
    title: 'HTTP Feature',
    status: 'active',
  });

  const fixture = { app, db, owner, builder, verifier, other, team, project, feature };
  fixtures.push(fixture);
  return fixture;
}

async function getTask(app, taskCode, principalCode = '') {
  const response = await app.inject({
    method: 'GET',
    url: `/tasks/${taskCode}`,
    headers: principalCode ? { 'x-principal-code': principalCode } : {},
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true, response.body);
  return response.json().data;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture.app.close();
    await closeTestDb(fixture.db);
  }
});

test('task routes enforce the public-code HTTP contract across create, assign, claim, submit, verify, close, and history', async () => {
  const { app, owner, builder, verifier, feature } = await createFixture();

  const created = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-principal-code': owner.code },
    payload: {
      task_code: publicCode(999),
      feature_code: feature.code,
      title: 'Implement route contract',
      brief: 'Original brief',
      profile: 'builder',
      source: 'requirement',
      acceptance: [{ id: 'AC-1', text: 'Contract passes' }],
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().ok, true, created.body);
  assert.notEqual(created.json().data.task_code, publicCode(999));
  assert.equal(created.json().data.status, 'draft');
  assert.equal(Object.hasOwn(created.json().data, 'task_id'), false);
  const taskCode = created.json().data.task_code;

  const patchedContract = await app.inject({
    method: 'PATCH',
    url: `/tasks/${taskCode}/contract`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      base_snapshot: 0,
      title: 'Implement route contract v2',
      brief: 'Stable brief',
      acceptance: [{ id: 'AC-1', text: 'Contract passes' }],
      validation_seams: ['api'],
      scope: { writable_paths: ['apps/core-api/**'] },
    },
  });
  assert.equal(patchedContract.json().ok, true, patchedContract.body);
  assert.equal(patchedContract.json().data.brief, 'Stable brief');
  assert.equal(patchedContract.json().data.requirement_title, null);

  const assigned = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/assign`,
    headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: builder.code, base_snapshot: patchedContract.json().data.base_snapshot },
  });
  assert.equal(assigned.json().ok, true, assigned.body);
  assert.equal(assigned.json().data.assignee_principal_code, builder.code);

  const claimed = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(41),
      workspace_code: publicCode(42),
      profile: 'builder',
      base_snapshot: assigned.json().data.base_snapshot,
      workspace_path: 'C:/tmp/acp-claim',
      git_base: 'abc123',
    },
  });
  assert.equal(claimed.json().ok, true, claimed.body);
  assert.deepEqual(claimed.json().data, {
    task_code: taskCode,
    run_code: publicCode(41),
    workspace_code: publicCode(42),
    status: 'running',
  });

  const submitted = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/submit`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(41),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      artifact: { kind: 'commit', uri: 'git:commit', content_hash: 'sha-task' },
      evidence: { type: 'self_test', result: 'pass', acceptance_refs: ['AC-1'], command: 'node --test' },
    },
  });
  assert.equal(submitted.json().ok, true, submitted.body);
  assert.equal(submitted.json().data.status, 'submitted');

  const lockedContract = await app.inject({
    method: 'PATCH',
    url: `/tasks/${taskCode}/contract`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      title: 'Should fail',
      brief: 'Should fail',
      acceptance: [{ id: 'AC-1', text: 'Contract passes' }],
    },
  });
  assert.equal(lockedContract.json().ok, false, lockedContract.body);
  assert.equal(lockedContract.json().error.code, 'task_contract_locked');

  const verificationClaim = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(43),
      workspace_code: publicCode(44),
      profile: 'verifier',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-verify',
      git_base: 'abc123',
    },
  });
  assert.equal(verificationClaim.json().ok, true, verificationClaim.body);
  assert.deepEqual(verificationClaim.json().data, {
    task_code: taskCode,
    run_code: publicCode(43),
    workspace_code: publicCode(44),
    status: 'submitted',
    verification_run: true,
  });

  const verified = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/verify`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(43),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      evidence: { result: 'pass', acceptance_refs: ['AC-1'], summary: 'Verified' },
    },
  });
  assert.equal(verified.json().ok, true, verified.body);
  assert.equal(verified.json().data.status, 'verified');

  const closed = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/close`,
    headers: { 'x-principal-code': owner.code },
    payload: { base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot },
  });
  assert.equal(closed.json().ok, true, closed.body);
  assert.equal(closed.json().data.status, 'closed');

  const history = await app.inject({ method: 'GET', url: `/tasks/${taskCode}/history`, headers: { 'x-principal-code': owner.code } });
  assert.equal(history.json().ok, true, history.body);
  const actions = history.json().data.map((event) => event.action);
  for (const action of [
    'task.created',
    'task.assigned',
    'task.claimed',
    'task.self_tested',
    'task.submitted',
    'task.verification_claimed',
    'task.verified',
    'task.closed',
  ]) {
    assert.ok(actions.includes(action), `history missing ${action}: ${actions.join(', ')}`);
  }
});

test('requirement document and requirement routes return public-code payloads and enforce owner-only edits', async () => {
  const { app, db, owner, builder, project, feature } = await createFixture();

  const module = await app.inject({ method: 'POST', url: `/projects/${project.code}/modules`, headers: { 'x-principal-code': owner.code }, payload: { name: 'AUTH' } });
  assert.equal(module.json().ok, true, module.body);

  const document = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/requirement-documents`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      document_code: publicCode(901),
      module_key: 'AUTH',
      title: 'Auth requirements',
      summary: 'Login and password rules',
      content: '# Auth\n\n## Background\n\n## Rules\n',
      keywords: ['login', 'password'],
    },
  });
  assert.equal(document.json().ok, true, document.body);
  assert.notEqual(document.json().data.document_code, publicCode(901));
  assert.equal(document.json().data.project_code, project.code);
  assert.equal(document.json().data.owner_principal_code, builder.code);
  const documentCode = document.json().data.document_code;

  const requirement = await app.inject({
    method: 'POST',
    url: '/requirements',
    headers: { 'x-principal-code': builder.code },
    payload: {
      requirement_code: publicCode(902),
      feature_code: feature.code,
      document_code: documentCode,
      title: 'Force password change',
      body: 'Initial password must be changed before any protected route.',
      acceptance_criteria: [{ id: 'AC-1', text: 'Protected routes are blocked until password change' }],
      open_questions: [],
      status: 'draft',
    },
  });
  assert.equal(requirement.json().ok, true, requirement.body);
  assert.notEqual(requirement.json().data.requirement_code, publicCode(902));
  assert.equal(requirement.json().data.feature_code, feature.code);
  assert.equal(requirement.json().data.document_code, documentCode);
  const requirementCode = requirement.json().data.requirement_code;

  await db.insert(schema.tasks).values({
    code: publicCode(45),
    feature_id: feature.id,
    requirement_id: (await db.select().from(schema.requirements).where(eq(schema.requirements.code, requirementCode)).limit(1))[0].id,
    title: 'Build password gate',
    profile: 'builder',
    source: 'requirement',
    status: 'running',
    assignee_principal_id: builder.id,
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Protected routes are blocked until password change' }]),
    base_snapshot: 1,
    created_at: '2026-08-13T01:00:00.000Z',
  });

  const detail = await app.inject({
    method: 'GET',
    url: `/requirements/${requirementCode}`,
    headers: { 'x-principal-code': owner.code },
  });
  assert.equal(detail.json().ok, true, detail.body);
  assert.equal(detail.json().data.requirement_code, requirementCode);
  assert.equal(detail.json().data.tasks[0].task_code, publicCode(45));
  assert.equal(detail.json().data.tasks[0].assignee_principal_code, builder.code);
  assert.equal(detail.json().data.can_edit, true);

  const denied = await app.inject({
    method: 'PATCH',
    url: `/requirements/${requirementCode}`,
    headers: { 'x-principal-code': builder.code },
    payload: { title: 'Builder edit', body: 'Should fail' },
  });
  assert.equal(denied.json().ok, false, denied.body);
  assert.equal(denied.json().error.code, 'requirement_forbidden');

  const updated = await app.inject({
    method: 'PATCH',
    url: `/requirements/${requirementCode}`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      title: 'Owner updated title',
      body: 'Owner updated body',
      acceptance_criteria: [{ id: 'AC-1', text: 'Owner can revise' }],
      open_questions: [],
    },
  });
  assert.equal(updated.json().ok, true, updated.body);
  assert.equal(updated.json().data.current_revision, 2);

  const confirmed = await app.inject({
    method: 'POST',
    url: `/requirements/${requirementCode}/transition`,
    headers: { 'x-principal-code': owner.code },
    payload: { status: 'confirmed' },
  });
  assert.equal(confirmed.json().ok, true, confirmed.body);
  assert.equal(confirmed.json().data.status, 'confirmed');

  const list = await app.inject({
    method: 'GET',
    url: `/projects/${project.code}/requirement-documents?q=password`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(list.json().ok, true, list.body);
  assert.equal(list.json().data[0].document_code, documentCode);

  const revisedDocument = await app.inject({
    method: 'PATCH',
    url: `/requirement-documents/${documentCode}`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      module_key: 'AUTH',
      title: 'Auth requirements revised',
      summary: 'Updated summary',
      content: '# Auth\n\n## Background\n\n## Rules\n\nPassword change required.\n',
      keywords: ['login', 'password', 'security'],
      change_summary: 'Add password change rule',
    },
  });
  assert.equal(revisedDocument.json().ok, true, revisedDocument.body);
  assert.equal(revisedDocument.json().data.current_revision, 2);

  const documentDetail = await app.inject({
    method: 'GET',
    url: `/requirement-documents/${documentCode}`,
    headers: { 'x-principal-code': owner.code },
  });
  assert.equal(documentDetail.json().ok, true, documentDetail.body);
  assert.deepEqual(documentDetail.json().data.linked_requirements.map((item) => item.requirement_code), [requirementCode]);
  assert.deepEqual(documentDetail.json().data.revisions.map((item) => item.revision), [2, 1]);
});

test('requirement topic entries accept image attachments and return them in the timeline', async () => {
  const { app, owner, project } = await createFixture();
  const topic = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/requirement-topics`,
    headers: { 'x-principal-code': owner.code },
    payload: { title: '截图讨论', problem_statement: '需要结合界面截图说明问题' },
  });
  assert.equal(topic.json().ok, true, topic.body);
  const topicCode = topic.json().data.topic_code;
  const entry = await app.inject({
    method: 'POST',
    url: `/requirement-topics/${topicCode}/entries`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      entry_type: 'comment',
      content: '导航栏在窄屏下发生遮挡。',
      images: [{ file_name: 'navigation.png', data_url: 'data:image/png;base64,iVBORw0KGgo=' }],
    },
  });
  assert.equal(entry.json().ok, true, entry.body);
  assert.equal(entry.json().data.images[0].file_name, 'navigation.png');
  const detail = await app.inject({
    method: 'GET',
    url: `/requirement-topics/${topicCode}`,
    headers: { 'x-principal-code': owner.code },
  });
  assert.equal(detail.json().ok, true, detail.body);
  assert.equal(detail.json().data.entries[0].images[0].mime_type, 'image/png');
  assert.match(detail.json().data.entries[0].images[0].image_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  const withdrawal = await app.inject({
    method: 'POST',
    url: `/requirement-topic-entries/${entry.json().data.entry_code}/withdraw`,
    headers: { 'x-principal-code': owner.code },
    payload: { reason: '测试记录已完成验证' },
  });
  assert.equal(withdrawal.json().ok, true, withdrawal.body);
  const withdrawnDetail = await app.inject({ method: 'GET', url: `/requirement-topics/${topicCode}`, headers: { 'x-principal-code': owner.code } });
  assert.equal(withdrawnDetail.json().data.entries[0].content, '');
  assert.deepEqual(withdrawnDetail.json().data.entries[0].images, []);
  assert.equal(withdrawnDetail.json().data.entries[0].withdrawal_reason, '测试记录已完成验证');
});

test('handoff routes expose nested folders, API documents, search and immutable revisions', async () => {
  const { app, owner, builder, other, project } = await createFixture();

  const integrationFolder = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/handoff/folders`,
    headers: { 'x-principal-code': builder.code },
    payload: { name: '接口与联调' },
  });
  assert.equal(integrationFolder.json().ok, true, integrationFolder.body);
  const integrationFolderCode = integrationFolder.json().data.folder_code;

  const frontendBackendFolder = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/handoff/folders`,
    headers: { 'x-principal-code': builder.code },
    payload: { name: '前后端对接', parent_folder_code: integrationFolderCode },
  });
  assert.equal(frontendBackendFolder.json().ok, true, frontendBackendFolder.body);
  const frontendBackendFolderCode = frontendBackendFolder.json().data.folder_code;

  const created = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/handoff/documents`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      folder_code: frontendBackendFolderCode,
      kind: 'api',
      title: 'Web 与 Core API 登录约定',
      summary: '登录请求、响应结构和错误码。',
      content: '# 登录接口\n\n## 请求\n\n`POST /auth/login`\n\n## 错误码\n\n- unauthorized',
    },
  });
  assert.equal(created.json().ok, true, created.body);
  assert.equal(created.json().data.kind, 'api');
  const documentCode = created.json().data.document_code;

  const library = await app.inject({
    method: 'GET',
    url: `/projects/${project.code}/handoff?q=错误码`,
    headers: { 'x-principal-code': owner.code },
  });
  assert.equal(library.json().ok, true, library.body);
  assert.deepEqual(library.json().data.folders.map((folder) => folder.name), ['项目规范', '需求文档', '架构设计', '测试资料', '接口与联调', '前后端对接']);
  assert.deepEqual(library.json().data.documents.map((document) => document.document_code), [documentCode]);

  const revised = await app.inject({
    method: 'PATCH',
    url: `/handoff-documents/${documentCode}`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      folder_code: frontendBackendFolderCode,
      kind: 'api',
      title: 'Web 与 Core API 身份接口约定',
      summary: '登录、首次改密及错误码。',
      content: '# 身份接口\n\n## 登录\n\n`POST /auth/login`\n\n## 首次改密\n\n`POST /auth/password-change`',
      change_summary: '补充首次改密接口',
    },
  });
  assert.equal(revised.json().ok, true, revised.body);
  assert.deepEqual(revised.json().data.revisions.map((revision) => revision.revision), [2, 1]);
  assert.equal(revised.json().data.revisions[1].content.includes('首次改密'), false);

  const forbidden = await app.inject({
    method: 'GET',
    url: `/handoff-documents/${documentCode}`,
    headers: { 'x-principal-code': other.code },
  });
  assert.equal(forbidden.json().ok, false, forbidden.body);
  assert.equal(forbidden.json().error.code, 'project_document_forbidden');
});

test('team and project routes create generated codes, enforce ownership, persist personal order, and filter by public codes', async () => {
  const { app, owner, builder, other, team, project } = await createFixture();

  const createdTeam = await app.inject({
    method: 'POST',
    url: '/teams',
    headers: { 'x-principal-code': builder.code },
    payload: { team_code: publicCode(903), name: 'Builder Team' },
  });
  assert.equal(createdTeam.json().ok, true, createdTeam.body);
  assert.notEqual(createdTeam.json().data.team_code, publicCode(903));
  const builderTeamCode = createdTeam.json().data.team_code;

  const createdProject = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { 'x-principal-code': builder.code },
    payload: { project_code: publicCode(904), team_code: builderTeamCode, name: 'Builder Project', description: 'Builder 项目简介' },
  });
  assert.equal(createdProject.json().ok, true, createdProject.body);
  assert.notEqual(createdProject.json().data.project_code, publicCode(904));
  const builderProjectCode = createdProject.json().data.project_code;

  const secondProject = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { 'x-principal-code': builder.code },
    payload: { team_code: builderTeamCode, name: 'Builder Project Two' },
  });
  assert.equal(secondProject.json().ok, true, secondProject.body);
  const secondProjectCode = secondProject.json().data.project_code;

  const reorderedTeams = await app.inject({
    method: 'PUT',
    url: '/teams/order',
    headers: { 'x-principal-code': builder.code },
    payload: { team_codes: [builderTeamCode, team.code] },
  });
  assert.equal(reorderedTeams.json().ok, true, reorderedTeams.body);
  const listedTeams = await app.inject({
    method: 'GET',
    url: '/teams',
    headers: { 'x-principal-code': builder.code },
  });
  assert.deepEqual(listedTeams.json().data.map((item) => item.team_code), [builderTeamCode, team.code]);

  const reorderedProjects = await app.inject({
    method: 'PUT',
    url: '/projects/order',
    headers: { 'x-principal-code': builder.code },
    payload: { team_code: builderTeamCode, project_codes: [secondProjectCode, builderProjectCode] },
  });
  assert.equal(reorderedProjects.json().ok, true, reorderedProjects.body);

  const addedTeamMember = await app.inject({
    method: 'POST',
    url: `/teams/${builderTeamCode}/members`,
    headers: { 'x-principal-code': builder.code },
    payload: { user_code: other.code, role: 'member' },
  });
  assert.equal(addedTeamMember.json().ok, true, addedTeamMember.body);
  assert.equal(addedTeamMember.json().data.user_code, other.code);

  const renamedTeam = await app.inject({
    method: 'PATCH',
    url: `/teams/${builderTeamCode}`,
    headers: { 'x-principal-code': builder.code },
    payload: { name: 'Builder Team Renamed' },
  });
  assert.equal(renamedTeam.json().ok, true, renamedTeam.body);
  assert.equal(renamedTeam.json().data.name, 'Builder Team Renamed');

  const forbiddenRename = await app.inject({
    method: 'PATCH',
    url: `/teams/${builderTeamCode}`,
    headers: { 'x-principal-code': other.code },
    payload: { name: 'Forbidden' },
  });
  assert.equal(forbiddenRename.json().ok, false, forbiddenRename.body);
  assert.equal(forbiddenRename.json().error.code, 'team_forbidden');

  const ownerPromotionRejected = await app.inject({
    method: 'PATCH',
    url: `/teams/${builderTeamCode}/members/${other.code}`,
    headers: { 'x-principal-code': builder.code },
    payload: { role: 'owner' },
  });
  assert.equal(ownerPromotionRejected.json().ok, false, ownerPromotionRejected.body);
  assert.equal(ownerPromotionRejected.json().error.code, 'member_role_invalid');
  const promotedTeamMember = await app.inject({
    method: 'PATCH',
    url: `/teams/${builderTeamCode}/members/${other.code}`,
    headers: { 'x-principal-code': builder.code },
    payload: { role: 'admin' },
  });
  assert.equal(promotedTeamMember.json().ok, true, promotedTeamMember.body);
  assert.equal(promotedTeamMember.json().data.role, 'admin');

  const addedProjectMember = await app.inject({
    method: 'POST',
    url: `/projects/${builderProjectCode}/members`,
    headers: { 'x-principal-code': builder.code },
    payload: { user_code: other.code, role: 'member' },
  });
  assert.equal(addedProjectMember.json().ok, true, addedProjectMember.body);
  assert.equal(addedProjectMember.json().data.user_code, other.code);

  const forbiddenProjectRename = await app.inject({
    method: 'PATCH',
    url: `/projects/${builderProjectCode}`,
    headers: { 'x-principal-code': other.code },
    payload: { name: 'Forbidden Project Name' },
  });
  assert.equal(forbiddenProjectRename.json().ok, false, forbiddenProjectRename.body);
  assert.equal(forbiddenProjectRename.json().error.code, 'project_forbidden');

  const renamedProject = await app.inject({
    method: 'PATCH',
    url: `/projects/${builderProjectCode}`,
    headers: { 'x-principal-code': builder.code },
    payload: { name: 'Builder Project Renamed', description: '用于交付协作。' },
  });
  assert.equal(renamedProject.json().ok, true, renamedProject.body);
  assert.equal(renamedProject.json().data.project_code, builderProjectCode);
  assert.equal(renamedProject.json().data.name, 'Builder Project Renamed');
  assert.equal(renamedProject.json().data.description, '用于交付协作。');
  assert.equal(Object.hasOwn(renamedProject.json().data, 'project_id'), false);

  const forbiddenArchive = await app.inject({
    method: 'PATCH',
    url: `/projects/${builderProjectCode}/status`,
    headers: { 'x-principal-code': other.code },
    payload: { status: 'archived' },
  });
  assert.equal(forbiddenArchive.json().ok, false, forbiddenArchive.body);
  assert.equal(forbiddenArchive.json().error.code, 'project_forbidden');

  const archivedProject = await app.inject({
    method: 'PATCH',
    url: `/projects/${builderProjectCode}/status`,
    headers: { 'x-principal-code': builder.code },
    payload: { status: 'archived' },
  });
  assert.equal(archivedProject.json().ok, true, archivedProject.body);
  assert.equal(archivedProject.json().data.status, 'archived');

  const restoredProject = await app.inject({
    method: 'PATCH',
    url: `/projects/${builderProjectCode}/status`,
    headers: { 'x-principal-code': builder.code },
    payload: { status: 'active' },
  });
  assert.equal(restoredProject.json().ok, true, restoredProject.body);
  assert.equal(restoredProject.json().data.status, 'active');

  const forbiddenRepository = await app.inject({
    method: 'POST',
    url: `/projects/${builderProjectCode}/repositories`,
    headers: { 'x-principal-code': other.code },
    payload: { name: 'Forbidden', remote_url: 'git@example.com:team/forbidden.git' },
  });
  assert.equal(forbiddenRepository.json().ok, false, forbiddenRepository.body);
  assert.equal(forbiddenRepository.json().error.code, 'project_repository_forbidden');

  const createdRepository = await app.inject({
    method: 'POST',
    url: `/projects/${builderProjectCode}/repositories`,
    headers: { 'x-principal-code': builder.code },
    payload: { name: '管理端 Web', purpose: '项目工作台', remote_url: 'git@example.com:team/web.git', default_branch: 'main' },
  });
  assert.equal(createdRepository.json().ok, true, createdRepository.body);
  assert.match(createdRepository.json().data.repository_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  const repositoryCode = createdRepository.json().data.repository_code;

  const listedRepositories = await app.inject({
    method: 'GET',
    url: `/projects/${builderProjectCode}/repositories`,
    headers: { 'x-principal-code': other.code },
  });
  assert.equal(listedRepositories.json().ok, true, listedRepositories.body);
  assert.deepEqual(listedRepositories.json().data.map((item) => ({ code: item.repository_code, can_manage: item.can_manage })), [
    { code: repositoryCode, can_manage: false },
  ]);

  const registeredWorkspace = await app.inject({
    method: 'POST',
    url: `/projects/${builderProjectCode}/workspaces`,
    headers: { 'x-principal-code': other.code },
    payload: { name: 'Other 产品工作空间', path: 'C:/must-not-persist' },
  });
  assert.equal(registeredWorkspace.json().ok, true, registeredWorkspace.body);
  assert.equal(Object.hasOwn(registeredWorkspace.json().data, 'path'), false);

  const archivedRepository = await app.inject({
    method: 'PATCH',
    url: `/repositories/${repositoryCode}`,
    headers: { 'x-principal-code': builder.code },
    payload: { status: 'archived' },
  });
  assert.equal(archivedRepository.json().ok, true, archivedRepository.body);
  assert.equal(archivedRepository.json().data.status, 'archived');

  const forbiddenDocument = await app.inject({
    method: 'PUT',
    url: `/projects/${builderProjectCode}/document`,
    headers: { 'x-principal-code': other.code },
    payload: { title: 'Forbidden', content: '# No' },
  });
  assert.equal(forbiddenDocument.json().ok, false, forbiddenDocument.body);
  assert.equal(forbiddenDocument.json().error.code, 'project_document_forbidden');

  const savedDocument = await app.inject({
    method: 'PUT',
    url: `/projects/${builderProjectCode}/document`,
    headers: { 'x-principal-code': builder.code },
    payload: { title: 'Builder Project Doc', content: '# Body\n\nShared context.' },
  });
  assert.equal(savedDocument.json().ok, true, savedDocument.body);
  assert.equal(savedDocument.json().data.project_code, builderProjectCode);
  assert.equal(savedDocument.json().data.can_edit, true);

  const artifact = await app.inject({
    method: 'POST',
    url: `/projects/${builderProjectCode}/artifacts`,
    headers: { 'x-principal-code': builder.code },
    payload: { kind: 'document', title: 'Project brief', uri: 'docs/project.md', content_hash: 'sha-doc' },
  });
  assert.equal(artifact.json().ok, true, artifact.body);
  assert.equal(artifact.json().data.project_code, builderProjectCode);

  const listedProjects = await app.inject({
    method: 'GET',
    url: `/projects?principal_code=${builder.code}`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(listedProjects.json().ok, true, listedProjects.body);
  assert.ok(listedProjects.json().data.some((item) => item.project_code === builderProjectCode));
  assert.ok(listedProjects.json().data.some((item) => item.project_code === project.code));

  const teamProjects = await app.inject({
    method: 'GET',
    url: `/projects?team_code=${builderTeamCode}`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.deepEqual(teamProjects.json().data.map((item) => item.project_code), [secondProjectCode, builderProjectCode]);
  assert.equal(teamProjects.json().data[1].name, 'Builder Project Renamed');
  assert.equal(teamProjects.json().data[1].description, '用于交付协作。');

  const artifacts = await app.inject({
    method: 'GET',
    url: `/projects/${builderProjectCode}/artifacts`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(artifacts.json().ok, true, artifacts.body);
  assert.equal(artifacts.json().data[0].artifact_code, artifact.json().data.artifact_code);
  assert.equal(Object.hasOwn(artifacts.json().data[0], 'project_id'), false);

  const projectDocument = await app.inject({
    method: 'GET',
    url: `/projects/${builderProjectCode}/document`,
    headers: { 'x-principal-code': other.code },
  });
  assert.equal(projectDocument.json().ok, true, projectDocument.body);
  assert.equal(projectDocument.json().data.project_code, builderProjectCode);
  assert.equal(projectDocument.json().data.can_edit, false);

  const ownerRemovalRejected = await app.inject({
    method: 'DELETE',
    url: `/teams/${builderTeamCode}/members/${builder.code}`,
    headers: { 'x-principal-code': other.code },
  });
  assert.equal(ownerRemovalRejected.json().ok, false, ownerRemovalRejected.body);
  assert.equal(ownerRemovalRejected.json().error.code, 'team_owner_protected');

  const demotedTeamMember = await app.inject({
    method: 'PATCH',
    url: `/teams/${builderTeamCode}/members/${other.code}`,
    headers: { 'x-principal-code': builder.code },
    payload: { role: 'member' },
  });
  assert.equal(demotedTeamMember.json().ok, true, demotedTeamMember.body);

  const removedTeamMember = await app.inject({
    method: 'DELETE',
    url: `/teams/${builderTeamCode}/members/${other.code}`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(removedTeamMember.json().ok, true, removedTeamMember.body);
  assert.equal(removedTeamMember.json().data.user_code, other.code);

  const remainingProjectMembers = await app.inject({
    method: 'GET',
    url: `/projects/${builderProjectCode}/members`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(remainingProjectMembers.json().ok, true, remainingProjectMembers.body);
  assert.equal(remainingProjectMembers.json().data.some((member) => member.user_code === other.code), false);
});

test('project structure routes expose modules, phases, milestones, and feature bindings by public code', async () => {
  const { app, db, owner, builder, project, feature } = await createFixture();

  const moduleCreated = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/modules`,
    headers: { 'x-principal-code': owner.code },
    payload: { name: 'AUTH', description: 'Identity', sort_order: 1 },
  });
  assert.equal(moduleCreated.json().ok, true, moduleCreated.body);

  const phaseCreated = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/phases`,
    headers: { 'x-principal-code': owner.code },
    payload: { name: 'MVP', goal: 'First ship', sort_order: 1, start_date: '2026-08-01', end_date: '2026-09-30' },
  });
  assert.equal(phaseCreated.json().ok, true, phaseCreated.body);
  assert.equal(phaseCreated.json().data.start_date, '2026-08-01');
  assert.equal(phaseCreated.json().data.end_date, '2026-09-30');

  const milestoneCreated = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/milestones`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      phase_code: phaseCreated.json().data.phase_code,
      name: 'Auth Done',
      goal: 'Deliver auth',
      start_date: '2026-08-10',
      target_date: '2026-08-31',
      sort_order: 1,
      owner_principal_code: owner.code,
    },
  });
  assert.equal(milestoneCreated.json().ok, true, milestoneCreated.body);
  assert.equal(milestoneCreated.json().data.start_date, '2026-08-10');
  assert.equal(milestoneCreated.json().data.target_date, '2026-08-31');

  const invalidMilestoneDates = await app.inject({
    method: 'PATCH',
    url: `/milestones/${milestoneCreated.json().data.milestone_code}`,
    headers: { 'x-principal-code': owner.code },
    payload: { start_date: '2026-09-01', target_date: '2026-08-31' },
  });
  assert.equal(invalidMilestoneDates.json().ok, false, invalidMilestoneDates.body);
  assert.equal(invalidMilestoneDates.json().error.code, 'milestone_date_range_invalid');

  const featureUpdated = await app.inject({
    method: 'PATCH',
    url: `/features/${feature.code}`,
    headers: { 'x-principal-code': owner.code },
    payload: {
      name: 'HTTP Feature v2',
      module_code: moduleCreated.json().data.module_code,
      milestone_code: milestoneCreated.json().data.milestone_code,
      start_date: '2026-08-12',
      end_date: '2026-08-24',
      status: 'delivered',
    },
  });
  assert.equal(featureUpdated.json().ok, true, featureUpdated.body);
  assert.equal(featureUpdated.json().data.module_code, moduleCreated.json().data.module_code);
  assert.equal(featureUpdated.json().data.milestone_code, milestoneCreated.json().data.milestone_code);
  assert.equal(featureUpdated.json().data.start_date, '2026-08-12');
  assert.equal(featureUpdated.json().data.end_date, '2026-08-24');

  const outsideMilestone = await app.inject({
    method: 'PATCH',
    url: `/features/${feature.code}`,
    headers: { 'x-principal-code': owner.code },
    payload: { start_date: '2026-08-09', end_date: '2026-08-24' },
  });
  assert.equal(outsideMilestone.json().ok, false, outsideMilestone.body);
  assert.equal(outsideMilestone.json().error.code, 'feature_schedule_outside_milestone');

  const milestoneConflict = await app.inject({
    method: 'PATCH',
    url: `/milestones/${milestoneCreated.json().data.milestone_code}`,
    headers: { 'x-principal-code': owner.code },
    payload: { target_date: '2026-08-20' },
  });
  assert.equal(milestoneConflict.json().ok, false, milestoneConflict.body);
  assert.equal(milestoneConflict.json().error.code, 'milestone_feature_schedule_conflict');

  const featureDetail = await app.inject({
    method: 'GET',
    url: `/features/${feature.code}`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(featureDetail.json().ok, true, featureDetail.body);
  assert.equal(featureDetail.json().data.name, 'HTTP Feature v2');

  const moduleList = await app.inject({
    method: 'GET',
    url: `/projects/${project.code}/modules`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(moduleList.json().ok, true, moduleList.body);
  assert.equal(moduleList.json().data[0].module_code, moduleCreated.json().data.module_code);

  const milestoneList = await app.inject({
    method: 'GET',
    url: `/projects/${project.code}/milestones`,
    headers: { 'x-principal-code': builder.code },
  });
  assert.equal(milestoneList.json().ok, true, milestoneList.body);
  assert.equal(milestoneList.json().data[0].feature_count, 1);
  assert.equal(milestoneList.json().data[0].delivered_feature_count, 1);

  const secondModule = await app.inject({
    method: 'POST',
    url: `/projects/${project.code}/modules`,
    headers: { 'x-principal-code': owner.code },
    payload: { name: 'DELIVERY' },
  });
  assert.equal(secondModule.json().ok, true, secondModule.body);
  const reorderedModules = await app.inject({
    method: 'PUT',
    url: `/projects/${project.code}/modules/order`,
    headers: { 'x-principal-code': owner.code },
    payload: { module_codes: [secondModule.json().data.module_code, moduleCreated.json().data.module_code] },
  });
  assert.equal(reorderedModules.json().ok, true, reorderedModules.body);
  const reorderedModuleList = await app.inject({ method: 'GET', url: `/projects/${project.code}/modules`, headers: { 'x-principal-code': owner.code } });
  assert.deepEqual(reorderedModuleList.json().data.map((module) => module.module_code), [secondModule.json().data.module_code, moduleCreated.json().data.module_code]);

  const secondFeature = await app.inject({
    method: 'POST',
    url: '/features',
    headers: { 'x-principal-code': owner.code },
    payload: { project_code: project.code, title: 'Second Feature', module_code: secondModule.json().data.module_code },
  });
  assert.equal(secondFeature.json().ok, true, secondFeature.body);
  const reorderedFeatures = await app.inject({
    method: 'PUT',
    url: `/projects/${project.code}/features/order`,
    headers: { 'x-principal-code': owner.code },
    payload: { feature_codes: [secondFeature.json().data.feature_code, feature.code] },
  });
  assert.equal(reorderedFeatures.json().ok, true, reorderedFeatures.body);
  const reorderedFeatureList = await app.inject({ method: 'GET', url: `/features?project_code=${project.code}`, headers: { 'x-principal-code': owner.code } });
  assert.deepEqual(reorderedFeatureList.json().data.map((item) => item.feature_code), [secondFeature.json().data.feature_code, feature.code]);
});

test('defect routes use feature and task public codes across report, transition, fixing, retest, close, and list', async () => {
  const { app, db, owner, builder, feature } = await createFixture();

  const reported = await app.inject({
    method: 'POST',
    url: '/defects',
    headers: { 'x-principal-code': builder.code },
    payload: { feature_code: feature.code, title: 'Broken flow', severity: 'high', description: 'Route breaks' },
  });
  assert.equal(reported.json().ok, true, reported.body);
  assert.equal(reported.json().data.status, 'reported');
  const defectCode = reported.json().data.defect_code;

  const denied = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': builder.code },
    payload: { to: 'triaged' },
  });
  assert.equal(denied.json().ok, false, denied.body);
  assert.equal(denied.json().error.code, 'defect_forbidden');

  const triaged = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': owner.code },
    payload: { to: 'triaged' },
  });
  assert.equal(triaged.json().ok, true, triaged.body);

  const missingFix = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': builder.code },
    payload: { to: 'fixing' },
  });
  assert.equal(missingFix.json().ok, false, missingFix.body);
  assert.equal(missingFix.json().error.code, 'fix_task_required');

  const fixTask = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-principal-code': owner.code },
    payload: {
      feature_code: feature.code,
      title: 'Fix defect',
      profile: 'builder',
      source: 'defect-fix',
      defect_code: defectCode,
      acceptance: [{ id: 'AC-1', text: 'Defect closed' }],
    },
  });
  assert.equal(fixTask.json().ok, true, fixTask.body);

  const fixing = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': builder.code },
    payload: { to: 'fixing', fix_task_code: fixTask.json().data.task_code },
  });
  assert.equal(fixing.json().ok, true, fixing.body);
  assert.equal(fixing.json().data.status, 'fixing');

  const prematureRetest = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': builder.code },
    payload: { to: 'retest' },
  });
  assert.equal(prematureRetest.json().ok, false, prematureRetest.body);
  assert.equal(prematureRetest.json().error.code, 'fix_task_not_completed');
  await db.update(schema.tasks).set({ status: 'verified' }).where(eq(schema.tasks.code, fixTask.json().data.task_code));

  const retest = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': builder.code },
    payload: { to: 'retest' },
  });
  assert.equal(retest.json().ok, true, retest.body);

  const closed = await app.inject({
    method: 'POST',
    url: `/defects/${defectCode}/transition`,
    headers: { 'x-principal-code': owner.code },
    payload: { to: 'closed' },
  });
  assert.equal(closed.json().ok, true, closed.body);

  const list = await app.inject({ method: 'GET', url: '/defects?status=closed', headers: { 'x-principal-code': builder.code } });
  assert.equal(list.json().ok, true, list.body);
  assert.equal(list.json().data[0].defect_code, defectCode);
  assert.equal(list.json().data[0].feature_code, feature.code);
  assert.equal(list.json().data[0].description, 'Route breaks');
  assert.equal(list.json().data[0].fix_tasks[0].task_code, fixTask.json().data.task_code);
});

test('project-scoped filters do not leak tasks, requirements, defects, or features across projects', async () => {
  const { app, db, owner, other, team, project, feature } = await createFixture();
  const otherProject = await insertProject(db, {
    code: publicCode(71),
    team_id: team.id,
    name: 'Other Project',
    current_snapshot: 1,
    created_at: '2026-08-13T00:00:00.000Z',
  });
  await insertProjectMember(db, {
    principal_id: other.id,
    project_id: otherProject.id,
    role: 'owner',
    display_name: other.display_name,
    created_at: '2026-08-13T00:00:00.000Z',
  });
  const otherFeature = await insertFeature(db, {
    code: publicCode(72),
    project_id: otherProject.id,
    title: 'Other Feature',
    status: 'active',
  });
  const [otherRequirement] = await db.insert(schema.requirements).values({
    code: publicCode(73),
    feature_id: otherFeature.id,
    title: 'Other requirement',
    current_revision: 1,
    state: 'draft',
    owner_principal_id: other.id,
  }).returning();
  await db.insert(schema.requirementRevisions).values({
    code: publicCode(74),
    requirement_id: otherRequirement.id,
    revision: 1,
    summary: 'Other body',
    acceptance_criteria: JSON.stringify([{ id: 'AC-1', text: 'Other' }]),
    open_questions: JSON.stringify([]),
    created_at: '2026-08-13T00:00:00.000Z',
  });
  await db.insert(schema.tasks).values({
    code: publicCode(75),
    feature_id: otherFeature.id,
    requirement_id: otherRequirement.id,
    title: 'Other task',
    profile: 'builder',
    source: 'requirement',
    status: 'assigned',
    acceptance: JSON.stringify([{ id: 'AC-1', text: 'Other' }]),
    base_snapshot: 1,
    created_at: '2026-08-13T00:00:00.000Z',
  });
  await db.insert(schema.defects).values({
    code: publicCode(76),
    feature_id: otherFeature.id,
    title: 'Other defect',
    severity: 'medium',
    reported_by: other.id,
    description: 'Other issue',
    status: 'reported',
  });

  const primaryRequirement = await app.inject({
    method: 'POST',
    url: '/requirements',
    headers: { 'x-principal-code': owner.code },
    payload: {
      feature_code: feature.code,
      title: 'Primary requirement',
      body: 'Only the primary project should see this requirement.',
      acceptance_criteria: [{ id: 'AC-1', text: 'Primary' }],
      open_questions: [],
      status: 'draft',
    },
  });
  assert.equal(primaryRequirement.json().ok, true, primaryRequirement.body);

  const tasks = await app.inject({ method: 'GET', url: `/tasks?project_code=${project.code}`, headers: { 'x-principal-code': owner.code } });
  assert.equal(tasks.json().data.some((item) => item.task_code === publicCode(75)), false);

  const features = await app.inject({ method: 'GET', url: `/features?project_code=${project.code}`, headers: { 'x-principal-code': owner.code } });
  assert.deepEqual(features.json().data.map((item) => item.feature_code), [feature.code]);

  const requirements = await app.inject({ method: 'GET', url: `/requirements?project_code=${project.code}`, headers: { 'x-principal-code': owner.code } });
  assert.equal(requirements.json().data.every((item) => item.feature_code === feature.code), true);

  const defects = await app.inject({ method: 'GET', url: `/defects?project_code=${project.code}`, headers: { 'x-principal-code': owner.code } });
  assert.equal(defects.json().data.some((item) => item.defect_code === publicCode(76)), false);
});

test('verification failure moves the task to failed and owner can reassign it back to ready for rework', async () => {
  const { app, db, owner, builder, verifier, feature } = await createFixture();

  const created = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-principal-code': owner.code },
    payload: {
      feature_code: feature.code,
      title: 'Verification failure path',
      profile: 'builder',
      source: 'requirement',
      acceptance: [{ id: 'AC-1', text: 'Works' }],
    },
  });
  assert.equal(created.json().ok, true, created.body);
  const taskCode = created.json().data.task_code;

  const assign = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/assign`,
    headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: builder.code, base_snapshot: created.json().data.base_snapshot },
  });
  assert.equal(assign.json().ok, true, assign.body);

  const claim = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(61),
      workspace_code: publicCode(62),
      profile: 'builder',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-fail-claim',
      git_base: 'abc123',
    },
  });
  assert.equal(claim.json().ok, true, claim.body);

  const submit = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/submit`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(61),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      artifact: { kind: 'commit', uri: 'git:commit', content_hash: 'sha-fail' },
      evidence: { type: 'self_test', result: 'pass', acceptance_refs: ['AC-1'], command: 'node --test' },
    },
  });
  assert.equal(submit.json().ok, true, submit.body);
  assert.equal(submit.json().data.status, 'submitted');

  const verifyClaim = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(63),
      workspace_code: publicCode(64),
      profile: 'verifier',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-fail-verify',
      git_base: 'abc123',
    },
  });
  assert.equal(verifyClaim.json().ok, true, verifyClaim.body);

  // Verifier 提交 fail：任务进入 failed 而非被拒绝。
  const failed = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/verify`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(63),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      evidence: { result: 'fail', acceptance_refs: ['AC-1'], summary: '回归未通过：登录页空白' },
    },
  });
  assert.equal(failed.json().ok, true, failed.body);
  assert.equal(failed.json().data.status, 'failed');
  assert.equal((await getTask(app, taskCode, owner.code)).status, 'failed');

  // Owner 把 failed 任务重新分派回 assigned（Builder 返工）。
  const reassign = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/assign`,
    headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: builder.code, base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot },
  });
  assert.equal(reassign.json().ok, true, reassign.body);
  assert.equal((await getTask(app, taskCode, owner.code)).status, 'assigned');

  const [audit] = await db.select().from(schema.auditEvents)
    .where(eq(schema.auditEvents.action, 'task.verification_failed'))
    .orderBy(schema.auditEvents.id)
    .limit(10);
  assert.ok(audit, 'verification failure should be audited as task.verification_failed');
});

test('closing the last unfinished task derives the feature to delivered and gates milestone completion', async () => {
  const { app, owner, builder, verifier, feature, project } = await createFixture();

  const created = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-principal-code': owner.code },
    payload: {
      feature_code: feature.code,
      title: 'Delivery projection',
      profile: 'builder',
      source: 'requirement',
      acceptance: [{ id: 'AC-1', text: 'Works' }],
    },
  });
  assert.equal(created.json().ok, true, created.body);
  const taskCode = created.json().data.task_code;

  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/assign`,
    headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: builder.code, base_snapshot: created.json().data.base_snapshot },
  });
  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(71),
      workspace_code: publicCode(72),
      profile: 'builder',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-deliver-claim',
      git_base: 'abc123',
    },
  });
  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/submit`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(71),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      artifact: { kind: 'commit', uri: 'git:commit', content_hash: 'sha-deliver' },
      evidence: { type: 'self_test', result: 'pass', acceptance_refs: ['AC-1'], command: 'node --test' },
    },
  });


  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(73),
      workspace_code: publicCode(74),
      profile: 'verifier',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-deliver-verify',
      git_base: 'abc123',
    },
  });
  const verified = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/verify`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(73),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      evidence: { result: 'pass', acceptance_refs: ['AC-1'], summary: 'Verified' },
    },
  });
  assert.equal(verified.json().ok, true, verified.body);

  // 关闭最后一个未完结任务 → active Feature 自动派生为 delivered。
  const closed = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/close`,
    headers: { 'x-principal-code': owner.code },
    payload: { base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot },
  });
  assert.equal(closed.json().ok, true, closed.body);

  const features = await app.inject({
    method: 'GET',
    url: `/features?project_code=${project.code}`,
    headers: { 'x-principal-code': owner.code },
  });
  assert.equal(features.json().ok, true, features.body);
  const deliveredFeature = features.json().data.find((item) => item.feature_code === feature.code);
  assert.ok(deliveredFeature, 'fixture feature should be listed');
  assert.equal(deliveredFeature.status, 'delivered', 'feature should be derived to delivered after its last task closed');
});

test('inconclusive verification also routes the task to failed with its own evidence trail', async () => {
  const { app, db, owner, builder, verifier, feature } = await createFixture();

  const created = await app.inject({
    method: 'POST',
    url: '/tasks',
    headers: { 'x-principal-code': owner.code },
    payload: {
      feature_code: feature.code,
      title: 'Inconclusive verification path',
      profile: 'builder',
      source: 'requirement',
      acceptance: [{ id: 'AC-1', text: 'Works' }],
    },
  });
  assert.equal(created.json().ok, true, created.body);
  const taskCode = created.json().data.task_code;

  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/assign`,
    headers: { 'x-principal-code': owner.code },
    payload: { assignee_principal_code: builder.code, base_snapshot: created.json().data.base_snapshot },
  });
  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(81),
      workspace_code: publicCode(82),
      profile: 'builder',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-inconclusive-claim',
      git_base: 'abc123',
    },
  });
  const submitted = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/submit`,
    headers: { 'x-principal-code': builder.code },
    payload: {
      run_code: publicCode(81),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      artifact: { kind: 'commit', uri: 'git:commit', content_hash: 'sha-inc' },
      evidence: { type: 'self_test', result: 'pass', acceptance_refs: ['AC-1'], command: 'node --test' },
    },
  });
  assert.equal(submitted.json().ok, true, submitted.body);

  await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/claim`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(83),
      workspace_code: publicCode(84),
      profile: 'verifier',
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      workspace_path: 'C:/tmp/acp-inconclusive-verify',
      git_base: 'abc123',
    },
  });

  const inconclusive = await app.inject({
    method: 'POST',
    url: `/tasks/${taskCode}/verify`,
    headers: { 'x-principal-code': verifier.code },
    payload: {
      run_code: publicCode(83),
      base_snapshot: (await getTask(app, taskCode, owner.code)).base_snapshot,
      evidence: { result: 'inconclusive', acceptance_refs: ['AC-1'], summary: '测试环境故障，无法得出结论' },
    },
  });
  assert.equal(inconclusive.json().ok, true, inconclusive.body);
  assert.equal(inconclusive.json().data.status, 'failed');
  assert.equal((await getTask(app, taskCode, owner.code)).status, 'failed');

  // inconclusive 的验证证据仍然落库可追溯。
  const evidences = await db.select().from(schema.evidences)
    .where(eq(schema.evidences.task_id, (await db.select().from(schema.tasks).where(eq(schema.tasks.code, taskCode)).limit(1))[0].id));
  assert.equal(evidences.some((row) => row.result === 'inconclusive'), true);

  const [audit] = await db.select().from(schema.auditEvents)
    .where(eq(schema.auditEvents.action, 'task.verification_failed'))
    .orderBy(schema.auditEvents.id)
    .limit(10);
  assert.ok(audit);
});
