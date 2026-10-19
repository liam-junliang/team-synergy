import { useLocale } from './useLocale';
import { t } from './i18n.ts';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

export interface FormSelectOption {
  value: string;
  label: string;
  meta?: string;
  disabled?: boolean;
}

interface FormSelectProps {
  value: string;
  options: FormSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
}

function firstEnabledIndex(options: FormSelectOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function nextEnabledIndex(options: FormSelectOption[], current: number, direction: 1 | -1) {
  if (options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function FormSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  emptyMessage = t('暂无可选项'),
  disabled = false,
  required = false,
}: FormSelectProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selectedOption = options.find((option) => option.value === value);

  const openMenu = (preferredIndex?: number) => {
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setActiveIndex(preferredIndex ?? (selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options)));
    setOpen(true);
  };

  const closeMenu = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId, open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!open) {
        const edge = direction === 1 ? -1 : 0;
        openMenu(nextEnabledIndex(options, edge, direction));
      } else {
        setActiveIndex((current) => nextEnabledIndex(options, current, direction));
      }
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options));
      return;
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, 0, -1));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      selectOption(activeIndex);
    }
  };

  return (
    <div ref={rootRef} className={`relative min-w-0 ${open ? 'z-40' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
        className={`flex h-[42px] w-full items-center gap-3 rounded-lg border bg-white px-3 text-left text-sm outline-none transition disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${open ? 'border-cyan-500 ring-2 ring-cyan-100' : 'border-slate-300 hover:border-slate-400 focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100'}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selectedOption ? 'text-slate-700' : 'text-slate-400'}`}>{selectedOption?.label ?? placeholder}</span>
        {selectedOption?.meta && <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">{selectedOption.meta}</span>}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl shadow-slate-900/10">
          <div id={listboxId} role="listbox" aria-label={ariaLabel} className="scroll-region max-h-64 space-y-0.5 overflow-y-auto">
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;
              return (
                <button
                  id={`${listboxId}-option-${index}`}
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  tabIndex={-1}
                  onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
                  onClick={() => selectOption(index)}
                  className={`flex min-h-10 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${selected ? 'bg-cyan-50 font-semibold text-cyan-900' : active ? 'bg-slate-100 text-slate-800' : 'text-slate-600 hover:bg-slate-50'} disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-300`}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.meta && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${option.disabled ? 'bg-slate-100 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>{option.meta}</span>}
                  {selected && <CheckIcon />}
                </button>
              );
            })}
            {options.length === 0 && <div className="px-3 py-6 text-center text-xs text-slate-400">{emptyMessage}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}><path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CheckIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4 shrink-0 text-cyan-700"><path d="m4.5 10.5 3.5 3.5 7.5-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
