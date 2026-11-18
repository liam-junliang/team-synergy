import { useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCodeUnderstandingContext, getCodeUnderstandingGraph, getCodeUnderstandingRun, getCodeUnderstandingUaMap, getCodeAnalysisRuntime, listCodeAnalyses, requestCodeAnalysis, type CodeGraphResult, type CodeRunSummary } from './codeUnderstandingApi';
import { codeNodeRelations, layoutCodeMap, nodeKey, type MapNode } from './codeUnderstandingMap';
import { codeReaderStateForScope, codeRepositoryPath, codeRunMatchesRepository, resolveCodeRepositorySelection, type CodeReaderState } from './codeUnderstandingRepository';
import { codeUnderstandingPath, type WorkspaceRoute } from './workspaceRouting';
import { navigateWorkspace } from './workspaceNavigation';
import { formatDateTime, t } from './i18n';
import { useLocale } from './useLocale';
import { ApiError } from './apiError';
import { CodeSourceAccessNotice } from './CodeSourceAccessNotice';
import { UaNativeReader } from './UaNativeReader';
import { PublicCodeSchema } from '../../../packages/contracts/src/schemas';
import './codeUnderstanding.css';

const PAGE_SIZE = 64;
const statusNames: Record<string, string> = { preparing: '准备中', indexing: '建立索引', awaiting_agent: '等待 Agent 理解', validating: '校验中', uploading: '上传中', succeeded: '已发布', failed: '失败', cancelled: '已取消' };
const verificationNames: Record<string, string> = { observed: '代码观察', inferred: '推断', unresolved: '尚未解析' };
const activeRun = (run: CodeRunSummary) => !['succeeded', 'failed', 'cancelled'].includes(run.status);

export function codeRequirementsPreparationCommand(project: string, run?: CodeRunSummary, node?: string): string | null {
  if (!run || run.runner === 'server_git' || run.status !== 'succeeded' || !run.snapshot || !run.artifact_sha256 || !PublicCodeSchema.safeParse(project).success || !PublicCodeSchema.safeParse(run.code).success) return null;
  const selectedNode = node ? ` --code-node '${node.replaceAll("'", "''")}'` : '';
  return `tsp intake prepare --project ${project} --code-run ${run.code}${selectedNode} --profile pilot --out .tsp/intake/code-rules-${run.code}`;
}

function Notice({ error, onRetry, actionLabel }: { error: unknown; onRetry?: () => void; actionLabel?: string }) {
  return <div role="alert" className="cu-notice cu-error"><span>{error instanceof Error ? error.message : String(error)}</span>{onRetry && <button className="ui-button ui-button-secondary" onClick={onRetry}>{actionLabel || t('重试')}</button>}</div>;
}

