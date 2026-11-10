import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cx } from './cx';
import { IconButton } from './IconButton';

export type DialogPlacement = 'center' | 'sheet';

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button, or a backdrop click. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row at the bottom, for example Cancel and Confirm buttons. */
  footer?: ReactNode;
  /**
   * `center` is a centered modal. `sheet` is a bottom sheet on phones and a
   * right-hand side panel from the `lg` breakpoint.
   */
  placement?: DialogPlacement;
  /** Element to focus on open. Defaults to the first focusable element in the body, then the close button. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeLabel?: string;
  className?: string;
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

const PLACEMENT: Record<DialogPlacement, string> = {
  center:
    'm-auto w-[calc(100%-2rem)] max-w-md rounded-3xl max-h-[calc(100dvh-2rem)] open:animate-rise-in',
  sheet: cx(
    'mx-0 mb-0 mt-auto w-full max-w-none rounded-t-3xl max-h-[88dvh] open:animate-sheet-in pb-[env(safe-area-inset-bottom)]',
    'lg:my-0 lg:ml-auto lg:mr-0 lg:h-dvh lg:max-h-none lg:w-[28rem] lg:rounded-none lg:rounded-l-3xl lg:pb-0 lg:open:animate-panel-in',
  ),
};

/**
 * Modal dialog built on the native `<dialog>` element. It traps Tab focus
 * inside, closes on Escape, and returns focus to the element that was
 * focused before it opened.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  placement = 'center',
  initialFocusRef,
  closeLabel = 'Close',
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute('open', '');
        }
      } else {
        // Environments without showModal (older browsers, jsdom).
        dialog.setAttribute('open', '');
      }
    }
    const target =
      initialFocusRef?.current ??
      (bodyRef.current ? focusableIn(bodyRef.current)[0] : undefined) ??
      focusableIn(dialog)[0];
    target?.focus();

    return () => {
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      dialog.removeAttribute('open');
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open, initialFocusRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = focusableIn(ref.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-modal="true"
      onKeyDown={handleKeyDown}
      onCancel={(event) => {
        // Native Escape handling; keep React state as the source of truth.
        event.preventDefault();
        onCloseRef.current();
      }}
      onClick={(event) => {
        // A click on the dialog element itself is a click on the backdrop,
        // because the inner panel covers the whole dialog box.
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      className={cx(
        'overflow-hidden border-0 bg-surface p-0 text-text shadow-raised backdrop:animate-fade-in',
        PLACEMENT[placement],
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col lg:h-full">
          {placement === 'sheet' && <div aria-hidden="true" className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-border lg:hidden" />}
          <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-2 sm:px-6">
            <div className="min-w-0 flex-1 pt-2">
              <h2 id={titleId} className="text-lg font-semibold leading-snug tracking-tight">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-text-muted">
                  {description}
                </p>
              )}
            </div>
            <IconButton label={closeLabel} icon={<X />} onClick={() => onCloseRef.current()} className="-mr-2" />
          </header>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3 sm:px-6">
            {children}
          </div>
          {footer && (
            <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}
