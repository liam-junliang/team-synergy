import { useProjectAccess } from './useProjectAccess';
import { t, getLocale } from './i18n.ts';
import { useLocale } from './useLocale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { requirementWorkspacePath } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import {
  addRequirementTopicEntry,
  closeRequirementDocumentReview,
  createRequirementIdea,
  createRequirementTopic,
  getRequirementTopic,
  linkRequirementTopicDocuments,
  linkRequirementTopicIdeas,
  listRequirementDocumentReviews,
  listRequirementIdeas,
  listRequirementTopics,
  startRequirementDocumentReview,
  updateRequirementIdea,
  voteRequirementDocumentReview,
  withdrawRequirementTopicEntry,
  type RequirementDocumentReview,
  type RequirementDocumentSummary,
  type RequirementIdea,
  type RequirementReviewVote,
  type RequirementTopicDetail,
  type RequirementTopicEntry,
  type RequirementTopicEntryImage,
  type RequirementTopicEntryImageInput,
  type RequirementTopicEntryType,
} from './api';

const TOPIC_STATUS = { open: '讨论中', decided: '已决策', reopened: '重新讨论', archived: '已归档' } as const;
const ENTRY_META: Record<RequirementTopicEntryType, { label: string; tone: string }> = {
  comment: { label: '讨论', tone: 'bg-slate-100 text-slate-700' },
  alternative: { label: '备选方案', tone: 'bg-indigo-50 text-indigo-700' },
  feedback: { label: '方案调整', tone: 'bg-amber-50 text-amber-800' },
  decision: { label: '决策', tone: 'bg-cyan-50 text-cyan-800' },
};

type IdeaDialogState = { mode: 'create' } | { mode: 'edit'; idea: RequirementIdea };