export function HostedCodeAnalysisControls({ projectCode, repositoryCode, canWrite }: { projectCode: string; repositoryCode?: string; canWrite: boolean }) {
  const client = useQueryClient();
  const retryKey = useRef<string | null>(null);
  const runtime = useQuery({ queryKey: ['code-understanding-runtime', projectCode], queryFn: () => getCodeAnalysisRuntime(projectCode), retry: false, staleTime: 30000 });
  const jobs = useQuery({ queryKey: ['code-understanding-analyses', projectCode], queryFn: () => listCodeAnalyses(projectCode), enabled: runtime.data?.configured === true,
    retry: false, refetchInterval: query => query.state.data?.some(job => job.status === 'queued' || job.status === 'running') ? 3000 : false });
  const latest = jobs.data?.filter(job => job.repository_code === repositoryCode).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const busy = latest?.status === 'queued' || latest?.status === 'running';
  const progress = useQuery({ queryKey: ['code-understanding-run', projectCode, latest?.run_code],
    queryFn: () => getCodeUnderstandingRun(projectCode, latest?.run_code ?? ''),
    enabled: Boolean(busy && latest?.run_code), retry: false, refetchInterval: busy ? 5000 : false });
  const request = useMutation({ mutationFn: async () => {
    if (!repositoryCode || !canWrite || runtime.data?.configured !== true) throw new Error(t('当前无法请求服务器分析。'));
    retryKey.current ??= crypto.randomUUID();
    return requestCodeAnalysis(projectCode, { repository_codes: [repositoryCode], idempotency_key: retryKey.current });
  }, onSuccess: rows => {
    retryKey.current = null;
    client.setQueryData(['code-understanding-analyses', projectCode], (previous: typeof rows | undefined) => [...rows, ...(previous ?? []).filter(job => !rows.some(row => row.job_code === job.job_code))]);
    void client.invalidateQueries({ queryKey: ['code-understanding-analyses', projectCode] });
  } });
  useEffect(() => {
    if (latest?.status === 'succeeded' && latest.run_code) void client.invalidateQueries({ queryKey: ['code-understanding-context', projectCode] });
  }, [client, projectCode, latest?.job_code, latest?.status, latest?.run_code]);
  const statusLabels = { queued: '排队中', running: '服务器分析中', succeeded: '主线分析已发布', failed: '主线分析失败' };
  return <section className="cu-hosted-analysis" aria-label={t('服务器主线分析')}>
    <strong>{t('服务器主线分析')}</strong>
    <p>{t('按项目登记的仓库地址和主分支分析，不读取浏览者本机文件。')}</p>
    {runtime.isPending ? <p role="status">{t('正在检查分析服务…')}</p> : runtime.error ? <Notice error={t('无法读取分析服务状态，请刷新后重试。')} onRetry={() => void runtime.refetch()} />
      : <p>{runtime.data?.configured ? [t('分析服务已就绪'), runtime.data.model].filter(Boolean).join(' · ') : t('服务器分析服务未配置')}{runtime.data?.message && <> · {runtime.data.message}</>}</p>}
    {latest && <div role="status"><p>{t(statusLabels[latest.status])} · {latest.branch} · {formatDateTime(latest.updated_at)}</p>{busy && progress.data?.message && <p>{progress.data.message}</p>}{latest.error && <p className="cu-analysis-error">{latest.error}</p>}</div>}
    {jobs.error && <Notice error={t('无法读取分析作业，请刷新后重试。')} onRetry={() => void jobs.refetch()} />}
    {request.error && <Notice error={request.error} />}
    {!repositoryCode && <p>{t('请先登记项目代码仓库和主分支。')}</p>}
    {!canWrite && <p>{t('当前账号可查看分析；更新需要项目写入权限。')}</p>}
    <button type="button" className="ui-button ui-button-primary" disabled={!repositoryCode || !canWrite || !runtime.data?.configured || request.isPending || busy} onClick={() => request.mutate()}>{request.isPending ? t('正在提交…') : busy ? t('分析进行中') : t('更新主线分析')}</button>
  </section>;
}

