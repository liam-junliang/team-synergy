import { useEffect, useId, useRef, useState } from 'react';
import type { AuthUser } from './api';
import { t } from './i18n';
import { personalMemoryWorkspacePath } from './workspaceRouting';

export function AccountMenu({ user, currentView, onLogout }: {
  user: AuthUser; currentView: string; onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const items = popup.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items?.length) items[focusLast.current ? items.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  const itemStyle = 'block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus-visible:outline-cyan-600';
  return <div ref={root} className="relative shrink-0 max-sm:absolute max-sm:right-4 max-sm:top-2.5"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" id={id} aria-label={t('账号菜单')} title={t('账号菜单')}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id + '-menu' : undefined}
      onClick={() => { focusLast.current = false; setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); focusLast.current = event.key === 'ArrowUp'; setOpen(true);
        }
      }}
      className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 hover:border-cyan-500 focus-visible:outline-cyan-400">
      <span className="grid h-7 w-7 place-items-center rounded-md bg-cyan-600 font-bold text-white" aria-hidden="true">{Array.from(user.display_name.trim() || user.account)[0]?.toUpperCase()}</span>
      <span className="hidden max-w-28 truncate text-xs font-semibold text-slate-100 md:block">{user.display_name}</span>
      <span aria-hidden="true" className="text-slate-400">▾</span>
    </button>
    {open && <div id={id + '-menu'} ref={popup} role="menu" aria-labelledby={id}
      className="absolute right-0 top-full z-50 mt-2 w-48 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-1.5 text-slate-800 shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Tab' && event.shiftKey && index === 0) { event.preventDefault(); close(); return; }
        let next: number;
        switch (event.key) {
          case 'ArrowDown': next = (index + 1) % items.length; break;
          case 'ArrowUp': next = (index - 1 + items.length) % items.length; break;
          case 'Home': next = 0; break;
          case 'End': next = items.length - 1; break;
          default: return;
        }
        event.preventDefault(); items[next]?.focus();
      }}>
      <a role="menuitem" href="/account" aria-current={currentView === 'account' ? 'page' : undefined} className={itemStyle} onClick={close}>{t('个人设置')}</a>
      <a role="menuitem" href={personalMemoryWorkspacePath()} aria-current={currentView === 'personal-memory' ? 'page' : undefined} className={itemStyle} onClick={close}>{t('我的记忆')}</a>
      <div role="separator" className="my-1 border-t border-slate-200" />
      <button role="menuitem" type="button" className={itemStyle} onClick={() => { close(); onLogout(); }}>{t('退出')}</button>
    </div>}
  </div>;
}
