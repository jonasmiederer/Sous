import type { ReactNode } from 'react';
import { TextArea } from '../../ui';
import { CONTEXT_INPUT_MAX, isContextInputTooLong } from './validation';

export interface ContextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Slot rendered beside the field, for the voice button (task 24.5). */
  action?: ReactNode;
  id?: string;
}

/**
 * Optional free-text note for the request (Requirement 4.1). Shows a live
 * code-point counter; the parent blocks submission while
 * `isContextInputTooLong` is true (Requirements 4.2, 13.9).
 */
export function ContextInput({ value, onChange, disabled, action, id }: ContextInputProps) {
  const tooLong = isContextInputTooLong(value);
  return (
    <div className="flex items-end gap-2">
      <TextArea
        id={id}
        label="Anything else?"
        optional
        placeholder="Something warm, ready in 20 minutes, uses up the spinach…"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxCodePoints={CONTEXT_INPUT_MAX}
        error={tooLong ? `Keep your note to ${CONTEXT_INPUT_MAX} characters or fewer.` : undefined}
        disabled={disabled}
        containerClassName="min-w-0 flex-1"
      />
      {action && <div className={tooLong ? 'mb-8 shrink-0' : 'mb-0.5 shrink-0'}>{action}</div>}
    </div>
  );
}