export function RequirementIdeasWorkbench({ projectCode, onCountChange }: { projectCode: string; onCountChange?: (count: number) => void }) {
  useLocale();
  const client = useQueryClient();
  const { canWrite } = useProjectAccess(projectCode);
  const [search, setSearch] = useState('');
  const [ideaDialog, setIdeaDialog] = useState<IdeaDialogState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showTopic, setShowTopic] = useState(false);
  const query = useQuery({ queryKey: ['requirement-ideas', projectCode], queryFn: () => listRequirementIdeas(projectCode), enabled: Boolean(projectCode) });
  useEffect(() => onCountChange?.(query.data?.length ?? 0), [onCountChange, query.data?.length]);
  const create = useMutation({ mutationFn: (input: { title: string; detail?: string; source?: string }) => createRequirementIdea(projectCode, input), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-ideas', projectCode] }); setIdeaDialog(null); } });
  const update = useMutation({ mutationFn: ({ ideaCode, input }: { ideaCode: string; input: { title: string; detail?: string; source?: string } }) => updateRequirementIdea(ideaCode, input), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-ideas', projectCode] }); void client.invalidateQueries({ queryKey: ['requirement-topic'] }); setIdeaDialog(null); } });
  const updateLifecycle = useMutation({ mutationFn: (idea: RequirementIdea) => updateRequirementIdea(idea.idea_code, { status: idea.status === 'active' ? 'archived' : 'active' }), onSuccess: (_, idea) => { void client.invalidateQueries({ queryKey: ['requirement-ideas', projectCode] }); void client.invalidateQueries({ queryKey: ['requirement-topic'] }); setSelected((current) => { const next = new Set(current); next.delete(idea.idea_code); return next; }); setIdeaDialog(null); } });
  const createTopic = useMutation({ mutationFn: (input: { title: string; problem_statement: string; goal: string }) => createRequirementTopic(projectCode, { ...input, idea_codes: [...selected] }), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); void client.invalidateQueries({ queryKey: ['requirement-ideas', projectCode] }); setSelected(new Set()); setShowTopic(false); navigateWorkspace(requirementWorkspacePath(projectCode, { tab: 'topics' })); } });
  const ideas = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return (query.data ?? []).filter((idea) => !needle || `${idea.title} ${idea.detail} ${idea.source ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [query.data, search]);

  return <section className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4 max-xl:grid-cols-1">
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <label className="relative w-[360px] max-w-full flex-none max-md:w-full">
          <span className="sr-only">{t("搜索想法")}</span>
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"><SearchIcon /></span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索想法、来源或关键词")} className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] leading-5 text-slate-700 outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-100" />
        </label>
        <div className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0 max-md:w-full max-md:justify-end">
          {canWrite && <button type="button" disabled={selected.size === 0} onClick={() => setShowTopic(true)} className="ui-button ui-button-secondary">{t("整理为议题")}{selected.size > 0 && <span className="rounded-full bg-cyan-50 px-1.5 text-[10px] font-bold text-cyan-700">{selected.size}</span>}</button>}
          {canWrite && <button type="button" onClick={() => setIdeaDialog({ mode: 'create' })} className="ui-button ui-button-primary">{t("记录想法")}</button>}
        </div>
      </div>
      {query.isLoading ? <Empty>{t("正在加载想法…")}</Empty> : ideas.length === 0 ? <Empty>{t("先记录零散想法，再把相关想法整理成需求议题。")}</Empty> : <div className="divide-y divide-slate-100">
        {ideas.map((idea) => <article key={idea.idea_code} className={`group flex gap-3 px-4 py-4 transition ${selected.has(idea.idea_code) ? 'bg-cyan-50/30' : 'hover:bg-slate-50'}`}>
          <input aria-label={t("选择想法：{0}", { "0": idea.title })} type="checkbox" disabled={!canWrite || idea.status === 'archived'} checked={selected.has(idea.idea_code)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(idea.idea_code)) next.delete(idea.idea_code); else next.add(idea.idea_code); return next; })} className="mt-1 h-4 w-4 rounded border-slate-300 text-cyan-600 disabled:cursor-not-allowed disabled:opacity-40" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">{idea.title}</h3>{idea.status === 'archived' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{t("已归档")}</span>}{idea.topic_count > 0 && <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700">{t("进入 {0} 个议题", { "0": idea.topic_count })}</span>}</div>
            {idea.detail && <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600">{idea.detail}</p>}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-400"><code>{idea.idea_code}</code>{idea.source && <span>{t("来源：{0}", { "0": idea.source })}</span>}<time>{new Date(idea.updated_at).toLocaleDateString(getLocale())}</time></div>
          </div>
          {canWrite && <button type="button" onClick={() => setIdeaDialog({ mode: 'edit', idea })} aria-label={t("编辑想法：{0}", { "0": idea.title })} title={t("编辑想法")} className="ui-context-action self-start"><EditIcon />{t("编辑")}</button>}
        </article>)}
      </div>}
    </div>
    <aside className="space-y-3">
      <section className="rounded-2xl border border-cyan-100 bg-cyan-50/60 p-4"><p className="text-[11px] font-bold tracking-[.16em] text-cyan-700">DISCOVERY</p><h2 className="mt-1 font-bold text-slate-900">{t("先记录，不急着定方案")}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{t("想法只回答“发现了什么”。把相关想法选中整理成议题后，再讨论问题、方案和取舍。")}</p></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-4"><h2 className="text-sm font-bold text-slate-800">{t("当前想法")}</h2><div className="mt-3 grid grid-cols-2 gap-3"><Metric label={t("全部")} value={query.data?.length ?? 0} /><Metric label={t("未进入议题")} value={(query.data ?? []).filter((idea) => idea.topic_count === 0 && idea.status === 'active').length} /></div></section>
    </aside>
    {canWrite && ideaDialog && <IdeaDialog
      key={ideaDialog.mode === 'edit' ? ideaDialog.idea.idea_code : 'create-idea'}
      state={ideaDialog}
      pending={create.isPending || update.isPending || updateLifecycle.isPending}
      error={create.error ?? update.error ?? updateLifecycle.error}
      onClose={() => setIdeaDialog(null)}
      onSubmit={(input) => ideaDialog.mode === 'create' ? create.mutate(input) : update.mutate({ ideaCode: ideaDialog.idea.idea_code, input })}
      onLifecycleChange={() => { if (ideaDialog.mode === 'edit') updateLifecycle.mutate(ideaDialog.idea); }}
    />}
    {canWrite && showTopic && <TopicDialog ideaCount={selected.size} pending={createTopic.isPending} error={createTopic.error} onClose={() => setShowTopic(false)} onSubmit={(input) => createTopic.mutate(input)} />}
  </section>;
}

export function RequirementTopicsWorkbench({ projectCode, documents, onCountChange }: { projectCode: string; documents: RequirementDocumentSummary[]; onCountChange?: (count: number) => void }) {
  useLocale();
  const client = useQueryClient();
  const { canWrite, canManage } = useProjectAccess(projectCode);
  const [search, setSearch] = useState('');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [entryType, setEntryType] = useState<RequirementTopicEntryType | null>(null);
  const [previewImage, setPreviewImage] = useState<RequirementTopicEntryImage | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<RequirementTopicEntry | null>(null);
  const [linkMode, setLinkMode] = useState<'ideas' | 'documents' | null>(null);
  const topicsQuery = useQuery({ queryKey: ['requirement-topics', projectCode], queryFn: () => listRequirementTopics(projectCode), enabled: Boolean(projectCode) });
  useEffect(() => onCountChange?.(topicsQuery.data?.length ?? 0), [onCountChange, topicsQuery.data?.length]);
  const topics = useMemo(() => { const needle = search.trim().toLocaleLowerCase(); return (topicsQuery.data ?? []).filter((topic) => !needle || `${topic.title} ${topic.problem_statement} ${topic.goal}`.toLocaleLowerCase().includes(needle)); }, [search, topicsQuery.data]);
  useEffect(() => {
    const availableTopics = topicsQuery.data ?? [];
    if (availableTopics.length === 0) {
      if (selectedCode) setSelectedCode(null);
      return;
    }
    if (!selectedCode || !availableTopics.some((topic) => topic.topic_code === selectedCode)) {
      setSelectedCode(availableTopics[0].topic_code);
    }
  }, [selectedCode, topicsQuery.data]);
  const activeCode = selectedCode;
  const detailQuery = useQuery({ queryKey: ['requirement-topic', activeCode], queryFn: () => getRequirementTopic(activeCode as string), enabled: Boolean(activeCode) });
  const create = useMutation({ mutationFn: (input: { title: string; problem_statement: string; goal: string }) => createRequirementTopic(projectCode, input), onSuccess: (topic) => { void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); setSelectedCode(topic.topic_code); setShowCreate(false); } });
  const addEntry = useMutation({ mutationFn: (input: { entry_type: RequirementTopicEntryType; content: string; rationale?: string; supersedes_entry_code?: string; images?: RequirementTopicEntryImageInput[] }) => addRequirementTopicEntry(activeCode as string, input), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-topic', activeCode] }); void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); setEntryType(null); } });
  const withdrawEntry = useMutation({ mutationFn: (input: { entryCode: string; reason?: string }) => withdrawRequirementTopicEntry(input.entryCode, input.reason), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-topic', activeCode] }); void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); setWithdrawTarget(null); } });
  const ideasQuery = useQuery({ queryKey: ['requirement-ideas', projectCode], queryFn: () => listRequirementIdeas(projectCode), enabled: linkMode === 'ideas' });
  const linkIdeas = useMutation({ mutationFn: (codes: string[]) => linkRequirementTopicIdeas(activeCode as string, codes), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-topic', activeCode] }); void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); setLinkMode(null); } });
  const linkDocuments = useMutation({ mutationFn: (codes: string[]) => linkRequirementTopicDocuments(activeCode as string, codes), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-topic', activeCode] }); void client.invalidateQueries({ queryKey: ['requirement-topics', projectCode] }); setLinkMode(null); } });
  const detail = detailQuery.data;

  return <section className="grid min-h-[600px] grid-cols-[320px_minmax(0,1fr)_300px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm max-xl:grid-cols-[280px_minmax(0,1fr)] max-lg:grid-cols-1">
    <aside className="border-r border-slate-200 max-lg:border-b max-lg:border-r-0">
      <div className="flex gap-2 border-b border-slate-200 p-3"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索议题")} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-cyan-500" />{canWrite && <button type="button" onClick={() => setShowCreate(true)} className="ui-button ui-button-primary ui-button-compact">{t("新建议题")}</button>}</div>
      <div className="max-h-[620px] overflow-y-auto p-2">{topics.length === 0 ? <Empty>{t("还没有需求议题")}</Empty> : topics.map((topic) => <button type="button" key={topic.topic_code} onClick={() => setSelectedCode(topic.topic_code)} className={`mb-1 w-full rounded-xl border p-3 text-left transition ${topic.topic_code === activeCode ? 'border-cyan-200 bg-cyan-50' : 'border-transparent hover:bg-slate-50'}`}><div className="flex items-start justify-between gap-2"><strong className="text-sm leading-5 text-slate-900">{topic.title}</strong><span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-500">{t(TOPIC_STATUS[topic.status])}</span></div>{topic.problem_statement && <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{topic.problem_statement}</p>}<div className="mt-2 flex gap-3 text-[10px] text-slate-400"><span>{t("{0} 想法", { "0": topic.idea_count })}</span><span>{t("{0} 条记录", { "0": topic.entry_count })}</span><span>{t("{0} 文档", { "0": topic.document_count })}</span></div></button>)}</div>
    </aside>
    <div className="min-w-0">
      {!detail ? <Empty>{detailQuery.error ? t("议题详情加载失败：{0}", { "0": detailQuery.error instanceof Error ? detailQuery.error.message : String(detailQuery.error) }) : detailQuery.isLoading ? t("正在加载议题…") : t("选择一个议题查看讨论与决策")}</Empty> : <>
        <header className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-4 max-md:flex-col">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{t(TOPIC_STATUS[detail.status])}</span>
                <code className="text-[10px] text-slate-400">{detail.topic_code}</code>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${detail.ideas.length > 0 ? 'bg-cyan-50 text-cyan-700' : 'bg-slate-100 text-slate-500'}`}>
                  {detail.ideas.length > 0 ? t("由 {0} 个想法汇聚", { "0": detail.ideas.length }) : t("直接创建的议题")}
                </span>
              </div>
              <h2 className="mt-2 text-xl font-bold text-slate-950">{detail.title}</h2>
              {detail.problem_statement && <p className="mt-2 text-sm leading-6 text-slate-600">{detail.problem_statement}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2 max-md:w-full max-md:justify-start">
              {canWrite && <button type="button" onClick={() => setEntryType('comment')} className="ui-button ui-button-secondary ui-button-compact">{t("参与讨论")}</button>}
              {canWrite && <button type="button" onClick={() => setEntryType('alternative')} className="ui-button ui-button-secondary ui-button-compact">{t("备选方案")}</button>}
              {canManage && <button type="button" onClick={() => setEntryType('decision')} className="ui-button ui-button-primary ui-button-compact">{t("形成决策")}</button>}
              {canWrite && <button type="button" onClick={() => setEntryType('feedback')} className="ui-button ui-button-compact border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:bg-amber-100">{t("方案调整")}</button>}
            </div>
          </div>
        </header>
        <div className="max-h-[535px] overflow-y-auto px-5 py-4"><h3 className="mb-4 text-xs font-bold tracking-[.14em] text-slate-500">{t("讨论与决策时间线")}</h3>{detail.entries.length === 0 ? <Empty>{t("议题已建立，补充讨论或形成第一条决策。")}</Empty> : <div className="relative space-y-4 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-slate-200">{detail.entries.map((entry) => <TopicEntryCard key={entry.entry_code} entry={{ ...entry, can_withdraw: canWrite && entry.can_withdraw }} onPreview={setPreviewImage} onWithdraw={setWithdrawTarget} />)}</div>}</div>
      </>}
    </div>
    <aside className="border-l border-slate-200 bg-slate-50/70 p-4 max-xl:col-span-2 max-xl:border-l-0 max-xl:border-t max-lg:col-span-1">{detail && <TopicContext canWrite={canWrite} detail={detail} onLinkIdeas={() => setLinkMode('ideas')} onLinkDocuments={() => setLinkMode('documents')} />}</aside>
    {canWrite && showCreate && <TopicDialog pending={create.isPending} error={create.error} onClose={() => setShowCreate(false)} onSubmit={(input) => create.mutate(input)} />}
    {canWrite && entryType && detail && <TopicEntryDialog type={entryType} currentDecision={detail.current_decision?.entry_code ?? undefined} pending={addEntry.isPending} error={addEntry.error} onClose={() => setEntryType(null)} onSubmit={(input) => addEntry.mutate(input)} />}
    {previewImage && <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />}
    {canWrite && withdrawTarget && <WithdrawEntryDialog entry={withdrawTarget} pending={withdrawEntry.isPending} error={withdrawEntry.error} onClose={() => setWithdrawTarget(null)} onSubmit={(reason) => withdrawEntry.mutate({ entryCode: withdrawTarget.entry_code, reason })} />}
    {canWrite && linkMode === 'ideas' && detail && <SelectionDialog title={t("关联想法")} items={(ideasQuery.data ?? []).filter((idea) => !detail.ideas.some((linked) => linked.idea_code === idea.idea_code)).map((idea) => ({ code: idea.idea_code, label: idea.title, description: idea.detail }))} pending={linkIdeas.isPending} onClose={() => setLinkMode(null)} onSubmit={(codes) => linkIdeas.mutate(codes)} />}
    {canWrite && linkMode === 'documents' && detail && <SelectionDialog title={t("关联需求文档")} items={documents.filter((document) => !detail.documents.some((linked) => linked.document_code === document.code)).map((document) => ({ code: document.code, label: document.title, description: document.summary }))} pending={linkDocuments.isPending} onClose={() => setLinkMode(null)} onSubmit={(codes) => linkDocuments.mutate(codes)} />}
  </section>;
}

function TopicContext({ canWrite, detail, onLinkIdeas, onLinkDocuments }: { canWrite: boolean; detail: RequirementTopicDetail; onLinkIdeas: () => void; onLinkDocuments: () => void }) {
  return <div className="space-y-5 max-xl:grid max-xl:grid-cols-3 max-xl:gap-4 max-xl:space-y-0 max-lg:block max-lg:space-y-5">
    <section>
      <div className="flex items-center justify-between"><h3 className="text-xs font-bold tracking-[.12em] text-slate-500">{t("当前决策")}</h3></div>
      {detail.current_decision ? <div className="mt-2 rounded-xl border border-cyan-100 bg-white p-3"><p className="text-sm leading-6 text-slate-700">{detail.current_decision.content}</p></div> : <p className="mt-2 text-xs leading-5 text-slate-400">{t("还没有形成决策，议题可持续讨论。")}</p>}
    </section>
    <section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold tracking-[.12em] text-slate-500">{t("来源想法")}<span className="ml-1 rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] text-cyan-700">{detail.ideas.length}</span></h3>
        {canWrite && <button type="button" onClick={onLinkIdeas} aria-label={t("关联想法")} title={t("关联想法")} className="ui-context-action ui-context-action-accent"><ContextLinkIcon />{t("关联")}</button>}
      </div>
      {detail.ideas.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed border-slate-300 bg-white/70 px-3 py-4 text-xs leading-5 text-slate-500">{t("这是直接创建的议题。可以继续关联相关想法，补充问题来源。")}</div>
      ) : (
        <div className="mt-2 space-y-2">
          {detail.ideas.map((idea) => <TopicIdeaCard key={idea.idea_code} idea={idea} initiallyOpen={detail.ideas.length === 1} />)}
        </div>
      )}
    </section>
    <section>
      <div className="flex items-center justify-between"><h3 className="text-xs font-bold tracking-[.12em] text-slate-500">{t("沉淀文档 · {0}", { "0": detail.documents.length })}</h3>{canWrite && <button type="button" onClick={onLinkDocuments} aria-label={t("关联文档")} title={t("关联文档")} className="ui-context-action ui-context-action-accent"><ContextLinkIcon />{t("关联")}</button>}</div>
      <div className="mt-2 space-y-2">{detail.documents.map((document) => <div key={document.document_code} className="rounded-lg border border-slate-200 bg-white p-2.5"><p className="text-xs font-semibold text-slate-700">{document.title}</p><p className="mt-1 text-[10px] text-slate-400">Revision {document.current_revision}</p></div>)}</div>
    </section>
  </div>;
}

