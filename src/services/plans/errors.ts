/**
 * Plan Service error model. Every service method returns a PlanResult and
 * never throws for expected failures; each error code maps to one HTTP status
 * in handlers.ts.
 */

export type PlanErrorCode =
  /** Range outside 1-31 days (Requirement 3.8). */
  | 'INVALID_RANGE'
  /** Malformed request body or parameters. */
  | 'INVALID_REQUEST'
  /** Context_Input longer than 500 characters (Requirement 4.2). */
  | 'CONTEXT_TOO_LONG'
  | 'UNRECOGNIZED_PRESET'
  | 'PRESET_CONFLICT'
  /** Plan generation needs a Preference_Profile (Requirement 3.3). */
  | 'PROFILE_REQUIRED'
  /** The agent failed or returned an unusable plan (Requirement 3.4, 8.4). */
  | 'GENERATION_FAILED'
  /** The 30s generation bound was exceeded (Requirement 3.4, 8.4). */
  | 'GENERATION_TIMEOUT'
  | 'PLAN_NOT_FOUND'
  | 'DAY_NOT_FOUND'
  | 'DAY_ALREADY_ASSIGNED'
  /** A supplied Meal violates a hard exclusion (Requirement 3.2, 6.7). */
  | 'MEAL_EXCLUDED'
  /** The plan changed concurrently; the caller should reload and retry. */
  | 'PLAN_CONFLICT'
  /** Storage write failed; prior persisted state unchanged (Requirement 8.6). */
  | 'SAVE_DID_NOT_COMPLETE';

export interface PlanError {
  code: PlanErrorCode;
  message: string;
}

export type PlanResult<T> = { ok: true; value: T } | { ok: false; error: PlanError };

export function planError(code: PlanErrorCode, message: string): { ok: false; error: PlanError } {
  return { ok: false, error: { code, message } };
}

export const PLAN_ERROR_MESSAGES = {
  invalidRange: 'The plan range must be between 1 and 31 days.',
  profileRequired: 'A Preference_Profile is required before a meal plan can be generated.',
  generationFailed: 'Meal plan generation failed; no plan was saved.',
  generationTimeout: 'Meal plan generation did not finish within 30 seconds; no plan was saved.',
  saveDidNotComplete: 'The save did not complete; the previously saved data is unchanged.',
  planConflict: 'The plan was changed by someone else; reload it and try again.',
} as const;
