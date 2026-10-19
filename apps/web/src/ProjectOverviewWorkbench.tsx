import { useLocale } from './useLocale';
import { t, formatDate } from './i18n.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  bindProjectHomeDocument, createHandoffDocument, getHandoffDocument, getProject, getProjectHome,
  listHandoffLibrary, listProjectMembers, listProjectRepositories, reviseHandoffDocument,
  type HandoffDocumentDetail, type HandoffDocumentInput, type HandoffDocumentSummary,
  type ProjectHome, type ProjectHomeDocument, type ProjectHomeSlot,
} from './api';
import { MarkdownDocument } from './MarkdownDocument';
import { canProject, roleMeta } from './projectManagement';
import { ProjectMemberManagement } from './ProjectMemberManagement';
import { projectDocumentWorkspacePath, projectFolderWorkspacePath, projectWorkspacePath, requirementWorkspacePath } from './workspaceRouting';

const HOME_SECTIONS: Array<{ slot: ProjectHomeSlot; title: string; description: string; placeholder: string }> = [
  { slot: 'overview', get title() { return t("项目说明"); }, get description() { return t("项目的目标、范围与当前重点。"); }, get placeholder() { return t("## 项目目标\n\n说明要解决的问题和期望结果。\n\n## 项目范围\n\n说明本阶段包含的工作与边界。"); } },
  { slot: 'guide', get title() { return t("参与指引"); }, get description() { return t("从准备环境到领取任务、提交与验收。"); }, get placeholder() { return t("## 准备环境\n\n说明仓库、依赖和启动方式。\n\n## 领取任务\n\n说明领取任务前需要阅读的资料与协作流程。\n\n## 提交与验收\n\n说明提交产物、测试证据和验收方式。"); } },
];

type HomeDialog = { slot: ProjectHomeSlot; mode: 'bind' | 'create' | 'edit'; document: ProjectHomeDocument | null };

export function activeHomeDocuments(documents: HandoffDocumentSummary[]): HandoffDocumentSummary[] {
  return documents.filter((document) => document.status === 'active' && (!document.source_kind || document.source_kind === 'project'));
}

