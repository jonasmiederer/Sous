import type { ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Message shown when a list has no items. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border px-6 py-10 text-center', className)}>
      {icon && (
        <div aria-hidden="true" className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-text [&_svg]:size-7">
          {icon}
        </div>
      )}
      <p className="text-base font-semibold text-text">{title}</p>
      {description && <p className="max-w-xs text-sm text-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
