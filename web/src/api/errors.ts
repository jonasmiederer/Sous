/**
 * API error model and user-facing messages (Requirement 13.16).
 *
 * `ERROR_MESSAGES` covers every error code the backend handlers emit
 * (collected from the error-code unions and literal codes in
 * src/services/**), plus a few codes the client produces itself for network
 * failures, client timeouts, and gateway throttling. `messageFor` returns the
 * generic message for anything else.
 */
import type { WireError } from './types';

export const SERVER_ERROR_CODES = [
  // Auth
  'INVALID_CREDENTIALS',
  'ACCOUNT_TEMPORARILY_LOCKED',
  'AUTHENTICATION_REQUIRED',
  'AUTH_UNAVAILABLE',
  // Membership
  'NOT_A_MEMBER',
  'NOT_HOUSEHOLD_OWNER',
  'CANNOT_REMOVE_OWNER',
  'INVALID_INVITATION',
  'ALREADY_A_MEMBER',
  'MEMBER_NOT_FOUND',
  // Input validation
  'INVALID_REQUEST',
  'CONTEXT_INPUT_TOO_LONG',
  'CONTEXT_TOO_LONG',
  'UNRECOGNIZED_PRESET',
  'PRESET_CONFLICT',
  'INVALID_RANGE',
  'PROFILE_REQUIRED',
  'NO_VALID_ITEMS',
  'INVALID_DIETARY_CONSTRAINT',
  // Generation
  'NO_SUGGESTION_AVAILABLE',
  'NO_DISTINCT_SUGGESTIONS',
  'UNKNOWN_SUGGESTION',
  'GENERATION_TIMEOUT',
  'GENERATION_FAILED',
  'AGENT_UNAVAILABLE',
  'MEAL_EXCLUDED',
  // Plans and grocery
  'PLAN_NOT_FOUND',
  'DAY_NOT_FOUND',
  'DAY_ALREADY_ASSIGNED',
  'PLAN_CONFLICT',
  'PLAN_INCONSISTENT',
  'GROCERY_CONFLICT',
  'GROCERY_LIST_NOT_FOUND',
  'SHOPPING_LIST_NOT_FOUND',
  'TOO_MANY_SHOPPING_LISTS',
  // Saves
  'SAVE_DID_NOT_COMPLETE',
  'SAVE_FAILED',
  'NOT_SAVED',
  'PROFILE_CONFLICT',
  'FRIDGE_CONFLICT',
  'TIMEOUT',
  // Conversations
  'CANNOT_APPLY',
  'TARGET_NOT_FOUND',
  'NOT_FOUND',
  'MEMORY_UNAVAILABLE',
  // Voice
  'UNSUPPORTED_AUDIO',
  'AUDIO_TOO_LARGE',
  'AUDIO_CONVERSION_FAILED',
  'VOICE_NOT_UNDERSTOOD',
  'VOICE_TIMEOUT',
  'AUDIO_UPLOAD_FAILED',
  'VOICE_NOT_FOUND',
  'VOICE_ALREADY_CONFIRMED',
  'VOICE_EXPIRED',
  'TARGET_OPERATION_FAILED',
  // Fallback (the Conversation Service uses INTERNAL)
  'INTERNAL_ERROR',
  'INTERNAL',
] as const;

/** Codes produced by the client, never by a handler. */
export const CLIENT_ERROR_CODES = ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TOO_MANY_REQUESTS'] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type KnownErrorCode = ServerErrorCode | ClientErrorCode;

const TRY_AGAIN = 'Please try again.';
const NOTHING_CHANGED = 'Nothing was changed.';

export const GENERIC_ERROR_MESSAGE = 'Something went wrong on our side. Please try again in a moment.';

