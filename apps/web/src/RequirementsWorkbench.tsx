import { useProjectAccess } from './useProjectAccess';
import { t, getLocale } from './i18n.ts';
import { useLocale } from './useLocale';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  createRequirement,
  createRequirementDocument,
  createTask,
  getRequirementDocument,
  listFeatures,
  listProjectModules,
  listRequirementDocuments,
  listRequirements,
  reviseRequirementDocument,
  type CreateRequirementInput,
  type Feature,
  type ProjectModule,
  type Requirement,
  type RequirementAcceptanceCriterion,
  type RequirementDocumentDetail,
  type RequirementDocumentInput,
  type RequirementDocumentSummary,
  type RequirementStatus,
} from './api';
import { MarkdownDocument, handleMarkdownAnchorClick } from './MarkdownDocument';
import { DocumentReaderHeader } from './DocumentReaderHeader';
import { requirementWorkspacePath, workspaceShareUrl } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import { useProjectDisplayNames } from './ProjectDisplayNames';
import { RequirementIdeasWorkbench, RequirementReviewPanel, RequirementTopicsWorkbench } from './RequirementDiscoveryWorkbench';
import { FormSelect } from './FormSelect';

const DOCUMENT_TEMPLATE = `# 模块需求说明

## 背景

说明当前问题和为什么需要这个模块。

## 目标

说明期望达成的业务结果。

## 范围

### 范围内

- （待补充）

### 范围外

- （待补充）

## 用户与场景

## 业务规则

## 验收策略

## 开放问题
`;

const REQUIREMENT_STATUS_LABEL: Record<RequirementStatus, string> = {
  draft: '待补充',
  clarifying: '待澄清',
  confirmed: '可拆任务',
  implementing: '执行中',
  delivered: '已完成',
  change_proposed: '有变更',
  deprecated: '已停用',
};

const DOCUMENT_REQUIREMENTS_PAGE_SIZE = 6;
const DOCUMENT_REVISIONS_PAGE_SIZE = 5;

type DocumentDialog = { mode: 'create' } | { mode: 'edit'; document: RequirementDocumentDetail };
type EntryDialog = { document?: RequirementDocumentDetail };

