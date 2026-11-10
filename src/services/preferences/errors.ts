/**
 * Preference Service error model. Service methods return a PreferenceResult
 * and never throw for expected failures; each code maps to one HTTP status in
 * handlers.ts.
 */
import type { DietaryConstraintRejectionReason } from '../../domain/preferences.js';

export type PreferenceErrorCode =
  /** Malformed body or field (wrong type, empty, too long). */
  | 'INVALID_REQUEST'
  /** Dietary constraint empty, over 200 chars, or duplicate (Requirement 6.6). */
  | 'INVALID_DIETARY_CONSTRAINT'
  /** Concurrent writers kept winning; nothing was saved by this request. */
  | 'PROFILE_CONFLICT'
  /** Storage write failed; the stored profile is unchanged (Requirement 6.2). */
  | 'NOT_SAVED'
  /** The time bound was exceeded (2s for feedback, Requirement 6.2). */
  | 'TIMEOUT';

export interface PreferenceError {
  code: PreferenceErrorCode;
  message: string;
  /** Set for INVALID_DIETARY_CONSTRAINT. */
  reason?: DietaryConstraintRejectionReason;
}

export type PreferenceResult<T> = { ok: true; value: T } | { ok: false; error: PreferenceError };

export function preferenceError(
  code: PreferenceErrorCode,
  message: string,
  reason?: DietaryConstraintRejectionReason,
): { ok: false; error: PreferenceError } {
  return { ok: false, error: { code, message, ...(reason !== undefined ? { reason } : {}) } };
}

export const PREFERENCE_ERROR_MESSAGES = {
  notSaved: 'Your preference was not saved; the previously saved preferences are unchanged.',
  conflict: 'Preferences were changed by someone else at the same time; please try again.',
  timeout:
    'Saving your preference took too long. Writes are atomic, so the change was either fully saved or not at all; reload to check.',
} as const;
