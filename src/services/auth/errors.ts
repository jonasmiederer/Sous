/**
 * Error model for the Auth & Membership Service.
 *
 * Service functions never throw for expected failures; they return a
 * ServiceResult. Handlers map each error code to an HTTP status.
 */

export type AuthServiceErrorCode =
  /** Generic login failure. Never says which field was wrong (1.2). */
  | 'INVALID_CREDENTIALS'
  /** 5 failures in 15 minutes for one identifier (1.3). */
  | 'ACCOUNT_TEMPORARILY_LOCKED'
  /** Cognito or the lockout store could not be reached. */
  | 'AUTH_UNAVAILABLE'
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_REQUEST'
  | 'NOT_A_MEMBER'
  | 'NOT_HOUSEHOLD_OWNER'
  | 'CANNOT_REMOVE_OWNER'
  | 'MEMBER_NOT_FOUND'
  /** Single response for invalid, used, declined, or expired Invitations (10.4). */
  | 'INVALID_INVITATION'
  | 'ALREADY_A_MEMBER'
  | 'SAVE_DID_NOT_COMPLETE'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ServiceError {
  code: AuthServiceErrorCode;
  message: string;
  /** Seconds until a locked identifier may retry. */
  retryAfterSeconds?: number;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: AuthServiceErrorCode, message: string, extra: Partial<ServiceError> = {}): ServiceResult<T> {
  return { ok: false, error: { code, message, ...extra } };
}

export const INVALID_CREDENTIALS_MESSAGE = 'The sign-in credentials are invalid.';
export const ACCOUNT_LOCKED_MESSAGE =
  'Too many failed sign-in attempts. This account is temporarily locked; try again later.';
export const INVALID_INVITATION_MESSAGE = 'This invitation is invalid, already used, declined, or expired.';
export const NOT_A_MEMBER_MESSAGE = 'You are not a member of this household.';
export const SAVE_DID_NOT_COMPLETE_MESSAGE = 'The save did not complete; the previously saved data is unchanged.';

export const HTTP_STATUS: Record<AuthServiceErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  ACCOUNT_TEMPORARILY_LOCKED: 423,
  AUTH_UNAVAILABLE: 503,
  AUTHENTICATION_REQUIRED: 401,
  INVALID_REQUEST: 400,
  NOT_A_MEMBER: 403,
  NOT_HOUSEHOLD_OWNER: 403,
  CANNOT_REMOVE_OWNER: 409,
  MEMBER_NOT_FOUND: 404,
  INVALID_INVITATION: 410,
  ALREADY_A_MEMBER: 409,
  SAVE_DID_NOT_COMPLETE: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};
