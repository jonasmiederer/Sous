/**
 * POST /auth/login (Requirements 1.1, 1.2, 1.3).
 *
 * Order of checks:
 *   1. Identifier must be 1-254 chars; otherwise generic invalid-credentials.
 *   2. If the identifier is locked, return the temporarily-locked error
 *      without calling Cognito.
 *   3. Password must be 8-128 chars; otherwise count a failure and return
 *      generic invalid-credentials (Cognito is not called).
 *   4. Call Cognito. A rejection counts a failure; the 5th failure in 15
 *      minutes locks the identifier and returns the locked error.
 *   5. Success clears the counter and returns the session.
 *
 * Every credential failure returns the same code and message, so the response
 * never reveals which field was wrong. Passwords are never logged.
 */
import type { UserId } from '../../domain/types.js';
import type { GlobalLookups } from '../../data/repository.js';
import { readIdTokenClaims, type CognitoAuthOutcome, type CognitoTokens } from './cognito.js';
import {
  ACCOUNT_LOCKED_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  fail,
  ok,
  type ServiceResult,
} from './errors.js';
import type { LockoutStatus, LockoutStore } from './lockout.js';

export const IDENTIFIER_MIN = 1;
export const IDENTIFIER_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export interface Authenticator {
  authenticate(username: string, password: string): Promise<CognitoAuthOutcome>;
}

export interface Logger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface LoginDeps {
  authenticator: Authenticator;
  lockout: LockoutStore;
  /** Used to mirror the User record on first sign-in (best-effort). */
  lookups?: GlobalLookups;
  now: () => Date;
  logger?: Logger;
}

export interface LoginInput {
  identifier: unknown;
  password: unknown;
}

export type LoginSuccess =
  | { kind: 'session'; user: { userId: UserId; email?: string }; tokens: CognitoTokens }
  /** Cognito requires another step (for example NEW_PASSWORD_REQUIRED). */
  | { kind: 'challenge'; challengeName: string; session?: string };

function invalidCredentials<T>(): ServiceResult<T> {
  return fail('INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
}

function locked<T>(status: LockoutStatus, now: Date): ServiceResult<T> {
  const retryAfterSeconds =
    status.lockedUntil !== undefined ? Math.max(1, Math.ceil((status.lockedUntil - now.getTime()) / 1000)) : undefined;
  return fail('ACCOUNT_TEMPORARILY_LOCKED', ACCOUNT_LOCKED_MESSAGE, retryAfterSeconds ? { retryAfterSeconds } : {});
}

const unavailable = <T>(): ServiceResult<T> =>
  fail('AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again.');

function inRange(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

export class LoginService {
  constructor(private readonly deps: LoginDeps) {}

  async login(input: LoginInput): Promise<ServiceResult<LoginSuccess>> {
    const { identifier, password } = input;
    if (!inRange(identifier, IDENTIFIER_MIN, IDENTIFIER_MAX)) return invalidCredentials();

    const now = this.deps.now();
    let status: LockoutStatus;
    try {
      status = await this.deps.lockout.status(identifier, now);
    } catch (err) {
      // Fail closed: without the counter we cannot enforce the lockout.
      this.deps.logger?.warn('lockout status read failed', { error: errorName(err) });
      return unavailable();
    }
    if (status.locked) return locked(status, now);

    if (!inRange(password, PASSWORD_MIN, PASSWORD_MAX)) return this.failure(identifier, now);

    const outcome = await this.deps.authenticator.authenticate(identifier, password);
    switch (outcome.kind) {
      case 'rejected':
        return this.failure(identifier, now);
      case 'unavailable':
        this.deps.logger?.warn('cognito unavailable', { reason: outcome.reason });
        return unavailable();
      case 'challenge':
        await this.clearFailures(identifier);
        return ok({
          kind: 'challenge',
          challengeName: outcome.challengeName,
          ...(outcome.session !== undefined ? { session: outcome.session } : {}),
        });
      case 'authenticated': {
        const claims = readIdTokenClaims(outcome.tokens.idToken);
        if (claims === undefined) {
          this.deps.logger?.warn('id token missing sub claim');
          return unavailable();
        }
        await this.clearFailures(identifier);
        await this.mirrorUser(claims.sub, claims.email ?? identifier, now);
        return ok({
          kind: 'session',
          user: { userId: claims.sub, ...(claims.email !== undefined ? { email: claims.email } : {}) },
          tokens: outcome.tokens,
        });
      }
    }
  }

  private async failure<T>(identifier: string, now: Date): Promise<ServiceResult<T>> {
    try {
      const status = await this.deps.lockout.recordFailure(identifier, now);
      if (status.locked) return locked(status, now);
    } catch (err) {
      this.deps.logger?.warn('lockout failure record failed', { error: errorName(err) });
    }
    return invalidCredentials();
  }

  private async clearFailures(identifier: string): Promise<void> {
    try {
      await this.deps.lockout.reset(identifier);
    } catch (err) {
      this.deps.logger?.warn('lockout reset failed', { error: errorName(err) });
    }
  }

  /** Creates the `USER#{userId}` mirror record if absent. Never blocks sign-in. */
  private async mirrorUser(userId: UserId, identifier: string, now: Date): Promise<void> {
    const lookups = this.deps.lookups;
    if (lookups === undefined) return;
    try {
      if ((await lookups.getUser(userId)) !== undefined) return;
      await lookups.createUser(userId, { userId, identifier, createdAt: now.toISOString() });
    } catch (err) {
      this.deps.logger?.warn('user mirror write failed', { error: errorName(err) });
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}
