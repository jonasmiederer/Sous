import { cx } from './cx';
import { codePointLength } from './text';

export interface CharCounterProps {
  value: string;
  max: number;
  id?: string;
  className?: string;
}

/**
 * Shows how many characters of `max` are used, counting Unicode code points
 * so the count matches the server's limit.
 */
export function CharCounter({ value, max, id, className }: CharCounterProps) {
  const used = codePointLength(value);
  const over = used - max;
  return (
    <span
      id={id}
      data-over={over > 0 || undefined}
      className={cx('text-xs tabular-nums', over > 0 ? 'font-medium text-danger' : 'text-text-muted', className)}
    >
      <span aria-hidden="true">
        {used} / {max}
      </span>
      <span className="sr-only">
        {over > 0 ? `${over} ${over === 1 ? 'character' : 'characters'} over the ${max}-character limit` : `${used} of ${max} characters used`}
      </span>
    </span>
  );
}