function TopicEntryCard({ entry, onPreview, onWithdraw }: { entry: RequirementTopicEntry; onPreview: (image: RequirementTopicEntryImage) => void; onWithdraw: (entry: RequirementTopicEntry) => void }) {
  const withdrawn = Boolean(entry.withdrawn_at);
  return <article className="relative pl-9">
    <span className={`absolute left-0 top-1.5 z-10 h-[23px] w-[23px] rounded-full border-4 border-white ${withdrawn ? 'bg-slate-300' : entry.entry_type === 'decision' ? 'bg-cyan-500' : entry.entry_type === 'feedback' ? 'bg-amber-400' : 'bg-slate-300'}`} />
    <div className={`rounded-xl border p-3 ${withdrawn ? 'border-dashed border-slate-200 bg-slate-50/80' : entry.entry_type === 'decision' ? 'border-cyan-200 bg-cyan-50/50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${withdrawn ? 'bg-slate-200 text-slate-500' : ENTRY_META[entry.entry_type].tone}`}>{t(ENTRY_META[entry.entry_type].label)}</span>
        <span className="text-xs font-medium text-slate-600">{entry.author_name ?? t("项目成员")}</span>
        <time className="text-[10px] text-slate-400">{new Date(entry.created_at).toLocaleString(getLocale())}</time>
        {entry.supersedes_entry_code && !withdrawn && <span className="text-[10px] text-amber-700">{t("替代历史决策")}</span>}
        {entry.can_withdraw && <button type="button" onClick={() => onWithdraw(entry)} aria-label={t("撤回{0}记录", { "0": t(ENTRY_META[entry.entry_type].label) })} title={t("撤回这条记录")} className="ui-context-action ui-context-action-danger ml-auto"><WithdrawIcon />{t("撤回")}</button>}
      </div>
      {withdrawn ? <div className="mt-3 rounded-lg bg-white/70 px-3 py-3 text-xs text-slate-500"><p>{t("该记录已由 {0} 撤回", { "0": entry.withdrawn_by_name ?? t('项目成员') })}</p>{entry.withdrawn_at && <time className="mt-1 block text-[10px] text-slate-400">{new Date(entry.withdrawn_at).toLocaleString(getLocale())}</time>}{entry.withdrawal_reason && <p className="mt-2 text-slate-500">{t("原因：{0}", { "0": entry.withdrawal_reason })}</p>}</div> : <>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{entry.content}</p>
        {entry.rationale && <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs leading-5 text-slate-500"><strong>{t("决策依据：")}</strong>{entry.rationale}</p>}
        {entry.images.length > 0 && <div className="mt-3 grid max-w-2xl grid-cols-4 gap-2 max-md:grid-cols-2">{entry.images.map((image) => <button type="button" key={image.image_code} onClick={() => onPreview(image)} className="group/image relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-200 bg-slate-100 text-left" aria-label={t("查看图片：{0}", { "0": image.file_name })}><img src={image.data_url} alt={image.file_name} loading="lazy" className="h-full w-full object-cover transition group-hover/image:scale-[1.03]" /><span className="absolute inset-x-0 bottom-0 truncate bg-slate-950/65 px-2 py-1 text-[10px] text-white">{image.file_name}</span></button>)}</div>}
        {entry.source_entity_code && <p className="mt-2 text-[10px] text-slate-400">{t("反馈来源 {0} · {1}", { "0": entry.source_entity_type ?? '', "1": entry.source_entity_code })}</p>}
      </>}
    </div>
  </article>;
}

function ContextLinkIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7.25 12.75 12.75 7.25" /><path d="M6.1 15.9H4.75a3.65 3.65 0 0 1 0-7.3H7" /><path d="M13 8.6h2.25a3.65 3.65 0 1 1 0 7.3H13" /></svg>;
}

function WithdrawIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m7 6-3 3 3 3" /><path d="M4.5 9H12a4 4 0 0 1 0 8H9" /></svg>;
}

function ArchiveIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7.5h12v8.25A1.25 1.25 0 0 1 14.75 17h-9.5A1.25 1.25 0 0 1 4 15.75Z" /><path d="M3 4.5h14v3H3zM8 11h4" /></svg>;
}

function RestoreIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 6-3 3 3 3" /><path d="M3.5 9H11a4.5 4.5 0 1 1-3.2 7.66" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m13.5 3.5 3 3-9.75 9.75-3.75.75.75-3.75Z" /><path d="m11.5 5.5 3 3" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="8.5" cy="8.5" r="4.75" /><path d="m12 12 4 4" /></svg>;
}

function TopicIdeaCard({ idea, initiallyOpen }: { idea: RequirementIdea; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/idea overflow-hidden rounded-xl border border-slate-200 bg-white">
    <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-3 [&::-webkit-details-marker]:hidden">
      <div className="min-w-0">
        <p className="text-xs font-semibold leading-5 text-slate-800">{idea.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
          {idea.source && <span>{t("来源：{0}", { "0": idea.source })}</span>}
          {idea.status === 'archived' && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{t("已归档")}</span>}
        </div>
      </div>
      <span className="mt-0.5 shrink-0 text-[10px] font-medium text-cyan-700 group-open/idea:hidden">{t("展开")}</span>
      <span className="mt-0.5 hidden shrink-0 text-[10px] font-medium text-slate-400 group-open/idea:inline">{t("收起")}</span>
    </summary>
    <div className="border-t border-slate-100 px-3 py-3">
      <p className="whitespace-pre-wrap text-xs leading-5 text-slate-600">{idea.detail || t("这个想法还没有补充详细说明。")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
        {idea.created_by_name && <span>{t("记录人：{0}", { "0": idea.created_by_name })}</span>}
        <time>{new Date(idea.updated_at).toLocaleDateString(getLocale())}</time>
        <code className="break-all">{idea.idea_code}</code>
      </div>
    </div>
  </details>;
}

export function RequirementReviewPanel({ documentCode, currentRevision, canWrite = false, canManage = false }: { documentCode: string; currentRevision: number; canWrite?: boolean; canManage?: boolean }) {
  useLocale();
  const client = useQueryClient();
  const [showVote, setShowVote] = useState(false);
  const query = useQuery({ queryKey: ['requirement-document-reviews', documentCode], queryFn: () => listRequirementDocumentReviews(documentCode), enabled: Boolean(documentCode) });
  const current = query.data?.find((review) => review.revision === currentRevision);
  const start = useMutation({ mutationFn: () => startRequirementDocumentReview(documentCode), onSuccess: () => void client.invalidateQueries({ queryKey: ['requirement-document-reviews', documentCode] }) });
  const vote = useMutation({ mutationFn: (input: { vote: RequirementReviewVote; comment: string }) => voteRequirementDocumentReview(current!.review_code, input.vote, input.comment), onSuccess: () => { void client.invalidateQueries({ queryKey: ['requirement-document-reviews', documentCode] }); setShowVote(false); } });
  const close = useMutation({ mutationFn: (conclusion: 'passed' | 'changes_requested' | 'no_consensus') => closeRequirementDocumentReview(current!.review_code, conclusion), onSuccess: () => void client.invalidateQueries({ queryKey: ['requirement-document-reviews', documentCode] }) });
  if (query.isLoading) return <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-400">{t("正在加载版本评审…")}</div>;
  return <section className="rounded-xl border border-slate-200 bg-white p-3">
    <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-sm font-bold text-slate-800">{t("Revision {0} 评审", { "0": currentRevision })}</h3>{current && <ReviewStatus review={current} />}</div><p className="mt-1 text-xs leading-5 text-slate-500">{t("评审是协作意见，不影响提炼需求项或创建任务草稿。")}</p></div>{!current ? (canWrite && <button type="button" onClick={() => start.mutate()} disabled={start.isPending} className="ui-button ui-button-secondary ui-button-compact">{t("发起评审")}</button>) : current.status === 'open' ? (canWrite && <button type="button" onClick={() => setShowVote(true)} className="ui-button ui-button-secondary ui-button-compact">{t("表达意见")}</button>) : null}</div>
    {current && <div className="mt-3 flex flex-wrap gap-2">{current.votes.length === 0 ? <span className="text-xs text-slate-400">{t("等待项目成员表达意见")}</span> : current.votes.map((item) => <span key={`${item.principal_code}-${item.responded_at}`} title={item.comment} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600">{item.principal_name ?? t("成员")} · {item.vote === 'support' ? t("支持") : item.vote === 'changes_requested' ? t("需要修改") : t("弃权")}</span>)}</div>}
    {canManage && current?.status === 'open' && <div className="mt-3 flex justify-end gap-2 border-t border-slate-100 pt-3"><span className="mr-auto text-[11px] text-slate-400">{t("由项目负责人或管理员结束")}</span><button type="button" onClick={() => close.mutate('changes_requested')} className="text-xs font-semibold text-amber-700">{t("需要修改")}</button><button type="button" onClick={() => close.mutate('no_consensus')} className="text-xs font-semibold text-slate-500">{t("暂无共识")}</button><button type="button" onClick={() => close.mutate('passed')} className="text-xs font-semibold text-emerald-700">{t("通过评审")}</button></div>}
    {canWrite && showVote && <VoteDialog pending={vote.isPending} error={vote.error} onClose={() => setShowVote(false)} onSubmit={(input) => vote.mutate(input)} />}
  </section>;
}

function ReviewStatus({ review }: { review: RequirementDocumentReview }) { const label = review.status === 'open' ? t("评审中") : review.conclusion === 'passed' ? t("已通过") : review.conclusion === 'changes_requested' ? t("需要修改") : t("已结束"); return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${review.status === 'open' ? 'bg-amber-50 text-amber-700' : review.conclusion === 'passed' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{label}</span>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-slate-50 p-3"><strong className="text-2xl text-slate-900">{value}</strong><p className="mt-1 text-[11px] text-slate-500">{label}</p></div>; }
function Empty({ children }: { children: ReactNode }) { return <div className="flex min-h-[160px] items-center justify-center px-6 text-center text-sm leading-6 text-slate-400">{children}</div>; }

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) { return <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[1px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl"><header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-900">{title}</h2><button type="button" onClick={onClose} aria-label={t("关闭")} className="text-xl text-slate-400 hover:text-slate-700">×</button></header>{children}</div></div>; }
function ErrorText({ error }: { error: unknown }) { return error ? <p className="text-xs text-rose-600">{error instanceof Error ? error.message : String(error)}</p> : null; }

function IdeaDialog({ state, pending, error, onClose, onSubmit, onLifecycleChange }: {
  state: IdeaDialogState;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: { title: string; detail?: string; source?: string }) => void;
  onLifecycleChange: () => void;
}) {
  const idea = state.mode === 'edit' ? state.idea : null;
  const [title, setTitle] = useState(idea?.title ?? '');
  const [detail, setDetail] = useState(idea?.detail ?? '');
  const [source, setSource] = useState(idea?.source ?? '');
  return <Modal title={idea ? t("编辑想法") : t("记录想法")} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); onSubmit({ title: title.trim(), detail: detail.trim(), source: source.trim() }); }}>
      <div className="space-y-4 p-5">
        <label className="block text-sm font-semibold text-slate-700">{t("一句话想法")}<input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("例如：任务领取后应该自动带上完整执行上下文")} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-cyan-500" /></label>
        <label className="block text-sm font-semibold text-slate-700">{t("补充观察")}<textarea value={detail} onChange={(event) => setDetail(event.target.value)} rows={4} placeholder={t("场景、问题表现、用户反馈或尚未验证的设想")} className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500" /></label>
        <label className="block text-sm font-semibold text-slate-700">{t("来源（可选）")}<input value={source} onChange={(event) => setSource(event.target.value)} placeholder={t("用户反馈、开发过程、缺陷复盘…")} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-cyan-500" /></label>
        <ErrorText error={error} />
      </div>
      <footer className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
        <div>{idea && <button type="button" disabled={pending} onClick={onLifecycleChange} className={`ui-button ${idea.status === 'active' ? 'ui-button-danger' : 'ui-button-secondary'}`}>{idea.status === 'active' ? <ArchiveIcon /> : <RestoreIcon />}{idea.status === 'active' ? t("归档想法") : t("恢复想法")}</button>}</div>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || !title.trim()} className="ui-button ui-button-primary">{pending ? t("保存中…") : idea ? t("保存修改") : t("保存想法")}</button></div>
      </footer>
    </form>
  </Modal>;
}
function TopicDialog({ ideaCount = 0, pending, error, onClose, onSubmit }: { ideaCount?: number; pending: boolean; error: unknown; onClose: () => void; onSubmit: (input: { title: string; problem_statement: string; goal: string }) => void }) { const [title, setTitle] = useState(''); const [problem, setProblem] = useState(''); const [goal, setGoal] = useState(''); return <Modal title={ideaCount ? t("把 {0} 个想法整理为需求议题", { "0": ideaCount }) : t("新建需求议题")} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit({ title, problem_statement: problem, goal }); }} className="space-y-4 p-5"><label className="block text-sm font-semibold text-slate-700">{t("议题名称")}<input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-cyan-500" /></label><label className="block text-sm font-semibold text-slate-700">{t("要解决的问题")}<textarea required value={problem} onChange={(event) => setProblem(event.target.value)} rows={3} className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500" /></label><label className="block text-sm font-semibold text-slate-700">{t("期望结果")}<textarea value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500" /></label><ErrorText error={error} /><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending} className="ui-button ui-button-primary">{pending ? t("创建中…") : t("创建议题")}</button></div></form></Modal>; }
function TopicEntryDialog({ type, currentDecision, pending, error, onClose, onSubmit }: { type: RequirementTopicEntryType; currentDecision?: string; pending: boolean; error: unknown; onClose: () => void; onSubmit: (input: { entry_type: RequirementTopicEntryType; content: string; rationale?: string; supersedes_entry_code?: string; images?: RequirementTopicEntryImageInput[] }) => void }) {
  const [content, setContent] = useState('');
  const [rationale, setRationale] = useState('');
  const [supersede, setSupersede] = useState(Boolean(currentDecision && type === 'decision'));
  const [images, setImages] = useState<Array<RequirementTopicEntryImageInput & { byteSize: number }>>([]);
  const [imageError, setImageError] = useState('');
  const [imagePending, setImagePending] = useState(false);
  const selectImages = async (files: File[]) => {
    setImageError('');
    if (images.length + files.length > 4) return setImageError(t("每条记录最多上传 4 张图片"));
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (files.some((file) => !allowed.has(file.type))) return setImageError(t("仅支持 PNG、JPG、WebP 或 GIF 图片"));
    if (files.some((file) => file.size > 2 * 1024 * 1024)) return setImageError(t("单张图片不能超过 2 MB"));
    if (images.reduce((sum, image) => sum + image.byteSize, 0) + files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) return setImageError(t("每条记录的图片总大小不能超过 5 MB"));
    setImagePending(true);
    try {
      const next = await Promise.all(files.map(async (file) => ({ file_name: file.name, data_url: await readFileDataUrl(file), byteSize: file.size })));
      setImages((current) => [...current, ...next]);
    } catch {
      setImageError(t("图片读取失败，请重新选择"));
    } finally {
      setImagePending(false);
    }
  };
  return <Modal title={type === 'feedback' ? t("记录方案调整") : t("新增{0}", { "0": t(ENTRY_META[type].label) })} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit({ entry_type: type, content, rationale, supersedes_entry_code: supersede ? currentDecision : undefined, images: images.map(({ file_name, data_url }) => ({ file_name, data_url })) }); }} className="space-y-4 p-5">
    <textarea autoFocus required value={content} onChange={(event) => setContent(event.target.value)} rows={6} placeholder={type === 'decision' ? t("清晰记录决定了什么，以及后续应按什么方向推进") : type === 'feedback' ? t("记录调整原因、影响范围和建议方案") : t("记录讨论内容或备选方案")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 outline-none focus:border-cyan-500" />
    {type === 'decision' && <><textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={3} placeholder={t("决策依据、取舍和未采用方案")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500" />{currentDecision && <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={supersede} onChange={(event) => setSupersede(event.target.checked)} />{t("这条决策替代当前历史决策")}</label>}</>}
    <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-slate-700">{t("附加图片")}<span className="font-normal text-slate-400">{t("（可选）")}</span></p><p className="mt-0.5 text-[11px] text-slate-400">{t("最多 4 张，单张 2 MB，支持 PNG/JPG/WebP/GIF")}</p></div><label className={`ui-button ui-button-secondary ui-button-compact ${imagePending ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}><input type="file" multiple disabled={imagePending} accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t("选择议题图片")} className="sr-only" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void selectImages(files); }} />{imagePending ? t("读取中…") : t("选择图片")}</label></div>{images.length > 0 && <div className="mt-3 grid grid-cols-4 gap-2 max-sm:grid-cols-2">{images.map((image, index) => <div key={`${image.file_name}-${index}`} className="relative aspect-[4/3] overflow-hidden rounded-lg border border-slate-200 bg-white"><img src={image.data_url} alt={image.file_name} className="h-full w-full object-cover" /><button type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={t("移除图片：{0}", { "0": image.file_name })} className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/70 text-sm text-white">×</button></div>)}</div>}</section>
    {imageError && <p className="text-xs text-rose-600">{imageError}</p>}<ErrorText error={error} /><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending || imagePending} className="ui-button ui-button-primary">{pending ? t("提交中…") : imagePending ? t("图片处理中…") : t("提交记录")}</button></div>
  </form></Modal>;
}
function readFileDataUrl(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(t("图片读取失败"))); reader.onerror = () => reject(new Error(t("图片读取失败"))); reader.readAsDataURL(file); }); }
function ImagePreviewDialog({ image, onClose }: { image: RequirementTopicEntryImage; onClose: () => void }) { return <Modal title={image.file_name} onClose={onClose}><div className="bg-slate-950 p-3"><img src={image.data_url} alt={image.file_name} className="mx-auto max-h-[72vh] w-auto max-w-full rounded object-contain" /></div><footer className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500"><span>{(image.byte_size / 1024).toFixed(1)} KB</span><button type="button" onClick={onClose} className="ui-button ui-button-secondary ui-button-compact">{t("关闭")}</button></footer></Modal>; }
function WithdrawEntryDialog({ entry, pending, error, onClose, onSubmit }: { entry: RequirementTopicEntry; pending: boolean; error: unknown; onClose: () => void; onSubmit: (reason?: string) => void }) { const [reason, setReason] = useState(''); return <Modal title={t("撤回这条记录？")} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit(reason.trim() || undefined); }} className="space-y-4 p-5"><div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">{t("撤回后，正文和图片将不再展示；时间线会保留撤回人、时间和审计记录。决策记录不能撤回。")}</div><p className="line-clamp-2 text-xs leading-5 text-slate-500">{t("原记录：{0}", { "0": entry.content })}</p><label className="block text-sm font-semibold text-slate-700">{t("撤回原因")}<span className="font-normal text-slate-400">{t("（可选）")}</span><textarea autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder={t("例如：内容误发、图片选择错误")} className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal outline-none focus:border-rose-300 focus:ring-2 focus:ring-rose-100" /></label><ErrorText error={error} /><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("返回")}</button><button disabled={pending} className="ui-button ui-button-danger">{pending ? t("撤回中…") : t("确认撤回")}</button></div></form></Modal>; }
function SelectionDialog({ title, items, pending, onClose, onSubmit }: { title: string; items: Array<{ code: string; label: string; description?: string }>; pending: boolean; onClose: () => void; onSubmit: (codes: string[]) => void }) { const [selected, setSelected] = useState<Set<string>>(new Set()); return <Modal title={title} onClose={onClose}><div className="max-h-[420px] overflow-y-auto p-4">{items.length === 0 ? <Empty>{t("没有可关联的内容")}</Empty> : items.map((item) => <label key={item.code} className="mb-2 flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3 hover:bg-slate-50"><input type="checkbox" checked={selected.has(item.code)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.code)) next.delete(item.code); else next.add(item.code); return next; })} /><span><strong className="block text-sm text-slate-800">{item.label}</strong>{item.description && <span className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{item.description}</span>}</span></label>)}</div><footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button type="button" disabled={pending || selected.size === 0} onClick={() => onSubmit([...selected])} className="ui-button ui-button-primary">{t("关联 {0}", { "0": selected.size || '' })}</button></footer></Modal>; }
function VoteDialog({ pending, error, onClose, onSubmit }: { pending: boolean; error: unknown; onClose: () => void; onSubmit: (input: { vote: RequirementReviewVote; comment: string }) => void }) { const [vote, setVote] = useState<RequirementReviewVote>('support'); const [comment, setComment] = useState(''); return <Modal title={t("表达评审意见")} onClose={onClose}><form onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit({ vote, comment }); }} className="space-y-4 p-5"><div className="grid grid-cols-3 gap-2">{([['support', t("支持")], ['changes_requested', t("需要修改")], ['abstain', t("弃权")]] as const).map(([value, label]) => <button type="button" key={value} onClick={() => setVote(value)} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${vote === value ? 'border-cyan-400 bg-cyan-50 text-cyan-800' : 'border-slate-200 text-slate-600'}`}>{label}</button>)}</div><textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={4} placeholder={t("补充意见（可选）")} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-cyan-500" /><ErrorText error={error} /><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="ui-button ui-button-secondary">{t("取消")}</button><button disabled={pending} className="ui-button ui-button-primary">{t("提交意见")}</button></div></form></Modal>; }
