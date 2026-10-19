import { useEffect, useRef, type ReactNode } from 'react';

// Keep fragment targets clear of the header even when titles wrap or locale changes.
export function trackDocumentReaderHeaderHeight(header: HTMLElement): () => void {
  const container = header.parentElement;
  if (!container) return () => {};
  const update = () => container.style.setProperty('--document-reader-header-height', `${header.getBoundingClientRect().height}px`);
  update();
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
  observer?.observe(header);
  return () => {
    observer?.disconnect();
    container.style.removeProperty('--document-reader-header-height');
  };
}

export function DocumentReaderHeader({ breadcrumb, title, summary, metadata, actionsLabel, children, notice }: {
  breadcrumb: ReactNode;
  title: string;
  summary?: string | null;
  metadata: ReactNode;
  actionsLabel: string;
  children: ReactNode;
  notice?: ReactNode;
}) {
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (headerRef.current) return trackDocumentReaderHeaderHeight(headerRef.current);
  }, []);
  return <header ref={headerRef} className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-5 sm:px-6">
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500">{breadcrumb}</div>
      <div role="group" aria-label={actionsLabel} className="flex max-w-full flex-wrap items-center gap-2">{children}</div>
    </div>
    <h2 className="break-words text-2xl font-bold text-slate-950">{title}</h2>
    {summary && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-500">{summary}</p>}
    <div className="ui-help mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">{metadata}</div>
    {notice}
  </header>;
}
