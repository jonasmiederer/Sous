import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cx } from './cx';

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed' | 'onChange'> {
  pressed: boolean;
  onPressedChange?: (pressed: boolean) => void;
  /**
   * Marks the chip as part of an invalid selection (for example a Preset
   * conflict). This is visual only; describe the problem in text and point
   * to it with `aria-describedby`.
   */
  invalid?: boolean;
  icon?: ReactNode;
}

/** A toggle button. Its state is exposed with `aria-pressed`. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { pressed, onPressedChange, invalid = false, icon, className, children, onClick, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-pressed={pressed}
      data-invalid={invalid || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPressedChange?.(!pressed);
      }}
      className={cx(
        'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
        pressed
          ? 'border-accent bg-accent-soft text-accent-text'
          : 'border-border-strong bg-surface text-text hover:bg-surface-2',
        invalid && 'border-danger bg-danger-soft text-danger',
        className,
      )}
      {...rest}
    >
      {pressed ? <Check aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});
