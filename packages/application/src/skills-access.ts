import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import type { SkillScope } from '@team-synergy/contracts';
import { assertProjectAccess, isProjectManager, resolveProjectAccess, resolveTeamRole, type AccessDb } from './project-access.js';
import { skillInvalid } from './skills-content.js';

export type SkillRow = typeof schema.skills.$inferSelect;
export type SkillRevisionRow = typeof schema.skillRevisions.$inferSelect;
export type SkillProject = typeof schema.projects.$inferSelect;
export async function skillPrincipal(db: AccessDb, code: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.code, code)).limit(1);
  if (!user || user.status !== 'active' || user.deleted_at) throw new DomainError('skill_forbidden', '当前身份不能访问技能库');
  return user;
}
export async function skillScope(db: AccessDb, type: SkillScope, code: string) {
  if (type === 'team') {
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.code, code)).limit(1);
    if (!row) throw new DomainError('skill_scope_not_found', '技能范围不存在');
    return { id: row.id, code: row.code, type };
  }
  if (type !== 'project') skillInvalid('技能范围必须是 team 或 project');
  const [row] = await db.select().from(schema.projects).where(eq(schema.projects.code, code)).limit(1);
  if (!row) throw new DomainError('skill_scope_not_found', '技能范围不存在');
  return { id: row.id, code: row.code, type };
}
export async function skillSourceAccess(db: AccessDb, row: Pick<SkillRow, 'scope_type' | 'scope_id'>, principalId: bigint) {
  if (row.scope_type === 'team') {
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, row.scope_id)).limit(1);
    const role = await resolveTeamRole(db, row.scope_id, principalId);
    return { read: !!role, write: !!role, manage: isProjectManager(role ?? undefined), code: team?.code ?? '' };
  }
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, row.scope_id)).limit(1);
  const access = await resolveProjectAccess(db, row.scope_id, principalId);
  return { read: !!access, write: !!access && access.role !== 'viewer' && project?.status === 'active',
    manage: !!access && isProjectManager(access.role) && project?.status === 'active', code: project?.code ?? '' };
}
export async function lockSkillScope(db: AccessDb, type: SkillScope, id: bigint, principalId: bigint) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, principalId)).for('share');
  if (!user || user.status !== 'active' || user.deleted_at) throw new DomainError('skill_forbidden', '当前身份不能访问技能库');
  if (type === 'team') await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, id)).for('share');
  else {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    if (!project) throw new DomainError('skill_scope_not_found', '项目不存在');
    await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('share');
    await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, id)).for('update');
  }
}
export async function skillByCode(db: AccessDb, code: string) {
  const [row] = await db.select().from(schema.skills).where(eq(schema.skills.code, code)).limit(1);
  if (!row) throw new DomainError('skill_not_found', '技能不存在');
  return row;
}
/** Hold the membership scopes used by a detail download until its bytes have been selected. */
export async function lockSkillReadScopes(db: AccessDb, skill: SkillRow, principalId: bigint, projectCode?: string) {
  const teamIds = new Set<bigint>(); const projectIds = new Set<bigint>();
  if (skill.scope_type === 'team') teamIds.add(skill.scope_id); else projectIds.add(skill.scope_id);
  if (projectCode) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.code, projectCode)).limit(1);
    if (!project) throw new DomainError('project_not_found', '项目不存在');
    await assertProjectAccess(db, project.id, principalId); projectIds.add(project.id);
  } else {
    const shares = await db.select().from(schema.skillShares).where(and(eq(schema.skillShares.skill_id, skill.id), isNull(schema.skillShares.revoked_at)));
    for (const share of shares) if (share.target_type === 'team' && await resolveTeamRole(db, share.target_id, principalId)) teamIds.add(share.target_id);
    const installs = await db.select().from(schema.projectSkillInstallations).where(eq(schema.projectSkillInstallations.skill_id, skill.id));
    for (const install of installs) if (await resolveProjectAccess(db, install.project_id, principalId)) projectIds.add(install.project_id);
  }
  for (const id of projectIds) {
    const [project] = await db.select({ team_id: schema.projects.team_id }).from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    if (project) teamIds.add(project.team_id);
  }
  const order = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;
  for (const id of [...teamIds].sort(order)) await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.id, id)).for('share');
  for (const id of [...projectIds].sort(order)) await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, id)).for('share');
}
export async function skillRevision(db: AccessDb, id: bigint, revision: number) {
  const [row] = await db.select().from(schema.skillRevisions).where(and(eq(schema.skillRevisions.skill_id, id), eq(schema.skillRevisions.revision, revision))).limit(1);
  if (!row) throw new DomainError('skill_revision_not_found', '技能版本不存在');
  return row;
}
export async function projectHasExternalMembers(db: AccessDb, project: SkillProject) {
  const members = await db.select().from(schema.members).where(eq(schema.members.project_id, project.id));
  const ids = new Set(members.map(member => member.principal_id));
  if (project.owner_principal_id) ids.add(project.owner_principal_id);
  for (const id of ids) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (user?.status === 'active' && !user.deleted_at && !await resolveTeamRole(db, project.team_id, id)) return true;
  }
  return false;
}
/** A grant authorizes delivery to the project, independently of the requesting user's source memberships. */
export async function skillProjectGrant(db: AccessDb, skill: SkillRow, revision: SkillRevisionRow, project: SkillProject): Promise<boolean> {
  if (skill.archived || !revision.published_at) return false;
  if (skill.scope_type === 'project' && skill.scope_id === project.id) return true;
  const external = await projectHasExternalMembers(db, project);
  if (skill.scope_type === 'team' && skill.scope_id === project.team_id && !external) return true;
  const shares = await db.select().from(schema.skillShares).where(and(eq(schema.skillShares.skill_id, skill.id), isNull(schema.skillShares.revoked_at)));
  return shares.some(share => (JSON.parse(share.revisions_json) as number[]).includes(revision.revision)
    && (!external || share.allow_external)
    && ((share.target_type === 'project' && share.target_id === project.id)
      || (share.target_type === 'team' && share.target_id === project.team_id && share.allow_projects)));
}
export async function skillVisibleRevisions(db: AccessDb, skill: SkillRow, principalId: bigint, projectCode?: string): Promise<SkillRevisionRow[]> {
  const revisions = await db.select().from(schema.skillRevisions).where(eq(schema.skillRevisions.skill_id, skill.id));
  const source = await skillSourceAccess(db, skill, principalId);
  // Source membership is independent of a target-project context; authors retain their maintenance rights.
  if (source.read) return revisions.filter(rev => !!rev.published_at || source.manage || (source.write && skill.owner_principal_id === principalId));
  if (projectCode) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.code, projectCode)).limit(1);
    if (!project) throw new DomainError('project_not_found', '项目不存在');
    const access = await assertProjectAccess(db, project.id, principalId);
    const [installed] = await db.select().from(schema.projectSkillInstallations).where(and(eq(schema.projectSkillInstallations.project_id, project.id), eq(schema.projectSkillInstallations.skill_id, skill.id))).limit(1);
    const visible: SkillRevisionRow[] = [];
    for (const rev of revisions) if ((isProjectManager(access.role) || installed?.revision === rev.revision) && await skillProjectGrant(db, skill, rev, project)) visible.push(rev);
    return visible;
  }
  const visible = new Set<number>();
  const shares = await db.select().from(schema.skillShares).where(and(eq(schema.skillShares.skill_id, skill.id), isNull(schema.skillShares.revoked_at)));
  for (const share of shares) {
    if (share.target_type === 'team' && await resolveTeamRole(db, share.target_id, principalId)) for (const revision of JSON.parse(share.revisions_json) as number[]) visible.add(revision);
  }
  const installations = await db.select().from(schema.projectSkillInstallations).where(eq(schema.projectSkillInstallations.skill_id, skill.id));
  for (const install of installations) {
    if (!await resolveProjectAccess(db, install.project_id, principalId)) continue;
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, install.project_id)).limit(1);
    const rev = revisions.find(item => item.revision === install.revision);
    if (project && rev && await skillProjectGrant(db, skill, rev, project)) visible.add(rev.revision);
  }
  return revisions.filter(rev => !!rev.published_at && !skill.archived && visible.has(rev.revision));
}
