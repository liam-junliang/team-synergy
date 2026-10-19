import { test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import {
  createTaskService,
  createProjectUseCases,
  createProjectStructureUseCases,
  createProjectUseCasesProject,
  createVerificationUseCases,
  createMemberUseCases,
  createTeamUseCases,
  createDefectUseCases,
  createRequirementUseCases,
} from '../dist/index.js';
import {
  addProjectMember,
  insertFeature,
  insertProject,
  insertRequirement,
  insertTask,
  insertUser,
  seedWorkspaceProject,
  useTestDb,
} from './test-db.mjs';

const fixture = useTestDb(import.meta.url);

async function seededDb() {
  const db = fixture.db;
  const seeded = await seedWorkspaceProject(db, {
    teamLegacyCode: 'TEAM-APP',
    teamName: 'App Team',
    projectLegacyCode: 'PROJECT-A',
    projectName: 'acp',
    users: [
      { key: 'chen', legacyCode: 'user-chen', account: 'chen', displayName: 'chen', teamRole: 'owner', projectRole: 'owner' },
      { key: 'wang', legacyCode: 'user-wang', account: 'wang', displayName: 'wang', teamRole: 'member', projectRole: 'member' },
    ],
  });
  return { db, ...seeded };
}

test('project create：注册用户成为 Owner 并写入审计；非注册用户拒绝', async () => {
  const db = fixture.db;
  const creator = await insertUser(db, { legacyCode: 'user-creator', account: 'creator', displayName: 'Creator', status: 'active' });
  const teams = createTeamUseCases(db);
  const createdTeam = await teams.createTeam({ name: 'Creator Team', principalCode: creator.code });
  assert.equal(createdTeam.ok, true, JSON.stringify(createdTeam));

  const projects = createProjectUseCasesProject(db);
  const created = await projects.createProject({ teamCode: createdTeam.data.team_code, name: 'Alpha', principalCode: creator.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.role, 'owner');
  const [projectRow] = await db.select().from(schema.projects).where(eq(schema.projects.code, created.data.project_code)).limit(1);
  const [member] = await db.select().from(schema.members).where(and(
    eq(schema.members.principal_id, creator.id),
    eq(schema.members.project_id, projectRow.id),
  )).limit(1);
  assert.equal(member.role, 'admin');
  assert.equal(projectRow.owner_principal_id, creator.id);
  assert.equal(projectRow.created_by, creator.id);
  assert.equal(projectRow.member_policy, 'team_read');
  assert.equal(member.display_name, 'Creator');
  const [audit] = await db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'project'),
    eq(schema.auditEvents.entity_id, projectRow.id),
  )).limit(1);
  assert.equal(audit.action, 'project.created');
  assert.equal(audit.principal_id, creator.id);
  const folders = await db.select().from(schema.projectDocumentFolders).where(eq(schema.projectDocumentFolders.project_id, projectRow.id));
  assert.deepEqual(folders.map(folder => folder.system_role).sort(), ['architecture', 'requirements', 'standards', 'testing']);
  assert.equal(folders.every(folder => folder.parent_id === null && folder.status === 'active' && folder.created_by === null), true);

  const rejected = await projects.createProject({ teamCode: createdTeam.data.team_code, name: 'Ghost', principalCode: '00000000000000000000' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'user_not_found');
});

test('project list：仅返回用户参与的多个项目及各自角色', async () => {
  const db = fixture.db;
  const one = await insertUser(db, { legacyCode: 'user-one', account: 'one', displayName: 'One', status: 'active' });
  const two = await insertUser(db, { legacyCode: 'user-two', account: 'two', displayName: 'Two', status: 'active' });
  const teams = createTeamUseCases(db);
  const projects = createProjectUseCasesProject(db);
  const teamOne = await teams.createTeam({ name: 'One Team', principalCode: one.code });
  const teamOneExtra = await teams.createTeam({ name: 'One Extra Team', principalCode: one.code });
  const teamTwo = await teams.createTeam({ name: 'Two Team', principalCode: two.code });
  const projectOne = await projects.createProject({ teamCode: teamOne.data.team_code, name: 'One', principalCode: one.code });
  const projectTwo = await projects.createProject({ teamCode: teamOne.data.team_code, name: 'Two', principalCode: one.code });
  const projectOther = await projects.createProject({ teamCode: teamTwo.data.team_code, name: 'Other', principalCode: two.code });
  assert.equal(projectOne.ok && projectTwo.ok && projectOther.ok, true);

  const reorderedTeams = await teams.reorderTeams({
    teamCodes: [teamOneExtra.data.team_code, teamOne.data.team_code],
    principalCode: one.code,
  });
  assert.equal(reorderedTeams.ok, true, JSON.stringify(reorderedTeams));
  assert.deepEqual((await teams.listTeams(one.code)).map((team) => team.team_code), [
    teamOneExtra.data.team_code,
    teamOne.data.team_code,
  ]);
  const invalidTeamOrder = await teams.reorderTeams({ teamCodes: [teamOne.data.team_code], principalCode: one.code });
  assert.equal(invalidTeamOrder.ok, false);
  assert.equal(invalidTeamOrder.error.code, 'team_order_invalid');

  const reorderedProjects = await projects.reorderProjects({
    teamCode: teamOne.data.team_code,
    projectCodes: [projectTwo.data.project_code, projectOne.data.project_code],
    principalCode: one.code,
  });
  assert.equal(reorderedProjects.ok, true, JSON.stringify(reorderedProjects));

  assert.deepEqual((await projects.listProjects(one.code)).map(({ project_code, name, role }) => ({ project_code, name, role })), [
    { project_code: projectTwo.data.project_code, name: 'Two', role: 'owner' },
    { project_code: projectOne.data.project_code, name: 'One', role: 'owner' },
  ]);
  assert.deepEqual((await projects.listProjects(two.code)).map(({ project_code, role }) => ({ project_code, role })), [
    { project_code: projectOther.data.project_code, role: 'owner' },
  ]);
});

