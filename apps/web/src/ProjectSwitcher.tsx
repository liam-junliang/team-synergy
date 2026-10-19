import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { currentPrincipalCode, listProjects, listTeams, type ProjectSummary, type TeamSummary } from './api';
import { filterSwitchableProjects, isExternalProject, projectSwitchPath, projectTeamName } from './projectSwitching';
import { roleMeta } from './projectManagement';
import { navigateWorkspace } from './workspaceNavigation';
import type { WorkspaceRoute } from './workspaceRouting';
import { t } from './i18n.ts';
import { useLocale } from './useLocale';

export function ProjectSwitcherOption({ project, teams, teamMembershipKnown, selected, path, onClick }: {
  project: ProjectSummary;
  teams: TeamSummary[];
  teamMembershipKnown: boolean;
  selected: boolean;
  path: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const teamName = projectTeamName(project, teams);
  const external = isExternalProject(project, teams, teamMembershipKnown);
  const role = roleMeta(project.role);
  return <li><a href={path} aria-current={selected ? 'page' : undefined} onClick={onClick}
    className={`flex items-start gap-2 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 ${selected ? 'bg-cyan-50 text-cyan-900' : 'hover:bg-slate-50'}`}>
    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{project.name}</span><span title={teamName} className="mt-1 block truncate text-xs text-slate-500">{teamName}</span>
      <span className="mt-1.5 flex flex-wrap gap-1 text-[11px]"><span className={`rounded px-1.5 py-0.5 ${role.color}`}>{role.label}</span>{external && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700">{t('外部协作')}</span>}</span>
    </span>
    <span className="flex shrink-0 flex-col items-end gap-1 text-xs">{selected && <span className="text-cyan-700">{t('当前项目')}</span>}{project.status === 'archived' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{t('已归档')}</span>}</span>
  </a></li>;
}

export function ProjectSwitcher({ route, currentProjectName }: { route: WorkspaceRoute; currentProjectName?: string }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const popupId = useId();
  const principalCode = currentPrincipalCode();
  // The server returns all authorized projects, including direct memberships in external teams.
  const projectsQuery = useQuery({ queryKey: ['projects', 'switcher', principalCode], queryFn: () => listProjects(), enabled: open, staleTime: 30_000 });
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: listTeams, enabled: open, staleTime: 30_000 });
  const projects = projectsQuery.data ?? [];
  const teams = teamsQuery.data ?? [];
  const visible = filterSwitchableProjects(projects, teams, search);
  const currentName = currentProjectName || projects.find(project => project.code === route.projectCode)?.name || route.projectCode || t('我的项目');

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); setSearch(''); }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function close(restoreFocus = false) {
    setOpen(false);
    setSearch('');
    if (restoreFocus) triggerRef.current?.focus();
  }

  function navigate(event: MouseEvent<HTMLAnchorElement>, path: string, current = false) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    close(true);
    if (!current) navigateWorkspace(path);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!open && event.target === triggerRef.current && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); return; }
    if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const links = Array.from(resultsRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []);
    if (!links.length) return;
    const index = links.indexOf(event.target as HTMLAnchorElement);
    if (index < 0 && event.target !== searchRef.current) return;
    // Home/End keep normal caret behavior while typing in the search input.
    if (index < 0 && ['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1
      : index < 0 ? event.key === 'ArrowDown' ? 0 : links.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  }

  return <div ref={rootRef} className="relative min-w-0 max-w-36 sm:max-w-52" onKeyDown={keyboard} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) close();
  }}>
    <button ref={triggerRef} type="button" aria-label={t('切换项目')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
      title={currentName} onClick={() => { if (open) close(); else setOpen(true); }}
      className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs font-medium text-cyan-300 outline-none hover:border-cyan-500 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-cyan-400">
      <span className="truncate">{currentName}</span>
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <section id={popupId} role="dialog" aria-label={t('切换项目')} className="absolute left-0 right-auto top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-700 shadow-xl shadow-slate-950/20 sm:left-auto sm:right-0">
      <div className="border-b border-slate-100 p-3">
        <h2 className="mb-2 text-sm font-semibold text-slate-900">{t('我的项目')}</h2>
        <input ref={searchRef} type="search" aria-label={t('搜索项目或团队')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('搜索项目、团队名称或编码')} className="form-control form-control-compact w-full" />
      </div>
      <div className="max-h-80 overflow-y-auto p-2">
        {projectsQuery.isPending ? <p role="status" className="px-3 py-5 text-center text-sm text-slate-500">{t('正在读取项目…')}</p>
          : projectsQuery.error ? <div role="alert" className="space-y-2 rounded-lg bg-rose-50 p-3 text-xs text-rose-700"><p>{t('项目列表读取失败')}</p><p className="break-words">{projectsQuery.error.message}</p><button type="button" className="font-semibold underline underline-offset-2" onClick={() => void projectsQuery.refetch()}>{t('重新读取项目')}</button></div>
            : <>
              {teamsQuery.error && <div role="alert" className="mb-2 rounded-lg bg-amber-50 p-2 text-xs leading-5 text-amber-800">{t('团队名称暂时无法读取')} <button type="button" onClick={() => void teamsQuery.refetch()} className="font-semibold underline underline-offset-2">{t('重新读取团队')}</button></div>}
              {visible.length === 0 ? <p role="status" className="px-3 py-5 text-center text-sm text-slate-500">{search.trim() ? t('没有匹配的项目') : t('还没有参与的项目')}</p>
                : <ul ref={resultsRef} className="space-y-1">{visible.map(project => {
                  const selected = project.code === route.projectCode;
                  const path = projectSwitchPath(route, project.code);
                  return <ProjectSwitcherOption key={project.code} project={project} teams={teams} teamMembershipKnown={teamsQuery.isSuccess}
                    selected={selected} path={path} onClick={event => navigate(event, path, selected)} />;
                })}</ul>}
            </>}
      </div>
      <a href="/teams" onClick={event => navigate(event, '/teams')} className="block border-t border-slate-100 px-4 py-3 text-xs font-semibold text-cyan-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500">{t('管理团队与项目')}</a>
    </section>}
  </div>;
}
