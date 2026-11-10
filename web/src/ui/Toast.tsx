import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

/** Controls the toast's icon and intent. */
export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: ReactNode;
  tone?: ToastTone;
  /** Optional action, for example "Reload" or "Undo". Running it dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** Auto-dismiss after this many milliseconds; `null` keeps it until dismissed. Default 5000. */
  durationMs?: number | null;
  /** Reusing an id replaces the existing toast instead of stacking a new one. */
  id?: string;
}

interface ToastItem extends Required<Pick<ToastOptions, 'message' | 'tone'>> {
  id: string;
  action?: ToastOptions['action'];
  durationMs: number | null;
}

export interface ToastApi {
  show(options: ToastOptions): string;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const DEFAULT_TOAST_MS = 5000;
/** At most this many toasts are shown at once; the oldest drop off. */
const MAX_VISIBLE = 3;
/** Source of unique ids when the caller doesn't supply one. */
let counter = 0;

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert } as const;

/**
 * Hosts toasts in a polite live region. The region is always rendered so
 * screen readers pick up messages added later.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  // Reusing an id replaces that toast in place; otherwise append and keep only the newest MAX_VISIBLE.
  const show = useCallback((options: ToastOptions) => {
    const id = options.id ?? `toast-${++counter}`;
    const item: ToastItem = {
      id,
      message: options.message,
      tone: options.tone ?? 'info',
      action: options.action,
      durationMs: options.durationMs === undefined ? DEFAULT_TOAST_MS : options.durationMs,
    };
    setItems((current) => [...current.filter((existing) => existing.id !== id), item].slice(-MAX_VISIBLE));
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:right-6 lg:left-auto lg:items-end"
      >
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

/** One toast. Auto-dismiss is paused while it is hovered or focused, so it can be read or acted on. */
function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const Icon = ICONS[item.tone];
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (item.durationMs === null || paused) return;
    timer.current = setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => clearTimeout(timer.current);
  }, [item.id, item.durationMs, paused, onDismiss]);

  return (
    <div
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex w-full max-w-sm animate-rise-in items-center gap-3 rounded-2xl bg-inverse py-2 pr-2 pl-4 text-sm text-inverse-text shadow-raised"
    >
      <Icon aria-hidden="true" className="size-5 shrink-0" />
      <div className="min-w-0 flex-1 py-1.5">{item.message}</div>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            item.action?.onAction();
            onDismiss(item.id);
          }}
          className="min-h-11 shrink-0 rounded-xl px-3 font-semibold underline-offset-4 hover:underline"
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full opacity-80 hover:opacity-100"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

/** Access the toast API. Throws if used outside `ToastProvider`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