export function ProjectOverviewWorkbench({ projectCode }: { projectCode: string }) {
  useLocale();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<HomeDialog | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const homeQuery = useQuery({ queryKey: ['project-home', projectCode], queryFn: () => getProjectHome(projectCode) });
  const projectQuery = useQuery({ queryKey: ['project', projectCode], queryFn: () => getProject(projectCode) });
  const membersQuery = useQuery({
    queryKey: ['project-members', projectCode],
    queryFn: () => listProjectMembers(projectCode, projectQuery.data?.member_management_supported === false),
    enabled: Boolean(projectQuery.data),
  });
  const repositoriesQuery = useQuery({ queryKey: ['project-repositories', projectCode], queryFn: () => listProjectRepositories(projectCode) });
  const project = projectQuery.data;
  const home = homeQuery.data ? { ...homeQuery.data, can_edit: homeQuery.data.can_edit && projectQuery.isSuccess && canProject(project, 'manage') } : undefined;
  const repositories = (repositoriesQuery.data ?? []).filter((repository) => repository.status === 'active');
  const members = membersQuery.data ?? [];

  async function saved(updatedHome?: ProjectHome) {
    if (updatedHome) queryClient.setQueryData(['project-home', projectCode], updatedHome);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['project-home', projectCode] }),
      queryClient.invalidateQueries({ queryKey: ['handoff-library', projectCode] }),
      queryClient.invalidateQueries({ queryKey: ['handoff-document'] }),
    ]);
    setDialog(null);
  }

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6">
      <div className="mx-auto max-w-[1360px]">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-3xl"><p className="text-[11px] font-bold tracking-[0.16em] text-cyan-700">PROJECT HOME</p><h1 className="mt-1 break-words text-2xl font-bold tracking-tight text-slate-950">{project?.name || t("项目首页")}</h1><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-500">{project?.description || t("了解项目目标、参与方式与团队规范。")}</p>{projectQuery.error && <InlineError error={projectQuery.error} />}</div>
          <nav aria-label={t("项目快捷入口")} className="flex flex-wrap gap-2"><a href={requirementWorkspacePath(projectCode)} className="ui-button ui-button-secondary">{t("需求")}</a><a href={projectWorkspacePath(projectCode, 'plan')} className="ui-button ui-button-secondary">{t("计划")}</a><a href={projectWorkspacePath(projectCode, 'board')} className="ui-button ui-button-primary">{t("任务看板")}</a><a href={projectWorkspacePath(projectCode, 'documents')} className="ui-button ui-button-secondary">{t("全部文档")}</a></nav>
        </header>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-5">
            {homeQuery.isLoading ? <p className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">{t("正在加载项目首页…")}</p> : homeQuery.error ? <div className="rounded-2xl border border-rose-200 bg-white p-5"><InlineError error={homeQuery.error} /><button type="button" onClick={() => void homeQuery.refetch()} className="ui-button ui-button-secondary mt-3">{t("重试加载")}</button></div> : home && <>{HOME_SECTIONS.map((section) => {
              const document = home[section.slot];
              return <section key={section.slot} aria-labelledby={`home-${section.slot}`} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-5 sm:px-6"><div><h2 id={`home-${section.slot}`} className="text-base font-bold text-slate-900">{section.title}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{section.description}</p></div><div className="flex flex-wrap gap-2">{document && <a href={projectDocumentWorkspacePath(projectCode, document.document_code)} className="ui-button ui-button-secondary ui-button-compact">{t("打开文档")}</a>}{home.can_edit && <><button type="button" onClick={() => setDialog({ slot: section.slot, mode: 'bind', document })} className="ui-button ui-button-secondary ui-button-compact">{document ? t("更换文档") : t("绑定已有文档")}</button><button type="button" onClick={() => setDialog({ slot: section.slot, mode: document ? 'edit' : 'create', document })} className="ui-button ui-button-secondary ui-button-compact">{document ? t("编辑正文") : t("新建文档")}</button></>}</div></header>
                <div className="p-5 sm:p-6">
                  {document ? <><div className="mb-5 flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3"><h3 className="min-w-0 break-words text-sm font-semibold text-slate-700">{document.title}</h3><span className="text-[11px] text-slate-400">r{document.revision}{document.updated_at ? ` · ${formatDate(document.updated_at)}` : ''}</span></div><div className="min-w-0 break-words">{document.content.trim() ? <MarkdownDocument content={document.content} /> : <p className="text-sm text-slate-400">{t("这份文档尚无正文。")}</p>}</div></> : <div className="rounded-xl border border-dashed border-slate-200 px-5 py-7 text-center"><p className="text-sm font-medium text-slate-600">{t("尚未设置{title}", { title: section.title })}</p><p className="mt-2 text-xs leading-6 text-slate-400">{home.can_edit ? t("可绑定文档库中的现有文档，或新建一份文档。") : t("项目负责人或管理员设置后，成员可在这里查看。")}</p></div>}
                </div>
              </section>;
            })}<ProjectStandardsSection projectCode={projectCode} home={home} /></>}
          </div>
          <aside aria-label={t("项目成员与仓库")} className="grid min-w-0 gap-5 sm:grid-cols-2 xl:grid-cols-1">
            <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold text-slate-900">{t("项目成员")}<span className="ml-2 font-normal text-slate-500">{membersQuery.isSuccess ? members.length : ''}</span></h2>{project && <button type="button" onClick={() => setMembersOpen(true)} className="ui-button ui-button-secondary ui-button-compact">{t('成员与权限')}</button>}</div>
              {projectQuery.error ? <InlineError error={projectQuery.error} /> : !project || membersQuery.isLoading ? <p className="ui-help mt-4">{t("正在加载成员…")}</p> : membersQuery.error ? <InlineError error={membersQuery.error} /> : <ul className="mt-4 space-y-3">
                {members.map((member) => <li key={member.code} className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{member.display_name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1"><span className="block break-words text-sm text-slate-700">{member.display_name}</span>{member.account && <span className="ui-meta mt-0.5 block break-all">@{member.account}</span>}{member.is_external && <span className="mt-1 block text-xs text-cyan-700">{t('外部协作')}</span>}{member.access_source === 'team' && <span className="ui-meta mt-1 block">{t('团队规则')}</span>}</span>
                  <span className={`shrink-0 text-[11px] ${member.role === 'owner' ? 'font-semibold text-cyan-700' : 'text-slate-500'}`}>{roleMeta(member.role).label}</span>
                </li>)}
                {members.length === 0 && <li className="ui-help">{t("暂无项目成员信息。")}</li>}
              </ul>}
            </section>
            <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
              <h2 className="text-sm font-bold text-slate-900">{t("代码仓库")}<span className="ml-2 font-normal text-slate-500">{repositoriesQuery.isSuccess ? repositories.length : ''}</span></h2>
              {repositoriesQuery.isLoading ? <p className="ui-help mt-4">{t("正在加载仓库…")}</p> : repositoriesQuery.error ? <InlineError error={repositoriesQuery.error} /> : <ul className="mt-4 space-y-4">
                {repositories.map((repository) => <li key={repository.code} className="min-w-0 border-b border-slate-100 pb-4 last:border-0 last:pb-0"><h3 className="break-words text-sm font-semibold text-slate-700">{repository.name}</h3>{repository.purpose && <p className="ui-help mt-1 break-words">{repository.purpose}</p>}<p className="mt-2 break-all font-mono text-[11px] leading-5 text-slate-500">{repository.remote_url}</p></li>)}
                {repositories.length === 0 && <li className="ui-help">{t("尚未关联代码仓库。")}</li>}
              </ul>}
            </section>
          </aside>
        </div>
      </div>
      {dialog && home?.can_edit && <HomeSectionDialog key={`${projectCode}-${dialog.slot}-${dialog.mode}-${dialog.document?.document_code ?? 'new'}`} projectCode={projectCode} dialog={dialog} onClose={() => setDialog(null)} onSaved={saved} />}
      {membersOpen && project && <ProjectMemberManagement project={project} onClose={() => setMembersOpen(false)} />}
    </main>
  );
}

