import { useProjectAccess } from './useProjectAccess';
import { t, getLocale, systemFolderName } from './i18n.ts';
import { useLocale } from './useLocale';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode, type Ref } from 'react';
import {
  createHandoffDocument,
  createHandoffFolder,
  getHandoffDocument,
  listHandoffLibrary,
  reviseHandoffDocument,
  updateHandoffFolder,
  type HandoffDocumentDetail,
  type HandoffDocumentRevision,
  type HandoffDocumentInput,
  type HandoffDocumentKind,
  type HandoffDocumentSummary,
  type HandoffFolder,
  type ArchitectureDocumentDetail,
  type TestAssetDetail,
} from './api';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { MarkdownDocument } from './MarkdownDocument';
import { ArchitectureDocumentEditor, ArchitectureDocumentReader } from './ArchitectureWorkbench';
import { TestAssetEditor, TestAssetReader } from './TestAssets';
import { DocumentVersionHistory as ProjectDocumentHistory, formatDocumentDate as formatDate } from './DocumentVersionHistory';
import { DocumentReaderHeader } from './DocumentReaderHeader';
import { projectHomeWorkspacePath, requirementWorkspacePath, testingWorkspacePath } from './workspaceRouting';
export { MarkdownDocument } from './MarkdownDocument';
export { DocumentVersionHistory as ProjectDocumentHistory } from './DocumentVersionHistory';