export const ERROR_MESSAGES: Readonly<Record<KnownErrorCode, string>> = {
  INVALID_CREDENTIALS: "That email and password don't match. Check them and try again.",
  ACCOUNT_TEMPORARILY_LOCKED: 'Too many sign-in attempts. Your account is locked for a little while; try again later.',
  AUTHENTICATION_REQUIRED: 'Your session has ended. Please sign in again.',
  AUTH_UNAVAILABLE: `Sign-in isn't available right now. ${TRY_AGAIN}`,

  NOT_A_MEMBER: "You don't have access to that household. Pick one of your households to continue.",
  NOT_HOUSEHOLD_OWNER: 'Only the household owner can do that.',
  CANNOT_REMOVE_OWNER: "The household owner can't be removed.",
  INVALID_INVITATION: 'This invitation is no longer valid. It may have expired, been declined, or already been used.',
  ALREADY_A_MEMBER: 'That person is already a member of this household.',
  MEMBER_NOT_FOUND: "We couldn't find that member in this household.",

  INVALID_REQUEST: "Something in the request wasn't right. Check what you entered and try again.",
  CONTEXT_INPUT_TOO_LONG: 'Your note is too long. Keep it to 500 characters or fewer.',
  CONTEXT_TOO_LONG: 'Your note is too long. Keep it to 500 characters or fewer.',
  UNRECOGNIZED_PRESET: 'Choose from Healthy, Quick, Craving, or Fine dining.',
  PRESET_CONFLICT: "Those presets can't be combined. Deselect one and try again.",
  INVALID_RANGE: 'A plan can cover 1 to 31 days.',
  PROFILE_REQUIRED: 'Add a few preferences first, like a dish you love or an ingredient to avoid, then create a plan.',
  NO_VALID_ITEMS: 'Add at least one item with a name, amount, and unit.',
  INVALID_DIETARY_CONSTRAINT: 'That dietary need is empty, longer than 200 characters, or already on your list.',

  NO_SUGGESTION_AVAILABLE: `We couldn't come up with a meal right now. ${TRY_AGAIN}`,
  NO_DISTINCT_SUGGESTIONS: "We've run out of new ideas for this request. Try changing your note or presets.",
  UNKNOWN_SUGGESTION: 'That suggestion is no longer available. Ask for new suggestions.',
  GENERATION_TIMEOUT: `That took too long, so we stopped. ${NOTHING_CHANGED} ${TRY_AGAIN}`,
  GENERATION_FAILED: `We couldn't create that right now. ${NOTHING_CHANGED} ${TRY_AGAIN}`,
  AGENT_UNAVAILABLE: `The meal assistant isn't available right now. ${NOTHING_CHANGED} ${TRY_AGAIN}`,
  MEAL_EXCLUDED: 'That meal contains an ingredient your household avoids.',

  PLAN_NOT_FOUND: "We couldn't find that meal plan. It may have been deleted.",
  DAY_NOT_FOUND: "That day isn't part of this plan.",
  DAY_ALREADY_ASSIGNED: 'That day already has a meal. Replace it instead.',
  PLAN_CONFLICT: 'Someone else changed this plan at the same time. Reload it and try again.',
  PLAN_INCONSISTENT: "We couldn't build a grocery list from this plan. Try replacing the meals that look wrong.",
  GROCERY_CONFLICT: `The grocery list was being updated at the same time. ${TRY_AGAIN}`,
  GROCERY_LIST_NOT_FOUND: "There's no grocery list for this plan yet.",
  SHOPPING_LIST_NOT_FOUND: "That grocery list doesn't exist any more. It may have been deleted.",
  TOO_MANY_SHOPPING_LISTS: 'You have too many grocery lists. Delete one before making another.',

  SAVE_DID_NOT_COMPLETE: `We couldn't save that. Your previous data is unchanged. ${TRY_AGAIN}`,
  SAVE_FAILED: `We couldn't save that. Your previous data is unchanged. ${TRY_AGAIN}`,
  NOT_SAVED: `We couldn't save that. Your previous data is unchanged. ${TRY_AGAIN}`,
  PROFILE_CONFLICT: `Someone else updated your preferences at the same time. ${TRY_AGAIN}`,
  FRIDGE_CONFLICT: `Someone else updated the fridge at the same time. ${TRY_AGAIN}`,
  TIMEOUT: 'Saving took too long. Reload to check whether your change was saved.',

  CANNOT_APPLY: "We couldn't apply that change. Try saying it a different way.",
  TARGET_NOT_FOUND: "We couldn't find what you wanted to change. It may have been removed.",
  NOT_FOUND: "We couldn't find that.",
  MEMORY_UNAVAILABLE: `The chat isn't available right now. ${NOTHING_CHANGED} ${TRY_AGAIN}`,

  UNSUPPORTED_AUDIO: "We can't use that recording format. Try recording again, or type instead.",
  AUDIO_TOO_LARGE: 'That recording is too long. Keep it under 30 seconds.',
  AUDIO_CONVERSION_FAILED: "We couldn't process that recording. Please try recording again.",
  VOICE_NOT_UNDERSTOOD: "We couldn't make out what you said. Please try recording again.",
  VOICE_TIMEOUT: 'Processing your recording took too long. Please try recording again.',
  AUDIO_UPLOAD_FAILED: "We couldn't upload your recording. Please try recording again.",
  VOICE_NOT_FOUND: "We couldn't find that recording. Please record again.",
  VOICE_ALREADY_CONFIRMED: 'That recording was already used.',
  VOICE_EXPIRED: 'That recording has expired. Please record again.',
  TARGET_OPERATION_FAILED: "We couldn't apply what you said. Check the transcript and try again.",

  INTERNAL_ERROR: GENERIC_ERROR_MESSAGE,
  INTERNAL: GENERIC_ERROR_MESSAGE,

  NETWORK_ERROR: "Couldn't reach Sous. Check your connection and try again.",
  REQUEST_TIMEOUT: "Couldn't reach Sous. Check your connection and try again.",
  TOO_MANY_REQUESTS: 'Too many requests. Wait a moment and try again.',
};

export function isKnownErrorCode(code: unknown): code is KnownErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code);
}

/** User-facing message for an error code; the generic message for unknown codes. */
export function messageFor(code: string): string {
  return isKnownErrorCode(code) ? ERROR_MESSAGES[code] : GENERIC_ERROR_MESSAGE;
}

export interface ApiErrorInit {
  status: number;
  code: string;
  /** Server-provided message, for logs only. Show `userMessage` to people. */
  message?: string;
  retryAfterSeconds?: number;
  /** The full `error` object of the response body, when there was one. */
  body?: WireError;
}

/** A failed API call. `status` is 0 for network failures and client timeouts. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly body?: WireError;

  constructor(init: ApiErrorInit) {
    super(init.message ?? init.code);
    this.status = init.status;
    this.code = init.code;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
    if (init.body !== undefined) this.body = init.body;
  }

  /** The message to show the User. Voice target failures use the target operation's own code. */
  get userMessage(): string {
    if (this.code === 'TARGET_OPERATION_FAILED') {
      const inner = this.body?.targetError?.code;
      if (inner !== undefined && isKnownErrorCode(inner)) return ERROR_MESSAGES[inner];
    }
    return messageFor(this.code);
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
