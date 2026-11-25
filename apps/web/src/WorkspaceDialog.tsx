import type { ReactNode } from 'react';
import { useLocale } from './useLocale';
import { t } from './i18n';
import { DialogLayer } from './DialogLayer';

export function WorkspaceDialog({ id, title, description, onClose, dismissDisabled = false, children, footer, size = 'default' }: { id: string; title: string; description: string; onClose: () => void; dismissDisabled?: boolean; children: ReactNode; footer?: ReactNode; size?: 'default' | 'wide' | 'large' }) {
  useLocale();

  return (
    <DialogLayer className="flex items-end justify-center bg-slate-950/55 sm:items-center sm:p-4" onDismiss={onClose} dismissDisabled={dismissDisabled}>
      <section role="dialog" aria-modal="true" aria-busy={dismissDisabled || undefined} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} className={`flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:rounded-2xl ${size === 'large' ? 'sm:max-w-5xl' : size === 'wide' ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 break-words">
            <h2 id={`${id}-title`} className="text-lg font-bold text-slate-900">{title}</h2>
            <p id={`${id}-description`} className="mt-1 text-sm text-slate-500">{description}</p>
          </div>
          <button type="button" onClick={onClose} disabled={dismissDisabled} aria-label={t("关闭{p0}弹窗", { p0: title })} title={t(dismissDisabled ? "处理中…" : "关闭（Esc）")} className="ui-icon-button hover:!border-rose-200 hover:!bg-rose-50 hover:!text-rose-700">
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="shrink-0 border-t border-slate-200 bg-white px-5 py-4">{footer}</footer>}
      </section>
    </DialogLayer>
  );
}
