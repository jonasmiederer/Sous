import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cx } from './cx';

/** Shared control styles for text inputs, text areas, and selects. */
export const CONTROL_CLASS =
  'block w-full rounded-xl border border-border-strong bg-surface px-3.5 text-base text-text placeholder:text-text-muted transition-[border-color,box-shadow] duration-150 hover:border-text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger';

export interface FieldIds {
  controlId: string;
  hintId: string;
  errorId: string;
  counterId: string;
}

export function describedBy(ids: FieldIds, parts: { hint?: boolean; error?: boolean; counter?: boolean }, extra?: string) {
  const list = [extra, parts.error && ids.errorId, parts.hint && ids.hintId, parts.counter && ids.counterId].filter(Boolean);
  return list.length > 0 ? list.join(' ') : undefined;
}

export interface FieldFrameProps {
  ids: FieldIds;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Rendered at the end of the label row, for example a CharCounter. */
  trailing?: ReactNode;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

export function FieldFrame({ ids, label, hint, error, trailing, optional, className, children }: FieldFrameProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={ids.controlId} className="text-sm font-medium text-text">
          {label}
          {optional && <span className="ml-1 font-normal text-text-muted">(optional)</span>}
        </label>
        {trailing}
      </div>
      {children}
      {hint && !error && (
        <p id={ids.hintId} className="text-sm text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={ids.errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
