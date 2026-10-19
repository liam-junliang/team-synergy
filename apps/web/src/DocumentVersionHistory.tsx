import { t, getLocale } from './i18n.ts';
interface VersionHistoryDocument {
  current_revision: number;
  revisions: Array<{
    revision_code: string;
    revision: number;
    change_summary: string;
    created_at: string;
  }>;
}

export function formatDocumentDate(value: string | null | undefined): string {
  if (!value) return t("时间未知");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(getLocale(), { hour12: false });
}

export function DocumentVersionHistory({ document, viewRevision, onSelect, onClose, id = 'document-version-history' }: {
  document: VersionHistoryDocument;
  viewRevision: number | null;
  onSelect: (revision: number | null) => void;
  onClose: () => void;
  id?: string;
}) {
  return <aside id={id} aria-labelledby={`${id}-heading`} className="absolute inset-y-0 right-0 z-20 w-60 max-w-full min-h-0 overflow-y-auto border-l border-slate-200 bg-slate-50 p-4 shadow-lg xl:static xl:w-auto xl:shadow-none">
    <div className="flex items-center justify-between gap-2"><h3 id={`${id}-heading`} className="ui-field-label">{t("版本记录")}</h3><button type="button" onClick={onClose} className="ui-context-action" aria-label={t("收起版本记录")}>{t("收起")}</button></div>
    <div className="mt-3 space-y-2">{document.revisions.map(revision => <button key={revision.revision_code} type="button" aria-pressed={(viewRevision ?? document.current_revision) === revision.revision} onClick={() => onSelect(revision.revision === document.current_revision ? null : revision.revision)} className={`w-full rounded-xl border p-3 text-left transition ${(viewRevision ?? document.current_revision) === revision.revision ? 'border-cyan-300 bg-white shadow-sm' : 'border-transparent hover:border-slate-200 hover:bg-white'}`}>
      <div className="flex items-center justify-between gap-2"><strong className="text-xs text-slate-800">Revision {revision.revision}</strong>{revision.revision === document.current_revision && <span className="rounded bg-cyan-100 px-1.5 py-0.5 text-[11px] font-semibold text-cyan-700">{t("当前")}</span>}</div>
      <p className="ui-help mt-1 line-clamp-2">{revision.change_summary}</p><p className="ui-meta mt-2">{formatDocumentDate(revision.created_at)}</p>
    </button>)}</div>
  </aside>;
}
