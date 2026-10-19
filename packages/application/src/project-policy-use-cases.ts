import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@team-synergy/persistence';
import { DomainError, toAuditEvent } from '@team-synergy/domain';
import { ProjectMemberPolicySchema, type ProjectMemberPolicy } from '@team-synergy/contracts';
import { assertProjectAccess, resolveProjectAccess } from './project-access.js';
import { assertWorkHandedOff } from './member-use-cases.js';
import { createPublicCode, findProjectByCode, findUserByCode } from './public-code.js';
import { fail, insertAudit, now } from './task-service.js';

export function createProjectPolicyUseCases(db: Db) {
  async function context(projectCode: string, principalCode: string) {
    const [project, principal] = await Promise.all([findProjectByCode(db, projectCode), findUserByCode(db, principalCode)]);
    if (!project || !principal) throw new DomainError('project_forbidden', '项目不存在或无访问权限');
    await assertProjectAccess(db, project.id, principal.id, 'owner');
    if (!project.owner_principal_id) throw new DomainError('ownership_pending', '请先确认唯一负责人');
    return { project, principal };
  }

  async function previewPolicy(projectCode: string, principalCode: string, requested?: ProjectMemberPolicy) {
    try {
      const { project } = await context(projectCode, principalCode);
      const policy = ProjectMemberPolicySchema.parse(requested ?? project.member_policy);
      const members = await db.select({ id: schema.teamMembers.principal_id }).from(schema.teamMembers).where(eq(schema.teamMembers.team_id, project.team_id));
      const users = members.length ? await db.select().from(schema.users).where(and(inArray(schema.users.id, members.map(row => row.id)), eq(schema.users.status, 'active'))) : [];
      const grants = await db.select().from(schema.members).where(eq(schema.members.project_id, project.id));
      const explicit = new Map(grants.map(row => [row.principal_id, row.role]));
      const inherited = (value: ProjectMemberPolicy) => value === 'private' ? null : value === 'team_read' ? 'viewer' : 'member';
      const changed = users.filter(user => !user.deleted_at && user.id !== project.owner_principal_id && !explicit.has(user.id)).map(user => ({
        user_code: user.code, display_name: user.display_name, before: inherited(project.member_policy), after: inherited(policy),
      })).filter(row => row.before !== row.after);
      return { ok: true as const, data: {
        member_policy: project.member_policy, proposed_policy: policy,
        impact: {
          gained_read: changed.filter(row => !row.before && row.after).length,
          gained_write: changed.filter(row => row.before !== 'member' && row.after === 'member').length,
          lost_write: changed.filter(row => row.before === 'member' && row.after !== 'member').length,
          lost_access: changed.filter(row => row.before && !row.after).length,
          explicit_exceptions: grants.filter(row => row.principal_id !== project.owner_principal_id).length,
        }, changes: changed,
      } };
    } catch (error) { return fail(error); }
  }

  async function updatePolicy(cmd: { projectCode: string; principalCode: string; memberPolicy: ProjectMemberPolicy }) {
    try {
      const policy = ProjectMemberPolicySchema.parse(cmd.memberPolicy);
      const { project, principal } = await context(cmd.projectCode, cmd.principalCode);
      await db.transaction(async tx => {
        await tx.select().from(schema.users).where(eq(schema.users.id, principal.id)).for('update');
        await tx.select().from(schema.teams).where(eq(schema.teams.id, project.team_id)).for('update');
        const [locked] = await tx.select().from(schema.projects).where(eq(schema.projects.id, project.id)).for('update');
        await assertProjectAccess(tx, project.id, principal.id, 'owner');
        if (!locked || !locked.owner_principal_id) throw new DomainError('ownership_pending', '请先确认唯一负责人');
        if (locked.status !== 'active') throw new DomainError('project_archived', '已归档项目不能调整访问方式');
        if (locked.member_policy === 'team_write' && policy !== 'team_write') {
          const members = await tx.select({ id: schema.teamMembers.principal_id }).from(schema.teamMembers)
            .where(eq(schema.teamMembers.team_id, locked.team_id));
          for (const member of members) {
            const access = await resolveProjectAccess(tx, locked.id, member.id);
            // Explicit grants and ownership keep their existing rights when the
            // team default changes. Inherited writers must hand off work first.
            if (access?.source === 'team' && access.role === 'member') {
              await assertWorkHandedOff(tx, locked.id, member.id);
            }
          }
        }
        await tx.update(schema.projects).set({ member_policy: policy }).where(eq(schema.projects.id, project.id));
        await insertAudit(tx, toAuditEvent({ entity_type: 'project', entity_id: project.id, principal_id: principal.id, base_snapshot: locked.current_snapshot,
          action: 'project.access_policy_changed', payload: { from: locked.member_policy, to: policy },
        }, createPublicCode(), now()));
      });
      return { ok: true as const, data: { project_code: project.code, member_policy: policy } };
    } catch (error) { return fail(error); }
  }
  return { previewPolicy, updatePolicy };
}