test('project list：外部项目成员仅看到授权项目及安全团队信息，内部成员不标记为外部', async () => {
  const ctx = await seededDb();
  const projects = createProjectUseCasesProject(ctx.db);
  const teams = createTeamUseCases(ctx.db);
  const external = await insertUser(ctx.db, { account: 'external', displayName: 'External' });
  await addProjectMember(ctx.db, {
    principalId: external.id,
    projectId: ctx.project.id,
    role: 'member',
    displayName: external.display_name,
  });
  const privateProject = await insertProject(ctx.db, { teamId: ctx.team.id, name: 'Private sibling' });
  await addProjectMember(ctx.db, {
    principalId: ctx.users.chen.id,
    projectId: privateProject.id,
    role: 'owner',
    displayName: ctx.users.chen.display_name,
  });

  assert.deepEqual(await teams.listTeams(external.code), []);
  const externalProjects = await projects.listProjects(external.code);
  assert.deepEqual(externalProjects.map(({ project_code, team_code, team_name, is_external, role }) => ({
    project_code, team_code, team_name, is_external, role,
  })), [{
    project_code: ctx.project.code,
    team_code: ctx.team.code,
    team_name: ctx.team.name,
    is_external: true,
    role: 'member',
  }]);
  assert.equal(externalProjects.some((project) => project.project_code === privateProject.code), false);
  assert.equal('team_members' in externalProjects[0], false);
  assert.equal('team_members_count' in externalProjects[0], false);
  assert.deepEqual(await projects.listProjects(external.code, ctx.team.code), externalProjects);

  const internalProjects = await projects.listProjects(ctx.users.wang.code);
  assert.deepEqual(internalProjects.map(({ project_code, team_name, is_external, role }) => ({
    project_code, team_name, is_external, role,
  })), [{ project_code: ctx.project.code, team_name: ctx.team.name, is_external: false, role: 'member' }]);
  assert.deepEqual(await projects.listProjects('00000000000000000000'), []);
  await ctx.db.update(schema.users).set({ status: 'disabled' }).where(eq(schema.users.id, external.id));
  assert.deepEqual(await projects.listProjects(external.code), []);
});

test('project update：普通成员不能修改项目资料，负责人修改后保留编码并记录审计', async () => {
  const ctx = await seededDb();
  const projects = createProjectUseCasesProject(ctx.db);

  const forbidden = await projects.updateProject({ projectCode: ctx.project.code, name: '越权名称', description: '越权简介', principalCode: ctx.users.wang.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'project_forbidden');
  const empty = await projects.updateProject({ projectCode: ctx.project.code, name: '   ', principalCode: ctx.users.chen.code });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'project_name_required');

  const updated = await projects.updateProject({
    projectCode: ctx.project.code,
    name: '  Agent 协作平台  ',
    description: '  面向多 Agent 交付协作。  ',
    principalCode: ctx.users.chen.code,
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.data.project_code, ctx.project.code);
  assert.equal(updated.data.name, 'Agent 协作平台');
  assert.equal(updated.data.description, '面向多 Agent 交付协作。');
  assert.equal(updated.data.current_snapshot, 1);
  const [stored] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.code, ctx.project.code));
  assert.equal(stored.name, 'Agent 协作平台');
  assert.equal(stored.description, '面向多 Agent 交付协作。');
  assert.equal(stored.current_snapshot, 1);
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'project'),
    eq(schema.auditEvents.entity_id, ctx.project.id),
  ));
  const audit = audits.find((event) => event.action === 'project.updated');
  assert.equal(audit?.principal_id, ctx.users.chen.id);
  assert.equal(audit?.base_snapshot, 0);
  assert.deepEqual(JSON.parse(audit?.payload ?? '{}'), {
    name: { from: 'acp', to: 'Agent 协作平台' },
    description: { from: null, to: '面向多 Agent 交付协作。' },
  });
});

test('project archive：只有项目 Owner 可归档，数据保留并可恢复', async () => {
  const ctx = await seededDb();
  const projects = createProjectUseCasesProject(ctx.db);

  const forbidden = await projects.updateProjectStatus({ projectCode: ctx.project.code, status: 'archived', principalCode: ctx.users.wang.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'project_forbidden');

  const archived = await projects.updateProjectStatus({ projectCode: ctx.project.code, status: 'archived', principalCode: ctx.users.chen.code });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.data.status, 'archived');
  const listed = await projects.listProjects(ctx.users.chen.code, ctx.team.code);
  assert.equal(listed.find((project) => project.project_code === ctx.project.code)?.status, 'archived');

  const restored = await projects.updateProjectStatus({ projectCode: ctx.project.code, status: 'active', principalCode: ctx.users.chen.code });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.data.status, 'active');
  const [stored] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.code, ctx.project.code));
  assert.equal(stored.status, 'active');
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'project'),
    eq(schema.auditEvents.entity_id, ctx.project.id),
  ));
  assert.deepEqual(audits.map((event) => event.action), ['project.archived', 'project.restored']);
});

