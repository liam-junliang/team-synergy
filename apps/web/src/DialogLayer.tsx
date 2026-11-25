import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const layers: HTMLDivElement[] = [];
const focusableSelector = 'button, input:not([type="hidden"]), textarea, select, a[href], summary, [tabindex]';

function focusableWithin(layer: HTMLDivElement): HTMLElement[] {
  return Array.from(layer.querySelectorAll<HTMLElement>(focusableSelector)).filter(element =>
    element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0,
  );
}

export function DialogLayer({ className, onDismiss, dismissDisabled = false, children }: {
  className: string;
  onDismiss: () => void;
  dismissDisabled?: boolean;
  children: ReactNode;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const pointerOnBackdrop = useRef(false);
  const dismiss = useRef({ onDismiss, dismissDisabled });
  dismiss.current = { onDismiss, dismissDisabled };
  const [opener] = useState(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const previous = layers.at(-1);
    layers.push(element);
    if (!element.contains(document.activeElement)) {
      (focusableWithin(element)[0] ?? element).focus({ preventScroll: true });
    }
    if (previous) previous.inert = true;
    function handleKey(event: KeyboardEvent) {
      if (!element || layers.at(-1) !== element || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!event.repeat && !dismiss.current.dismissDisabled) dismiss.current.onDismiss();
      } else if (event.key === 'Tab') {
        const elements = focusableWithin(element);
        const first = elements[0];
        const last = elements.at(-1);
        const active = document.activeElement;
        if (!elements.some(control => control === active) || active === (event.shiftKey ? first : last)) {
          event.preventDefault();
          ((event.shiftKey ? last : first) ?? element).focus({ preventScroll: true });
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      const wasTop = layers.at(-1) === element;
      layers.splice(layers.indexOf(element), 1);
      if (!wasTop) return;
      const newTop = layers.at(-1);
      if (newTop) newTop.inert = false;
      queueMicrotask(() => {
        const top = layers.at(-1);
        if (top?.contains(document.activeElement)) return;
        if (opener?.isConnected && (!top || top.contains(opener))) opener.focus({ preventScroll: true });
        else if (top) (focusableWithin(top)[0] ?? top).focus({ preventScroll: true });
      });
    };
  }, [opener]);

  const overlay = <div ref={layer} role="presentation" tabIndex={-1}
    className={`fixed inset-0 z-[70] outline-none ${className}`}
    onPointerDown={event => { pointerOnBackdrop.current = event.target === event.currentTarget && event.button === 0; }}
    onClick={event => {
      const startedOnBackdrop = pointerOnBackdrop.current;
      pointerOnBackdrop.current = false;
      if (!startedOnBackdrop || event.target !== event.currentTarget || layer.current !== layers.at(-1)) return;
      event.stopPropagation();
      if (!dismissDisabled) onDismiss();
    }}
  >{children}</div>;
  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}
