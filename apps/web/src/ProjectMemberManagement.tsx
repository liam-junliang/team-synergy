import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addProjectMember, listProjectMembers, listUserDirectory, previewProjectPolicy, removeProjectMember, updateProjectMemberRole, updateProjectPolicy, type AddProjectMemberInput, type Member, type ProjectMemberPolicy, type ProjectSummary } from './api';
import { canManageMember, canProject, memberRemovalLabel, projectPolicyDescription, projectPolicyLabel, roleMeta } from './projectManagement';
import { PersonSearchSelect } from './PersonSearchSelect';
import { FormSelect } from './FormSelect';
import { WorkspaceDialog } from './WorkspaceDialog';
import { OwnershipTransferPanel } from './OwnershipTransferPanel';
import { t } from './i18n';
import { useLocale } from './useLocale';

export function ProjectMemberManagement({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  useLocale();
  const client = useQueryClient();
  const mayManage = canProject(project, 'manage_members');
  const mayManageAdmins = canProject(project, 'manage_admins');
  const actorRole = mayManageAdmins ? 'owner' : mayManage ? 'admin' : project.role;
  const [userCode, setUserCode] = useState('');
  const [role, setRole] = useState<AddProjectMemberInput['role']>('member');
  const [policy, setPolicy] = useState<ProjectMemberPolicy>(project.member_policy ?? 'private');
  const [previewedPolicy, setPreviewedPolicy] = useState<ProjectMemberPolicy | null>(null);
  const membersQuery = useQuery({ queryKey: ['project-members', project.code], queryFn: () => listProjectMembers(project.code) });
  const directory = useQuery({ queryKey: ['user-directory'], queryFn: listUserDirectory, enabled: mayManage });
  const members = membersQuery.data ?? [];
  const availableUsers = (directory.data ?? []).filter((user) => !members.some((member) => member.code === user.code));
  const roleOptions = [...(mayManageAdmins ? ['admin'] : []), 'member', 'viewer'].map((value) => ({ value, label: roleMeta(value).label }));
  async function refresh() {
    setUserCode('');
    await Promise.all(['project-members', 'project', 'projects', 'project-home', 'project-policy-preview'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  }
  const mutation = useMutation({ mutationFn: (input: { action: 'add' | 'update' | 'remove'; user: string; role?: AddProjectMemberInput['role']; inherited?: boolean }) => {
    if (input.action === 'remove') return removeProjectMember(project.code, input.user);
    if (input.action === 'add' || input.inherited) return addProjectMember(project.code, { user_code: input.user, role: input.role! });
    return updateProjectMemberRole(project.code, input.user, input.role!);
  }, onSuccess: refresh });
  const policyPreview = useQuery({ queryKey: ['project-policy-preview', project.code, policy], queryFn: () => previewProjectPolicy(project.code, policy), enabled: canProject(project, 'manage_policy') && previewedPolicy === policy && policy !== project.member_policy, staleTime: 0 });
  const policyMutation = useMutation({ mutationFn: () => updateProjectPolicy(project.code, policy), onSuccess: async () => { setPreviewedPolicy(null); await refresh(); } });
  function remove(member: Member) {
    const restores = member.is_external !== true && (project.member_policy ?? 'private') !== 'private';
    const message = restores ? t('撤销单独授权后，{name} 将恢复为{role}，仍可访问项目。', { name: member.display_name, role: roleMeta(project.member_policy === 'team_write' ? 'member' : 'viewer').label }) : t('确认移出项目成员「{name}」？', { name: member.display_name });
    if (window.confirm(message)) mutation.mutate({ action: 'remove', user: member.code });
  }
  return <WorkspaceDialog id="project-members-dialog" title={t('成员与权限')} description={project.name} size="wide" onClose={onClose}>
    <div className="space-y-5">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><h3 className="text-sm font-bold text-slate-900">{t('项目访问方式')}</h3>
        {canProject(project, 'manage_policy') ? <><FormSelect value={policy} options={(['private', 'team_read', 'team_write'] as const).map((value) => ({ value, label: projectPolicyLabel(value) }))} onChange={(value) => { setPolicy(value as ProjectMemberPolicy); setPreviewedPolicy(null); }} ariaLabel={t('项目访问方式')} placeholder={t('项目访问方式')} disabled={policyMutation.isPending} /><p className="ui-help">{projectPolicyDescription(policy)}</p>
          {policy !== (project.member_policy ?? 'private') && <div className="space-y-3"><button type="button" onClick={() => { setPreviewedPolicy(policy); void policyPreview.refetch(); }} disabled={policyPreview.isFetching || policyMutation.isPending} className="ui-button ui-button-secondary">{t('预览权限影响')}</button>
            {previewedPolicy === policy && policyPreview.isSuccess && <div role="status" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900"><p>{t('新增可读 {read} 人，新增可写 {write} 人，失去写权限 {lostWrite} 人，失去访问 {lost} 人；保留 {exceptions} 项单独授权。', { read: policyPreview.data.impact.gained_read, write: policyPreview.data.impact.gained_write, lostWrite: policyPreview.data.impact.lost_write ?? 0, lost: policyPreview.data.impact.lost_access, exceptions: policyPreview.data.impact.explicit_exceptions })}</p><button type="button" disabled={policyMutation.isPending || policyPreview.isFetching} onClick={() => policyMutation.mutate()} className="ui-button ui-button-primary">{t('确认修改访问方式')}</button></div>}
          </div>}
          {policyPreview.error && <ErrorMessage error={policyPreview.error} />}{policyMutation.error && <ErrorMessage error={policyMutation.error} />}
        </> : <><p className="text-sm font-semibold text-slate-700">{projectPolicyLabel(project.member_policy ?? 'private')}</p><p className="ui-help">{projectPolicyDescription(project.member_policy ?? 'private')}</p></>}
      </section>
      <section><h3 className="text-sm font-bold text-slate-900">{t('项目成员')} <span className="font-normal text-slate-500">{membersQuery.isSuccess ? members.length : ''}</span></h3><p className="ui-help mt-1">{t('团队规则与单独授权共同决定访问权限；单独授权优先。')}</p>
        {membersQuery.isPending && <p className="ui-help py-4">{t('正在加载成员…')}</p>}{membersQuery.error && <ErrorMessage error={membersQuery.error} />}
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">{members.map((member) => <li key={member.code} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold text-slate-800">{member.display_name}{member.account && <span className="ml-2 text-xs font-normal text-slate-500">@{member.account}</span>}</p><p className="mt-1 text-xs text-slate-500">{member.role === 'owner' ? roleMeta('owner').label : t(member.access_source === 'team' ? '团队规则' : '单独授权')}{member.is_external && <span className="ml-2 rounded bg-cyan-50 px-1.5 py-0.5 text-cyan-800">{t('外部协作')}</span>}</p></div>
          {mayManage && canManageMember(actorRole, member) ? <div className="flex min-w-0 flex-wrap items-center gap-2"><div className="w-32"><FormSelect ariaLabel={t('成员角色：{name}', { name: member.display_name })} placeholder={t('成员权限')} value={member.effective_role ?? member.role} options={roleOptions} disabled={mutation.isPending} onChange={(value) => mutation.mutate({ action: 'update', user: member.code, role: value as AddProjectMemberInput['role'], inherited: member.access_source === 'team' })} /></div>{member.access_source !== 'team' && <button type="button" disabled={mutation.isPending} onClick={() => remove(member)} className="ui-button ui-button-danger ui-button-compact">{memberRemovalLabel(member, project.member_policy ?? 'private')}</button>}</div> : <span className={`rounded-md px-2 py-1 text-xs ${roleMeta(member.effective_role ?? member.role).color}`}>{roleMeta(member.effective_role ?? member.role).label}</span>}
        </li>)}</ul>{mutation.error && <ErrorMessage error={mutation.error} />}
      </section>
      {mayManage && <form onSubmit={(event) => { event.preventDefault(); if (userCode) mutation.mutate({ action: 'add', user: userCode, role }); }} className="space-y-3 rounded-xl bg-slate-50 p-4"><h3 className="text-sm font-bold text-slate-900">{t('添加项目成员')}</h3><p className="ui-help">{t('可添加团队外用户。仅授予本项目权限，不会加入所属团队。')}</p><div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]"><PersonSearchSelect value={userCode} options={availableUsers} onChange={setUserCode} ariaLabel={t('选择项目成员')} placeholder={t('搜索并选择用户')} required size="roomy" showDetails disabled={mutation.isPending || directory.isPending || Boolean(directory.error)} /><FormSelect value={role} options={roleOptions} onChange={(value) => setRole(value as AddProjectMemberInput['role'])} ariaLabel={t('成员权限')} placeholder={t('成员权限')} disabled={mutation.isPending} /></div>{directory.error && <ErrorMessage error={directory.error} />}<button disabled={!userCode || mutation.isPending || Boolean(directory.error)} className="ui-button ui-button-primary">{t('添加成员')}</button></form>}
      <OwnershipTransferPanel scope="project" scopeCode={project.code} teamCode={project.team_code} ownerCode={project.owner_code} createdByCode={project.created_by_code} pending={project.ownership_pending} mayTransfer={canProject(project, 'transfer')} actorRole={project.role} members={members} />
    </div>
  </WorkspaceDialog>;
}

function ErrorMessage({ error }: { error: Error }) { return <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs leading-5 text-rose-700">{error.message}</p>; }