test('project repositories/workspace：Owner 配置多仓库，成员可查阅且云端工作空间不保存本机路径', async () => {
  const ctx = await seededDb();
  const projects = createProjectUseCasesProject(ctx.db);

  const forbidden = await projects.createProjectRepository({
    projectCode: ctx.project.code,
    principalCode: ctx.users.wang.code,
    name: 'Web',
    remoteUrl: 'git@example.com:team/web.git',
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'project_repository_forbidden');

  const secret = await projects.createProjectRepository({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: 'Secret',
    remoteUrl: 'https://token@example.com/team/secret.git',
  });
  assert.equal(secret.ok, false);
  assert.equal(secret.error.code, 'repository_remote_contains_credentials');

  const web = await projects.createProjectRepository({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: '管理端 Web',
    purpose: '项目工作台',
    remoteUrl: 'git@example.com:team/web.git',
    defaultBranch: 'main',
  });
  const api = await projects.createProjectRepository({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: 'Core API',
    purpose: '云端服务',
    remoteUrl: 'https://example.com/team/api.git',
    defaultBranch: 'develop',
  });
  assert.equal(web.ok && api.ok, true, JSON.stringify({ web, api }));
  assert.notEqual(web.data.repository_code, api.data.repository_code);

  const memberList = await projects.listProjectRepositories(ctx.project.code, ctx.users.wang.code);
  assert.equal(memberList.ok, true, JSON.stringify(memberList));
  assert.deepEqual(memberList.data.map(({ name, can_manage }) => ({ name, can_manage })), [
    { name: 'Core API', can_manage: false },
    { name: '管理端 Web', can_manage: false },
  ]);

  const archived = await projects.updateProjectRepository({
    repositoryCode: web.data.repository_code,
    principalCode: ctx.users.chen.code,
    status: 'archived',
  });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  assert.equal(archived.data.status, 'archived');

  const workspace = await projects.registerProjectWorkspace({
    projectCode: ctx.project.code,
    principalCode: ctx.users.wang.code,
    name: 'Wang 产品工作空间',
  });
  assert.equal(workspace.ok, true, JSON.stringify(workspace));
  assert.equal('path' in workspace.data, false);
  const [storedWorkspace] = await ctx.db.select().from(schema.projectWorkspaces).where(eq(schema.projectWorkspaces.code, workspace.data.project_workspace_code));
  assert.equal(storedWorkspace.name, 'Wang 产品工作空间');
  assert.equal(Object.hasOwn(storedWorkspace, 'path'), false);
});

test('project document：成员可读完整正文，只有项目 Owner 可编辑并形成修订', async () => {
  const ctx = await seededDb();
  const projects = createProjectUseCasesProject(ctx.db);

  const empty = await projects.getProjectDocument(ctx.project.code, ctx.users.wang.code);
  assert.equal(empty.ok, true, JSON.stringify(empty));
  assert.equal(empty.data.content, '');
  assert.equal(empty.data.revision, 0);
  assert.equal(empty.data.can_edit, false);

  const forbidden = await projects.saveProjectDocument({
    projectCode: ctx.project.code,
    principalCode: ctx.users.wang.code,
    title: '越权',
    content: '# 不应保存',
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'project_document_forbidden');

  const created = await projects.saveProjectDocument({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    title: '项目总览',
    content: '# 项目目标\n\n这是 CLI 与 Web 共用的完整正文。',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.revision, 1);
  const viewed = await projects.getProjectDocument(ctx.project.code, ctx.users.wang.code);
  assert.equal(viewed.ok, true, JSON.stringify(viewed));
  assert.equal(viewed.data.title, '项目总览');
  assert.match(viewed.data.content, /CLI 与 Web 共用/);
  assert.equal(viewed.data.can_edit, false);

  const updated = await projects.saveProjectDocument({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    title: '项目总览',
    content: '# 项目目标\n\n第二版正文。',
  });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.data.revision, 2);
  const audits = await ctx.db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'project'),
    eq(schema.auditEvents.entity_id, ctx.project.id),
  ));
  assert.deepEqual(audits.map((event) => event.action), ['project.document_created', 'project.document_updated']);
});

