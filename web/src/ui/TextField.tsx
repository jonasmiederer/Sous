import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import { CONTROL_CLASS, FieldFrame, describedBy, type FieldIds } from './Field';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {
  label: ReactNode;
  hint?: ReactNode;
  /** Error text. Sets `aria-invalid` and is linked with `aria-describedby`. */
  error?: ReactNode;
  optional?: boolean;
  containerClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, optional, id, className, containerClassName, type, 'aria-describedby': extraDescribedBy, ...rest },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? `${autoId}-input`;
  const ids: FieldIds = { controlId, hintId: `${controlId}-hint`, errorId: `${controlId}-error`, counterId: `${controlId}-count` };
  return (
    <FieldFrame ids={ids} label={label} hint={hint} error={error} optional={optional} className={containerClassName}>
      <input
        ref={ref}
        id={controlId}
        type={type ?? 'text'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, { hint: Boolean(hint) && !error, error: Boolean(error) }, extraDescribedBy)}
        className={cx(CONTROL_CLASS, 'min-h-11 py-2', className)}
        {...rest}
      />
    </FieldFrame>
  );
});