function ProjectStandardsSection({ projectCode, home }: { projectCode: string; home: ProjectHome }) {
  useLocale();
  const folderHref = projectFolderWorkspacePath(projectCode, home.standards_folder_code);
  return <section aria-labelledby="home-standards" className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-5 sm:px-6">
      <div><h2 id="home-standards" className="text-base font-bold text-slate-900">{t("项目规范")}<span className="ml-2 text-xs font-normal text-slate-500">{t("{count} 份规范", { count: home.standards.length })}</span></h2><p className="ui-help mt-1">{t("团队共同遵循的协作约定与编码规范。")}</p></div>
      <div className="flex flex-wrap gap-2"><a href={folderHref} className="ui-button ui-button-secondary ui-button-compact">{t("打开项目规范目录")}</a>{home.can_edit && <a href={projectFolderWorkspacePath(projectCode, home.standards_folder_code, true)} className="ui-button ui-button-secondary ui-button-compact">{t("新增规范")}</a>}</div>
    </header>
    <div className="px-5 py-4 sm:px-6">
      <p className="ui-help">{t("规范记录协作与实现约定。")} <a href={requirementWorkspacePath(projectCode)} className="font-semibold text-cyan-700 underline underline-offset-2">{t("前往需求维护功能目标、业务规则和验收标准。")}</a></p>
      {home.standards.length ? <ul className="mt-3 divide-y divide-slate-100">{home.standards.map((document) => <li key={document.document_code} className="flex items-start justify-between gap-3 py-3">
        <div className="min-w-0"><h3 className="break-words text-sm font-semibold text-slate-800"><a href={projectDocumentWorkspacePath(projectCode, document.document_code)} className="hover:text-cyan-700">{document.title}</a></h3><p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-slate-500">{document.summary.trim() || t("暂无摘要，打开文档查看规范。")}</p><p className="ui-meta mt-1">r{document.revision}{document.updated_at ? ` · ${formatDate(document.updated_at)}` : ''}</p></div>
        <a href={projectDocumentWorkspacePath(projectCode, document.document_code)} aria-label={t("打开规范：{p0}", { p0: document.title })} className="ui-button ui-button-secondary ui-button-compact shrink-0">{t("打开")}</a>
      </li>)}</ul> : <div className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center"><p className="text-sm font-medium text-slate-600">{t("暂无项目规范")}</p><p className="ui-help mt-2">{home.can_edit ? t("新增规范，或在文档库中将已有文档移入“项目规范”目录。") : t("项目负责人或管理员添加规范后，成员可在这里查看。")}</p></div>}
      {home.can_edit && home.standards.length > 0 && <p className="ui-help mt-2">{t("可在文档库中编辑已有文档，将所属文件夹改为“项目规范”。")}</p>}
    </div>
  </section>;
}

function HomeSectionDialog({ projectCode, dialog, onClose, onSaved }: { projectCode: string; dialog: HomeDialog; onClose: () => void; onSaved: (home?: ProjectHome) => Promise<void> }) {
  useLocale();
  const section = HOME_SECTIONS.find((item) => item.slot === dialog.slot) ?? HOME_SECTIONS[0];
  const [pending, setPending] = useState(false);
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-3 sm:p-5" role="presentation" onMouseDown={(event) => { if (!pending && event.currentTarget === event.target) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="home-dialog-title" className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"><header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5"><div><h2 id="home-dialog-title" className="text-lg font-bold text-slate-900">{section.title} · {dialog.mode === 'bind' ? t("绑定文档") : dialog.mode === 'create' ? t("新建文档") : t("编辑正文")}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{t("首页直接引用文档库中的文档，正文更新会同步展示。")}</p></div><button type="button" disabled={pending} onClick={onClose} className="ui-button ui-button-secondary">{t("关闭")}</button></header><div className="min-h-0 overflow-y-auto p-5">
    {dialog.mode === 'bind' ? <HomeBindingForm projectCode={projectCode} slot={dialog.slot} current={dialog.document} onSaved={onSaved} onPending={setPending} /> : dialog.mode === 'edit' && dialog.document ? <ExistingHomeDocumentEditor projectCode={projectCode} documentCode={dialog.document.document_code} onSaved={onSaved} onPending={setPending} /> : <HomeDocumentForm projectCode={projectCode} slot={dialog.slot} title={section.title} placeholder={section.placeholder} onSaved={onSaved} onPending={setPending} />}
  </div></section></div>;
}

function HomeBindingForm({ projectCode, slot, current, onSaved, onPending }: { projectCode: string; slot: ProjectHomeSlot; current: ProjectHomeDocument | null; onSaved: (home?: ProjectHome) => Promise<void>; onPending: (pending: boolean) => void }) {
  useLocale();
  const [documentCode, setDocumentCode] = useState(current?.document_code ?? '');
  const libraryQuery = useQuery({ queryKey: ['handoff-library', projectCode, ''], queryFn: () => listHandoffLibrary(projectCode) });
  const documents = activeHomeDocuments(libraryQuery.data?.documents ?? []);
  const mutation = useMutation({
    mutationFn: () => bindProjectHomeDocument(projectCode, slot, documentCode || null),
    onMutate: () => onPending(true),
    onSuccess: onSaved,
    onSettled: () => onPending(false),
  });
  const validSelection = !documentCode || documents.some((document) => document.document_code === documentCode);
  return <form onSubmit={(event) => { event.preventDefault(); if (validSelection) mutation.mutate(); }} className="space-y-4"><label className="block text-sm font-semibold text-slate-700">{t("选择现有文档")}<select value={documentCode} onChange={(event) => setDocumentCode(event.target.value)} disabled={libraryQuery.isLoading || mutation.isPending} className="form-control mt-2 w-full bg-white"><option value="">{t("暂不绑定")}</option>{documents.map((document) => <option key={document.document_code} value={document.document_code}>{document.title} · r{document.current_revision}</option>)}</select></label>{libraryQuery.isLoading && <p className="text-xs text-slate-400">{t("正在加载项目文档…")}</p>}{libraryQuery.error && <InlineError error={libraryQuery.error} />}{!libraryQuery.isLoading && !libraryQuery.error && documents.length === 0 && <p className="text-sm text-slate-500">{t("文档库中还没有可用文档，可关闭后选择“新建文档”。")}</p>}<p className="text-xs leading-6 text-slate-500">{t("仅展示当前项目未归档的文档。更换或解除绑定会保留原文档。")}</p>{mutation.error && <InlineError error={mutation.error} />}<div className="flex justify-end"><button disabled={mutation.isPending || libraryQuery.isLoading || Boolean(libraryQuery.error) || !validSelection} className="ui-button ui-button-primary">{mutation.isPending ? t("保存中…") : t("保存绑定")}</button></div></form>;
}

function ExistingHomeDocumentEditor({ projectCode, documentCode, onSaved, onPending }: { projectCode: string; documentCode: string; onSaved: (home?: ProjectHome) => Promise<void>; onPending: (pending: boolean) => void }) {
  useLocale();
  const documentQuery = useQuery({ queryKey: ['home-document-editor', documentCode], queryFn: () => getHandoffDocument(documentCode), gcTime: 0, refetchOnWindowFocus: false });
  if (documentQuery.isLoading) return <p className="py-8 text-sm text-slate-400">{t("正在读取文档正文…")}</p>;
  if (documentQuery.error) return <InlineError error={documentQuery.error} />;
  if (!documentQuery.data) return null;
  if (!documentQuery.data.can_edit || documentQuery.data.status !== 'active' || !activeHomeDocuments([documentQuery.data]).length) return <p role="alert" className="text-sm text-rose-700">{t("此文档不可编辑，请关闭后重新选择文档。")}</p>;
  return <HomeDocumentForm projectCode={projectCode} existing={documentQuery.data} title={documentQuery.data.title} placeholder="" onSaved={onSaved} onPending={onPending} />;
}

function HomeDocumentForm({ projectCode, slot, existing, title: initialTitle, placeholder, onSaved, onPending }: { projectCode: string; slot?: ProjectHomeSlot; existing?: HandoffDocumentDetail; title: string; placeholder: string; onSaved: (home?: ProjectHome) => Promise<void>; onPending: (pending: boolean) => void }) {
  useLocale();
  const [title, setTitle] = useState(initialTitle);
  const [summary, setSummary] = useState(existing?.summary ?? '');
  const [content, setContent] = useState(existing?.content ?? '');
  const [changeSummary, setChangeSummary] = useState('');
  const [createdDocumentCode, setCreatedDocumentCode] = useState<string | null>(null);
  const createdDocument = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (existing) {
        const latest = await getHandoffDocument(existing.document_code);
        if (latest.current_revision !== existing.current_revision) throw new Error(t("文档已有新版本，请关闭后重新打开编辑。"));
        await reviseHandoffDocument(existing.document_code, homeDocumentRevision(latest, { title, summary, content, change_summary: changeSummary }));
        return undefined;
      }
      if (!slot) throw new Error(t("请选择首页栏目"));
      if (!createdDocument.current) {
        const saved = await createHandoffDocument(projectCode, { kind: 'doc', folder_code: null, title: title.trim(), summary: summary.trim(), content });
        createdDocument.current = saved.document_code;
        setCreatedDocumentCode(saved.document_code);
      }
      return bindProjectHomeDocument(projectCode, slot, createdDocument.current);
    },
    onMutate: () => onPending(true),
    onSuccess: onSaved,
    onSettled: () => onPending(false),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mutation.isPending && title.trim() && content.trim() && (!existing || changeSummary.trim())) mutation.mutate();
  }
  return <form onSubmit={submit} className="space-y-4"><fieldset disabled={mutation.isPending || Boolean(createdDocumentCode)} className="space-y-4"><HomeField label={t("文档标题")}><input required value={title} onChange={(event) => setTitle(event.target.value)} className="form-control w-full" /></HomeField><HomeField label={t("简要说明")}><input value={summary} onChange={(event) => setSummary(event.target.value)} className="form-control w-full" /></HomeField><HomeField label={t("正文（Markdown）")}><textarea required rows={14} value={content} onChange={(event) => setContent(event.target.value)} placeholder={placeholder} className="form-control w-full resize-y font-mono text-sm leading-6" /></HomeField>{existing && <HomeField label={t("本次变更说明")}><input required value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} placeholder={t("说明本次更新的内容")} className="form-control w-full" /></HomeField>}</fieldset>{createdDocumentCode && <p className="rounded-lg bg-cyan-50 p-3 text-xs leading-6 text-cyan-900">{t("文档已保存到文档库。若绑定失败，可重试绑定，或")}<a href={projectDocumentWorkspacePath(projectCode, createdDocumentCode)} className="underline underline-offset-2">{t("打开已保存的文档")}</a>。</p>}{mutation.error && <InlineError error={mutation.error} />}<div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><p className="text-xs text-slate-400">{existing ? t("更新将保存为原文档的新版本。") : t("新文档会同时出现在项目文档库。")}</p><button disabled={mutation.isPending || !title.trim() || !content.trim() || Boolean(existing && !changeSummary.trim())} className="ui-button ui-button-primary">{mutation.isPending ? t("保存中…") : existing ? t("保存新版本") : createdDocumentCode ? t("重试绑定") : t("创建并绑定")}</button></div></form>;
}

export function homeDocumentRevision(document: HandoffDocumentDetail, draft: Pick<HandoffDocumentInput, 'title' | 'summary' | 'content' | 'change_summary'>): HandoffDocumentInput {
  return { ...draft, title: draft.title.trim(), summary: draft.summary?.trim(), folder_code: document.folder_code, status: document.status };
}

function HomeField({ label, children }: { label: string; children: ReactNode }) {
  useLocale();
  return <label className="ui-field-label">{label}<div className="mt-2">{children}</div></label>;
}

function InlineError({ error }: { error: Error }) {
  useLocale();
  return <p role="alert" className="mt-3 break-words rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{error.message}</p>;
}