export function RequirementsWorkbench({ projectCode, documentCode, initialTab = 'ideas' }: {
  projectCode?: string;
  documentCode?: string;
  initialTab?: 'ideas' | 'topics' | 'documents' | 'checklist';
} = {}) {
  useLocale();
  const activeProjectCode = projectCode ?? '';
  const { canWrite, canManage } = useProjectAccess(activeProjectCode);
  const queryClient = useQueryClient();
  const [documentSearch, setDocumentSearch] = useState('');
  const [requirementSearch, setRequirementSearch] = useState('');
  const [selectedDocumentCode, setSelectedDocumentCode] = useState<string | null>(documentCode ?? null);
  const [documentDialog, setDocumentDialog] = useState<DocumentDialog | null>(null);
  const [entryDialog, setEntryDialog] = useState<EntryDialog | null>(null);
  const [taskDialog, setTaskDialog] = useState<Requirement | null>(null);
  const [notice, setNotice] = useState<{ message: string; parameters?: Record<string, string | number> } | null>(null);

  useEffect(() => {
    if (documentCode) setSelectedDocumentCode(documentCode);
  }, [documentCode]);

  const documentsQuery = useQuery({
    queryKey: ['requirement-documents', activeProjectCode],
    queryFn: () => listRequirementDocuments(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const featuresQuery = useQuery({
    queryKey: ['features', activeProjectCode],
    queryFn: () => listFeatures(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const modulesQuery = useQuery({
    queryKey: ['project-modules', activeProjectCode],
    queryFn: () => listProjectModules(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });
  const requirementsQuery = useQuery({
    queryKey: ['requirements', activeProjectCode],
    queryFn: () => listRequirements(activeProjectCode),
    enabled: Boolean(activeProjectCode),
  });

  const documents = documentsQuery.data ?? [];
  const requirements = requirementsQuery.data ?? [];
  const filteredDocuments = useMemo(() => {
    const needle = documentSearch.trim().toLocaleLowerCase();
    if (!needle) return documents;
    return documents.filter((document) => [
      document.code,
      document.module_key,
      document.title,
      document.summary,
      ...document.keywords,
    ].join(' ').toLocaleLowerCase().includes(needle));
  }, [documents, documentSearch]);
  const groupedDocuments = useMemo(() => {
    const groups = new Map<string, RequirementDocumentSummary[]>();
    for (const document of filteredDocuments) {
      const current = groups.get(document.module_key) ?? [];
      current.push(document);
      groups.set(document.module_key, current);
    }
    return [...groups.entries()];
  }, [filteredDocuments]);
  const selectedDocumentCodeFromList = filteredDocuments.some((document) => document.code === selectedDocumentCode)
    ? selectedDocumentCode
    : filteredDocuments[0]?.code;
  const detailQuery = useQuery({
    queryKey: ['requirement-document', selectedDocumentCodeFromList],
    queryFn: () => getRequirementDocument(selectedDocumentCodeFromList as string),
    enabled: initialTab === 'documents' && Boolean(selectedDocumentCodeFromList),
  });
  const selectedDocument = detailQuery.data ? { ...detailQuery.data, can_edit: canWrite && detailQuery.data.can_edit } : undefined;

  const createDocumentMutation = useMutation({
    mutationFn: (input: RequirementDocumentInput) => createRequirementDocument(activeProjectCode, input),
    onSuccess: (document) => {
      void invalidateRequirementDocumentQueries(queryClient, activeProjectCode, document.code);
      setSelectedDocumentCode(document.code);
      setDocumentDialog(null);
      navigateWorkspace(requirementWorkspacePath(activeProjectCode, { documentCode: document.code }));
    },
  });
  const reviseDocumentMutation = useMutation({
    mutationFn: ({ documentCode: code, input }: { documentCode: string; input: RequirementDocumentInput }) => reviseRequirementDocument(code, input),
    onSuccess: (document) => {
      void invalidateRequirementDocumentQueries(queryClient, activeProjectCode, document.code);
      setDocumentDialog(null);
    },
  });
  const createEntryMutation = useMutation({
    mutationFn: createRequirement,
    onSuccess: (requirement) => {
      void queryClient.invalidateQueries({ queryKey: ['requirements', activeProjectCode] });
      if (requirement.document_code) void queryClient.invalidateQueries({ queryKey: ['requirement-document', requirement.document_code] });
      setEntryDialog(null);
      setNotice({ message: "需求项 {0} 已加入需求清单", parameters: { "0": requirement.code } });
    },
  });
  const createTaskMutation = useMutation({
    mutationFn: ({ requirement, input }: {
      requirement: Requirement;
      input: { title: string; profile: 'planner' | 'builder' | 'verifier'; acceptance: RequirementAcceptanceCriterion[] };
    }) => {
      if (!requirement.feature_code) {
        throw new Error(t("该需求项尚未绑定 Feature，无法直接拆成任务"));
      }
      return createTask({
        ...input,
        feature_code: requirement.feature_code,
        requirement_code: requirement.code,
        source: 'requirement',
      });
    },
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ['requirements', activeProjectCode] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setTaskDialog(null);
      setNotice({ message: "任务 {0} 已创建，并关联到需求项", parameters: { "0": task.code } });
    },
  });

  function submitDocument(input: RequirementDocumentInput) {
    if (!documentDialog) return;
    if (documentDialog.mode === 'create') createDocumentMutation.mutate(input);
    else reviseDocumentMutation.mutate({ documentCode: documentDialog.document.code, input });
  }

  function selectDocument(code: string) {
    setSelectedDocumentCode(code);
    navigateWorkspace(requirementWorkspacePath(activeProjectCode, { documentCode: code }));
  }

  async function shareDocument(document: RequirementDocumentDetail) {
    const shareUrl = workspaceShareUrl(requirementWorkspacePath(activeProjectCode, { documentCode: document.code }), window.location.origin);
    await navigator.clipboard.writeText(shareUrl);
    setNotice({ message: "文档链接已复制，项目成员登录后可直接打开" });
  }

  if (!activeProjectCode) return <WorkbenchError error={t("缺少项目编码")} />;
  if (documentsQuery.isLoading || featuresQuery.isLoading || modulesQuery.isLoading || requirementsQuery.isLoading) return <WorkbenchLoading label={t("正在加载需求工作台…")} />;
  if (documentsQuery.error || featuresQuery.error || modulesQuery.error || requirementsQuery.error) return <WorkbenchError error={documentsQuery.error ?? featuresQuery.error ?? modulesQuery.error ?? requirementsQuery.error} />;

  const generatedTasks = requirements.reduce((sum, requirement) => sum + (requirement.task_count ?? 0), 0);
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-slate-50">
      <section className="mx-auto max-w-[1616px] p-5 lg:p-7">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold tracking-[0.18em] text-cyan-700">REQUIREMENTS</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{t("项目需求")}</h1>
            <p className="mt-1 text-sm text-slate-500">{t("从零散想法进入议题讨论与决策，再沉淀需求文档和需求项。")}</p>
          </div>
          {canWrite && (initialTab === 'documents' || initialTab === 'checklist') && <div className="flex gap-2">
            {initialTab === 'documents' ? (
              (canWrite && <button type="button" onClick={() => { createDocumentMutation.reset(); setDocumentDialog({ mode: 'create' }); }} className="ui-button ui-button-primary"><UploadToolIcon />{t("上传 / 新建文档")}</button>)
            ) : (
              (canWrite && <button type="button" onClick={() => { createEntryMutation.reset(); setEntryDialog({}); }} className="ui-button ui-button-primary"><PlusToolIcon />{t("新增需求项")}</button>)
            )}
          </div>}
        </header>

        <div className="mb-4 flex min-w-0 items-center justify-between gap-3 border-b border-slate-200">
          <nav className="flex min-w-0 flex-1 gap-4 overflow-x-auto sm:gap-6" aria-label={t("需求工作台视图")}>
            <a href={requirementWorkspacePath(activeProjectCode, { tab: 'ideas' })} className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-bold ${initialTab === 'ideas' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t("想法")}</a>
            <a href={requirementWorkspacePath(activeProjectCode, { tab: 'topics' })} className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-bold ${initialTab === 'topics' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t("需求议题")}</a>
            <a href={requirementWorkspacePath(activeProjectCode, { tab: 'documents' })} className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-bold ${initialTab === 'documents' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t("需求文档")}<span className="ml-1 text-xs font-medium text-slate-400">{documents.length}</span></a>
            <a href={requirementWorkspacePath(activeProjectCode, { tab: 'checklist' })} className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-bold ${initialTab === 'checklist' ? 'border-cyan-600 text-cyan-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t("需求清单")}<span className="ml-1 text-xs font-medium text-slate-400">{requirements.length}</span></a>
          </nav>
          <div className="hidden shrink-0 text-xs text-slate-400 sm:block">{t("已关联 {0} 个任务", { "0": generatedTasks })}</div>
        </div>

        {notice && <div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700"><span>{t(notice.message, notice.parameters)}</span><button type="button" onClick={() => setNotice(null)} className="text-xs font-bold">{t("关闭")}</button></div>}

        {initialTab === 'ideas' ? (
          <RequirementIdeasWorkbench projectCode={activeProjectCode} />
        ) : initialTab === 'topics' ? (
          <RequirementTopicsWorkbench projectCode={activeProjectCode} documents={documents} />
        ) : initialTab === 'documents' ? (
          <DocumentLibrary
            canWrite={canWrite}
            documents={documents}
            groupedDocuments={groupedDocuments}
            search={documentSearch}
            selectedDocumentCode={selectedDocumentCodeFromList}
            selectedDocument={selectedDocument}
            loadingDetail={detailQuery.isLoading}
            detailError={detailQuery.error}
            onSearch={setDocumentSearch}
            onSelect={selectDocument}
            onCreate={() => setDocumentDialog({ mode: 'create' })}
            onEdit={(document) => { reviseDocumentMutation.reset(); setDocumentDialog({ mode: 'edit', document }); }}
            onShare={(document) => void shareDocument(document)}
            onCreateEntry={(document) => { createEntryMutation.reset(); setEntryDialog({ document }); }}
          />
        ) : (
          <RequirementTable
            canWrite={canWrite}
            canManage={canManage}
            requirements={requirements}
            documents={documents}
            search={requirementSearch}
            onSearch={setRequirementSearch}
            onCreate={() => setEntryDialog({})}
            onCreateTask={(requirement) => { createTaskMutation.reset(); setTaskDialog(requirement); }}
          />
        )}
      </section>

      {canWrite && documentDialog && (
        <RequirementDocumentEditor
          key={documentDialog.mode === 'create' ? 'create-document' : `edit-${documentDialog.document.code}-${documentDialog.document.current_revision}`}
          mode={documentDialog.mode}
          initial={documentDialog.mode === 'edit' ? documentDialog.document : undefined}
          modules={modulesQuery.data ?? []}
          pending={createDocumentMutation.isPending || reviseDocumentMutation.isPending}
          error={createDocumentMutation.error ?? reviseDocumentMutation.error}
          onClose={() => setDocumentDialog(null)}
          onSubmit={submitDocument}
        />
      )}

      {canWrite && entryDialog && (
          <RequirementEntryDialog
          initialDocument={entryDialog.document}
          documents={documents}
          features={featuresQuery.data ?? []}
          pending={createEntryMutation.isPending}
          error={createEntryMutation.error}
          onClose={() => setEntryDialog(null)}
          onSubmit={(input) => createEntryMutation.mutate(input)}
        />
      )}

      {canManage && taskDialog && (
        <RequirementTaskDialog
          requirement={taskDialog}
          pending={createTaskMutation.isPending}
          error={createTaskMutation.error}
          onClose={() => setTaskDialog(null)}
          onSubmit={(input) => createTaskMutation.mutate({ requirement: taskDialog, input })}
        />
      )}
    </main>
  );
}

export async function invalidateRequirementDocumentQueries(queryClient: QueryClient, projectCode: string, documentCode: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['requirement-documents', projectCode] }),
    queryClient.invalidateQueries({ queryKey: ['requirement-document', documentCode] }),
    queryClient.invalidateQueries({ queryKey: ['handoff-library', projectCode] }),
    queryClient.invalidateQueries({ queryKey: ['handoff-document', documentCode] }),
  ]);
}

function DocumentLibrary({ canWrite, documents, groupedDocuments, search, selectedDocumentCode, selectedDocument, loadingDetail, detailError, onSearch, onSelect, onCreate, onEdit, onShare, onCreateEntry }: {
  canWrite: boolean;
  documents: RequirementDocumentSummary[];
  groupedDocuments: Array<[string, RequirementDocumentSummary[]]>;
  search: string;
  selectedDocumentCode?: string | null;
  selectedDocument?: RequirementDocumentDetail;
  loadingDetail: boolean;
  detailError: Error | null;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (document: RequirementDocumentDetail) => void;
  onShare: (document: RequirementDocumentDetail) => void;
  onCreateEntry: (document: RequirementDocumentDetail) => void;
}) {
  return (
    <div className="grid min-h-[720px] items-start gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="document-library-sidebar">
        <div className="shrink-0 border-b border-slate-200 p-4">
          <h2 className="font-bold text-slate-900">{t("需求文档")}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">{t("文档统一归集在文档库「需求文档」目录，可在此直接阅读与编辑。")}</p>
          <input aria-label={t("搜索需求文档")} value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t("搜索标题、模块或关键词")} className="mt-3 h-8 w-full rounded-lg border border-slate-200 bg-white px-3 !text-[12px] !font-medium !leading-4 text-slate-700 shadow-sm outline-none transition placeholder:!text-[12px] placeholder:!font-medium placeholder:text-slate-500 placeholder:opacity-100 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100" />
        </div>
        <div aria-label={t("需求文档目录列表")} className="scroll-region min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {groupedDocuments.map(([moduleKey, moduleDocuments]) => (
            <section key={moduleKey} className="mb-3 last:mb-0">
              <div className="flex items-center justify-between px-2 py-2"><h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">{moduleKey}</h3><span className="text-[11px] text-slate-300">{moduleDocuments.length}</span></div>
              <div className="space-y-1">
                {moduleDocuments.map((document) => (
                  <button type="button" key={document.code} onClick={() => onSelect(document.code)} className={`block w-full rounded-xl px-3 py-3 text-left transition ${selectedDocumentCode === document.code ? 'bg-cyan-50 ring-1 ring-inset ring-cyan-200' : 'hover:bg-slate-50'}`}>
                    <div className="flex items-center justify-between gap-2"><code className="text-[10px] font-bold text-cyan-700">{document.code}</code><span className="text-[10px] text-slate-400">r{document.current_revision}</span></div>
                    <div className="mt-2 text-sm font-bold text-slate-900">{document.title}</div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{document.summary}</p>
                    <div className="mt-2 text-[10px] text-slate-400">{new Date(document.updated_at).toLocaleDateString(getLocale())}</div>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {groupedDocuments.length === 0 && <div className="px-5 py-16 text-center text-sm text-slate-400">{documents.length ? t("没有匹配的需求文档") : t("尚未上传需求文档")}</div>}
        </div>
      </aside>

      <section className="min-w-0 overflow-clip rounded-xl border border-slate-200 bg-white shadow-sm">
        {loadingDetail && <WorkbenchLoading label={t("正在读取需求文档…")} />}
        {detailError && <div className="m-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t("读取失败：{0}", { "0": detailError.message })}</div>}
        {selectedDocument && <RequirementDocumentReader document={selectedDocument} onEdit={() => onEdit(selectedDocument)} onShare={() => onShare(selectedDocument)} onCreateEntry={() => onCreateEntry(selectedDocument)} />}
        {!selectedDocumentCode && <EmptyLibrary canWrite={canWrite} onCreate={onCreate} />}
      </section>
    </div>
  );
}

function RequirementDocumentReader({ document, onEdit, onShare, onCreateEntry }: {
  document: RequirementDocumentDetail;
  onEdit: () => void;
  onShare: () => void;
  onCreateEntry: () => void;
}) {
  const { memberName } = useProjectDisplayNames();
  const { canWrite, canManage } = useProjectAccess(document.project_code);
  const [requirementsPage, setRequirementsPage] = useState(1);
  const [revisionsPage, setRevisionsPage] = useState(1);

  useEffect(() => {
    setRequirementsPage(1);
    setRevisionsPage(1);
  }, [document.code]);

  const requirementsPageCount = Math.max(1, Math.ceil(document.linked_requirements.length / DOCUMENT_REQUIREMENTS_PAGE_SIZE));
  const activeRequirementsPage = Math.min(requirementsPage, requirementsPageCount);
  const visibleRequirements = document.linked_requirements.slice(
    (activeRequirementsPage - 1) * DOCUMENT_REQUIREMENTS_PAGE_SIZE,
    activeRequirementsPage * DOCUMENT_REQUIREMENTS_PAGE_SIZE,
  );
  const newestRevisions = useMemo(
    () => [...document.revisions].sort((left, right) => right.revision - left.revision),
    [document.revisions],
  );
  const revisionsPageCount = Math.max(1, Math.ceil(newestRevisions.length / DOCUMENT_REVISIONS_PAGE_SIZE));
  const activeRevisionsPage = Math.min(revisionsPage, revisionsPageCount);
  const visibleRevisions = newestRevisions.slice(
    (activeRevisionsPage - 1) * DOCUMENT_REVISIONS_PAGE_SIZE,
    activeRevisionsPage * DOCUMENT_REVISIONS_PAGE_SIZE,
  );
  const outline = document.outline ?? [];

  return (
    <article className="min-w-0" onClick={handleMarkdownAnchorClick}>
      <DocumentReaderHeader title={document.title} summary={document.summary} actionsLabel={t('文档操作')}
        breadcrumb={<><span className="min-w-0 break-words">{document.module_key}</span><span>/</span><span className="shrink-0 rounded bg-cyan-100 px-1.5 py-0.5 font-semibold text-cyan-700">doc</span></>}
        metadata={<><code className="break-all">{document.code}</code><span>Revision {document.current_revision}</span>{document.keywords.map(keyword => <span key={keyword} className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-semibold text-cyan-700">#{keyword}</span>)}</>}>
        <button type="button" onClick={onShare} className="ui-button ui-button-secondary"><ShareToolIcon />{t("复制分享链接")}</button>
        {document.can_edit && (canWrite && <button type="button" onClick={onEdit} className="ui-button ui-button-secondary"><EditToolIcon />{t("编辑文档")}</button>)}
        {canWrite && <button type="button" onClick={onCreateEntry} className="ui-button ui-button-strong"><ExtractToolIcon />{t("提炼需求项")}</button>}
      </DocumentReaderHeader>

      <div className="grid gap-8 px-6 py-7 lg:grid-cols-[190px_minmax(0,1fr)] lg:px-8">
        <aside>
          <div className="sticky top-[calc(var(--document-reader-header-height,0px)+1rem)]">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-400">{t("本文目录")}</h3>
            <ol className="mt-3 space-y-2">
              {outline.map((item, index) => (
                <li key={`${item.anchor}-${index}`} className={`${item.level > 2 ? 'pl-3' : ''}`}>
                  <a href={`#${item.anchor}`} className="block rounded-md px-2 py-1 text-xs leading-5 text-slate-500 hover:bg-cyan-50 hover:text-cyan-700">
                    {item.title}
                  </a>
                </li>
              ))}
            </ol>
            <div className="mt-6 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-400"><div>{t("维护人")}</div><strong title={t("用户编码：{0}", { "0": document.owner_code })} className="font-semibold text-slate-600">{memberName(document.owner_code)}</strong><div className="mt-3">{t("最近更新")}</div><div className="text-slate-600">{new Date(document.updated_at).toLocaleString(getLocale())}</div></div>
          </div>
        </aside>
        <div className="min-w-0">
          <RequirementReviewPanel canWrite={canWrite} canManage={canManage} documentCode={document.code} currentRevision={document.current_revision} />
          <div className="h-6" />
          <MarkdownDocument content={document.content} outline={outline} />

          <section className="mt-10 border-t border-slate-200 pt-8">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold tracking-[0.14em] text-cyan-700">REQUIREMENT ITEMS</p><h3 className="mt-1 text-xl font-bold text-slate-950">{t("从本文档提炼的需求项")}</h3></div><span className="text-xs text-slate-400">{t("{0} 条", { "0": document.linked_requirements.length })}</span></div>
            {document.linked_requirements.length ? <>
              <div className="scroll-region mt-4 max-h-96 overflow-y-auto overscroll-contain pr-2">
                <div className="grid gap-2 sm:grid-cols-2">{visibleRequirements.map((requirement) => <a href={requirementWorkspacePath(document.project_code, { tab: 'checklist' })} key={requirement.requirement_code} className="rounded-xl border border-slate-200 bg-slate-50 p-4 hover:border-cyan-300"><div className="flex items-start justify-between gap-2"><code className="text-xs font-bold text-cyan-700">{requirement.requirement_code}</code><span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200">{t(REQUIREMENT_STATUS_LABEL[requirement.state])}</span></div><div className="mt-2 text-sm font-semibold text-slate-800">{requirement.title}</div></a>)}</div>
              </div>
              <CollectionPager label={t("需求项分页")} page={activeRequirementsPage} pageCount={requirementsPageCount} pageSize={DOCUMENT_REQUIREMENTS_PAGE_SIZE} total={document.linked_requirements.length} onChange={setRequirementsPage} />
            </> : <div className="mt-4 rounded-xl border border-dashed border-slate-300 px-5 py-6 text-center text-sm text-slate-400">{t("还没有需求项。可由成员或 Agent 阅读文档后，把独立、可验收的内容提炼到需求清单。")}</div>}
          </section>

          <section className="mt-8 border-t border-slate-200 pt-8">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-bold text-slate-900">{t("修改记录")}</h3><span className="text-xs text-slate-400">{t("最新版本在前 · 历史内容保留")}</span></div>
            <div className="scroll-region mt-3 max-h-96 overflow-y-auto overscroll-contain pr-2">
              <div className="space-y-2">{visibleRevisions.map((revision) => <div key={revision.revision} className={`grid gap-2 rounded-xl border px-4 py-3 sm:grid-cols-[80px_1fr_auto] ${revision.revision === document.current_revision ? 'border-cyan-200 bg-cyan-50/50' : 'border-slate-200'}`}><strong className="text-sm text-slate-800">r{revision.revision}</strong><div><div className="text-sm text-slate-700">{revision.change_summary}</div><div title={t("用户编码：{0}", { "0": revision.created_by })} className="mt-1 text-[11px] text-slate-400">{memberName(revision.created_by)}</div></div><time className="text-[11px] text-slate-400">{new Date(revision.created_at).toLocaleString(getLocale())}</time></div>)}</div>
            </div>
            <CollectionPager label={t("版本记录分页")} page={activeRevisionsPage} pageCount={revisionsPageCount} pageSize={DOCUMENT_REVISIONS_PAGE_SIZE} total={newestRevisions.length} onChange={setRevisionsPage} />
          </section>
        </div>
      </div>
    </article>
  );
}

function CollectionPager({ label, page, pageCount, pageSize, total, onChange }: {
  label: string;
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <nav aria-label={label} className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs text-slate-400">
      <span>{t("显示 {0}–{1} / {2}", { "0": start, "1": end, "2": total })}</span>
      <div className="flex items-center gap-2">
        <button type="button" className="ui-button ui-button-secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>{t("上一页")}</button>
        <span className="min-w-20 text-center text-slate-500">{t("第 {0} / {1} 页", { "0": page, "1": pageCount })}</span>
        <button type="button" className="ui-button ui-button-secondary" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>{t("下一页")}</button>
      </div>
    </nav>
  );
}

function RequirementTable({ canWrite, canManage, requirements, documents, search, onSearch, onCreate, onCreateTask }: {
  canWrite: boolean;
  canManage: boolean;
  requirements: Requirement[];
  documents: RequirementDocumentSummary[];
  search: string;
  onSearch: (value: string) => void;
  onCreate: () => void;
  onCreateTask: (requirement: Requirement) => void;
}) {
  const { featureName, moduleName } = useProjectDisplayNames();
  const documentsByCode = new Map(documents.map((document) => [document.code, document]));
  const needle = search.trim().toLocaleLowerCase();
  const filtered = needle ? requirements.filter((requirement) => [
    requirement.code,
    requirement.title,
    requirement.body,
    requirement.feature_code,
    requirement.module_code,
    requirement.module_name,
    requirement.document_code,
  ].join(' ').toLocaleLowerCase().includes(needle)) : requirements;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div><h2 className="font-bold text-slate-900">{t("需求清单")}</h2><p className="mt-1 text-xs text-slate-500">{t("每条需求项都稳定、可引用、可验收，并可继续拆解任务。")}</p></div>
        <div className="flex gap-1.5"><input aria-label={t("搜索需求项")} value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t("搜索编码、标题或 Feature")} className="h-8 w-64 rounded-lg border border-slate-200 bg-white px-3 !text-[12px] !font-medium !leading-4 text-slate-700 shadow-sm outline-none placeholder:!text-[12px] placeholder:!font-medium placeholder:text-slate-500 placeholder:opacity-100 focus:border-cyan-400" />{canWrite && <button type="button" onClick={onCreate} className="ui-button ui-button-secondary"><PlusToolIcon />{t("新增需求项")}</button>}</div>
      </header>
      {filtered.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-[1080px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">{t("需求项")}</th><th className="px-4 py-3">{t("来源文档")}</th><th className="px-4 py-3">{t("模块")}</th><th className="px-4 py-3">Feature</th><th className="px-4 py-3 text-center">{t("验收")}</th><th className="px-4 py-3 text-center">{t("待澄清")}</th><th className="px-4 py-3 text-center">{t("任务")}</th><th className="px-4 py-3">{t("状态")}</th><th className="px-5 py-3 text-right">{t("操作")}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((requirement) => {
                const document = requirement.document_code ? documentsByCode.get(requirement.document_code) : undefined;
                return <tr key={requirement.code} className="align-top hover:bg-slate-50/70"><td className="px-5 py-4"><div className="max-w-sm font-semibold text-slate-900">{requirement.title}</div><code className="mt-1 block text-[11px] text-slate-400">{requirement.code}</code><p className="mt-1 line-clamp-2 max-w-sm text-xs leading-5 text-slate-500">{requirement.body}</p></td><td className="px-4 py-4">{document ? <a href={requirementWorkspacePath(document.project_code, { documentCode: document.code })} className="block max-w-44 text-xs font-semibold text-slate-700 hover:text-cyan-700"><span className="block text-[10px] text-cyan-700">{document.module_key}</span>{document.title}</a> : <span className="text-xs text-slate-300">{t("未关联")}</span>}</td><td className="px-4 py-4 text-xs font-semibold text-slate-600"><div className="font-semibold text-slate-700">{requirement.module_name ?? (moduleName(requirement.module_code) || t("未归属"))}</div><code className="mt-1 block text-[10px] text-slate-400">{requirement.module_code ?? '—'}</code></td><td title={t("Feature 编码：{0}", { "0": requirement.feature_code ?? t('未绑定') })} className="px-4 py-4 text-xs font-semibold text-slate-600"><div className="font-semibold text-slate-700">{featureName(requirement.feature_code)}</div><code className="mt-1 block text-[10px] text-slate-400">{requirement.feature_code ?? '—'}</code></td><td className="px-4 py-4 text-center font-semibold text-slate-700">{requirement.acceptance_criteria.length}</td><td className="px-4 py-4 text-center"><span className={requirement.open_questions.length ? 'font-bold text-amber-700' : 'text-slate-400'}>{requirement.open_questions.length}</span></td><td className="px-4 py-4 text-center"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">{requirement.task_count ?? 0}</span></td><td className="px-4 py-4"><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-bold text-cyan-700">{t(REQUIREMENT_STATUS_LABEL[requirement.status])}</span></td><td className="px-5 py-4 text-right">{canManage && <button type="button" onClick={() => onCreateTask(requirement)} className="ui-button ui-button-strong">{t("拆成任务")}</button>}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="px-6 py-24 text-center"><h3 className="font-bold text-slate-800">{requirements.length ? t("没有匹配的需求项") : t("需求清单还是空的")}</h3><p className="mt-2 text-sm text-slate-500">{t("先完善需求文档，再由成员或 Agent 提炼独立需求项。")}</p>{requirements.length === 0 && (canWrite && <button type="button" onClick={onCreate} className="ui-button ui-button-primary mt-5">{t("新增第一条需求项")}</button>)}</div>}
    </section>
  );
}

function RequirementDocumentEditor({ mode, initial, modules, pending, error, onClose, onSubmit }: {
  mode: 'create' | 'edit';
  initial?: RequirementDocumentDetail;
  modules: ProjectModule[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: RequirementDocumentInput) => void;
}) {
  const initialModuleCode = modules.find((module) => module.code === initial?.module_key || module.name === initial?.module_key)?.code ?? '';
  const [moduleCode, setModuleCode] = useState(initialModuleCode);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [keywords, setKeywords] = useState(initial?.keywords.join('，') ?? '');
  const [content, setContent] = useState(initial?.content ?? t(DOCUMENT_TEMPLATE));
  const [changeSummary, setChangeSummary] = useState('');
  const [fileName, setFileName] = useState('');

  async function loadFile(file?: File) {
    if (!file) return;
    const nextContent = await file.text();
    const firstHeading = /^#\s+(.+)$/m.exec(nextContent)?.[1]?.trim();
    const baseName = file.name.replace(/\.(md|markdown|txt)$/i, '');
    setContent(nextContent);
    setFileName(file.name);
    if (!title.trim()) setTitle(firstHeading || baseName);
    if (!summary.trim()) setSummary(inferSummary(nextContent, firstHeading || baseName));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const selectedModule = modules.find((module) => module.code === moduleCode);
    if (!selectedModule) return;
    onSubmit({
      module_code: selectedModule.code,
      module_key: selectedModule.name,
      title,
      summary: summary || inferSummary(content, title),
      content,
      keywords: keywords.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean),
      change_summary: mode === 'edit' ? changeSummary : undefined,
    });
  }

  return (
    <ModalShell title={mode === 'create' ? t("上传或新建需求文档") : t("编辑 {0}", { "0": initial?.title ?? '' })} eyebrow="COLLABORATIVE DOCUMENT" description={mode === 'create' ? t("支持 Markdown / TXT 文件；保存后团队成员即可阅读和分享。") : t("保存后生成 Revision {0}，历史内容继续保留。", { "0": String((initial?.current_revision ?? 0) + 1) })} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-dashed border-cyan-300 bg-cyan-50/60 px-5 py-4 text-sm text-cyan-800 hover:bg-cyan-50"><span><strong className="block">{t("选择 Markdown / TXT 文件")}</strong><span className="mt-1 block text-xs text-cyan-700/70">{t("自动读取正文，并从文件名或一级标题推断文档标题。")}</span></span><span className="rounded-lg bg-white px-4 py-2 text-xs font-bold shadow-sm">{fileName || t("选择文件")}</span><input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" className="sr-only" onChange={(event) => void loadFile(event.target.files?.[0])} /></label>
          <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
            <div className="block text-sm font-semibold text-slate-700">
              {t("所属模块")}<div className="mt-1.5">
                <FormSelect
                  required
                  value={moduleCode}
                  onChange={setModuleCode}
                  ariaLabel={t("所属模块")}
                  placeholder={t("请选择功能模块")}
                  options={modules.map((module) => ({
                    value: module.code,
                    label: module.name,
                    meta: module.status === 'archived' ? t("已归档") : undefined,
                    disabled: module.status === 'archived' && module.code !== moduleCode,
                  }))}
                />
              </div>
            </div>
            <Field label={t("文档标题")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("例如：账号、身份与权限需求说明")} className="form-control" /></Field>
          </div>
          <Field label={t("摘要")} hint={t("可留空，系统会从正文首段自动生成。")}><textarea rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} className="form-control resize-y leading-6" /></Field>
          <Field label={t("检索关键词")} hint={t("逗号分隔，帮助人和 Agent 快速找到文档。")}><input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={t("登录，账号，密码，权限")} className="form-control" /></Field>
          <Field label={t("Markdown 正文")}><textarea required rows={24} value={content} onChange={(event) => setContent(event.target.value)} className="form-control resize-y font-mono text-sm leading-6" /></Field>
          {mode === 'edit' && <Field label={t("本次修改说明")} hint={t("一句话说明改了什么，便于协作者判断是否需要重读。")}><input required value={changeSummary} onChange={(event) => setChangeSummary(event.target.value)} placeholder={t("例如：补充首次登录和密码重置规则")} className="form-control" /></Field>}
          {error && <ErrorMessage prefix={t("保存失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={mode === 'create' ? t("保存需求文档") : t("保存新版本")} disabled={!moduleCode || !title.trim() || !content.trim() || (mode === 'edit' && !changeSummary.trim())} />
      </form>
    </ModalShell>
  );
}

function RequirementEntryDialog({ initialDocument, documents, features, pending, error, onClose, onSubmit }: {
  initialDocument?: RequirementDocumentDetail;
  documents: RequirementDocumentSummary[];
  features: Feature[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: CreateRequirementInput) => void;
}) {
  const locale = useLocale();
  const [documentCode, setDocumentCode] = useState(initialDocument?.code ?? '');
  const moduleOptions = useMemo(() => {
    const map = new Map<string, { code: string; name: string }>();
    features.forEach((feature) => {
      const code = feature.module_code ?? feature.module_name ?? '';
      if (!code) return;
      if (!map.has(code)) {
        map.set(code, { code, name: feature.module_name ?? feature.module_code ?? code });
      }
    });
    return [...map.values()].sort((left, right) => left.name.localeCompare(right.name, locale) || left.code.localeCompare(right.code));
  }, [features, locale]);
  const [moduleCode, setModuleCode] = useState('');
  const [featureCode, setFeatureCode] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [criteria, setCriteria] = useState<RequirementAcceptanceCriterion[]>([{ id: 'AC-1', text: '' }]);
  const [questions, setQuestions] = useState<string[]>(['']);

  useEffect(() => {
    setModuleCode('');
    setFeatureCode('');
  }, [initialDocument?.code]);

  const filteredFeatures = useMemo(() => {
    if (!moduleCode) return features;
    return features.filter((feature) => (feature.module_code ?? feature.module_name ?? '') === moduleCode);
  }, [features, moduleCode]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const selectedModule = moduleOptions.find((item) => item.code === moduleCode) ?? null;
    const selectedFeature = filteredFeatures.find((item) => item.code === featureCode) ?? null;
    onSubmit({
      document_code: documentCode || undefined,
      feature_code: selectedFeature?.code ?? null,
      module_code: selectedModule?.code ?? null,
      module_name: selectedModule?.name ?? null,
      title,
      body,
      acceptance_criteria: criteria.filter((item) => item.text.trim()).map((item, index) => ({ id: item.id.trim() || `AC-${index + 1}`, text: item.text.trim() })),
      open_questions: questions.map((item) => item.trim()).filter(Boolean),
      status: 'draft',
    });
  }

  return (
    <ModalShell title={t("新增需求项")} eyebrow="REQUIREMENT CHECKLIST" description={t("把文档中的独立需求整理成稳定条目，供 Agent 引用并继续拆解任务。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <div className="grid gap-4 sm:grid-cols-3"><Field label={t("来源文档")}><select value={documentCode} onChange={(event) => setDocumentCode(event.target.value)} className="form-control bg-white"><option value="">{t("暂不关联")}</option>{documents.map((document) => <option key={document.code} value={document.code}>{document.module_key} · {document.title}</option>)}</select></Field><Field label={t("所属模块")}><select value={moduleCode} onChange={(event) => { setModuleCode(event.target.value); setFeatureCode(''); }} className="form-control bg-white"><option value="">{t("暂不归属")}</option>{moduleOptions.map((module) => <option key={module.code} value={module.code}>{module.name} · {module.code}</option>)}</select></Field><Field label={t("所属 Feature")}><select value={featureCode} onChange={(event) => setFeatureCode(event.target.value)} className="form-control bg-white"><option value="">{t("暂不绑定")}</option>{filteredFeatures.map((feature) => <option key={feature.code} value={feature.code}>{feature.title} · {feature.code}</option>)}</select></Field></div>
          <Field label={t("需求项标题")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="form-control" /></Field>
          <Field label={t("需求说明")}><textarea required rows={6} value={body} onChange={(event) => setBody(event.target.value)} className="form-control resize-y leading-6" /></Field>
          <EditableList title={t("验收标准")} onAdd={() => setCriteria((items) => [...items, { id: `AC-${items.length + 1}`, text: '' }])}>{criteria.map((criterion, index) => <div key={index} className="grid gap-2 sm:grid-cols-[90px_1fr_auto]"><input aria-label={t("验收标准 {0} 编码", { "0": index + 1 })} value={criterion.id} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} className="form-control font-mono" /><input aria-label={t("验收标准 {0}", { "0": index + 1 })} value={criterion.text} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} className="form-control" /><RemoveButton onClick={() => setCriteria((items) => items.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</EditableList>
          <EditableList title={t("待澄清问题")} onAdd={() => setQuestions((items) => [...items, ''])}>{questions.map((question, index) => <div key={index} className="grid gap-2 sm:grid-cols-[1fr_auto]"><input aria-label={t("待澄清问题 {0}", { "0": index + 1 })} value={question} onChange={(event) => setQuestions((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} className="form-control" /><RemoveButton onClick={() => setQuestions((items) => items.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</EditableList>
          {error && <ErrorMessage prefix={t("创建失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={t("加入需求清单")} disabled={!title.trim() || !body.trim()} />
      </form>
    </ModalShell>
  );
}

function RequirementTaskDialog({ requirement, pending, error, onClose, onSubmit }: {
  requirement: Requirement;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (input: { title: string; profile: 'planner' | 'builder' | 'verifier'; acceptance: RequirementAcceptanceCriterion[] }) => void;
}) {
  const [title, setTitle] = useState(requirement.title);
  const [profile, setProfile] = useState<'planner' | 'builder' | 'verifier'>('builder');
  const [criteria, setCriteria] = useState<RequirementAcceptanceCriterion[]>(requirement.acceptance_criteria.length ? requirement.acceptance_criteria : [{ id: 'AC-1', text: '' }]);
  const [copied, setCopied] = useState(false);
  const agentCommand = agentTaskCommand(requirement);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ title, profile, acceptance: criteria.filter((item) => item.text.trim()) });
  }

  return (
    <ModalShell title={t("从需求项拆解任务")} eyebrow={requirement.code} description={t("Web 可直接登记一个任务；Agent 也可以读取这条需求后，通过 CLI 连续创建多条关联任务。")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="space-y-5 p-6">
          <section className="rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-bold">{t("交给 Agent 拆解")}</h3><p className="mt-1 text-xs text-slate-400">{t("先 show 获取完整需求项，再按拆解结果创建一个或多个 Task。")}</p></div><button type="button" onClick={() => void navigator.clipboard.writeText(agentCommand).then(() => setCopied(true))} className="ui-button ui-button-compact border-white/10 bg-white/10 text-white shadow-none hover:bg-white/20">{copied ? t("已复制") : t("复制指令")}</button></div><pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-cyan-200">{agentCommand}</pre></section>
          <div className="grid gap-4 sm:grid-cols-[1fr]"><Field label={t("任务标题")}><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="form-control" /></Field></div>
          <Field label="Agent Profile"><select value={profile} onChange={(event) => setProfile(event.target.value as typeof profile)} className="form-control bg-white"><option value="planner">{t("planner · 规划与拆解")}</option><option value="builder">{t("builder · 实现")}</option><option value="verifier">{t("verifier · 独立验证")}</option></select></Field>
          <EditableList title={t("任务验收标准")} onAdd={() => setCriteria((items) => [...items, { id: `AC-${items.length + 1}`, text: '' }])}>{criteria.map((criterion, index) => <div key={index} className="grid gap-2 sm:grid-cols-[90px_1fr_auto]"><input value={criterion.id} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} className="form-control font-mono" /><input value={criterion.text} onChange={(event) => setCriteria((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} className="form-control" /><RemoveButton onClick={() => setCriteria((items) => items.filter((_, itemIndex) => itemIndex !== index))} /></div>)}</EditableList>
          {error && <ErrorMessage prefix={t("任务创建失败")} error={error} />}
        </div>
        <ModalFooter onClose={onClose} pending={pending} submitLabel={t("创建关联任务")} disabled={!title.trim() || !criteria.some((item) => item.text.trim())} />
      </form>
    </ModalShell>
  );
}

function inferSummary(content: string, fallback: string): string {
  return content.split(/\n\s*\n/).map((part) => part.replace(/^#{1,6}\s+.+$/gm, '').replace(/^[-*]\s+/gm, '').trim()).find(Boolean)?.slice(0, 240) || fallback;
}

function agentTaskCommand(requirement: Requirement): string {
  const acceptance = JSON.stringify(requirement.acceptance_criteria.length ? requirement.acceptance_criteria : [{ id: 'AC-1', text: t("根据需求补充可验证标准") }]);
  const safeTitle = requirement.title.replaceAll('"', '\\"');
  const featureArg = requirement.feature_code ? ` --feature ${requirement.feature_code}` : '';
  return `tsp requirement show ${requirement.code}\ntsp task create <TASK-CODE>${featureArg} --title "${safeTitle}" --profile builder --source requirement --requirement ${requirement.code} --acceptance '${acceptance}'`;
}

function PlusToolIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function UploadToolIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5V16h12v-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ShareToolIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="M7.5 11.5 12.5 6m-7 2H4a3 3 0 0 0 0 6h3m6-8h3a3 3 0 1 1 0 6h-1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function EditToolIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="m4 13.5-.5 3 3-.5L15 7.5 12.5 5 4 13.5ZM11.5 6l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ExtractToolIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 shrink-0"><path d="m10 2 .8 3.2L14 6l-3.2.8L10 10l-.8-3.2L6 6l3.2-.8L10 2Zm5 8 .55 2.45L18 13l-2.45.55L15 16l-.55-2.45L12 13l2.45-.55L15 10ZM5 11l.65 2.35L8 14l-2.35.65L5 17l-.65-2.35L2 14l2.35-.65L5 11Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}

function EmptyLibrary({ onCreate, canWrite }: { canWrite: boolean; onCreate: () => void }) {
  return <div className="grid min-h-[720px] place-items-center p-8 text-center"><div><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-cyan-50 text-xl text-cyan-700">{t("需")}</div><h2 className="mt-4 text-xl font-bold text-slate-900">{t("上传第一份需求文档")}</h2><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">{t("支持 Markdown 和纯文本。保存后团队成员即可阅读、分享，并继续提炼需求项。")}</p>{canWrite && <button type="button" onClick={onCreate} className="ui-button ui-button-primary mt-5">{t("上传 / 新建文档")}</button>}</div></div>;
}

function ModalShell({ title, eyebrow, description, onClose, children }: { title: string; eyebrow: string; description: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="modal-title" className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="z-10 flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
          <div><p className="text-xs font-bold tracking-[0.16em] text-cyan-700">{eyebrow}</p><h2 id="modal-title" className="mt-1 text-xl font-bold text-slate-950">{title}</h2><p className="mt-1 text-xs text-slate-500">{description}</p></div>
          <button type="button" onClick={onClose} aria-label={t("关闭弹窗")} className="ui-button ui-button-secondary">{t("关闭")}</button>
        </header>
        <div className="modal-scroll-region min-h-0 flex-1 overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}

function ModalFooter({ onClose, pending, submitLabel, disabled }: { onClose: () => void; pending: boolean; submitLabel: string; disabled: boolean }) {
  return <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-4"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || disabled} className="ui-button ui-button-primary">{pending ? t("保存中…") : submitLabel}</button></footer>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block text-sm font-semibold text-slate-700">{label}{hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}<div className="mt-1.5">{children}</div></label>;
}

function EditableList({ title, onAdd, children }: { title: string; onAdd: () => void; children: ReactNode }) {
  return <section><div className="flex items-center justify-between"><h3 className="text-sm font-bold text-slate-800">{title}</h3><button type="button" onClick={onAdd} className="ui-button ui-button-secondary ui-button-compact">{t("添加一条")}</button></div><div className="mt-3 space-y-2">{children}</div></section>;
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="ui-button ui-button-danger">{t("移除")}</button>;
}

function ErrorMessage({ prefix, error }: { prefix: string; error: Error }) {
  return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{prefix}：{error.message}</p>;
}

export function WorkbenchLoading({ label }: { label: string }) {
  useLocale();
  return <div className="flex min-h-56 flex-1 items-center justify-center bg-slate-50 text-sm text-slate-500">{label}</div>;
}

export function WorkbenchError({ error }: { error: unknown }) {
  useLocale();
  return <div className="m-7 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{t("无法连接 core-api：")}{error instanceof Error ? error.message : String(error)}</div>;
}
