import type { ReactNode } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { Button } from './Button';
import { cx } from './cx';

export interface ErrorBannerProps {
  title?: ReactNode;
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  className?: string;
}

/** Inline error with an optional retry action. Announced with `role="alert"`. */
export function ErrorBanner({ title, message, onRetry, retryLabel = 'Try again', retrying, className }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cx('flex flex-col gap-3 rounded-2xl border border-danger/40 bg-danger-soft p-4 text-sm sm:flex-row sm:items-center', className)}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
        <div className="min-w-0">
          {title && <p className="font-semibold text-text">{title}</p>}
          <p className={title ? 'mt-0.5 text-text' : 'text-text'}>{message}</p>
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} loading={retrying} icon={<RotateCw aria-hidden="true" className="size-4" />} className="self-start sm:self-auto">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
