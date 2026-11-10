import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required accessible name; also shown as a tooltip. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'primary';
}

const VARIANTS = {
  ghost: 'text-text-muted hover:bg-surface-2 hover:text-text',
  secondary: 'border border-border-strong bg-surface text-text hover:bg-surface-2',
  primary: 'bg-accent text-accent-contrast hover:bg-accent-hover',
} as const;

/** A square, 44 × 44 px icon-only button with a required accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', className, type, title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={title ?? label}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="contents">
        {icon}
      </span>
    </button>
  );
});
