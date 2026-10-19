import { canProject } from './projectManagement';
import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useDeferredValue, useEffect, useRef, useState, type Ref } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createArchitectureDocument, getArchitectureDocument, getProject, listArchitectureDocuments, reviseArchitectureDocument,
  type ArchitectureContentKind, type ArchitectureDocumentDetail, type ArchitectureDocumentRevision,
  type ArchitectureDocumentRevisionInput, type ArchitectureDocumentSummary,
} from './api';
import { MarkdownDocument } from './MarkdownDocument';
import { DocumentVersionHistory, formatDocumentDate } from './DocumentVersionHistory';
import { DocumentReaderHeader } from './DocumentReaderHeader';
import { MermaidDiagram } from './MermaidDiagram';
import { DrawioDiagram } from './DrawioDiagram';
import { DrawioEditor } from './DrawioEditor';
import { navigateWorkspace } from './workspaceNavigation';
import { projectHomeWorkspacePath } from './workspaceRouting';
import {
  ARCHITECTURE_KIND_LABEL, architectureTemplate, architectureDraft, architectureSourceFile,
  architectureWriteInput, importArchitectureSource, isArchitectureRevisionConflict, updateArchitectureSource,
  validateArchitectureDraft, type ArchitectureDraft,
} from './architectureDocuments';

type ArchitectureView = Pick<ArchitectureDocumentRevision, 'title' | 'summary' | 'content_kind' | 'source_content' | 'preview_svg' | 'notes_markdown'>;

function downloadFile(file: { filename: string; blob: Blob }) {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ArchitecturePreview({ document: view }: { document: ArchitectureView }) {
  if (!view.source_content.trim()) return <p className="p-8 text-center text-sm text-slate-400">{t("添加图源后即可预览。")}</p>;
  if (view.content_kind === 'mermaid') return <MermaidDiagram source={view.source_content} title={view.title || t('架构图')} />;
  if (view.content_kind === 'drawio') return <DrawioDiagram source={view.source_content} previewSvg={view.preview_svg} title={view.title || t('架构图')} />;
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(view.source_content)) return <p role="alert" className="p-5 text-sm text-rose-700">{t("图片格式不受支持。")}</p>;
  return <div className="overflow-auto p-4"><img src={view.source_content} alt={view.title || t('架构图')} className="mx-auto max-h-[680px] max-w-full object-contain" /></div>;
}

export function ArchitectureDocumentReader({ document, onEdit, embedded = false }: { document: ArchitectureDocumentDetail; onEdit: () => void; embedded?: boolean }) {
  useLocale();
  const [revision, setRevision] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const [exportError, setExportError] = useState('');
  const historical = revision === null ? undefined : document.revisions.find((item) => item.revision === revision);
  const viewed: ArchitectureView = historical ?? document;
  const viewedRevision = historical?.revision ?? document.current_revision;
  function closeHistory() {
    setHistoryOpen(false);
    historyToggleRef.current?.focus();
  }
  return <article className={`relative grid min-w-0 grid-cols-[minmax(0,1fr)] overflow-clip bg-white ${embedded ? '' : 'rounded-2xl border border-slate-200 shadow-sm'} ${historyOpen ? 'xl:grid-cols-[minmax(0,1fr)_240px]' : ''}`} onKeyDown={(event) => { if (historyOpen && event.key === 'Escape') { event.stopPropagation(); closeHistory(); } }}>
    <div className="min-w-0">
      <ArchitectureDocumentHeader document={document} historical={historical} historyOpen={historyOpen} historyToggleRef={historyToggleRef}
        onToggleHistory={() => setHistoryOpen(open => !open)} onReturnCurrent={() => setRevision(null)} onEdit={onEdit}
        onDownload={() => { try { downloadFile(architectureSourceFile(viewed.content_kind, viewed.source_content, viewed.title, viewedRevision)); setExportError(''); } catch (error) { setExportError(error instanceof Error ? error.message : String(error)); } }} />
      {exportError && <div className="px-5 pt-4 sm:px-6"><ArchitectureError error={exportError} /></div>}
      <div className="min-w-0 overflow-hidden p-3 sm:p-5"><ArchitecturePreview document={viewed} /></div>
      {viewed.notes_markdown.trim() && <section aria-label={t("架构说明")} className="border-t border-slate-100 p-5 sm:p-6"><h3 className="mb-4 text-sm font-semibold text-slate-800">{t("架构说明")}</h3><MarkdownDocument content={viewed.notes_markdown} /></section>}
      {viewed.content_kind !== 'image' && <details className="border-t border-slate-100 p-5 sm:p-6"><summary className="cursor-pointer text-sm font-semibold text-slate-600">{t("查看图源")}</summary><pre className="mt-3 max-h-[360px] overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100"><code>{viewed.source_content}</code></pre></details>}
    </div>
    {historyOpen && <DocumentVersionHistory id="architecture-version-history" document={document} viewRevision={revision} onSelect={setRevision} onClose={closeHistory} />}
  </article>;
}