test('team member role：Owner 可任免管理员，但负责人只能通过所有权转移变更', async () => {
  const db = fixture.db;
  const owner = await insertUser(db, { legacyCode: 'team-owner', account: 'team.owner', displayName: 'Team Owner', status: 'active' });
  const memberUser = await insertUser(db, { legacyCode: 'team-member', account: 'team.member', displayName: 'Team Member', status: 'active' });
  const teams = createTeamUseCases(db);
  const team = await teams.createTeam({ name: 'Access Team', principalCode: owner.code });
  assert.equal(team.ok, true, JSON.stringify(team));
  assert.equal((await teams.addMember({ teamCode: team.data.team_code, userCode: memberUser.code, role: 'member', actorPrincipalCode: owner.code })).ok, true);

  const forbidden = await teams.updateMemberRole({ teamCode: team.data.team_code, userCode: owner.code, role: 'member', actorPrincipalCode: memberUser.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'team_forbidden');

  const invalidOwnerGrant = await teams.updateMemberRole({ teamCode: team.data.team_code, userCode: memberUser.code, role: 'owner', actorPrincipalCode: owner.code });
  assert.equal(invalidOwnerGrant.ok, false);
  assert.equal(invalidOwnerGrant.error.code, 'member_role_invalid');
  const promoted = await teams.updateMemberRole({ teamCode: team.data.team_code, userCode: memberUser.code, role: 'admin', actorPrincipalCode: owner.code });
  assert.equal(promoted.ok, true, JSON.stringify(promoted));
  assert.equal(promoted.data.role, 'admin');
  assert.equal((await teams.updateMemberRole({ teamCode: team.data.team_code, userCode: owner.code, role: 'member', actorPrincipalCode: memberUser.code })).error.code, 'team_owner_protected');

  const lastOwner = await teams.updateMemberRole({ teamCode: team.data.team_code, userCode: owner.code, role: 'member', actorPrincipalCode: owner.code });
  assert.equal(lastOwner.ok, false);
  assert.equal(lastOwner.error.code, 'team_owner_protected');
  const members = await teams.listMembers(team.data.team_code, owner.code);
  assert.equal(members.data.filter(member => member.role === 'owner').length, 1);
  assert.equal(members.data.find(member => member.role === 'owner').user_code, owner.code);
});

test('team member remove：负责人不可直接移出，普通成员移出后同步撤销团队下的项目权限', async () => {
  const db = fixture.db;
  const owner = await insertUser(db, { legacyCode: 'remove-owner', account: 'remove.owner', displayName: 'Remove Owner', status: 'active' });
  const target = await insertUser(db, { legacyCode: 'remove-target', account: 'remove.target', displayName: 'Remove Target', status: 'active' });
  const teams = createTeamUseCases(db);
  const team = await teams.createTeam({ name: 'Removal Team', principalCode: owner.code });
  assert.equal(team.ok, true, JSON.stringify(team));
  assert.equal((await teams.addMember({ teamCode: team.data.team_code, userCode: target.code, role: 'member', actorPrincipalCode: owner.code })).ok, true);

  const project = await createProjectUseCasesProject(db).createProject({ teamCode: team.data.team_code, name: 'Removal Project', principalCode: owner.code });
  assert.equal(project.ok, true, JSON.stringify(project));
  assert.equal((await createMemberUseCases(db).addMember({ projectCode: project.data.project_code, userCode: target.code, role: 'member', actorPrincipalCode: owner.code })).ok, true);

  const ownerRemoval = await teams.removeMember({ teamCode: team.data.team_code, userCode: owner.code, actorPrincipalCode: owner.code });
  assert.equal(ownerRemoval.ok, false);
  assert.equal(ownerRemoval.error.code, 'team_owner_protected');

  const removed = await teams.removeMember({ teamCode: team.data.team_code, userCode: target.code, actorPrincipalCode: owner.code });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.data.user_code, target.code);
  assert.deepEqual(removed.data.revoked_project_codes, [project.data.project_code]);
  assert.equal((await teams.listMembers(team.data.team_code, owner.code)).data.some((member) => member.user_code === target.code), false);
  assert.equal((await createMemberUseCases(db).listMembers(project.data.project_code, owner.code)).some((member) => member.user_code === target.code), false);
});

test('team rename：只有 Owner 可修改名称并记录审计', async () => {
  const db = fixture.db;
  const owner = await insertUser(db, { legacyCode: 'rename-owner', account: 'rename.owner', displayName: 'Rename Owner', status: 'active' });
  const memberUser = await insertUser(db, { legacyCode: 'rename-member', account: 'rename.member', displayName: 'Rename Member', status: 'active' });
  const teams = createTeamUseCases(db);
  const team = await teams.createTeam({ name: '旧团队名', principalCode: owner.code });
  assert.equal(team.ok, true, JSON.stringify(team));
  assert.equal((await teams.addMember({ teamCode: team.data.team_code, userCode: memberUser.code, role: 'member', actorPrincipalCode: owner.code })).ok, true);

  const forbidden = await teams.renameTeam({ teamCode: team.data.team_code, name: '越权名称', actorPrincipalCode: memberUser.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'team_forbidden');
  const empty = await teams.renameTeam({ teamCode: team.data.team_code, name: '   ', actorPrincipalCode: owner.code });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'team_name_required');

  const renamed = await teams.renameTeam({ teamCode: team.data.team_code, name: '  新团队名  ', actorPrincipalCode: owner.code });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.deepEqual(renamed.data, { team_code: team.data.team_code, name: '新团队名' });
  const [stored] = await db.select().from(schema.teams).where(eq(schema.teams.code, team.data.team_code));
  assert.equal(stored.name, '新团队名');
  const audits = await db.select().from(schema.auditEvents).where(and(
    eq(schema.auditEvents.entity_type, 'team'),
    eq(schema.auditEvents.entity_id, stored.id),
  ));
  const audit = audits.find((event) => event.action === 'team.renamed');
  assert.equal(audit?.principal_id, owner.id);
  assert.deepEqual(JSON.parse(audit?.payload ?? '{}'), { from: '旧团队名', to: '新团队名' });
});

