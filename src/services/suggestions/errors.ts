/**
 * Typed error codes for the Suggestion Service and their HTTP statuses.
 *
 * Every error carries a stable `code`, a user-facing `message`, and, where the
 * requirement asks for one, a `reason` (Requirement 2.4). The `sessionId` is
 * echoed on generation failures so the client can retry in the same request
 * session (Requirement 2.4: "preserve the request session").
 */
import type { SessionId } from '../../domain/types.js';

export type SuggestionErrorCode =
  /** Malformed body or field types (not covered by a more specific code). */
  | 'INVALID_REQUEST'
  /** Context_Input longer than 500 characters (Requirement 4.2). */
  | 'CONTEXT_INPUT_TOO_LONG'
  /** A Preset outside the four named Presets (Requirement 5.6). */
  | 'UNRECOGNIZED_PRESET'
  /** Selected Presets cannot be jointly satisfied (Requirement 5.5). */
  | 'PRESET_CONFLICT'
  /** A rejected suggestion id that is not part of the request session. */
  | 'UNKNOWN_SUGGESTION'
  /** The agent produced no usable suggestion (Requirement 2.4). */
  | 'NO_SUGGESTION_AVAILABLE'
  /** Every usable suggestion repeats a rejected name (Requirement 2.6). */
  | 'NO_DISTINCT_SUGGESTIONS'
  /** Generation exceeded the 10-second bound (Requirement 2.7). */
  | 'GENERATION_TIMEOUT'
  /** Persisting the session's suggestions failed (Requirement 8.6). */
  | 'SAVE_DID_NOT_COMPLETE';

export type NoSuggestionReason =
  | 'agent_unavailable'
  | 'agent_invalid_response'
  | 'no_well_formed_suggestions'
  | 'all_suggestions_excluded'
  | 'storage_unavailable';

export interface SuggestionError {
  code: SuggestionErrorCode;
  message: string;
  reason?: NoSuggestionReason | string;
  sessionId?: SessionId;
  /** Extra machine-readable detail (e.g. unrecognized preset values). */
  details?: Record<string, unknown>;
}

export const SUGGESTION_ERROR_STATUS: Readonly<Record<SuggestionErrorCode, number>> = {
  INVALID_REQUEST: 400,
  CONTEXT_INPUT_TOO_LONG: 400,
  UNRECOGNIZED_PRESET: 400,
  PRESET_CONFLICT: 400,
  UNKNOWN_SUGGESTION: 400,
  NO_DISTINCT_SUGGESTIONS: 422,
  NO_SUGGESTION_AVAILABLE: 503,
  SAVE_DID_NOT_COMPLETE: 503,
  GENERATION_TIMEOUT: 504,
};

export const NO_SUGGESTION_MESSAGES: Readonly<Record<NoSuggestionReason, string>> = {
  agent_unavailable: 'No suggestion is available right now: suggestion generation was unavailable. Please try again.',
  agent_invalid_response:
    'No suggestion is available right now: the suggestion service returned an unusable result. Please try again.',
  no_well_formed_suggestions:
    'No suggestion is available: none of the generated meals had a name, ingredients, and steps. Please try again.',
  all_suggestions_excluded:
    'No suggestion is available: every generated meal contained an excluded ingredient or broke a dietary constraint. Please try again.',
  storage_unavailable: 'No suggestion is available right now: household data could not be loaded. Please try again.',
};