export function ArchitectureDocumentHeader({ document, historical, historyOpen, historyToggleRef, onToggleHistory, onReturnCurrent, onEdit, onDownload }: {
  document: ArchitectureDocumentDetail;
  historical?: ArchitectureDocumentRevision;
  historyOpen: boolean;
  historyToggleRef?: Ref<HTMLButtonElement>;
  onToggleHistory: () => void;
  onReturnCurrent: () => void;
  onEdit: () => void;
  onDownload: () => void;
}) {
  const viewed = historical ?? document;
  const isHistorical = Boolean(historical && historical.revision !== document.current_revision);
  return <DocumentReaderHeader title={viewed.title} summary={viewed.summary} actionsLabel={t("架构文档操作")}
    breadcrumb={<><span className="truncate">{t("架构设计")}</span><span>/</span><span className="shrink-0 rounded bg-cyan-100 px-1.5 py-0.5 font-semibold text-cyan-700">diagram</span></>}
    metadata={<><span>Revision {historical?.revision ?? document.current_revision} · {formatDocumentDate(historical?.created_at ?? document.updated_at)}</span><span>{t(ARCHITECTURE_KIND_LABEL[viewed.content_kind])}</span><code className="break-all">{document.document_code}</code></>}
    notice={isHistorical && <p role="status" className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">{t("正在查看历史版本 r{revision}，图源、预览与说明均来自该版本。", { revision: historical?.revision ?? 0 })}</p>}>
    <button type="button" className="ui-button ui-button-secondary" onClick={onDownload}>{t("下载图源")}</button>
    {isHistorical ? <button type="button" onClick={onReturnCurrent} className="ui-button ui-button-secondary min-w-28 justify-center">{t("返回当前版本")}</button> : document.can_edit && <button type="button" onClick={onEdit} className="ui-button ui-button-secondary min-w-28 justify-center">{t("编辑当前版本")}</button>}
    <button ref={historyToggleRef} type="button" onClick={onToggleHistory} aria-expanded={historyOpen} aria-controls="architecture-version-history" className="ui-button ui-button-secondary" title={historyOpen ? t('收起版本记录') : t('展开版本记录')}>{t("版本记录")}</button>
  </DocumentReaderHeader>;
}

export function ArchitectureWorkbench({ projectCode, documentCode }: { projectCode: string; documentCode?: string }) {
  useLocale();
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ document?: ArchitectureDocumentDetail } | null>(null);
  const [notice, setNotice] = useState<{ title: string; revision: number } | null>(null);
  const projectQuery = useQuery({ queryKey: ['project', projectCode], queryFn: () => getProject(projectCode) });
  const projectArchived = projectQuery.data?.status === 'archived';
  const canCreate = projectQuery.isSuccess && canProject(projectQuery.data, 'write');
  const libraryQuery = useQuery({ queryKey: ['architecture-documents', projectCode], queryFn: () => listArchitectureDocuments(projectCode) });
  const documents = libraryQuery.data ?? [];
  const filtered = filterArchitectureDocuments(documents, search);
  // A direct link remains readable even when the list is filtered or still loading.
  const selectedCode = documentCode ?? filtered[0]?.document_code;
  const detailQuery = useQuery({ queryKey: ['architecture-document', selectedCode], queryFn: () => getArchitectureDocument(selectedCode as string), enabled: Boolean(selectedCode) });
  const selectedDocument = detailQuery.data?.project_code === projectCode ? { ...detailQuery.data, can_edit: canCreate && detailQuery.data.can_edit } : undefined;

  async function saved(document: ArchitectureDocumentDetail) {
    setEditor(null);
    setNotice({ title: document.title, revision: document.current_revision });
    navigateWorkspace(projectHomeWorkspacePath(projectCode, 'architecture', document.document_code));
  }

  return <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50">
    <section className="mx-auto max-w-[1408px] p-4 sm:p-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">ARCHITECTURE</p><h1 className="mt-1 text-2xl font-bold text-slate-950">{t("架构设计")}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{t("维护系统边界、组件关系和部署方案，图源与说明按版本保存。")}</p></div>{canCreate && <button type="button" onClick={() => setEditor({})} className="ui-button ui-button-primary">{t("新建架构设计")}</button>}</header>
      {projectArchived ? <p role="status" className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-600">{t("项目已归档，架构设计为只读状态。已有资料与历史版本仍可阅读、下载。")}</p> : projectQuery.error ? <div role="alert" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">{t("暂时无法确认项目状态，恢复后可新建架构设计。")}<button type="button" onClick={() => void projectQuery.refetch()} className="ml-2 font-semibold underline underline-offset-2">{t("重试读取项目")}</button></div> : projectQuery.isPending && <p role="status" className="mb-4 text-sm text-slate-500">{t("正在读取项目状态…")}</p>}
      {notice && <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><span>{t("「{value0}」已保存为 r{value1}", { value0: notice.title, value1: String(notice.revision) })}</span><button type="button" className="shrink-0 font-semibold" onClick={() => setNotice(null)}>{t("关闭")}</button></div>}
      <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside aria-label={t("架构设计列表")} className="document-library-sidebar"><header className="space-y-3 shrink-0 border-b border-slate-100 p-4"><h2 className="text-sm font-semibold text-slate-800">{t("架构资料")}<span className="ml-1 font-normal text-slate-400">{documents.length}</span></h2><input type="search" aria-label={t("搜索架构设计")} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索标题、摘要或编码")} className="form-control w-full" /></header><div className="scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">{libraryQuery.isLoading ? <p className="p-4 text-sm text-slate-500">{t("正在加载架构资料…")}</p> : libraryQuery.error ? <div className="p-3"><ArchitectureError error={libraryQuery.error} /><button type="button" onClick={() => void libraryQuery.refetch()} className="ui-button ui-button-secondary ui-button-compact mt-3">{t("重试")}</button></div> : filtered.length ? filtered.map((item) => <a key={item.document_code} href={projectHomeWorkspacePath(projectCode, 'architecture', item.document_code)} aria-current={selectedCode === item.document_code ? 'page' : undefined} className={`mb-2 block rounded-xl border p-3 last:mb-0 ${selectedCode === item.document_code ? 'border-cyan-200 bg-cyan-50' : 'border-transparent hover:bg-slate-50'}`}><div className="flex items-center justify-between gap-2 text-xs text-slate-400"><span>{t(ARCHITECTURE_KIND_LABEL[item.content_kind])}</span><span>r{item.current_revision}</span></div><h3 className="mt-2 break-words text-sm font-semibold text-slate-900">{item.title}</h3>{item.summary && <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-slate-500">{item.summary}</p>}</a>) : <p className="p-5 text-center text-sm text-slate-400">{search.trim() ? t('没有匹配的架构资料。') : t('尚未添加架构资料。')}</p>}</div></aside>
        <div className="min-w-0">{detailQuery.isLoading && selectedCode ? <p className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">{t("正在加载架构设计…")}</p> : detailQuery.error ? <div className="rounded-2xl border border-rose-200 bg-white p-5"><ArchitectureError error={detailQuery.error} /><button type="button" onClick={() => void detailQuery.refetch()} className="ui-button ui-button-secondary mt-3">{t("重试")}</button></div> : selectedDocument ? <ArchitectureDocumentReader key={selectedDocument.document_code} document={selectedDocument} onEdit={() => setEditor({ document: selectedDocument })} /> : <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><h2 className="text-base font-semibold text-slate-700">{documentCode ? t('此架构资料不属于当前项目。') : canCreate ? t('为项目添加第一份架构设计') : t('尚无架构设计')}</h2><p className="mt-3 text-sm leading-6 text-slate-500">{canCreate ? t('支持 Mermaid、draw.io 与图片。可导入现有图源，也可从模板开始绘制。') : projectArchived ? t('项目恢复后可添加新的架构资料。') : t('确认项目状态后可新建架构资料。')}</p>{!documentCode && canCreate && <button type="button" className="ui-button ui-button-primary mt-5" onClick={() => setEditor({})}>{t("新建架构设计")}</button>}</div>}</div>
      </div>
    </section>
    {canCreate && editor && <ArchitectureDocumentEditor projectCode={projectCode} initial={editor.document} onClose={() => setEditor(null)} onSaved={saved} />}
  </main>;
}