export function CodeUnderstandingWorkbench({ projectCode, route }: { projectCode: string; route: WorkspaceRoute }) {
  const locale = useLocale();
  const [provider, setProvider] = useState<'ua' | 'codegraph'>('ua');
  const [focused, setFocused] = useState(false);
  const context = useQuery({ queryKey: ['code-understanding-context', projectCode], queryFn: () => getCodeUnderstandingContext(projectCode), refetchInterval: 10000, retry: false });
  const requestedSelection = context.data ? resolveCodeRepositorySelection(context.data, route) : null;
  const requestedRun = requestedSelection?.requestedRun;
  const needsRun = requestedSelection?.needsRun === true;
  const historicalRun = useQuery({ queryKey: ['code-understanding-run', projectCode, requestedRun], queryFn: () => getCodeUnderstandingRun(projectCode, requestedRun ?? ''), enabled: needsRun, retry: false });
  const availableContext = context.data && historicalRun.data && needsRun ? { ...context.data, runs: [...context.data.runs, historicalRun.data] } : context.data;
  const selection = availableContext ? resolveCodeRepositorySelection(availableContext, route) : null;
  const readerRunCode = !selection?.invalid ? selection?.run?.code : undefined;
  const readerRun = availableContext?.runs.find(run => run.code === readerRunCode);
  const ua = useQuery({ queryKey: ['code-understanding-ua-map', projectCode, readerRunCode], queryFn: () => getCodeUnderstandingUaMap(projectCode, readerRunCode ?? ''), enabled: Boolean(readerRunCode && !selection?.invalid && (!readerRun || readerRun.status === 'succeeded')), retry: false });
  const repositoryCode = selection?.repositoryCode;
  const repositoryName = selection?.repository?.name;
  const readableUa = codeRunMatchesRepository(ua.data?.run, readerRunCode, repositoryCode) ? ua.data : undefined;
  const activeRunSummary = readableUa?.run || readerRun;
  const readingMainline = selection?.mainline || (!route.understandingRun && !route.understandingView);
  const readerScope = `${projectCode}:${repositoryCode ?? ''}:${readerRunCode ?? ''}`;
  const [savedReaderState, setReaderState] = useState<CodeReaderState | null>(null);
  const { search, offset, direction, evidenceOpen } = codeReaderStateForScope(savedReaderState, readerScope, route.understandingNode);
  const updateReader = (patch: Partial<Omit<CodeReaderState, 'scope'>>) => setReaderState(previous => ({ ...codeReaderStateForScope(previous, readerScope, route.understandingNode), ...patch }));
  const deferredSearch = useDeferredValue(useMemo(() => ({ scope: readerScope, search }), [readerScope, search]));
  const needle = deferredSearch.scope === readerScope ? deferredSearch.search : '';
  const symbolQuery = { run_code: readerRunCode, provider: 'codegraph' as const, query: needle.trim(), offset, limit: PAGE_SIZE };
  const symbols = useQuery({ queryKey: ['code-understanding-graph', projectCode, symbolQuery], queryFn: () => getCodeUnderstandingGraph(projectCode, symbolQuery), enabled: Boolean(readerRunCode && activeRunSummary?.status === 'succeeded' && provider === 'codegraph'), retry: false });
  const detailRun = route.understandingRun || readerRunCode;
  const detail = useQuery({ queryKey: ['code-understanding-node', projectCode, detailRun, route.understandingNode, direction], queryFn: () => getCodeUnderstandingGraph(projectCode, { run_code: detailRun, node_id: route.understandingNode, direction, limit: 200 }), enabled: Boolean(detailRun && route.understandingNode && !selection?.invalid && activeRunSummary?.status === 'succeeded'), retry: false });
  const selectedNode = detail.data?.nodes.find(node => node.id === route.understandingNode && node.run_code === detailRun);
  const preparationCommand = codeRequirementsPreparationCommand(projectCode, activeRunSummary, selectedNode?.id);
  const go = (next: { repository?: string; run?: string; node?: string; view?: string }) => navigateWorkspace(codeUnderstandingPath(projectCode, next));
  const chooseRepository = (code: string) => navigateWorkspace(codeRepositoryPath(projectCode, code));
  const chooseNode = (node: MapNode) => { updateReader({ evidenceOpen: true }); go({ repository: node.repository_code, run: node.run_code, node: node.id, view: route.understandingView }); };
  const chooseNative = (id: string, showEvidence = false) => {
    if (!readerRunCode) return;
    updateReader({ evidenceOpen: showEvidence || evidenceOpen });
    go({ repository: repositoryCode, run: readerRunCode, node: id, view: route.understandingView });
  };
  const activeRuns = context.data?.runs.filter(activeRun) || [];
  const viewerDenied = [context.error, historicalRun.error, ua.error, symbols.error, detail.error]
    .some(error => error instanceof ApiError && error.code === 'code_understanding_forbidden');
  const legacy = readableUa?.projection;
  const visibleLegacy = legacy ? { ...legacy, nodes: legacy.nodes.slice(0, PAGE_SIZE), truncated: legacy.nodes.length > PAGE_SIZE } : null;
  const hostedControls = <HostedCodeAnalysisControls key={`${projectCode}:${repositoryCode}`} projectCode={projectCode} repositoryCode={repositoryCode} canWrite={context.data?.can_write === true} />;

  return <main aria-label={t('规格')} className={`cu-workbench cu-reader-workbench ${focused && !viewerDenied ? 'cu-reader-focused' : ''}`}>
    {viewerDenied ? (
      <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6"><CodeSourceAccessNotice projectCode={projectCode} resource="map" /></div>
    ) : context.isPending ? <p role="status" className="cu-empty">{t('正在加载规格…')}</p> : context.error ? <Notice error={context.error} onRetry={() => void context.refetch()} /> : <>
      {activeRuns.length > 0 && <details className="cu-progress"><summary>{t('正在分析')} · {activeRuns.length}</summary>{activeRuns.map(run => <a key={run.code} href={codeUnderstandingPath(projectCode, { repository: run.repository_code, run: run.code })}>{run.repository_code} · {t(statusNames[run.status])} · {formatDateTime(run.updated_at)}</a>)}<p>{t('进度由分析执行方上报；最近活动时间不代表仍在执行。')}</p></details>}
      {Boolean(context.data?.repositories.length) && <div className="cu-reader-strip">
        {context.data && (context.data.repositories.length > 1 ? <label className="cu-repository-picker"><span>{t('仓库')}</span><select aria-label={t('代码仓库')} value={selection?.repository?.code ?? ''} onChange={event => chooseRepository(event.target.value)}>{!selection?.repository && <option value="" disabled>{t('选择仓库')}</option>}{context.data.repositories.map(repo => <option key={repo.code} value={repo.code}>{repo.name}</option>)}</select></label> : context.data.repositories[0] && <span className="cu-reader-repository" title={t('项目主线')}>{context.data.repositories[0].name}</span>)}
        {readerRunCode && activeRunSummary?.status === 'succeeded' && <>
          <div className="cu-segment" aria-label={t('关系来源')}><button aria-pressed={provider === 'ua'} onClick={() => setProvider('ua')}>{t('UA 整体地图')}</button><button aria-pressed={provider === 'codegraph'} onClick={() => setProvider('codegraph')}>{t('codegraph 符号')}</button></div>
          {(route.understandingRun || route.understandingView) && !readingMainline && <button type="button" className="ui-button ui-button-secondary" onClick={() => go({ repository: repositoryCode })}>{t('返回项目主线')}</button>}
          <span className="cu-reader-commit">{activeRunSummary?.snapshot?.commit.slice(0, 8)}</span>
          <button className="cu-focus-button" aria-pressed={focused} onClick={() => setFocused(!focused)}>{focused ? t('退出专注') : t('专注阅读')}</button>
          <button className="ui-button ui-button-secondary cu-evidence-toggle" disabled={!route.understandingNode} aria-expanded={evidenceOpen} onClick={() => updateReader({ evidenceOpen: !evidenceOpen })}>{t('代码关系与证据')}</button>
          {preparationCommand && <details className="cu-source-popover"><summary>{t('从本次分析生成需求')}</summary><div><p>{t('让接入项目的 Agent 在分析执行环境运行以下命令，读取 UA、CodeGraph 和对应源码，生成规则与需求候选。')}</p><pre className="overflow-x-auto text-xs"><code>{preparationCommand}</code></pre><p>{t('准备完成后，让 Agent 阅读 AGENT.md；测试用例为验证计划，需实际执行后才能记录结果。')}</p><p>{t('每次使用新目录；候选仍按现有流程校验、审阅和发布。')}</p></div></details>}
          <details className="cu-source-popover"><summary>{t('分析来源')}</summary><div><strong>{repositoryName}</strong><p>{t('执行端')} · {activeRunSummary?.runner === 'server_git' ? t('服务器') : t('成员 Agent')}</p><p>{t('分析时间')} · {formatDateTime(activeRunSummary?.snapshot?.captured_at || activeRunSummary?.created_at)}</p><button type="button" className="ui-button ui-button-secondary" onClick={() => { void context.refetch(); if (readerRunCode) void ua.refetch(); }}>{t('刷新')}</button><p>{t('展示已发布的源码快照；仓库后续更新需要重新分析。')}</p>{hostedControls}<p>{t('分析记录')} {readerRunCode}</p><p>{t('快照')} {activeRunSummary?.snapshot?.snapshot_id}</p><p>{t('捕获时间')} {formatDateTime(activeRunSummary?.snapshot?.captured_at)}</p>{readableUa?.projection.coverage.map(item => <section key={item.provider}><strong>{item.provider.toUpperCase()} · {item.analyzed_files}/{item.total_files} {t('文件')}</strong>{item.limitations.map((text, i) => <p key={i}>{text}</p>)}</section>)}<p>{t('静态关系和 Agent 解释具有各自的依据与覆盖范围，推断不等于已确认业务事实。')}</p></div></details>
        </>}
      </div>}
      {needsRun && historicalRun.isPending ? <p role="status" className="cu-empty">{t('正在加载分析版本…')}</p> : needsRun && historicalRun.error ? <Notice error={historicalRun.error} /> : selection?.invalid ? <Notice error={t('所选版本不存在、已超出列表范围或不属于该仓库；请重新选择。')} actionLabel={t('返回项目主线')} onRetry={context.data?.repositories[0] ? () => chooseRepository(selection.repository?.code || context.data.repositories[0].code) : undefined} />
      : activeRunSummary && activeRunSummary.status !== 'succeeded' ? <section className="cu-empty"><h2>{t(statusNames[activeRunSummary.status])}</h2><p>{activeRunSummary.message || t('分析在独立执行环境完成，结果发布后可查看关系图。')}</p></section>
      : !readerRunCode ? <section className="cu-empty"><span className="cu-empty-symbol">◇</span><h2>{t('这里将呈现项目规格地图')}</h2><p>{t('此仓库尚无可读的主线分析。发布主分支分析后即可查看。')}</p>{hostedControls}</section> : <>
        {ua.error && <Notice error={ua.error} onRetry={() => void ua.refetch()} />}
        {ua.data && !readableUa ? <Notice error={t('分析结果与所选仓库不一致，请刷新后重试。')} onRetry={() => void ua.refetch()} /> : ua.isPending ? <p role="status" className="cu-empty">{t('正在加载关系图…')}</p> : readableUa && <div className={`cu-reader-stage ${evidenceOpen && route.understandingNode ? 'cu-show-evidence' : ''}`}>
          <div className="cu-reader-main">
            <div hidden={provider !== 'ua'} className="cu-reader-native-host">
              {readableUa.graph ? <UaNativeReader key={`${readerRunCode}:${readableUa.reader_profile ?? 'legacy_split'}`} graph={readableUa.graph} readerProfile={readableUa.reader_profile} selectedNode={route.understandingNode} locale={locale} onSelect={id => chooseNative(id)} onEvidence={id => chooseNative(id, true)} /> : <><p className="cu-notice">{t('此历史版本未保留 UA 原生元数据，当前显示兼容视图。由 Agent 重新发布分析后可使用完整阅读器。')}</p>{visibleLegacy && <CodeUnderstandingMap result={visibleLegacy} selected={selectedNode && nodeKey(selectedNode)} onSelect={chooseNode} />}</>}
            </div>
            {provider === 'codegraph' && <section className="cu-symbol-browser"><div className="cu-symbol-header"><div><h2>{t('codegraph 符号')}</h2><p>{t('搜索符号，查看调用关系与代码证据。')}</p></div><input type="search" aria-label={t('搜索节点')} placeholder={t('搜索模块、能力、符号…')} value={search} onChange={event => { updateReader({ search: event.target.value, offset: 0 }); }} /></div>{symbols.isPending ? <p role="status" className="cu-empty">{t('正在加载…')}</p> : symbols.error ? <Notice error={symbols.error} /> : symbols.data && <><ul className="cu-symbol-list">{symbols.data.nodes.map(node => <li key={nodeKey(node)}><button onClick={() => chooseNode(node)}><span className="cu-symbol-type">{node.kind}</span><strong>{node.label}</strong><code>{node.path}{node.line_start ? `:${node.line_start}` : ''}</code><span>↗</span></button></li>)}</ul><div className="cu-pagination"><span>{offset + 1}–{offset + symbols.data.nodes.length} / {symbols.data.total_nodes} {t('节点')}</span><div><button disabled={offset === 0} className="ui-button ui-button-secondary" onClick={() => updateReader({ offset: Math.max(0, offset - PAGE_SIZE) })}>{t('上一页')}</button><button disabled={!symbols.data.truncated} className="ui-button ui-button-secondary" onClick={() => updateReader({ offset: offset + PAGE_SIZE })}>{t('下一页')}</button></div></div></>}</section>}
          </div>
          {evidenceOpen && route.understandingNode && <aside className="cu-detail cu-reader-evidence" aria-label={t('节点与证据')}><div className="cu-detail-top"><strong>{t('代码关系与证据')}</strong><button className="ui-button ui-button-secondary" onClick={() => updateReader({ evidenceOpen: false })}>{t('关闭')}</button></div>{detail.isPending ? <p role="status">{t('正在加载…')}</p> : detail.error ? <Notice error={detail.error} /> : selectedNode && detail.data ? <CodeNodeDetail result={detail.data} node={selectedNode} direction={direction} onDirection={value => updateReader({ direction: value })} onSelect={chooseNode} /> : <p>{t('该节点未出现在已发布投影中。')}</p>}</aside>}
        </div>}
      </>}
    </>}
  </main>;
}

