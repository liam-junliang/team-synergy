import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError } from '@team-synergy/domain';
import type { MemberRole, TeamRole } from '@team-synergy/contracts';

export type AccessDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
export type ProjectAccess = { role: MemberRole; source: 'owner' | 'explicit' | 'team'; isExternal: boolean };

export function isProjectManager(role: string | undefined): boolean { return role === 'owner' || role === 'admin'; }
export function projectCapabilities(role: string | undefined) {
  const read = ['owner', 'admin', 'member', 'viewer'].includes(role ?? '');
  const manage = isProjectManager(role);
  return { read, write: read && role !== 'viewer', manage, manage_members: manage, manage_admins: role === 'owner', manage_policy: role === 'owner', transfer: role === 'owner', archive: role === 'owner' };
}

export async function resolveTeamRole(db: AccessDb, teamId: bigint, principalId: bigint): Promise<TeamRole | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, principalId)).limit(1);
  if (!user || user.status !== 'active' || user.deleted_at) return null;
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)).limit(1);
  if (!team) return null;
  if (team.owner_principal_id === principalId) return 'owner';
  const [member] = await db.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, teamId), eq(schema.teamMembers.principal_id, principalId))).limit(1);
  if (!member) return null;
  // Legacy multiple-owner records remain manageable until explicitly resolved.
  return member.role === 'owner' && team.owner_principal_id !== null ? 'admin' : member.role;
}

export async function resolveProjectAccess(db: AccessDb, projectId: bigint, principalId: bigint): Promise<ProjectAccess | null> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, principalId)).limit(1);
  if (!user || user.status !== 'active' || user.deleted_at) return null;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!project) return null;
  const [teamMember] = await db.select().from(schema.teamMembers).where(and(eq(schema.teamMembers.team_id, project.team_id), eq(schema.teamMembers.principal_id, principalId))).limit(1);
  const isExternal = !teamMember;
  if (project.owner_principal_id === principalId) return { role: 'owner', source: 'owner', isExternal };
  const [member] = await db.select().from(schema.members).where(and(eq(schema.members.project_id, projectId), eq(schema.members.principal_id, principalId))).limit(1);
  if (member) {
    const role = member.role === 'owner' && project.owner_principal_id !== null ? 'admin' : member.role;
    return { role, source: role === 'owner' ? 'owner' : 'explicit', isExternal };
  }
  if (teamMember && project.member_policy !== 'private') return { role: project.member_policy === 'team_write' ? 'member' : 'viewer', source: 'team', isExternal: false };
  return null;
}

/** A compatible member shape for existing object rules, including inherited access. */
export async function effectiveProjectMember(db: AccessDb, projectId: bigint, principalId: bigint) {
  const access = await resolveProjectAccess(db, projectId, principalId);
  if (!access) return undefined;
  return { principal_id: principalId, project_id: projectId, role: access.role, display_name: '', sort_order: 0, created_at: '', access_source: access.source, is_external: access.isExternal };
}

export async function assertProjectAccess(db: AccessDb, projectId: bigint, principalId: bigint, capability: 'read' | 'write' | 'manage' | 'owner' = 'read') {
  const access = await resolveProjectAccess(db, projectId, principalId);
  if (!access || (capability === 'write' && access.role === 'viewer') || (capability === 'manage' && !isProjectManager(access.role)) || (capability === 'owner' && access.role !== 'owner')) {
    throw new DomainError('project_forbidden', '当前项目权限不足');
  }
  if (capability === 'write' || capability === 'manage') {
    const [project] = await db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (project?.status !== 'active') throw new DomainError('project_archived', '项目已归档，不能修改内容');
  }
  return access;
}
