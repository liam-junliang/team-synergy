import { useLocale } from './useLocale';
import { t, getLocale } from './i18n.ts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface PersonSearchOption {
  code: string;
  display_name: string;
  account?: string;
}

interface PersonSearchSelectProps {
  value: string;
  options: PersonSearchOption[];
  onChange: (code: string) => void;
  ariaLabel: string;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  emptyOptionLabel?: string;
  disabled?: boolean;
  required?: boolean;
  showDetails?: boolean;
  size?: 'compact' | 'roomy';
}

export function filterPersonOptions(options: PersonSearchOption[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase(getLocale());
  if (!normalizedQuery) return options;
  return options.filter((option) =>
    `${option.display_name} ${option.account ?? ''} ${option.code}`
      .toLocaleLowerCase(getLocale())
      .includes(normalizedQuery));
}

export function choosePersonMenuPlacement(spaceAbove: number, spaceBelow: number, requiredSpace: number): 'top' | 'bottom' {
  return spaceBelow < requiredSpace && spaceAbove > spaceBelow ? 'top' : 'bottom';
}

function clippingParent(element: HTMLElement | null): HTMLElement | null {
  let parent = element?.parentElement ?? null;
  while (parent) {
    const overflow = window.getComputedStyle(parent).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') return parent;
    parent = parent.parentElement;
  }
  return null;
}

export function PersonSearchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  searchPlaceholder = t('搜索姓名或编码'),
  emptyMessage = t('没有匹配的人员'),
  emptyOptionLabel,
  disabled = false,
  required = false,
  showDetails = false,
  size = 'compact',
}: PersonSearchSelectProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPlacement, setMenuPlacement] = useState<'top' | 'bottom'>('bottom');
  const rootRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.code === value);
  const visibleOptions = useMemo(() => filterPersonOptions(options, query), [options, query]);
  const roomy = size === 'roomy';

  const updateMenuPlacement = () => {
    if (!rootRef.current) return;
    const rootBounds = rootRef.current.getBoundingClientRect();
    const clippingBounds = clippingParent(rootRef.current)?.getBoundingClientRect();
    const boundaryTop = clippingBounds?.top ?? 0;
    const boundaryBottom = clippingBounds?.bottom ?? window.innerHeight;
    setMenuPlacement(choosePersonMenuPlacement(
      rootBounds.top - boundaryTop,
      boundaryBottom - rootBounds.bottom,
      roomy ? 288 : 208,
    ));
  };

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const scrollParent = clippingParent(rootRef.current);
    const update = () => updateMenuPlacement();
    window.addEventListener('resize', update);
    scrollParent?.addEventListener('scroll', update, { passive: true });
    return () => {
      window.removeEventListener('resize', update);
      scrollParent?.removeEventListener('scroll', update);
    };
  }, [open, roomy]);

  const selectPerson = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className={`relative min-w-0 ${open ? 'z-30' : ''}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => {
          if (!open) updateMenuPlacement();
          setOpen((current) => !current);
        }}
        className={`flex w-full items-center gap-2 rounded-lg border text-left shadow-sm outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:opacity-50 ${roomy ? 'h-10 border-slate-300 bg-white px-3 text-sm leading-5' : 'h-8 border-slate-200 bg-slate-50 px-2.5 text-xs leading-4 hover:border-slate-300 hover:bg-white'} ${open ? 'border-cyan-400 bg-white ring-2 ring-cyan-100' : ''}`}
      >
        <span className={`grid shrink-0 place-items-center rounded-md font-bold leading-4 ${roomy ? 'h-6 w-6 text-xs' : 'h-5 w-5 text-[11px]'} ${selectedOption ? 'bg-cyan-100 text-cyan-800' : 'bg-slate-200 text-slate-500'}`}>
          {selectedOption ? selectedOption.display_name.trim().slice(0, 1).toUpperCase() : <PersonIcon />}
        </span>
        <span className={`min-w-0 flex-1 truncate ${selectedOption ? 'font-semibold text-slate-800' : 'text-slate-500'}`}>
          {selectedOption ? `${selectedOption.display_name}${selectedOption.account ? ` (@${selectedOption.account})` : ''}` : placeholder}
        </span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div data-placement={menuPlacement} className={`absolute left-0 right-0 z-40 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-900/10 ${menuPlacement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'}`}>
          <div className="relative border-b border-slate-100 p-2">
            <SearchIcon />
            <input
              autoFocus
              aria-label={t("搜索{value0}", { value0: ariaLabel })}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className={`${roomy ? 'h-9 text-sm leading-5' : 'h-8 text-xs leading-4'} w-full rounded-lg bg-slate-50 pl-8 pr-2.5 text-slate-700 outline-none transition focus:bg-white focus:ring-2 focus:ring-cyan-100`}
            />
          </div>
          <div id={listboxId} role="listbox" aria-label={ariaLabel} className={`${roomy ? 'max-h-56' : 'max-h-32'} scroll-region space-y-0.5 overflow-y-auto p-1`}>
            {emptyOptionLabel && !query.trim() && (
              <button type="button" role="option" aria-selected={!value} onClick={() => selectPerson('')} className={`flex h-8 w-full items-center justify-between rounded-lg px-2.5 text-left transition ${roomy ? 'text-sm leading-5' : 'text-xs leading-4'} ${!value ? 'bg-slate-900 font-semibold text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                <span>{emptyOptionLabel}</span>
                {!value && <span aria-hidden="true">✓</span>}
              </button>
            )}
            {visibleOptions.map((option) => {
              const selected = value === option.code;
              return (
                <button key={option.code} type="button" role="option" aria-selected={selected} onClick={() => selectPerson(option.code)} className={`flex w-full items-center gap-2 rounded-lg px-2 text-left transition ${roomy && showDetails ? 'min-h-11 py-1.5' : 'h-8'} ${roomy ? 'text-sm leading-5' : 'text-xs leading-4'} ${selected ? 'bg-cyan-50 font-semibold text-cyan-800' : 'text-slate-600 hover:bg-slate-50'}`}>
                  <span className={`grid shrink-0 place-items-center rounded-md font-bold leading-4 ${roomy ? 'h-7 w-7 text-xs' : 'h-5 w-5 text-[11px]'} ${selected ? 'bg-cyan-200 text-cyan-900' : 'bg-slate-100 text-slate-500'}`}>{option.display_name.trim().slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.display_name}{option.account && <span className="ml-1 font-normal text-cyan-700">@{option.account}</span>}</span>
                    {showDetails && <code className="block truncate text-[11px] font-normal leading-4 text-slate-500">{option.code}</code>}
                  </span>
                  {selected && <span aria-hidden="true" className="shrink-0 text-cyan-700">✓</span>}
                </button>
              );
            })}
            {visibleOptions.length === 0 && <div className={`${roomy ? 'text-sm leading-5' : 'text-xs leading-4'} px-2.5 py-4 text-center text-slate-500`}>{emptyMessage}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function PersonIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5"><circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M4.5 16c.7-3 2.5-4.5 5.5-4.5s4.8 1.5 5.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"><circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}><path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