export function CodeUnderstandingMap({ result, layer = '', selected, onSelect }: { result: CodeGraphResult; layer?: string; selected?: string; onSelect: (node: MapNode) => void }) {
  const layout = useMemo(() => layoutCodeMap(result.nodes, result.edges, layer), [result.nodes, result.edges, layer]);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const point = event.currentTarget.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(event.currentTarget.getScreenCTM()?.inverse());
  };
  const zoom = (factor: number) => setCamera(value => ({ ...value, scale: Math.max(0.15, Math.min(2.5, value.scale * factor)) }));
  return <section className="cu-map" aria-label={t('代码关系地图')}>
    <div className="cu-map-tools"><span>{t('拖动平移 · 选择节点查看关系')}</span><button className="ui-button ui-button-secondary" aria-label={t('缩小')} onClick={() => zoom(0.8)}>−</button><span>{Math.round(camera.scale * 100)}%</span><button className="ui-button ui-button-secondary" aria-label={t('放大')} onClick={() => zoom(1.25)}>+</button><button className="ui-button ui-button-secondary" onClick={() => setCamera({ x: 0, y: 0, scale: Math.min(1000 / layout.width, 600 / layout.height) })}>{t('适合画布')}</button><button className="ui-button ui-button-secondary" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}>{t('重置')}</button></div>
    {!layout.nodes.length ? <p className="cu-empty">{t('当前筛选没有节点。可调整搜索、分层或关系来源。')}</p> : <svg viewBox="0 0 1000 600" role="group" aria-label={t('可交互关系图')} onPointerDown={event => {
      if ((event.target as Element).closest('[data-node]')) return;
      const point = position(event);
      drag.current = { x: point.x, y: point.y, cameraX: camera.x, cameraY: camera.y };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { if (!drag.current) return; const point = position(event), origin = drag.current; setCamera(value => ({ ...value, x: origin.cameraX + point.x - origin.x, y: origin.cameraY + point.y - origin.y })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs><marker id="cu-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8" fill="#94a3b8" /></marker></defs>
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
        {layout.groups.map((group, index) => <g key={group.layer} className={`cu-layer cu-color-${index % 5}`}><rect x={group.x - 10} y="26" width={group.width + 10} height={layout.height - 42} rx="16" /><text x={group.x + 4} y="52">{group.layer.length > 26 ? `${group.layer.slice(0, 25)}…` : group.layer}</text></g>)}
        {layout.links.map(link => <path key={`${link.run_code}:${link.id}`} className={`cu-link ${link.provider === 'bridge' ? 'cu-bridge' : ''}`} markerEnd="url(#cu-arrow)" d={`M${link.sourceNode.x + 108},${link.sourceNode.y + 33} C${link.sourceNode.x + 260},${link.sourceNode.y + 33} ${link.targetNode.x - 40},${link.targetNode.y + 33} ${link.targetNode.x},${link.targetNode.y + 33}`}><title>{`${link.type} · ${link.provenance} · ${link.verification}`}</title></path>)}
        {layout.nodes.map(node => <g key={nodeKey(node)} data-node={nodeKey(node)} role="button" tabIndex={0} aria-label={`${node.label} · ${node.kind} · ${node.repository_code}`} aria-pressed={selected === nodeKey(node)} className={`cu-node ${selected === nodeKey(node) ? 'is-selected' : ''} ${node.provider === 'codegraph' ? 'cu-symbol' : ''}`} transform={`translate(${node.x},${node.y})`} onClick={() => onSelect(node)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); } }}>
          <title>{`${node.label}${node.summary ? `\n${node.summary}` : ''}`}</title><rect width="220" height="66" rx="10" /><text x="12" y="22" className="cu-node-label">{node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label}</text><text x="12" y="43" className="cu-node-kind">{node.kind} · {t(verificationNames[node.verification])}</text><circle cx="207" cy="15" r="3" /></g>)}
      </g>
    </svg>}
    <p className="cu-map-note">{t('连线仅显示当前页内的关系；完整邻接关系请选中节点查看。')}</p>
  </section>;
}