export function ProjectDocumentsWorkbench({ projectCode, projectId, documentCode, folderCode, createDocument = false }: { projectCode?: string; projectId?: string; documentCode?: string; folderCode?: string; createDocument?: boolean }) {
  useLocale();
  const { projectName, memberName } = useProjectDisplayNames();
  const queryClient = useQueryClient();
  const activeProjectCode = projectCode ?? projectId ?? '';
  const { canWrite } = useProjectAccess(activeProjectCode);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedDocumentCode, setSelectedDocumentCode] = useState<string | null>(documentCode ?? null);
  const [selectedFolderCode, setSelectedFolderCode] = useState<string | null>(folderCode ?? null);
  const [collapsedFolderCodes, setCollapsedFolderCodes] = useState<Set<string>>(() => new Set());
  const [viewRevision, setViewRevision] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dialog, setDialog] = useState<'folder' | 'document' | null>(createDocument ? 'document' : null);
  const [editingFolder, setEditingFolder] = useState<HandoffFolder | null>(null);
  const [editingDocument, setEditingDocument] = useState<HandoffDocumentDetail | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderParent, setFolderParent] = useState<string | null>(null);
  const [documentDraft, setDocumentDraft] = useState<HandoffDocumentInput>({
    folder_code: folderCode ?? null, kind: 'doc', title: '', summary: '', content: '',
  });
  const documentPaneRef = useRef<HTMLElement>(null);
  const historyToggleRef = useRef<HTMLButtonElement>(null);

  const libraryQuery = useQuery({
    queryKey: ['handoff-library', activeProjectCode, deferredQuery],
    queryFn: () => listHandoffLibrary(activeProjectCode, deferredQuery),
    enabled: Boolean(activeProjectCode),
  });
  const library = useMemo(() => libraryQuery.data ? { ...libraryQuery.data, can_create: canWrite && libraryQuery.data.can_create, folders: libraryQuery.data.folders.map(folder => ({ ...folder, can_edit: canWrite && folder.can_edit })) } : undefined, [libraryQuery.data, canWrite]);
  const activeFolders = useMemo(() => library?.folders.filter((folder) => folder.status === 'active') ?? [], [library]);
  const folderParents = useMemo(() => handoffFolderParents(activeFolders, editingFolder), [activeFolders, editingFolder]);
  const documentFolders = useMemo(() => activeFolders.filter((folder) => !isSourceDocumentFolder(activeFolders, folder.folder_code)), [activeFolders]);
  const activeDocuments = useMemo(() => library?.documents.filter((document) => document.status === 'active') ?? [], [library]);
  const folderDocuments = useMemo(() => handoffFolderDocuments(activeDocuments, activeFolders, selectedFolderCode), [activeDocuments, activeFolders, selectedFolderCode]);
  const selectedFolder = activeFolders.find((folder) => folder.folder_code === selectedFolderCode);
  const missingFolder = Boolean(selectedFolderCode && !selectedFolder);
  const selectedSystemRole = handoffSystemFolderRole(activeFolders, selectedFolderCode);
  const sourceFolderSelected = isSourceDocumentFolder(activeFolders, selectedFolderCode);
  const effectiveDocumentCode = selectedDocumentCode ?? folderDocuments[0]?.document_code ?? null;

  useEffect(() => {
    if (!library || (documentCode && selectedDocumentCode === documentCode)) return;
    if (selectedDocumentCode && folderDocuments.some((document) => document.document_code === selectedDocumentCode)) return;
    setSelectedDocumentCode(folderDocuments[0]?.document_code ?? null);
  }, [folderDocuments, documentCode, library, selectedDocumentCode]);

  const documentQuery = useQuery({
    queryKey: ['handoff-document', effectiveDocumentCode],
    queryFn: () => getHandoffDocument(effectiveDocumentCode!),
    enabled: Boolean(effectiveDocumentCode),
  });
  const documentProjectMismatch = Boolean(documentQuery.data && documentQuery.data.project_code !== activeProjectCode);
  const document = documentProjectMismatch || !documentQuery.data ? undefined : { ...documentQuery.data, can_edit: canWrite && documentQuery.data.can_edit, source_can_edit: canWrite && documentQuery.data.source_can_edit };
  const documentFolder = activeFolders.find(folder => folder.folder_code === document?.folder_code);

  useEffect(() => {
    setViewRevision(null);
    setHistoryOpen(false);
    documentPaneRef.current?.scrollTo({ top: 0 });
  }, [effectiveDocumentCode]);

  useEffect(() => {
    const selectedDocument = activeDocuments.find((item) => item.document_code === effectiveDocumentCode);
    if (!selectedDocument?.folder_code) return;
    const folderByCode = new Map(activeFolders.map((folder) => [folder.folder_code, folder]));
    const pathCodes = new Set<string>();
    let folderCode: string | null = selectedDocument.folder_code;
    while (folderCode && !pathCodes.has(folderCode)) {
      pathCodes.add(folderCode);
      folderCode = folderByCode.get(folderCode)?.parent_folder_code ?? null;
    }
    setCollapsedFolderCodes((current) => {
      if (![...pathCodes].some((code) => current.has(code))) return current;
      const next = new Set(current);
      pathCodes.forEach((code) => next.delete(code));
      return next;
    });
  }, [activeDocuments, activeFolders, effectiveDocumentCode]);

  const folderMutation = useMutation({
    mutationFn: () => editingFolder
      ? updateHandoffFolder(editingFolder.folder_code, { name: folderName.trim(), parent_folder_code: folderParent })
      : createHandoffFolder(activeProjectCode, { name: folderName.trim(), parent_folder_code: folderParent }),
    onSuccess: async (folder) => {
      setSelectedFolderCode(folder.folder_code);
      setSelectedDocumentCode(null);
      setDialog(null);
      await invalidateProjectDocumentQueries(queryClient, activeProjectCode);
    },
  });

  const documentMutation = useMutation({
    mutationFn: () => editingDocument
      ? reviseHandoffDocument(editingDocument.document_code, handoffRevisionInput(editingDocument, documentDraft))
      : createHandoffDocument(activeProjectCode, documentDraft),
    onSuccess: async (saved) => {
      setSelectedDocumentCode(saved.document_code);
      setSelectedFolderCode(saved.folder_code);
      setDialog(null);
      await invalidateProjectDocumentQueries(queryClient, activeProjectCode, saved.document_code);
    },
  });

  function openFolderDialog(folder?: HandoffFolder, parentCode: string | null = selectedFolderCode) {
    if (folder?.system_role || (!folder && !canCreateHandoffSubfolder(activeFolders, parentCode))) return;
    setEditingFolder(folder ?? null);
    setFolderName(folder?.name ?? '');
    setFolderParent(folder ? folder.parent_folder_code : parentCode);
    folderMutation.reset();
    setDialog('folder');
  }

  function openDocumentDialog(current?: HandoffDocumentDetail) {
    if (isSourceDocument(current) || isSourceDocumentFolder(activeFolders, current?.folder_code ?? selectedFolderCode)) return;
    setEditingDocument(current ?? null);
    setDocumentDraft(current ? {
      folder_code: current.folder_code,
      kind: canonicalDocumentKind(current.kind),
      title: current.title,
      summary: current.summary,
      content: current.content,
      change_summary: '',
      status: current.status,
    } : {
      folder_code: selectedFolderCode,
      kind: 'doc',
      title: '',
      summary: '',
      content: '',
    });
    documentMutation.reset();
    setDialog('document');
  }

  function submitFolder(event: FormEvent) {
    event.preventDefault();
    if (editingFolder ? !editingFolder.can_edit || Boolean(editingFolder.system_role) : !library?.can_create) return;
    if (folderParent && !folderParents.some((folder) => folder.folder_code === folderParent)) return;
    folderMutation.mutate();
  }

  function submitDocument(event: FormEvent) {
    event.preventDefault();
    if (editingDocument ? !editingDocument.can_edit || isSourceDocument(editingDocument) : !library?.can_create) return;
    if (documentDraft.folder_code && !documentFolders.some((folder) => folder.folder_code === documentDraft.folder_code)) return;
    documentMutation.mutate();
  }

  function loadMarkdownFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    void file.text().then((content) => setDocumentDraft((current) => ({
      ...current,
      content,
      title: current.title || file.name.replace(/\.(md|markdown|txt)$/i, ''),
    })));
  }

  function toggleFolder(folderCode: string) {
    setCollapsedFolderCodes((current) => {
      const next = new Set(current);
      if (next.has(folderCode)) next.delete(folderCode);
      else next.add(folderCode);
      return next;
    });
  }

  function renderDocuments(folderCode: string | null, depth: number) {
    return activeDocuments.filter((item) => item.folder_code === folderCode).map((item) => (
      <button
        key={item.document_code}
        type="button"
        onClick={() => {
          setSelectedFolderCode(item.folder_code);
          setSelectedDocumentCode(item.document_code);
        }}
        style={{ paddingLeft: 14 + depth * 14 }}
        className={`group flex w-full items-start gap-2 border-l-2 py-2 pr-2 text-left transition ${effectiveDocumentCode === item.document_code ? 'border-cyan-600 bg-cyan-50 text-cyan-950' : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-950'}`}
      >
        <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[11px] font-semibold ${kindMeta[canonicalDocumentKind(item.kind)].badge}`}>{kindMeta[canonicalDocumentKind(item.kind)].short}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{item.title}</span>
          <span className="mt-0.5 block text-[10px] text-slate-400">r{item.current_revision}</span>
        </span>
      </button>
    ));
  }

  function renderFolders(parentCode: string | null, depth = 0): ReactNode[] {
    return activeFolders.filter((folder) => folder.parent_folder_code === parentCode).flatMap((folder) => {
      const expanded = Boolean(deferredQuery.trim()) || !collapsedFolderCodes.has(folder.folder_code);
      return [<div key={`folder-${folder.folder_code}`}>
        <div
          style={{ paddingLeft: 10 + depth * 14 }}
          className={`group flex items-center gap-2 py-2 pr-2 ${selectedFolderCode === folder.folder_code ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
        >
          <button
            type="button"
            onClick={() => toggleFolder(folder.folder_code)}
            aria-label={t("{0}文件夹 {1}", { "0": expanded ? t('收起') : t('展开'), "1": systemFolderName(folder) })}
            aria-expanded={expanded}
            title={expanded ? t("收起文件夹") : t("展开文件夹")}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-[11px] text-slate-400 hover:bg-white hover:text-slate-700"
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button type="button" aria-current={selectedFolderCode === folder.folder_code ? 'location' : undefined} onClick={() => { setSelectedFolderCode(folder.folder_code); setSelectedDocumentCode(null); setDialog(null); }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-bold text-slate-700">
            <DocumentTreeIcon /><span className="truncate">{systemFolderName(folder)}</span>
          </button>
          {folder.system_role && <span className="ui-meta shrink-0" title={t("系统固定目录，不可改名、移动、删除或新建子文件夹")}>{t("系统")}</span>}
          {library?.can_create && canCreateHandoffSubfolder(activeFolders, folder.folder_code) && <button type="button" aria-label={t("在{0}下新建文件夹", { "0": systemFolderName(folder) })} title={t("新建子文件夹")} onClick={() => openFolderDialog(undefined, folder.folder_code)} className="rounded px-1 text-xs text-slate-500 hover:bg-white hover:text-cyan-700">＋</button>}
          {folder.can_edit && !folder.system_role && <button type="button" title={t("编辑文件夹")} onClick={() => openFolderDialog(folder)} className="invisible rounded px-1 text-xs text-slate-400 hover:bg-white hover:text-cyan-700 group-hover:visible">•••</button>}
        </div>
        {expanded && renderDocuments(folder.folder_code, depth + 1)}
        {expanded && renderFolders(folder.folder_code, depth + 1)}
      </div>];
    });
  }

  if (libraryQuery.isLoading) return <div className="grid flex-1 place-items-center text-sm text-slate-500">{t("正在加载项目文档库…")}</div>;
  if (libraryQuery.error) return <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{t("项目文档库加载失败：{0}", { "0": libraryQuery.error.message })}</div>;

  return (
    <main className="min-h-0 flex-1 overflow-hidden bg-slate-50 p-4 lg:p-6">
      <section className="mx-auto flex h-full min-h-[620px] max-w-[1640px] flex-col">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-cyan-700">PROJECT HANDOFF</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{t("{0} · 文档", { "0": projectName || t('项目') })}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("统一查阅项目规范、需求、架构与其他文档，正文和版本与业务页面同步。")}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">{t("{0} 文件夹 · {1} 文档", { "0": activeFolders.length, "1": activeDocuments.length })}</span>
            {library?.can_create && <button type="button" disabled={missingFolder || !canCreateHandoffSubfolder(activeFolders, selectedFolderCode)} onClick={() => openFolderDialog()} className="ui-button ui-button-secondary">{t("新建文件夹")}</button>}
            {library?.can_create && <button type="button" disabled={missingFolder || sourceFolderSelected} onClick={() => openDocumentDialog()} className="ui-button ui-button-primary">{t("新建文档")}</button>}
          </div>
        </header>
        {missingFolder && <p role="alert" className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{t("该文件夹不存在或已归档，请从文档库重新选择。")}</p>}
        {selectedSystemRole === 'standards' && <p className="mb-4 text-sm leading-6 text-slate-500">{t("项目规范为固定目录，可添加和编辑规范文档，不能新建子文件夹；已有子目录和文档继续保留。")}</p>}
        {selectedSystemRole === 'requirements' && <p className="mb-4 text-sm leading-6 text-slate-500">{t("需求文档在此自动归集，可直接阅读正文和历史版本。新增与编辑请前往")}<a href={requirementWorkspacePath(activeProjectCode, { tab: 'documents' })} className="ml-1 font-medium text-cyan-700 hover:text-cyan-900">{t("需求文档页面")}</a>{getLocale() === 'zh-CN' ? '。' : '.'}</p>}
        {selectedSystemRole === 'architecture' && <p className="mb-4 text-sm leading-6 text-slate-500">{t("架构设计在此自动归集，图源、说明和历史版本与项目页面同步，可直接阅读和编辑。新增请前往")}<a href={projectHomeWorkspacePath(activeProjectCode, 'architecture')} className="ml-1 font-medium text-cyan-700 hover:text-cyan-900">{t("架构设计页面")}</a>{getLocale() === 'zh-CN' ? '。' : '.'}</p>}

        {selectedSystemRole === 'testing' && <p className="mb-4 text-sm leading-6 text-slate-500">{t('测试资料在此自动归集，内容与历史版本保持同步。新增请前往')}<a href={testingWorkspacePath(activeProjectCode, 'assets')} className="ml-1 font-medium text-cyan-700 hover:text-cyan-900">{t('测试页面')}</a></p>}
        <div className={`relative grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ${historyOpen && document && !['architecture', 'testing'].includes(document.source_kind ?? '') ? 'xl:grid-cols-[260px_minmax(0,1fr)_240px]' : ''}`}>
          <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-3">
              <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-400 focus-within:border-cyan-500 focus-within:bg-white">
                <span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索项目文档")} className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none" />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-2">
              <div className={`group flex items-center gap-2 px-3 py-2 ${selectedFolderCode === null ? 'bg-slate-100' : 'hover:bg-slate-50'}`}>
                <button type="button" onClick={() => { setSelectedFolderCode(null); setSelectedDocumentCode(null); setDialog(null); }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-bold text-slate-700"><DocumentTreeIcon library />{t("文档库")}</button>
                {library?.can_create && <button type="button" title={t("在根目录新建文件夹")} onClick={() => openFolderDialog(undefined, null)} className="invisible rounded px-1 text-slate-400 hover:bg-white group-hover:visible">＋</button>}
              </div>
              {renderDocuments(null, 0)}
              {renderFolders(null)}
              {activeDocuments.length === 0 && <p className="px-4 py-8 text-center text-xs leading-5 text-slate-400">{t("还没有项目文档")}<br />{t("从文件夹或文档开始整理")}</p>}
            </div>
          </aside>

          <section ref={documentPaneRef} className="min-h-0 min-w-0 overflow-y-auto bg-white">
            {documentQuery.isLoading ? <div className="grid h-full place-items-center text-sm text-slate-400">{t("正在读取文档…")}</div> : documentProjectMismatch || documentQuery.error ? <div role="alert" className="m-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{documentProjectMismatch ? t("该文档不属于当前项目，请从文档库重新选择。") : t("读取文档失败：{0}", { "0": documentQuery.error?.message ?? '' })}</div> : document ? (() => {
              if (document.source_kind === 'architecture') return <ProjectArchitectureDocument key={document.document_code} document={document} />;
              if (document.source_kind === 'testing') return <ProjectTestingDocument key={document.document_code} document={document} />;
              const historical = viewRevision === null ? null : document.revisions.find((revision) => revision.revision === viewRevision) ?? null;
              const shownContent = historical?.content ?? document.content;
              return <article>
                <ProjectDocumentHeader document={document} historical={historical} folderLabel={documentFolder ? systemFolderName(documentFolder) : undefined} historyOpen={historyOpen} historyToggleRef={historyToggleRef}
                  authorName={memberName(historical?.created_by_user_code ?? document.updated_by_user_code ?? '')}
                  onToggleHistory={() => setHistoryOpen(open => !open)} onReturnCurrent={() => setViewRevision(null)} onEdit={() => openDocumentDialog(document)} />
                <div className="mx-auto max-w-[920px] px-4 py-6 sm:px-6 lg:px-8"><MarkdownDocument content={shownContent} outline={historical ? undefined : document.outline} /></div>
              </article>;
            })() : <div className="grid h-full place-items-center px-8 text-center"><div><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-cyan-50 text-2xl text-cyan-700">{t("文")}</div><h2 className="mt-4 text-lg font-bold text-slate-900">{t("选择一份项目文档")}</h2><p className="mt-2 text-sm text-slate-500">{t("从左侧目录查阅，或新建接口、部署、数据等项目资料。")}</p></div></div>}
          </section>

          {historyOpen && document && !['architecture', 'testing'].includes(document.source_kind ?? '') && <ProjectDocumentHistory document={document} viewRevision={viewRevision} onSelect={setViewRevision}
            onClose={() => { setHistoryOpen(false); historyToggleRef.current?.focus(); }} />}
        </div>
      </section>

      {canWrite && dialog === 'folder' && <Dialog title={editingFolder ? t("编辑文件夹") : t("新建文件夹")} onClose={() => setDialog(null)}>
        <form onSubmit={submitFolder} className="space-y-4">
          <label className="ui-field-label block">{t("文件夹名称")}<input autoFocus required value={folderName} onChange={(event) => setFolderName(event.target.value)} className="form-control mt-1.5" /></label>
          <label className="ui-field-label block">{t("上级文件夹")}<select value={folderParent ?? ''} onChange={(event) => setFolderParent(event.target.value || null)} className="form-control mt-1.5"><option value="">{t("文档库根目录")}</option>{folderParents.filter((folder) => folder.folder_code !== editingFolder?.folder_code).map((folder) => <option key={folder.folder_code} value={folder.folder_code}>{systemFolderName(folder)}</option>)}</select></label>
          {folderMutation.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{folderMutation.error.message}</p>}
          <DialogActions pending={folderMutation.isPending} disabled={!folderName.trim()} onCancel={() => setDialog(null)} label={editingFolder ? t("保存修改") : t("创建文件夹")} />
        </form>
      </Dialog>}

      {canWrite && dialog === 'document' && !missingFolder && !sourceFolderSelected && !isSourceDocument(editingDocument) && (editingDocument?.can_edit || library?.can_create) && <Dialog title={editingDocument ? t("编辑项目文档") : t("新建项目文档")} wide onClose={() => setDialog(null)}>
        <form onSubmit={submitDocument} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <label className="ui-field-label block">{t("文档类型")}<select value={documentDraft.kind} onChange={(event) => setDocumentDraft((current) => ({ ...current, kind: event.target.value as HandoffDocumentKind }))} className="form-control mt-1.5">{Object.entries(kindMeta).map(([kind, meta]) => <option key={kind} value={kind}>{t(meta.label)}</option>)}</select></label>
            <label className="ui-field-label block">{t("所属文件夹")}<select value={documentDraft.folder_code ?? ''} onChange={(event) => setDocumentDraft((current) => ({ ...current, folder_code: event.target.value || null }))} className="form-control mt-1.5"><option value="">{t("文档库根目录")}</option>{documentFolders.map((folder) => <option key={folder.folder_code} value={folder.folder_code}>{systemFolderName(folder)}</option>)}</select></label>
          </div>
          {documentDraft.kind === 'diagram' && <p className="ui-help">{t("使用 Markdown 的 Mermaid 代码块编写图表；需要 draw.io 或独立图源版本时，在项目的架构设计中创建。")}</p>}
          <label className="ui-field-label block">{t("标题")}<input autoFocus required value={documentDraft.title} onChange={(event) => setDocumentDraft((current) => ({ ...current, title: event.target.value }))} className="form-control mt-1.5" /></label>
          <label className="ui-field-label block">{t("摘要")}<input value={documentDraft.summary ?? ''} onChange={(event) => setDocumentDraft((current) => ({ ...current, summary: event.target.value }))} placeholder={t("说明这份文档解决什么协作问题，帮助 Agent 快速判断是否需要读取")} className="form-control mt-1.5" /></label>
          <div className="flex items-center justify-between"><span className="ui-field-label">{t("Markdown 正文")}</span><label className="cursor-pointer text-xs font-bold text-cyan-700 hover:text-cyan-900">{t("导入本地文件")}<input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={loadMarkdownFile} className="sr-only" /></label></div>
          <textarea required value={documentDraft.content} onChange={(event) => setDocumentDraft((current) => ({ ...current, content: event.target.value }))} rows={18} placeholder={documentDraft.kind === 'api' ? t(apiDocumentTemplate) : t("# 文档标题\n\n## 目标\n\n## 约定\n\n## 注意事项")} className="form-control resize-y font-mono leading-6" />
          {editingDocument && <label className="ui-field-label block">{t("本次修订说明")}<input required value={documentDraft.change_summary ?? ''} onChange={(event) => setDocumentDraft((current) => ({ ...current, change_summary: event.target.value }))} placeholder={t("例如：补充鉴权错误码与重试约定")} className="form-control mt-1.5" /></label>}
          {documentMutation.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{documentMutation.error.message}</p>}
          <DialogActions pending={documentMutation.isPending} disabled={!documentDraft.title.trim() || !documentDraft.content.trim() || Boolean(editingDocument && !documentDraft.change_summary?.trim())} onCancel={() => setDialog(null)} label={editingDocument ? t("保存新 Revision") : t("创建文档")} />
        </form>
      </Dialog>}
    </main>
  );
}

