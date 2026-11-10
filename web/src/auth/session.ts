/**
 * Device session storage (Requirements 13.3, 13.17, 13.18).
 *
 * The session lives in `localStorage` under `sous.session.v1` so an installed
 * PWA stays signed in across launches (see design.md, "Storage trade-off").
 * `SessionStore` is framework-free: React reads it with `useSyncExternalStore`
 * and the API client reads it through `get()`.
 */
import type { ClientSession } from '../api/client';
import type { CognitoTokens, LoginResponse } from '../api/types';

export const SESSION_STORAGE_KEY = 'sous.session.v1';
export const ACTIVE_HOUSEHOLD_KEY_PREFIX = 'sous.activeHousehold.v1.';
export const GROCERY_CHECKS_KEY_PREFIX = 'sous.grocery.v1.';
/** Used when neither the ID token nor the response says when the token expires. */
export const DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface SessionUser {
  userId: string;
  email?: string;
}

export interface StoredSession extends ClientSession {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which the ID token expires. */
  expiresAt: number;
  user: SessionUser;
}

/** Why the session ended, so the sign-in screen can explain it. */
export type SessionEndReason = 'signed_out' | 'expired';

export function activeHouseholdKey(userId: string): string {
  return `${ACTIVE_HOUSEHOLD_KEY_PREFIX}${userId}`;
}

export function groceryChecksKey(householdId: string, planId: string): string {
  return `${GROCERY_CHECKS_KEY_PREFIX}${householdId}.${planId}`;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a JWT payload without verifying the signature. The API verifies
 * tokens; the client only needs `exp`, `sub`, and `email` for display and
 * renewal timing.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const value: unknown = JSON.parse(base64UrlDecode(parts[1]));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Expiry of the ID token in epoch ms: the `exp` claim, else `expiresIn`, else one hour. */
export function tokenExpiresAt(idToken: string, expiresInSeconds: number | undefined, nowMs: number): number {
  const exp = decodeJwtPayload(idToken)?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) return exp * 1000;
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return nowMs + expiresInSeconds * 1000;
  }
  return nowMs + DEFAULT_TOKEN_LIFETIME_MS;
}

export function sessionFromTokens(tokens: CognitoTokens, user: SessionUser, nowMs: number): StoredSession {
  return {
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    expiresAt: tokenExpiresAt(tokens.idToken, tokens.expiresIn, nowMs),
    user: { userId: user.userId, ...(user.email !== undefined ? { email: user.email } : {}) },
  };
}

/** The session for a successful `POST /auth/login`, or undefined for a challenge. */
export function sessionFromLogin(response: LoginResponse, nowMs: number): StoredSession | undefined {
  if (response.kind !== 'session') return undefined;
  return sessionFromTokens(response.tokens, response.user, nowMs);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const user = v.user as Record<string, unknown> | undefined;
  return (
    typeof v.idToken === 'string' &&
    v.idToken !== '' &&
    typeof v.accessToken === 'string' &&
    typeof v.expiresAt === 'number' &&
    (v.refreshToken === undefined || typeof v.refreshToken === 'string') &&
    typeof user === 'object' &&
    user !== null &&
    typeof user.userId === 'string' &&
    user.userId !== ''
  );
}

export interface SessionStore {
  get(): StoredSession | null;
  set(session: StoredSession): void;
  /** Removes the stored session. `reason` is kept in memory for the sign-in screen. */
  clear(reason?: SessionEndReason): void;
  /** The reason passed to the last `clear`, until the next `set`. */
  lastEndReason(): SessionEndReason | undefined;
  subscribe(listener: () => void): () => void;
}

export function createSessionStore(storage: Storage): SessionStore {
  const listeners = new Set<() => void>();
  let cachedRaw: string | null | undefined;
  let cached: StoredSession | null = null;
  let endReason: SessionEndReason | undefined;

  function read(): StoredSession | null {
    let raw: string | null;
    try {
      raw = storage.getItem(SESSION_STORAGE_KEY);
    } catch {
      raw = null;
    }
    // Stable snapshot for useSyncExternalStore: re-parse only when the raw value changes.
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    cached = null;
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        cached = isStoredSession(parsed) ? parsed : null;
      } catch {
        cached = null;
      }
    }
    return cached;
  }

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  return {
    get: read,
    set(session) {
      endReason = undefined;
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      notify();
    },
    clear(reason) {
      endReason = reason;
      try {
        storage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Storage unavailable: nothing to remove.
      }
      notify();
    },
    lastEndReason: () => endReason,
    subscribe(listener) {
      listeners.add(listener);
      // Another tab signing in or out changes the same key.
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === SESSION_STORAGE_KEY) listener();
      };
      if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      };
    },
  };
}

/**
 * Removes every device key tied to a signed-in User (Requirement 13.18): the
 * session, that User's Active_Household selection, and all grocery check
 * state. Grocery keys are removed by prefix, so check state of Households
 * that are not currently listed is also discarded.
 */
export function clearUserDeviceData(storage: Storage, userId: string | undefined): void {
  const toRemove: string[] = [SESSION_STORAGE_KEY];
  if (userId) toRemove.push(activeHouseholdKey(userId));
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(GROCERY_CHECKS_KEY_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) storage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