export function CodeNodeDetail({ result, node, direction, onDirection, onSelect }: { result: CodeGraphResult; node: MapNode; direction: 'in' | 'out' | 'both'; onDirection: (value: 'in' | 'out' | 'both') => void; onSelect: (node: MapNode) => void }) {
  const relations = codeNodeRelations(result, node, direction);
  const evidenceIds = new Set([...node.evidence_ids, ...relations.flatMap(item => item.edge.evidence_ids)]);
  const evidence = result.evidence.filter(item => item.run_code === node.run_code && evidenceIds.has(item.id));
  return <><div className="cu-node-heading"><span className="cu-badge">{node.provider.toUpperCase()} · {node.kind}</span><h2>{node.label}</h2><span className={`cu-verification ${node.verification}`}>{t(verificationNames[node.verification])}</span><p>{node.summary || t('未提供职责说明。')}</p>{node.path && <code>{node.path}{node.line_start ? `:${node.line_start}${node.line_end ? `–${node.line_end}` : ''}` : ''}</code>}<small>{node.repository_code} · {node.run_code}</small></div>
    {node.domain_meta && <section className="space-y-3" aria-label={t('业务规则与上下游')}>
      {node.domain_meta.entities?.length ? <div><h3>{t('状态与实体')}</h3><ul className="space-y-1 text-xs leading-6">{node.domain_meta.entities.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
      {node.domain_meta.userPurposes?.length ? <div><h3>{t('用途')}</h3><ul className="space-y-1 text-xs leading-6">{node.domain_meta.userPurposes.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
      {node.domain_meta.businessRules?.length ? <div><h3>{t('业务规则与未决事项')}</h3><ul className="space-y-1 text-xs leading-6">{node.domain_meta.businessRules.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
      {node.domain_meta.unknowns?.length ? <div><h3>{t('未决事项')}</h3><ul className="space-y-1 text-xs leading-6">{node.domain_meta.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
      {node.domain_meta.crossDomainInteractions?.length ? <div><h3>{t('上下游交互')}</h3><ul className="space-y-1 text-xs leading-6">{node.domain_meta.crossDomainInteractions.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    </section>}
    <div className="cu-relation-heading"><h3>{t('相邻关系')}</h3><select aria-label={t('关系方向')} value={direction} onChange={event => onDirection(event.target.value as 'in' | 'out' | 'both')}><option value="both">{t('双向')}</option><option value="out">{t('出向')}</option><option value="in">{t('入向')}</option></select></div>
    <ul className="cu-relations">{relations.map(({ edge, outgoing, node: other }) => <li key={edge.id}><small>{outgoing ? '→' : '←'} {edge.type} · {edge.provider} · {edge.provenance} · {t(verificationNames[edge.verification])}</small>{other ? <button onClick={() => onSelect(other)}>{other.label}<span>{other.provider} ↗</span></button> : <span>{t('关联节点未包含在当前返回范围中。')}</span>}</li>)}</ul>{!relations.length && <p>{t('当前方向没有已发布关系。')}</p>}{result.truncated && <p className="cu-notice">{t('邻接结果达到查询上限；Agent 可通过 CLI 分页继续查询。')}</p>}
    <h3>{t('来源证据')}</h3>{evidence.length ? evidence.map(item => <details className="cu-evidence" key={item.id} open><summary>{item.path}:{item.line_start}–{item.line_end}</summary>{item.snippet ? <pre><code>{item.snippet}</code></pre> : <p>{t('仅发布了位置与摘要，未上传源码片段。')}</p>}<small>SHA-256 {item.sha256}</small></details>) : <p>{t('本节点及当前关系未附带证据片段。')}</p>}
  </>;
}