test('项目隔离：其他项目的 Owner 不能在当前项目创建或分派实体', async () => {
  const ctx = await seededDb();
  const ownerB = await insertUser(ctx.db, { legacyCode: 'owner-b', account: 'owner.b', displayName: 'Owner B', status: 'active' });
  const teamB = await createTeamUseCases(ctx.db).createTeam({ name: 'Team B', principalCode: ownerB.code });
  assert.equal(teamB.ok, true, JSON.stringify(teamB));
  const projectB = await createProjectUseCasesProject(ctx.db).createProject({ teamCode: teamB.data.team_code, name: 'b', principalCode: ownerB.code });
  assert.equal(projectB.ok, true, JSON.stringify(projectB));
  const [projectBRow] = await ctx.db.select().from(schema.projects).where(eq(schema.projects.code, projectB.data.project_code)).limit(1);
  const featureB = await insertFeature(ctx.db, { legacyCode: 'FEATURE-B', projectId: projectBRow.id, title: 'b' });

  const projects = createProjectUseCases(ctx.db);
  const feature = await projects.createFeature({ projectCode: projectB.data.project_code, title: 'forbidden', principalCode: ctx.users.chen.code });
  assert.equal(feature.ok, false);
  assert.equal(feature.error.code, 'feature_forbidden');

  const task = await projects.createTask({
    featureCode: featureB.code,
    title: 'forbidden',
    profile: 'builder',
    source: 'requirement',
    acceptance: [{ id: 'AC-1', text: 'x' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(task.ok, false);
  assert.equal(task.error.code, 'create_task_forbidden');

  const requirement = await createRequirementUseCases(ctx.db).createRequirement({
    featureCode: featureB.code,
    title: 'forbidden',
    body: 'x',
    principalCode: ctx.users.chen.code,
  });
  assert.equal(requirement.ok, false);
  assert.equal(requirement.error.code, 'requirement_forbidden');

  const defect = await createDefectUseCases(ctx.db).reportDefect({
    featureCode: featureB.code,
    title: 'forbidden',
    severity: 'low',
    description: 'x',
    principalCode: ctx.users.chen.code,
  });
  assert.equal(defect.ok, false);
  assert.equal(defect.error.code, 'defect_forbidden');
});

test('feature create：Owner 创建成功；非 Owner 拒绝', async () => {
  const ctx = await seededDb();
  const uc = createProjectUseCases(ctx.db);
  const created = await uc.createFeature({ projectCode: ctx.project.code, title: '用户登录', principalCode: ctx.users.chen.code });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.feature_code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
  const forbidden = await uc.createFeature({ projectCode: ctx.project.code, title: 'x', principalCode: ctx.users.wang.code });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'feature_forbidden');
});

test('项目结构排序：模块与 Feature 顺序可持久化且必须提交完整集合', async () => {
  const ctx = await seededDb();
  const structure = createProjectStructureUseCases(ctx.db);
  const features = createProjectUseCases(ctx.db);

  const moduleA = await structure.createModule({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code, name: '模块 A' });
  const moduleB = await structure.createModule({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code, name: '模块 B' });
  assert.equal(moduleA.ok && moduleB.ok, true);
  assert.equal(moduleA.data.sort_order, 0);
  assert.equal(moduleB.data.sort_order, 1);

  const reorderedModules = await structure.reorderModules({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    moduleCodes: [moduleB.data.module_code, moduleA.data.module_code],
  });
  assert.equal(reorderedModules.ok, true, JSON.stringify(reorderedModules));
  const listedModules = await structure.listModules({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code });
  assert.deepEqual(listedModules.data.map((module) => module.module_code), [moduleB.data.module_code, moduleA.data.module_code]);
  const invalidModuleOrder = await structure.reorderModules({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code, moduleCodes: [moduleA.data.module_code] });
  assert.equal(invalidModuleOrder.ok, false);
  assert.equal(invalidModuleOrder.error.code, 'module_order_invalid');

  const featureA = await features.createFeature({ projectCode: ctx.project.code, title: 'Feature A', moduleCode: moduleA.data.module_code, principalCode: ctx.users.chen.code });
  const featureB = await features.createFeature({ projectCode: ctx.project.code, title: 'Feature B', moduleCode: moduleB.data.module_code, principalCode: ctx.users.chen.code });
  assert.equal(featureA.ok && featureB.ok, true);
  assert.equal(featureA.data.sort_order, 0);
  assert.equal(featureB.data.sort_order, 1);

  const reorderedFeatures = await features.reorderFeatures({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    featureCodes: [featureB.data.feature_code, featureA.data.feature_code],
  });
  assert.equal(reorderedFeatures.ok, true, JSON.stringify(reorderedFeatures));
  const listedFeatures = await features.listFeatures({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code });
  assert.deepEqual(listedFeatures.data.map((feature) => feature.feature_code), [featureB.data.feature_code, featureA.data.feature_code]);
  const invalidFeatureOrder = await features.reorderFeatures({ projectCode: ctx.project.code, principalCode: ctx.users.chen.code, featureCodes: [featureA.data.feature_code] });
  assert.equal(invalidFeatureOrder.ok, false);
  assert.equal(invalidFeatureOrder.error.code, 'feature_order_invalid');
});

test('项目结构：Owner 可管理模块/阶段/里程碑，Feature 在里程碑窗口内独立排期', async () => {
  const ctx = await seededDb();
  const structure = createProjectStructureUseCases(ctx.db);
  const featureUc = createProjectUseCases(ctx.db);

  const moduleCreated = await structure.createModule({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: 'AUTH',
    description: '身份与认证',
    sortOrder: 1,
  });
  assert.equal(moduleCreated.ok, true, JSON.stringify(moduleCreated));

  const phaseCreated = await structure.createPhase({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: 'MVP',
    goal: '首个可用版本',
    sortOrder: 1,
    startDate: '2026-08-01',
    endDate: '2026-09-30',
  });
  assert.equal(phaseCreated.ok, true, JSON.stringify(phaseCreated));
  assert.equal(phaseCreated.data.start_date, '2026-08-01');
  assert.equal(phaseCreated.data.end_date, '2026-09-30');

  const invalidPhase = await structure.createPhase({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: '倒序阶段',
    startDate: '2026-09-01',
    endDate: '2026-08-01',
  });
  assert.equal(invalidPhase.ok, false);
  assert.equal(invalidPhase.error.code, 'phase_date_range_invalid');

  const milestoneCreated = await structure.createMilestone({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    phaseCode: phaseCreated.data.phase_code,
    name: 'Auth Done',
    goal: '认证闭环可交付',
    startDate: '2026-08-10',
    targetDate: '2026-08-31',
    sortOrder: 1,
    ownerPrincipalCode: ctx.users.chen.code,
  });
  assert.equal(milestoneCreated.ok, true, JSON.stringify(milestoneCreated));
  assert.equal(milestoneCreated.data.start_date, '2026-08-10');
  assert.equal(milestoneCreated.data.target_date, '2026-08-31');

  const invalidMilestone = await structure.createMilestone({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    phaseCode: phaseCreated.data.phase_code,
    name: '倒序里程碑',
    startDate: '2026-09-01',
    targetDate: '2026-08-31',
  });
  assert.equal(invalidMilestone.ok, false);
  assert.equal(invalidMilestone.error.code, 'milestone_date_range_invalid');

  const featureCreated = await featureUc.createFeature({
    projectCode: ctx.project.code,
    name: '登录',
    moduleCode: moduleCreated.data.module_code,
    milestoneCode: milestoneCreated.data.milestone_code,
    startDate: '2026-08-12',
    endDate: '2026-08-24',
    principalCode: ctx.users.chen.code,
  });
  assert.equal(featureCreated.ok, true, JSON.stringify(featureCreated));
  assert.equal(featureCreated.data.module_code, moduleCreated.data.module_code);
  assert.equal(featureCreated.data.milestone_code, milestoneCreated.data.milestone_code);
  assert.equal(featureCreated.data.start_date, '2026-08-12');
  assert.equal(featureCreated.data.end_date, '2026-08-24');

  const nonEmptyModuleArchive = await structure.updateModule({
    moduleCode: moduleCreated.data.module_code,
    principalCode: ctx.users.chen.code,
    status: 'archived',
  });
  assert.equal(nonEmptyModuleArchive.ok, false);
  assert.equal(nonEmptyModuleArchive.error.code, 'module_has_active_features');

  const outsideMilestone = await featureUc.updateFeature({
    featureCode: featureCreated.data.feature_code,
    principalCode: ctx.users.chen.code,
    startDate: '2026-08-09',
    endDate: '2026-08-24',
  });
  assert.equal(outsideMilestone.ok, false);
  assert.equal(outsideMilestone.error.code, 'feature_schedule_outside_milestone');

  const milestoneConflict = await structure.updateMilestone({
    milestoneCode: milestoneCreated.data.milestone_code,
    principalCode: ctx.users.chen.code,
    targetDate: '2026-08-20',
  });
  assert.equal(milestoneConflict.ok, false);
  assert.equal(milestoneConflict.error.code, 'milestone_feature_schedule_conflict');

  const featureUpdated = await featureUc.updateFeature({
    featureCode: featureCreated.data.feature_code,
    principalCode: ctx.users.chen.code,
    status: 'delivered',
  });
  assert.equal(featureUpdated.ok, true, JSON.stringify(featureUpdated));
  assert.equal(featureUpdated.data.status, 'delivered');
  assert.equal(featureUpdated.data.start_date, '2026-08-12');
  assert.equal(featureUpdated.data.end_date, '2026-08-24');

  // docs/30 P2-2：里程碑标记 completed 需要交付事实——
  // Feature 全部 delivered 后才放行；无 Feature 或有未交付 Feature 时拒绝。
  const completeWithDelivered = await structure.updateMilestone({
    milestoneCode: milestoneCreated.data.milestone_code,
    principalCode: ctx.users.chen.code,
    status: 'completed',
  });
  assert.equal(completeWithDelivered.ok, true, JSON.stringify(completeWithDelivered));
  assert.equal(completeWithDelivered.data.status, 'completed');

  const noFeatureMilestone = await structure.createMilestone({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    phaseCode: phaseCreated.data.phase_code,
    name: 'Empty Milestone',
    startDate: '2026-08-10',
    targetDate: '2026-08-31',
  });
  assert.equal(noFeatureMilestone.ok, true, JSON.stringify(noFeatureMilestone));
  const emptyComplete = await structure.updateMilestone({
    milestoneCode: noFeatureMilestone.data.milestone_code,
    principalCode: ctx.users.chen.code,
    status: 'completed',
  });
  assert.equal(emptyComplete.ok, false);
  assert.equal(emptyComplete.error.code, 'milestone_completion_blocked');

  const partialDeliveredModule = await structure.createModule({
    projectCode: ctx.project.code,
    principalCode: ctx.users.chen.code,
    name: '隔离模块',
  });
  assert.equal(partialDeliveredModule.ok, true, JSON.stringify(partialDeliveredModule));
  const partialDelivered = await featureUc.createFeature({
    projectCode: ctx.project.code,
    name: '未交付 Feature',
    moduleCode: partialDeliveredModule.data.module_code,
    milestoneCode: noFeatureMilestone.data.milestone_code,
    principalCode: ctx.users.chen.code,
  });
  assert.equal(partialDelivered.ok, true, JSON.stringify(partialDelivered));
  const partialComplete = await structure.updateMilestone({
    milestoneCode: noFeatureMilestone.data.milestone_code,
    principalCode: ctx.users.chen.code,
    status: 'completed',
  });
  assert.equal(partialComplete.ok, false);
  assert.equal(partialComplete.error.code, 'milestone_completion_blocked');

  const milestones = await structure.listMilestones({ projectCode: ctx.project.code, principalCode: ctx.users.wang.code });
  assert.equal(milestones.ok, true, JSON.stringify(milestones));
  const authDone = milestones.data.find((milestone) => milestone.milestone_code === milestoneCreated.data.milestone_code);
  assert.ok(authDone, 'Auth Done milestone should be listed');
  assert.deepEqual(authDone, {
    ...authDone,
    milestone_code: milestoneCreated.data.milestone_code,
    phase_code: phaseCreated.data.phase_code,
    phase_name: 'MVP',
    name: 'Auth Done',
    goal: '认证闭环可交付',
    start_date: '2026-08-10',
    target_date: '2026-08-31',
    feature_count: 1,
    delivered_feature_count: 1,
    task_total: 0,
    closed_task_count: 0,
  });

  const archivedFeature = await featureUc.updateFeature({
    featureCode: featureCreated.data.feature_code,
    principalCode: ctx.users.chen.code,
    status: 'archived',
  });
  assert.equal(archivedFeature.ok, true, JSON.stringify(archivedFeature));
  const archivedModule = await structure.updateModule({
    moduleCode: moduleCreated.data.module_code,
    principalCode: ctx.users.chen.code,
    status: 'archived',
  });
  assert.equal(archivedModule.ok, true, JSON.stringify(archivedModule));
  assert.equal(archivedModule.data.status, 'archived');
});

test('task create：验收标准缺失拒绝；依赖不存在拒绝；成功创建 draft + 依赖落库', async () => {
  const ctx = await seededDb();
  const uc = createProjectUseCases(ctx.db);
  const feature = await uc.createFeature({ projectCode: ctx.project.code, title: '用户登录', principalCode: ctx.users.chen.code });
  assert.equal(feature.ok, true, JSON.stringify(feature));
  const featureRow = (await ctx.db.select().from(schema.features).where(eq(schema.features.code, feature.data.feature_code)).limit(1))[0];
  const requirement = await insertRequirement(ctx.db, {
    legacyCode: 'REQ-12',
    featureId: featureRow.id,
    title: '认证需求',
    currentRevision: 1,
    state: 'confirmed',
    ownerPrincipalId: ctx.users.chen.id,
  });

  const noAcceptance = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: 'x',
    profile: 'builder',
    source: 'requirement',
    acceptance: [],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(noAcceptance.ok, false);
  assert.equal(noAcceptance.error.code, 'acceptance_required');

  const badDep = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: 'x',
    profile: 'builder',
    source: 'requirement',
    acceptance: [{ id: 'AC-1', text: 'y' }],
    dependsOnCodes: ['00000000000000000000'],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(badDep.ok, false);
  assert.equal(badDep.error.code, 'dependency_missing');

  const ok = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: '实现认证',
    profile: 'builder',
    source: 'requirement',
    requirementCode: requirement.code,
    acceptance: [{ id: 'AC-1', text: 'y' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(ok.ok, true);
  const [linkedTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.code, ok.data.task_code)).limit(1);
  assert.equal(linkedTask.requirement_id, requirement.id);
  const withDep = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: '验证认证',
    profile: 'verifier',
    source: 'requirement',
    acceptance: [{ id: 'AC-1', text: 'y' }],
    dependsOnCodes: [ok.data.task_code],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(withDep.ok, true);
  const [depTask] = await ctx.db.select().from(schema.tasks).where(eq(schema.tasks.code, withDep.data.task_code)).limit(1);
  const deps = await ctx.db.select().from(schema.taskDependencies).where(eq(schema.taskDependencies.task_id, depTask.id));
  assert.equal(deps.length, 1);
  assert.equal(deps[0].depends_on_task_id, linkedTask.id);
});

test('全闭环：create → assign → claim(builder) → submit → claim(verifier) → verify → close', async () => {
  const ctx = await seededDb();
  const uc = createProjectUseCases(ctx.db);
  const svc = createTaskService(ctx.db);
  const vc = createVerificationUseCases(ctx.db);

  const feature = await uc.createFeature({ projectCode: ctx.project.code, title: '用户登录', principalCode: ctx.users.chen.code });
  assert.equal(feature.ok, true, JSON.stringify(feature));
  const taskBuilder = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: '实现认证',
    profile: 'builder',
    source: 'requirement',
    acceptance: [{ id: 'AC-1', text: '账号不存在与密码错误返回相同响应' }],
    principalCode: ctx.users.chen.code,
  });
  const taskVerifier = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: '独立验证',
    profile: 'verifier',
    source: 'ad-hoc',
    acceptance: [{ id: 'AC-1', text: '账号不存在与密码错误返回相同响应' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(taskBuilder.ok && taskVerifier.ok, true);
  const assign1 = await svc.assignTask({
    taskCode: taskBuilder.data.task_code,
    assigneePrincipalCode: ctx.users.chen.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(assign1.ok, true, JSON.stringify(assign1));
  const claim1 = await svc.claimTask({
    taskCode: taskBuilder.data.task_code,
    principalCode: ctx.users.chen.code,
    profile: 'builder',
    baseSnapshot: assign1.data.base_snapshot,
    workspacePath: '/ws/RUN-b',
    gitBase: 'b',
    runCode: '12345678901234567890',
    workspaceCode: '23456789012345678901',
  });
  assert.equal(claim1.ok, true, JSON.stringify(claim1));

  const submitted = await svc.submitTask({
    taskCode: taskBuilder.data.task_code,
    runCode: claim1.data.run_code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: assign1.data.base_snapshot + 1,
    artifact: { kind: 'commit', uri: 'git:x', contentHash: 'h' },
    evidence: { type: 'self_test', result: 'pass', acceptanceRefs: ['AC-1'], command: 'pnpm test' },
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));

  const verifyByBuilder = await vc.verifyTask({
    taskCode: taskBuilder.data.task_code,
    runCode: claim1.data.run_code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: submitted.data.base_snapshot,
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1'] },
  });
  assert.equal(verifyByBuilder.ok, false);
  assert.equal(verifyByBuilder.error.code, 'verify_profile_forbidden');

  const assignVerifier = await svc.assignTask({
    taskCode: taskVerifier.data.task_code,
    assigneePrincipalCode: ctx.users.wang.code,
    principalCode: ctx.users.chen.code,
    baseSnapshot: 0,
  });
  assert.equal(assignVerifier.ok, true, JSON.stringify(assignVerifier));
  const claimV = await svc.claimTask({
    taskCode: taskBuilder.data.task_code,
    principalCode: ctx.users.wang.code,
    profile: 'verifier',
    baseSnapshot: submitted.data.base_snapshot,
    workspacePath: '/ws/RUN-v',
    gitBase: 'b',
    runCode: '34567890123456789012',
    workspaceCode: '45678901234567890123',
  });
  assert.equal(claimV.ok, true, JSON.stringify(claimV));
  assert.equal(claimV.data.verification_run, true);
  assert.equal(claimV.data.status, 'submitted');

  const verified = await vc.verifyTask({
    taskCode: taskBuilder.data.task_code,
    runCode: claimV.data.run_code,
    principalCode: ctx.users.wang.code,
    baseSnapshot: submitted.data.base_snapshot,
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1'], summary: '独立复核通过' },
  });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.data.status, 'verified');
  const close301 = await vc.closeTask({ taskCode: taskBuilder.data.task_code, principalCode: ctx.users.chen.code, baseSnapshot: verified.data.base_snapshot });
  assert.equal(close301.ok, true, JSON.stringify(close301));
  const [runV] = await ctx.db.select().from(schema.runs).where(eq(schema.runs.code, claimV.data.run_code)).limit(1);
  assert.equal(runV.status, 'completed');
  const again = await vc.verifyTask({
    taskCode: taskBuilder.data.task_code,
    runCode: claimV.data.run_code,
    principalCode: ctx.users.wang.code,
    baseSnapshot: verified.data.base_snapshot,
    evidence: { type: 'verifier_review', result: 'pass', acceptanceRefs: ['AC-1'] },
  });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'verify_run_inactive');
  const history = await vc.taskHistory(taskBuilder.data.task_code, ctx.users.chen.code);
  const actions = history.map((entry) => entry.action);
  assert.ok(actions.includes('task.created'));
  assert.ok(actions.includes('task.assigned'));
  assert.ok(actions.includes('task.claimed'));
  assert.ok(actions.includes('task.self_tested'));
  assert.ok(actions.includes('task.submitted'));
  assert.ok(actions.includes('task.verification_claimed'));
  assert.ok(actions.includes('task.verified'));
  assert.ok(actions.includes('task.closed'));
});

test('member：add/list/remove + 负责人保护 + 未完成任务保护', async () => {
  const ctx = await seededDb();
  const li = await insertUser(ctx.db, { legacyCode: 'user-li', account: 'li', displayName: 'li', status: 'active' });
  const mc = createMemberUseCases(ctx.db);
  const add = await mc.addMember({ userCode: li.code, role: 'member', actorPrincipalCode: ctx.users.chen.code, projectCode: ctx.project.code });
  assert.equal(add.ok, true, JSON.stringify(add));
  const dup = await mc.addMember({ userCode: li.code, role: 'member', actorPrincipalCode: ctx.users.chen.code, projectCode: ctx.project.code });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'member_exists');
  const list = await mc.listMembers(ctx.project.code, ctx.users.chen.code);
  assert.ok(list.some((member) => member.user_code === li.code));
  assert.equal(list.find(member => member.user_code === li.code).account, li.account);

  const removeByMember = await mc.removeMember({ projectCode: ctx.project.code, userCode: li.code, actorPrincipalCode: ctx.users.wang.code });
  assert.equal(removeByMember.ok, false);
  assert.equal(removeByMember.error.code, 'member_forbidden');

  const removeLastOwner = await mc.removeMember({ projectCode: ctx.project.code, userCode: ctx.users.chen.code, actorPrincipalCode: ctx.users.chen.code });
  assert.equal(removeLastOwner.ok, false);
  assert.equal(removeLastOwner.error.code, 'project_owner_protected');

  const uc = createProjectUseCases(ctx.db);
  const feature = await uc.createFeature({ projectCode: ctx.project.code, title: 'f', principalCode: ctx.users.chen.code });
  assert.equal(feature.ok, true, JSON.stringify(feature));
  const task = await uc.createTask({
    featureCode: feature.data.feature_code,
    title: 't',
    profile: 'builder',
    source: 'ad-hoc',
    acceptance: [{ id: 'AC-1', text: 'y' }],
    principalCode: ctx.users.chen.code,
  });
  assert.equal(task.ok, true, JSON.stringify(task));
  const svc = createTaskService(ctx.db);
  await svc.assignTask({ taskCode: task.data.task_code, assigneePrincipalCode: ctx.users.wang.code, principalCode: ctx.users.chen.code, baseSnapshot: 0 });
  const removeBusy = await mc.removeMember({ projectCode: ctx.project.code, userCode: ctx.users.wang.code, actorPrincipalCode: ctx.users.chen.code });
  assert.equal(removeBusy.ok, false);
  assert.equal(removeBusy.error.code, 'member_has_open_tasks');
});