export function ProjectArchitectureDocument({ document }: { document: HandoffDocumentDetail }) {
  useLocale();
  const [editing, setEditing] = useState<ArchitectureDocumentDetail | null>(null);
  const architecture = document.architecture_document;
  if (!architecture || architecture.document_code !== document.document_code || architecture.project_code !== document.project_code) {
    return <p role="alert" className="m-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{t("架构资料读取不完整，请刷新文档后重试。")}</p>;
  }
  const readable = { ...architecture, can_edit: document.source_can_edit === true && architecture.can_edit };
  return <>
    <ArchitectureDocumentReader document={readable} embedded onEdit={() => { if (readable.can_edit) setEditing(readable); }} />
    {editing && readable.can_edit && <ArchitectureDocumentEditor projectCode={document.project_code} initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
  </>;
}

export function ProjectTestingDocument({ document }: { document: HandoffDocumentDetail }) {
  const [editing, setEditing] = useState<TestAssetDetail | null>(null);
  const asset = document.testing_asset;
  if (!asset || asset.code !== document.document_code || asset.project_code !== document.project_code) return <p role="alert" className="m-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{t('测试资料读取不完整，请刷新后重试。')}</p>;
  const readable = { ...asset, can_edit: document.source_can_edit === true && asset.can_edit };
  return <><TestAssetReader document={readable} embedded onEdit={() => { if (readable.can_edit) setEditing(readable); }} />{editing && readable.can_edit && <TestAssetEditor projectCode={document.project_code} initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}</>;
}

export function ProjectDocumentHeader({ document, historical, folderLabel, authorName, historyOpen, historyToggleRef, onToggleHistory, onReturnCurrent, onEdit }: {
  document: HandoffDocumentDetail;
  historical: HandoffDocumentRevision | null;
  folderLabel?: string;
  authorName: string;
  historyOpen: boolean;
  historyToggleRef?: Ref<HTMLButtonElement>;
  onToggleHistory: () => void;
  onReturnCurrent: () => void;
  onEdit: () => void;
}) {
  return <DocumentReaderHeader title={historical?.title ?? document.title} summary={historical?.summary ?? document.summary} actionsLabel={t("文档操作")}
    breadcrumb={<><span className="truncate">{folderLabel ?? document.folder_name ?? t("根目录")}</span><span>/</span><span className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${kindMeta[canonicalDocumentKind(document.kind)].badge}`}>{kindMeta[canonicalDocumentKind(document.kind)].short}</span></>}
    metadata={<>Revision {historical?.revision ?? document.current_revision} · {formatDate(historical?.created_at ?? document.updated_at)} · {authorName}</>}>
    {historical ? <button type="button" onClick={onReturnCurrent} className="ui-button ui-button-secondary min-w-28 justify-center">{t("返回当前版本")}</button> : document.source_kind === 'requirement' ? (
      document.source_can_edit && <a href={requirementWorkspacePath(document.project_code, { documentCode: document.document_code })} className="ui-button ui-button-secondary min-w-28 justify-center">{t("在需求页编辑")}</a>
    ) : document.can_edit && <button type="button" onClick={onEdit} className="ui-button ui-button-secondary min-w-28 justify-center">{t("编辑文档")}</button>}
    <button ref={historyToggleRef} type="button" onClick={onToggleHistory} aria-expanded={historyOpen} aria-controls="document-version-history" className="ui-button ui-button-secondary" title={historyOpen ? t("收起版本记录") : t("展开版本记录")}>{t("版本记录")}</button>
  </DocumentReaderHeader>;
}

function DocumentTreeIcon({ library = false }: { library?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-slate-400">
    {library ? <><path d="M3.5 4h3v12h-3zM8.5 4h3v12h-3zM13 4.5l2.8-.7 2.7 11.6-2.8.6z" /><path d="M3.5 7h3M8.5 7h3" /></> : <path d="M2.5 6V4.5h5l2 2h8v9h-15V6Z" />}
  </svg>;
}

export function handoffSystemFolderRole(folders: HandoffFolder[], folderCode: string | null): HandoffFolder['system_role'] {
  const foldersByCode = new Map(folders.map((folder) => [folder.folder_code, folder]));
  const visited = new Set<string>();
  while (folderCode && !visited.has(folderCode)) {
    visited.add(folderCode);
    const folder = foldersByCode.get(folderCode);
    if (folder?.system_role) return folder.system_role;
    folderCode = folder?.parent_folder_code ?? null;
  }
  return null;
}

export function isRequirementDocumentFolder(folders: HandoffFolder[], folderCode: string | null): boolean {
  return handoffSystemFolderRole(folders, folderCode) === 'requirements';
}

export function canCreateHandoffSubfolder(folders: HandoffFolder[], folderCode: string | null): boolean {
  if (!folderCode) return true;
  const folder = folders.find((item) => item.folder_code === folderCode);
  return Boolean(folder && folder.can_create_folder !== false && !handoffSystemFolderRole(folders, folderCode));
}

export function handoffFolderParents(folders: HandoffFolder[], editingFolder: HandoffFolder | null = null): HandoffFolder[] {
  return folders.filter((folder) => folder.folder_code !== editingFolder?.folder_code
    && (canCreateHandoffSubfolder(folders, folder.folder_code) || folder.folder_code === editingFolder?.parent_folder_code));
}

export function isSourceDocumentFolder(folders: HandoffFolder[], folderCode: string | null): boolean {
  const role = handoffSystemFolderRole(folders, folderCode);
  return role === 'requirements' || role === 'architecture' || role === 'testing';
}

function isSourceDocument(document: HandoffDocumentSummary | null | undefined): boolean {
  return document?.source_kind === 'requirement' || document?.source_kind === 'architecture' || document?.source_kind === 'testing';
}

export function canonicalDocumentKind(kind: HandoffDocumentSummary['kind']): HandoffDocumentKind {
  return kind === 'api' || kind === 'diagram' ? kind : 'doc';
}

export function handoffRevisionInput(document: HandoffDocumentDetail, draft: HandoffDocumentInput): HandoffDocumentInput {
  return { ...draft, kind: draft.kind === canonicalDocumentKind(document.kind) ? undefined : draft.kind };
}

export function handoffFolderDocuments(documents: HandoffDocumentSummary[], folders: HandoffFolder[], folderCode: string | null): HandoffDocumentSummary[] {
  if (folderCode === null) return documents;
  if (!folders.some((folder) => folder.folder_code === folderCode)) return [];
  const codes = new Set([folderCode]);
  let previousSize = 0;
  while (codes.size !== previousSize) {
    previousSize = codes.size;
    folders.forEach((folder) => { if (folder.parent_folder_code && codes.has(folder.parent_folder_code)) codes.add(folder.folder_code); });
  }
  return documents.filter((document) => document.folder_code !== null && codes.has(document.folder_code));
}

export async function invalidateProjectDocumentQueries(queryClient: QueryClient, projectCode: string, documentCode?: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['handoff-library', projectCode] }),
    queryClient.invalidateQueries({ queryKey: ['project-home', projectCode] }),
    ...(documentCode ? [queryClient.invalidateQueries({ queryKey: ['handoff-document', documentCode] })] : []),
  ]);
}

const kindMeta: Record<HandoffDocumentKind, { label: string; short: string; badge: string }> = {
  doc: { label: 'doc · 普通文档', short: 'doc', badge: 'bg-slate-100 text-slate-600' },
  api: { label: 'api · 接口文档', short: 'api', badge: 'bg-violet-100 text-violet-700' },
  diagram: { label: 'diagram · 图表', short: 'diagram', badge: 'bg-cyan-100 text-cyan-700' },
};

const apiDocumentTemplate = '# 接口名称\n\n## 使用场景\n\n## 鉴权与权限\n\n## 请求\n\n## 响应\n\n## 错误码\n\n## 幂等与重试\n\n## 联调示例\n\n## 变更注意事项';

function Dialog({ title, wide = false, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  return <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl bg-white shadow-2xl ${wide ? 'max-w-4xl' : 'max-w-lg'}`}>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4"><h2 className="text-lg font-bold text-slate-950">{title}</h2><button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-800">×</button></header>
      <div className="p-6">{children}</div>
    </section>
  </div>;
}

function DialogActions({ pending, disabled, onCancel, label }: { pending: boolean; disabled: boolean; onCancel: () => void; label: string }) {
  return <div className="flex justify-end gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={onCancel} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || disabled} className="ui-button ui-button-primary">{pending ? t("保存中…") : label}</button></div>;
}
