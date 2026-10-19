import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminListProjects, adminListTeams, adminUpdateProject, adminUpdateTeam, type AdminProject, type AdminTeam } from './adminApi';
import { WorkspaceDialog } from './WorkspaceDialog';
import { SkillError } from './SkillShared';
import { t, formatDate } from './i18n';

type Selection = { kind: 'team'; item: AdminTeam } | { kind: 'project'; item: AdminProject };

export function AdminTeamsProjects() {
  const [tab, setTab] = useState<'teams' | 'projects'>('teams');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [team, setTeam] = useState<{ code: string; name: string } | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const cursor = cursors.at(-1);
  const teams = useQuery({ queryKey: ['admin-teams', query, cursor], queryFn: () => adminListTeams({ ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) }), enabled: tab === 'teams' });
  const projects = useQuery({ queryKey: ['admin-projects', query, status, team?.code, cursor], queryFn: () => adminListProjects({ ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}), ...(status ? { status } : {}), ...(team ? { team_code: team.code } : {}) }), enabled: tab === 'projects' });
  const active = tab === 'teams' ? teams : projects;
  function changeTab(next: 'teams' | 'projects') { setTab(next); setCursors([]); setTeam(null); }
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-200 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div role="tablist" aria-label={t('管理范围')} className="flex gap-2">{(['teams', 'projects'] as const).map(value => <button type="button" role="tab" aria-selected={tab === value} key={value} onClick={() => changeTab(value)} className={`ui-button ui-button-compact ${tab === value ? 'ui-button-primary' : 'ui-button-secondary'}`}>{t(value === 'teams' ? '团队' : '项目')}</button>)}</div><div className="flex items-center gap-3"><span className="text-xs text-slate-500">{t('共 {count} 项', { count: active.data?.total ?? 0 })}</span><button type="button" className="ui-button ui-button-secondary ui-button-compact" disabled={active.isFetching} onClick={() => void active.refetch()}>{t('刷新')}</button></div></div>
      <form onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursors([]); }} className="mt-4 flex flex-wrap gap-2">
        <input aria-label={t('搜索团队或项目')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('搜索名称或编码')} className="form-control min-w-40 flex-1" maxLength={200} />
        {tab === 'projects' && <select aria-label={t('项目状态')} className="form-control !w-auto" value={status} onChange={event => { setStatus(event.target.value); setCursors([]); }}><option value="">{t('全部状态')}</option><option value="active">{t('启用')}</option><option value="archived">{t('已归档')}</option></select>}
        <button type="submit" className="ui-button ui-button-secondary">{t('搜索')}</button>
      </form>
      {team && <div className="mt-3 flex items-center gap-3 text-xs text-slate-600"><span>{t('所属团队')}：{team.name}</span><button type="button" onClick={() => { setTeam(null); setCursors([]); }} className="font-semibold text-cyan-700">{t('清除筛选')}</button></div>}
    </div>
    <div className="p-4"><SkillError error={active.error} /></div>
    {active.isPending ? <p role="status" className="p-8 text-center text-sm text-slate-500">{t('正在加载…')}</p> : <>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500"><tr><th className="px-5 py-3">{t('名称 / 编码')}</th><th className="px-5 py-3">{t('负责人')}</th><th className="px-5 py-3">{t(tab === 'teams' ? '规模' : '状态')}</th><th className="px-5 py-3">{t('创建时间')}</th><th className="px-5 py-3 text-right">{t('操作')}</th></tr></thead>
        <tbody className="divide-y divide-slate-100">{tab === 'teams' ? teams.data?.items.map(item => <tr key={item.team_code}>
          <td className="max-w-72 px-5 py-4"><strong className="block break-words font-semibold text-slate-800">{item.name}</strong><code className="mt-1 block text-[11px] text-slate-400">{item.team_code}</code></td>
          <td className="px-5 py-4 text-slate-600">{item.owner_name ?? t('待指定负责人')}</td><td className="px-5 py-4 text-xs leading-6 text-slate-500">{t('{members} 人 · {projects} 项目', { members: item.members_count, projects: item.projects_count })}</td><td className="px-5 py-4 text-xs text-slate-500">{formatDate(item.created_at)}</td>
          <td className="px-5 py-4"><div className="flex justify-end gap-2"><button type="button" className="ui-button ui-button-secondary ui-button-compact" onClick={() => { setTab('projects'); setTeam({ code: item.team_code, name: item.name }); setQuery(''); setSearch(''); setCursors([]); }}>{t('查看项目')}</button><button type="button" className="ui-button ui-button-secondary ui-button-compact" onClick={() => setSelection({ kind: 'team', item })}>{t('编辑')}</button></div></td>
        </tr>) : projects.data?.items.map(item => <tr key={item.project_code}>
          <td className="max-w-72 px-5 py-4"><strong className="block break-words font-semibold text-slate-800">{item.name}</strong><span className="mt-1 block text-xs text-slate-500">{item.team_name}</span><code className="mt-1 block text-[11px] text-slate-400">{item.project_code}</code></td><td className="px-5 py-4 text-slate-600">{item.owner_name ?? t('待指定负责人')}</td>
          <td className="px-5 py-4"><span className={`rounded-md px-2 py-1 text-xs ${item.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t(item.status === 'active' ? '启用' : '已归档')}</span><span className="mt-2 block text-xs text-slate-500">{t('{count} 位成员', { count: item.members_count })}</span></td><td className="px-5 py-4 text-xs text-slate-500">{formatDate(item.created_at)}</td><td className="px-5 py-4 text-right"><button type="button" className="ui-button ui-button-secondary ui-button-compact" onClick={() => setSelection({ kind: 'project', item })}>{t('管理')}</button></td>
        </tr>)}</tbody>
      </table></div>
      {!active.data?.items.length && !active.error && <p className="p-12 text-center text-sm text-slate-500">{t('没有匹配的记录')}</p>}
      <div className="flex justify-end gap-2 border-t border-slate-100 p-4"><button type="button" className="ui-button ui-button-secondary ui-button-compact" disabled={!cursors.length} onClick={() => setCursors(value => value.slice(0, -1))}>{t('上一页')}</button><button type="button" className="ui-button ui-button-secondary ui-button-compact" disabled={!active.data?.next_cursor} onClick={() => { const next = active.data?.next_cursor; if (next) setCursors(value => [...value, next]); }}>{t('下一页')}</button></div>
    </>}
    {selection && <AdminEditDialog key={selection.kind === 'team' ? selection.item.team_code : selection.item.project_code} selection={selection} onClose={() => setSelection(null)} />}
  </section>;
}

export function AdminEditDialog({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(selection.item.name);
  const [description, setDescription] = useState(selection.kind === 'project' ? selection.item.description ?? '' : '');
  const [status, setStatus] = useState<'active' | 'archived'>(selection.kind === 'project' ? selection.item.status : 'active');
  const [reason, setReason] = useState('');
  const mutation = useMutation({ mutationFn: () => selection.kind === 'team' ? adminUpdateTeam(selection.item.team_code, { name: name.trim(), reason: reason.trim() }) : adminUpdateProject(selection.item.project_code, { name: name.trim(), description: description.trim() || null, status, reason: reason.trim(), base_snapshot: selection.item.current_snapshot }), onSuccess: async () => {
    await Promise.all(['admin-teams', 'admin-projects', 'teams', 'projects', 'project'].map(key => queryClient.invalidateQueries({ queryKey: [key] }))); onClose();
  } });
  function submit(event: FormEvent) { event.preventDefault(); if (name.trim() && reason.trim()) mutation.mutate(); }
  return <WorkspaceDialog id="admin-resource-edit" title={t(selection.kind === 'team' ? '编辑团队' : '管理项目')} description={t('管理操作会记录审计日志，请说明调整原因。')} onClose={() => { if (!mutation.isPending) onClose(); }}>
    <form className="space-y-4" onSubmit={submit}>
      <label className="ui-field-label block">{t('名称')}<input className="form-control mt-2" required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label>
      {selection.kind === 'project' && <><label className="ui-field-label block">{t('项目说明')}<textarea className="form-control mt-2" rows={4} value={description} onChange={event => setDescription(event.target.value)} maxLength={10000} /></label><label className="ui-field-label block">{t('项目状态')}<select className="form-control mt-2" value={status} onChange={event => setStatus(event.target.value as 'active' | 'archived')}><option value="active">{t('启用')}</option><option value="archived">{t('已归档')}</option></select></label>{status === 'archived' && <p className="text-xs leading-5 text-amber-700">{t('归档后项目进入只读状态；恢复后成员可继续操作。')}</p>}</>}
      <label className="ui-field-label block">{t('调整原因')}<textarea required maxLength={1000} className="form-control mt-2" rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <SkillError error={mutation.error} />
      <div className="flex justify-end gap-2"><button type="button" disabled={mutation.isPending} onClick={onClose} className="ui-button ui-button-secondary">{t('取消')}</button><button type="submit" disabled={mutation.isPending || !name.trim() || !reason.trim()} className="ui-button ui-button-primary">{mutation.isPending ? t('保存中…') : t('保存')}</button></div>
    </form>
  </WorkspaceDialog>;
}
