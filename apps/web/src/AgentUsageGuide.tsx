import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ProjectSummary } from './api';
import { t, type Locale } from './i18n';
import { handleMarkdownAnchorClick, MarkdownDocument } from './MarkdownDocument';
import { useLocale } from './useLocale';
import { agentWorkspacePath, type WorkspaceRoute } from './workspaceRouting';

type GuideHeading = { id: string; title: string };
type GuideChapter = GuideHeading & { sections: GuideHeading[] };

function guideMarkdownPath(locale: Locale): string {
  return `/agent/guide.${locale}.md`;
}

export async function readAgentGuide(locale: Locale, signal?: AbortSignal): Promise<string> {
  const response = await fetch(guideMarkdownPath(locale), {
    signal,
    credentials: 'omit',
    redirect: 'error',
    headers: { Accept: 'text/markdown, text/plain' },
  });
  if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('agent_guide_unavailable');
  }
  const content = await response.text();
  if (!content.trim()) throw new Error('agent_guide_unavailable');
  return content;
}

export function AgentUsageGuide({ route, project }: { route: WorkspaceRoute; project?: ProjectSummary }) {
  const locale = useLocale();
  const sourcePath = guideMarkdownPath(locale);
  const candidateProject = project?.code === route.projectCode ? project : undefined;
  const scrollRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<{ source: string; chapters: GuideChapter[] }>();
  const [active, setActive] = useState<string>();
  const guide = useQuery({
    queryKey: ['agent-usage-guide', locale],
    queryFn: ({ signal }) => readAgentGuide(locale, signal),
    retry: false,
  });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!guide.data || !scroller || !bodyRef.current) return;
    const headings = Array.from(bodyRef.current.querySelectorAll<HTMLElement>('h2[id], h3[id]'));
    const chapters: GuideChapter[] = [];
    for (const element of headings) {
      const heading = { id: element.id, title: element.textContent ?? '' };
      const parent = chapters.at(-1);
      if (element.tagName === 'H3' && parent) parent.sections.push(heading);
      else chapters.push({ ...heading, sections: [] });
    }
    setOutline({ source: guide.data, chapters });

    function updateActive() {
      if (!scroller) return;
      const threshold = scroller.getBoundingClientRect().top + 80;
      let index = headings.length - 1;
      while (index > 0 && headings[index].getBoundingClientRect().top > threshold) index--;
      const bottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      setActive((bottom ? headings.at(-1) : headings[index])?.id);
    }
    let frame = window.requestAnimationFrame(updateActive);
    function scheduleUpdate() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActive);
    }
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    return () => {
      scroller.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      window.cancelAnimationFrame(frame);
    };
  }, [guide.data]);
  const chapters = outline?.source === guide.data ? outline?.chapters ?? [] : [];

  return <main ref={scrollRef} aria-label={t('使用指南')} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-slate-50">
    <div onClick={handleMarkdownAnchorClick} className="mx-auto grid max-w-[1280px] items-start gap-4 px-4 py-5 sm:px-6 sm:py-6 min-[900px]:grid-cols-[15rem_minmax(0,1fr)] min-[900px]:gap-5 xl:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="min-w-0 min-[900px]:sticky min-[900px]:top-4" aria-label={t('目录')}>
        <details open className="hidden max-h-[calc(100dvh-9rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm min-[900px]:block">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-950">{t('目录')}</summary>
          <GuideOutline chapters={chapters} active={active} idPrefix="guide-desktop" />
        </details>
        <details className="rounded-xl border border-slate-200 bg-white shadow-sm min-[900px]:hidden">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-950">{t('目录')}</summary>
          <GuideOutline chapters={chapters} active={active} idPrefix="guide-mobile" closeOnNavigate />
        </details>
      </aside>
      <article className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-7">
          <div className="min-w-0 space-y-1.5">
            <p className="text-sm font-semibold text-slate-950">{t('Agent 操作手册')}</p>
            {candidateProject && <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-slate-600">
              <span>{t('当前页面的候选项目')} · {candidateProject.name}</span>
              <code className="break-all text-cyan-800">{candidateProject.code}</code>
              <span>{t('通过连接工具确认后使用。')}</span>
            </p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="ui-button ui-button-secondary" href={agentWorkspacePath('connect', route)}>{t('查看接入方式')}</a>
            <a className="ui-button ui-button-primary" href={sourcePath} type="text/markdown">{t('读取 Markdown')}</a>
          </div>
        </header>
        <div ref={bodyRef} className="mx-auto max-w-[900px] p-5 sm:p-7">
          {guide.data ? <MarkdownDocument content={guide.data} allowImages={false} copyCodeBlocks />
            : guide.isPending ? <p role="status" className="text-sm text-slate-500">{t('正在读取使用指南…')}</p>
            : <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-slate-700">{t('使用指南暂时无法读取。')}</p>
              <button type="button" className="ui-button ui-button-secondary" onClick={() => void guide.refetch()}>{t('重试')}</button>
            </div>}
        </div>
      </article>
    </div>
  </main>;
}

function GuideOutline({ chapters, active, idPrefix, closeOnNavigate = false }: {
  chapters: GuideChapter[];
  active?: string;
  idPrefix: string;
  closeOnNavigate?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  function closeMobileOutline(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!(event.target as HTMLElement).closest('a[href^="#"]')) return;
    const details = event.currentTarget.closest('details');
    if (details) details.open = false;
  }
  return <nav aria-label={t('指南章节')} onClick={closeOnNavigate ? closeMobileOutline : undefined}>
    <ul className="space-y-1 border-t border-slate-100 px-2 py-2">
      {chapters.map(chapter => {
        const expanded = !collapsed.includes(chapter.id);
        const sectionId = `${idPrefix}-${chapter.id}`;
        return <li key={chapter.id}>
          <div className="flex items-center gap-1">
            <OutlineLink heading={chapter} current={active === chapter.id || (!expanded && chapter.sections.some(section => section.id === active))} />
            {chapter.sections.length > 0 && <button type="button" aria-controls={sectionId} aria-expanded={expanded}
              aria-label={t(expanded ? '收起 {section} 的小节' : '展开 {section} 的小节', { section: chapter.title })}
              onClick={() => setCollapsed(items => expanded ? [...items, chapter.id] : items.filter(id => id !== chapter.id))}
              className="grid size-8 shrink-0 place-items-center rounded-md text-slate-600 hover:bg-slate-100 focus-visible:outline-cyan-700"
            >{expanded ? '−' : '+'}</button>}
          </div>
          {chapter.sections.length > 0 && <ul id={sectionId} hidden={!expanded} className="mb-2 ml-3.5 border-l border-slate-200 pl-1.5">
            {chapter.sections.map(section => <li key={section.id}><OutlineLink heading={section} current={active === section.id} nested /></li>)}
          </ul>}
        </li>;
      })}
    </ul>
  </nav>;
}

function OutlineLink({ heading, current, nested = false }: { heading: GuideHeading; current: boolean; nested?: boolean }) {
  return <a href={`#${encodeURIComponent(heading.id)}`} aria-current={current ? 'location' : undefined}
    className={`block min-w-0 flex-1 wrap-anywhere rounded-md px-2 py-1.5 leading-snug focus-visible:outline-cyan-700 ${nested ? 'text-xs' : 'text-sm font-semibold'} ${current ? 'bg-cyan-50 text-cyan-900' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950'}`}
  >{heading.title}</a>;
}