export function filterArchitectureDocuments(documents: ArchitectureDocumentSummary[], search: string): ArchitectureDocumentSummary[] {
  const needle = search.trim().toLocaleLowerCase();
  return needle ? documents.filter((item) => [item.title, item.summary, item.document_code, t(ARCHITECTURE_KIND_LABEL[item.content_kind])].join(' ').toLocaleLowerCase().includes(needle)) : documents;
}

export async function invalidateArchitectureDocumentQueries(queryClient: QueryClient, projectCode: string, documentCode: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['architecture-documents', projectCode] }),
    queryClient.invalidateQueries({ queryKey: ['architecture-document', documentCode] }),
    queryClient.invalidateQueries({ queryKey: ['handoff-library', projectCode] }),
    queryClient.invalidateQueries({ queryKey: ['handoff-document', documentCode] }),
  ]);
}

export function ArchitectureDocumentEditor({ projectCode, initial, onClose, onSaved }: { projectCode: string; initial?: ArchitectureDocumentDetail; onClose: () => void; onSaved: (document: ArchitectureDocumentDetail) => Promise<void> | void }) {
  useLocale();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ArchitectureDraft>(() => architectureDraft(initial));
  const [localError, setLocalError] = useState('');
  const [drawioOpen, setDrawioOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewTab, setPreviewTab] = useState<'diagram' | 'notes'>('diagram');
  const formatSources = useRef<Partial<Record<ArchitectureContentKind, { source: string; preview: string | null }>>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const previewDraft = useDeferredValue(draft);
  const mutation = useMutation({
    mutationFn: (submitted: ArchitectureDraft) => initial
      ? reviseArchitectureDocument(initial.document_code, architectureWriteInput(submitted, initial.current_revision) as ArchitectureDocumentRevisionInput)
      : createArchitectureDocument(projectCode, architectureWriteInput(submitted)),
    onSuccess: async (document) => {
      queryClient.setQueryData(['architecture-document', document.document_code], document);
      await invalidateArchitectureDocumentQueries(queryClient, projectCode, document.document_code);
      await onSaved(document);
    },
    onError: (error) => {
      if (initial && isArchitectureRevisionConflict(error)) {
        void invalidateArchitectureDocumentQueries(queryClient, projectCode, initial.document_code);
      }
    },
  });
  const pending = mutation.isPending || importing;

  useEffect(() => { titleInput.current?.focus(); }, []);

  function changeKind(kind: ArchitectureContentKind) {
    formatSources.current[draft.content_kind] = { source: draft.source_content, preview: draft.preview_svg };
    const stored = formatSources.current[kind];
    setDraft({ ...draft, content_kind: kind, source_content: stored?.source ?? architectureTemplate(kind), preview_svg: stored?.preview ?? null });
    setLocalError('');
  }

  async function importFile(file?: File) {
    if (!file) return;
    setImporting(true);
    setLocalError('');
    try {
      const imported = await importArchitectureSource(file);
      setDraft((current) => ({ ...current, ...imported, preview_svg: null, title: current.title || file.name.replace(/\.[^.]+$/, '') }));
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); }
    finally { setImporting(false); }
  }

  function submit() {
    const error = validateArchitectureDraft(draft, Boolean(initial));
    setLocalError(error ?? '');
    if (!error && !pending) mutation.mutate(draft);
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-2 sm:p-5">
    <section role="dialog" aria-modal="true" aria-labelledby="architecture-editor-title" className="flex max-h-[94vh] w-full max-w-[1280px] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 p-4 sm:px-6"><div><h2 id="architecture-editor-title" className="text-lg font-bold text-slate-950">{initial ? t('编辑架构设计') : t('新建架构设计')}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{initial ? t("基于 r{value0} 创建新版本，保留已有历史。", { value0: String(initial.current_revision) }) : t('图源、架构说明与预览图将保存为同一版本。')}</p></div><button type="button" disabled={pending} onClick={onClose} className="ui-button ui-button-secondary ui-button-compact">{t("关闭")}</button></header>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 overflow-y-auto p-4 sm:p-6">
          <fieldset disabled={pending} className="grid min-w-0 gap-6 xl:grid-cols-2">
            <div className="min-w-0 space-y-4">
              <label className="block text-sm font-semibold text-slate-700">{t("架构名称")}<input ref={titleInput} required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder={t("例如：系统总体架构")} className="form-control mt-2 w-full" /></label>
              <label className="block text-sm font-semibold text-slate-700">{t("摘要")}<textarea rows={2} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder={t("说明此图的范围与用途")} className="form-control mt-2 w-full resize-y" /></label>
              <div className="flex flex-wrap items-end gap-3"><label className="min-w-[150px] flex-1 text-sm font-semibold text-slate-700">{t("图源格式")}<select aria-label={t("图源格式")} value={draft.content_kind} onChange={(event) => changeKind(event.target.value as ArchitectureContentKind)} className="form-control mt-2 w-full bg-white">{Object.entries(ARCHITECTURE_KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label><button type="button" onClick={() => fileInput.current?.click()} className="ui-button ui-button-secondary">{importing ? t('导入中…') : t('导入图源')}</button><input ref={fileInput} type="file" accept=".mmd,.mermaid,.drawio,.xml,.png,.jpg,.jpeg,.webp" aria-label={t("导入架构图源")} className="hidden" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
              {draft.content_kind === 'drawio' && <div className="rounded-xl border border-cyan-100 bg-cyan-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium text-cyan-900">{t("在画布中拖拽绘制架构图")}</p><button type="button" onClick={() => setDrawioOpen(true)} className="ui-button ui-button-secondary">{t("打开 draw.io 编辑器")}</button></div><p className="mt-2 text-xs leading-5 text-cyan-700">{t("编辑器需连接 diagrams.net。在画布保存后，再保存本页版本；也可直接导入或修改 XML 图源。")}</p></div>}
              {draft.content_kind !== 'image' ? <label className="block text-sm font-semibold text-slate-700">{draft.content_kind === 'drawio' ? t('XML 图源') : t('Mermaid 图源')}<textarea aria-label={t("架构图源")} rows={11} spellCheck={false} value={draft.source_content} onChange={(event) => setDraft(updateArchitectureSource(draft, event.target.value))} className="form-control mt-2 w-full resize-y font-mono text-xs leading-6" /></label> : <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center"><p className="text-sm text-slate-600">{draft.source_content ? t('图片已载入，可在右侧或下方预览。') : t('上传 PNG、JPEG 或 WebP 架构图。')}</p><button type="button" className="ui-button ui-button-secondary mt-3" onClick={() => fileInput.current?.click()}>{draft.source_content ? t('更换图片') : t('选择图片')}</button></div>}
              <p className="text-xs leading-5 text-slate-400">{t("支持 .mmd、.drawio 与 PNG/JPEG/WebP，图源内容最多 6 MiB。切换格式会暂存当前图源。")}</p>
              <label className="block text-sm font-semibold text-slate-700">{t("架构说明")}<span className="text-xs font-normal text-slate-400">Markdown</span><textarea aria-label={t("架构说明")} rows={6} value={draft.notes_markdown} onChange={(event) => setDraft({ ...draft, notes_markdown: event.target.value })} placeholder={t("记录组件职责、关键决策与边界约束。")} className="form-control mt-2 w-full resize-y font-mono text-sm leading-6" /></label>
              {initial && <label className="block text-sm font-semibold text-slate-700">{t("修改说明")}<input required value={draft.change_summary} onChange={(event) => setDraft({ ...draft, change_summary: event.target.value })} placeholder={t("说明本次变更的原因与内容")} className="form-control mt-2 w-full" /></label>}
            </div>
            <section aria-label={t("架构实时预览")} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/60 xl:self-start"><header className="flex gap-4 border-b border-slate-200 bg-white px-4"><button type="button" onClick={() => setPreviewTab('diagram')} className={`border-b-2 py-3 text-sm font-semibold ${previewTab === 'diagram' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500'}`}>{t("图形预览")}</button><button type="button" onClick={() => setPreviewTab('notes')} className={`border-b-2 py-3 text-sm font-semibold ${previewTab === 'notes' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500'}`}>{t("说明预览")}</button></header><div className="max-h-[640px] min-h-[260px] overflow-auto p-3">{previewTab === 'diagram' ? <ArchitecturePreview document={previewDraft} /> : previewDraft.notes_markdown.trim() ? <MarkdownDocument content={previewDraft.notes_markdown} /> : <p className="p-5 text-sm text-slate-400">{t("填写架构说明后即可预览。")}</p>}</div></section>
          </fieldset>
        </div>
        <footer className="shrink-0 space-y-3 border-t border-slate-200 bg-white p-4 sm:px-6">
          {localError && <ArchitectureError error={localError} />}
          {mutation.error && (isArchitectureRevisionConflict(mutation.error) ? <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">{t("其他成员已保存新版本，当前草稿已保留。请下载草稿备份，关闭编辑后读取最新版本并合并修改。")}<button type="button" className="ml-2 font-semibold underline underline-offset-2" onClick={() => downloadFile({ filename: 'architecture-draft.json', blob: new Blob([JSON.stringify({ ...draft, document_code: initial?.document_code, base_revision: initial?.current_revision }, null, 2)], { type: 'application/json' }) })}>{t("下载草稿备份")}</button></div> : <ArchitectureError error={mutation.error} />)}
          <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" disabled={pending || !draft.source_content} onClick={() => { try { downloadFile(architectureSourceFile(draft.content_kind, draft.source_content, draft.title || 'architecture-draft')); } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); } }} className="ui-button ui-button-secondary ui-button-compact">{t("下载当前图源")}</button><div className="flex gap-2"><button type="button" disabled={pending} onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button type="submit" disabled={pending} className="ui-button ui-button-primary">{pending ? t('保存中…') : initial ? t('保存新版本') : t('保存架构设计')}</button></div></div>
        </footer>
      </form>
    </section>
    {drawioOpen && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/65 p-2 sm:p-4"><section role="dialog" aria-modal="true" aria-label={t("draw.io 图形编辑")} className="max-h-[96vh] w-full max-w-[1600px] overflow-y-auto rounded-2xl bg-white p-3 shadow-xl"><p className="mb-3 px-1 text-sm leading-6 text-slate-600">{t("在 draw.io 中保存后返回架构草稿，再点击“保存新版本”完成版本保存。")}</p><DrawioEditor source={draft.source_content} onClose={() => setDrawioOpen(false)} onSave={({ source, previewSvg }) => { setDraft((current) => ({ ...updateArchitectureSource(current, source, previewSvg), preview_svg: previewSvg ?? null })); setDrawioOpen(false); }} /></section></div>}
  </div>;
}

function ArchitectureError({ error }: { error: unknown }) {
  return <p role="alert" className="break-words text-sm leading-6 text-rose-700">{t(error instanceof Error ? error.message : String(error))}</p>;
}
