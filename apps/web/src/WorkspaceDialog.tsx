import { useEffect, useRef, type ReactNode } from 'react';
import { useLocale } from './useLocale';
import { t } from './i18n';

export function WorkspaceDialog({ id, title, description, onClose, children, footer, size = 'default' }: { id: string; title: string; description: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'default' | 'wide' }) {
  useLocale();
  const dialog = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? []).filter(element => element.getAttribute('type') !== 'hidden');
    (dialog.current?.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0])?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClick={(event) => event.stopPropagation()} className={`flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl ${size === 'wide' ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id={`${id}-title`} className="text-lg font-bold text-slate-900">{title}</h2>
            <p id={`${id}-description`} className="mt-1 text-sm text-slate-500">{description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("关闭{p0}弹窗", { p0: title })} title={t("关闭（Esc）")} className="ui-icon-button hover:!border-rose-200 hover:!bg-rose-50 hover:!text-rose-700">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-4">{footer}</footer>}
      </section>
    </div>
  );
}
