import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { CharCounter } from './CharCounter';
import { cx } from './cx';
import { CONTROL_CLASS, FieldFrame, describedBy, type FieldIds } from './Field';
import { codePointLength } from './text';

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'children' | 'maxLength'> {
  label: ReactNode;
  value: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  /**
   * Limit in Unicode code points. Shows a CharCounter and marks the field
   * invalid when exceeded. Typing past the limit is allowed so pasted text
   * can be edited down; callers block submission with `isOverLimit`.
   */
  maxCodePoints?: number;
  containerClassName?: string;
}

/** True when `value` has more code points than `max`. */
export function isOverLimit(value: string, max: number): boolean {
  return codePointLength(value) > max;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, value, hint, error, optional, maxCodePoints, id, rows, className, containerClassName, 'aria-describedby': extraDescribedBy, ...rest },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? `${autoId}-textarea`;
  const ids: FieldIds = { controlId, hintId: `${controlId}-hint`, errorId: `${controlId}-error`, counterId: `${controlId}-count` };
  const hasCounter = maxCodePoints !== undefined;
  const over = hasCounter && isOverLimit(value, maxCodePoints);
  const invalid = Boolean(error) || over;
  return (
    <FieldFrame
      ids={ids}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      className={containerClassName}
      trailing={hasCounter ? <CharCounter id={ids.counterId} value={value} max={maxCodePoints} /> : undefined}
    >
      <textarea
        ref={ref}
        id={controlId}
        value={value}
        rows={rows ?? 3}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy(ids, { hint: Boolean(hint) && !error, error: Boolean(error), counter: hasCounter }, extraDescribedBy)}
        className={cx(CONTROL_CLASS, 'min-h-24 resize-y py-2.5 leading-relaxed', className)}
        {...rest}
      />
    </FieldFrame>
  );
});
