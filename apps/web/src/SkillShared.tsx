import { useState } from 'react';
import { t } from './i18n';

export function SkillError({ error }: { error: unknown }) {
  return error ? <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{t(error instanceof Error ? error.message : String(error))}</p> : null;
}

export function CopyCommand({ command }: { command: string }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('复制不可用，请手动选择命令。');
      await navigator.clipboard.writeText(command); setStatus(t('已复制'));
    } catch { setStatus(t('复制不可用，请手动选择命令。')); }
  }
  return <div className="min-w-0"><div className="flex items-start gap-3 rounded-xl bg-slate-950 p-4 text-slate-100"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6"><code>{command}</code></pre><button type="button" onClick={() => void copy()} className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800 focus-visible:outline focus-visible:outline-cyan-400">{t('复制')}</button></div><p role="status" className="mt-1 min-h-4 text-xs text-slate-500">{status}</p></div>;
}
