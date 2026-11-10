import { cx } from './cx';

export interface SpinnerProps {
  /** Accessible label announced to screen readers. Pass `null` when a parent already announces the busy state. */
  label?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = { sm: 'size-4 border-2', md: 'size-6 border-2', lg: 'size-10 border-[3px]' } as const;

export function Spinner({ label = 'Loading', size = 'md', className }: SpinnerProps) {
  const ring = (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent',
        SIZES[size],
        className,
      )}
    />
  );
  if (label === null) return ring;
  return (
    <span role="status" className="inline-flex items-center">
      {ring}
      <span className="sr-only">{label}</span>
    </span>
  );
}
