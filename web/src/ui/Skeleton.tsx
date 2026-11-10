import { cx } from './cx';

export interface SkeletonProps {
  className?: string;
}

/** A pulsing placeholder block. Decorative; pair it with a labelled busy region. */
export function Skeleton({ className }: SkeletonProps) {
  return <span aria-hidden="true" className={cx('block animate-pulse rounded-xl bg-surface-2', className)} />;
}

export interface SkeletonListProps {
  rows?: number;
  label?: string;
  className?: string;
}

/** Card-shaped placeholders for a loading list, announced once as busy. */
export function SkeletonList({ rows = 3, label = 'Loading', className }: SkeletonListProps) {
  return (
    <div role="status" aria-busy="true" className={cx('flex flex-col gap-3', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ))}
    </div>
  );
}
