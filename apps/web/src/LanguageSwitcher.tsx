import { useEffect, useId, useRef, useState } from 'react';
import { setLocale, t, type Locale } from './i18n.ts';
import { useLocale } from './useLocale';

export default function LanguageSwitcher({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const languages: Array<{ value: Locale; label: string; lang: string }> = [
    { value: 'zh-CN', label: '简体中文', lang: 'zh-CN' },
    { value: 'en-US', label: 'English', lang: 'en' },
  ];

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function selectLanguage(value: Locale) {
    setLocale(value);
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div ref={container} className={`relative shrink-0 ${className}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button ref={trigger} id={`${id}-trigger`} type="button" aria-label={t('语言')}
        title={t('切换语言（{language}）', { language: languages.find((item) => item.value === locale)?.label ?? locale })}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => setOpen(!open)} onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
        }}
        className={`grid h-8 w-9 place-items-center rounded-lg border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${open ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500 hover:text-white'}`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5h14M5 17.5h14" />
        </svg>
      </button>
      {open && <div ref={menu} id={`${id}-menu`} role="menu" aria-labelledby={`${id}-trigger`}
        className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 text-slate-700 shadow-xl shadow-slate-950/15"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
          const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
          if (items.length === 0) return;
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
        }}
      >
        <p className="px-2.5 py-2 text-[11px] font-medium text-slate-400">{t('显示语言')}</p>
        {languages.map((item) => <button key={item.value} role="menuitemradio" aria-checked={item.value === locale} type="button" lang={item.lang}
          onClick={() => selectLanguage(item.value)}
          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 ${item.value === locale ? 'bg-cyan-50 font-semibold text-cyan-800' : 'hover:bg-slate-100 focus:bg-slate-100'}`}
        >{item.label}{item.value === locale && <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4.5 10 3.5 3.5 7.5-7.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}</button>)}
      </div>}
    </div>
  );
}
