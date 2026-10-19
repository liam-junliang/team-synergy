import { t, getLocale, type Locale } from './i18n.ts';
import type { AccessCapabilities, CreateProjectInput, Member, ProjectMemberPolicy, ProjectSummary, UpdateProjectInput } from './api';

export interface RoleMeta {
  label: string;
  color: string;
}

const UNKNOWN_ROLE: RoleMeta = { get label() { return t("成员"); }, color: 'bg-slate-100 text-slate-600' };

export function roleMeta(role: string): RoleMeta {
  const labels = getLocale() === 'en-US'
    ? { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }
    : { owner: '负责人', admin: '管理员', member: '成员', viewer: '观看者' };
  switch (role.toLowerCase()) {
    case 'owner':
      return { label: labels.owner, color: 'bg-amber-100 text-amber-800' };
    case 'admin':
      return { label: labels.admin, color: 'bg-violet-100 text-violet-700' };
    case 'member':
      return { label: labels.member, color: 'bg-cyan-100 text-cyan-700' };
    case 'viewer':
      return { label: labels.viewer, color: 'bg-slate-100 text-slate-600' };
    default:
      return { ...UNKNOWN_ROLE, label: role || UNKNOWN_ROLE.label };
  }
}

export function sortProjects(projects: readonly ProjectSummary[], locale: Locale = getLocale()): ProjectSummary[] {
  return [...projects].sort((left, right) => {
    if (left.role === 'owner' && right.role !== 'owner') return -1;
    if (left.role !== 'owner' && right.role === 'owner') return 1;
    return left.name.localeCompare(right.name, locale) || left.code.localeCompare(right.code);
  });
}

export function moveItemByCode<T extends { code: string }>(items: readonly T[], sourceCode: string, targetCode: string): T[] {
  const sourceIndex = items.findIndex((item) => item.code === sourceCode);
  const targetIndex = items.findIndex((item) => item.code === targetCode);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return [...items];
  const reordered = [...items];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  return reordered;
}

export function moveItemByOffset<T extends { code: string }>(items: readonly T[], code: string, offset: -1 | 1): T[] {
  const sourceIndex = items.findIndex((item) => item.code === code);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= items.length) return [...items];
  return moveItemByCode(items, code, items[targetIndex].code);
}

export function supportsProjectMemberManagement(project: { code?: string; project_code?: string; members_count?: number }): boolean {
  return typeof project.code === 'string' || typeof project.project_code === 'string' || project.members_count !== undefined;
}

export function projectCreatePayload(input: CreateProjectInput): CreateProjectInput {
  return {
    team_code: input.team_code,
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    member_policy: input.member_policy ?? 'team_read',
  };
}

/** Server capabilities are authoritative; role fallback supports older read responses. */
export function canProject(project: Pick<ProjectSummary, 'role' | 'capabilities' | 'status' | 'ownership_pending'> | undefined, capability: keyof AccessCapabilities): boolean {
  if (!project) return false;
  if (project.capabilities) return project.capabilities[capability] === true;
  const role = project.role;
  if (capability === 'read') return ['owner', 'admin', 'member', 'viewer'].includes(role);
  if (['transfer', 'archive', 'manage_policy', 'manage_admins'].includes(capability)) return role === 'owner' && !project.ownership_pending;
  if (project.status === 'archived') return false;
  if (capability === 'write') return ['owner', 'admin', 'member'].includes(role);
  return role === 'owner' || role === 'admin';
}

export function canManageMember(actorRole: string, member: Pick<Member, 'role' | 'effective_role'>): boolean {
  const role = member.effective_role ?? member.role;
  return role !== 'owner' && (actorRole === 'owner' || (actorRole === 'admin' && role !== 'admin'));
}

export function memberRemovalLabel(member: Member, policy: ProjectMemberPolicy): string {
  if (policy === 'private' || member.is_external === true) return t('移出项目');
  return member.is_external === false ? t('恢复团队默认权限') : t('撤销单独授权');
}

export function projectPolicyLabel(policy: ProjectMemberPolicy): string {
  return t(policy === 'private' ? '仅指定成员' : policy === 'team_write' ? '团队共同协作' : '团队可读，指定成员协作');
}

export function projectPolicyDescription(policy: ProjectMemberPolicy): string {
  return t(policy === 'private' ? '仅单独授权的成员可以访问。' : policy === 'team_write' ? '团队成员默认可协作；单独配置的观看者仍然只读。' : '团队成员默认只读，单独授权的成员可以协作。');
}

export function projectUpdatePayload(input: UpdateProjectInput): UpdateProjectInput {
  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
  };
}
