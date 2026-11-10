/**
 * Per-identifier login lockout (Requirement 1.3).
 *
 * Rule: when 5 consecutive failed sign-ins for one identifier fall within a
 * 15-minute window, further attempts for that identifier are rejected for 15
 * minutes. "Consecutive" means since the last successful sign-in: a success
 * clears the counter. Failures older than 15 minutes drop out of the window.
 *
 * The rule is implemented in our code (not Cognito's opaque lockout) so it is
 * deterministic and testable with an injected clock. State is stored in the
 * single table under a non-tenant key `LOCKOUT#{sha256(identifier)}`; the raw
 * identifier is never stored. Items carry a `ttl` attribute (epoch seconds)
 * so DynamoDB TTL can remove stale counters.
 */
import { createHash } from 'node:crypto';
import { ConditionFailedError } from '../../data/errors.js';
import { VERSION_ATTRIBUTE, type TableClient, type TableItem } from '../../data/tableClient.js';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LockoutState {
  /** Epoch-ms timestamps of failures still inside the window. */
  failures: number[];
  /** Epoch ms until which the identifier is locked. */
  lockedUntil?: number;
}

export interface LockoutStatus {
  locked: boolean;
  lockedUntil?: number;
}

export function lockoutStatus(state: LockoutState | undefined, nowMs: number): LockoutStatus {
  if (state?.lockedUntil !== undefined && nowMs < state.lockedUntil) {
    return { locked: true, lockedUntil: state.lockedUntil };
  }
  return { locked: false };
}

/** Applies one failed attempt at `nowMs` and returns the new state. Pure. */
export function applyFailure(state: LockoutState | undefined, nowMs: number): LockoutState {
  const inWindow = (state?.failures ?? []).filter((t) => t > nowMs - LOCKOUT_WINDOW_MS && t <= nowMs);
  const failures = [...inWindow, nowMs];
  if (failures.length >= LOCKOUT_THRESHOLD) {
    return { failures: [], lockedUntil: nowMs + LOCKOUT_DURATION_MS };
  }
  return { failures };
}

/** Normalizes an identifier so case or surrounding spaces cannot bypass the counter. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

export function hashIdentifier(identifier: string): string {
  return createHash('sha256').update(normalizeIdentifier(identifier), 'utf8').digest('hex');
}

export interface LockoutStore {
  status(identifier: string, now: Date): Promise<LockoutStatus>;
  /** Records a failure and returns the resulting status. */
  recordFailure(identifier: string, now: Date): Promise<LockoutStatus>;
  /** Clears the counter after a successful sign-in. */
  reset(identifier: string): Promise<void>;
}

export const LOCKOUT_PK_PREFIX = 'LOCKOUT#';
export const LOCKOUT_SK = 'LOCKOUT';
const MAX_WRITE_ATTEMPTS = 3;

function lockoutKey(identifier: string) {
  return { PK: LOCKOUT_PK_PREFIX + hashIdentifier(identifier), SK: LOCKOUT_SK };
}

function readState(item: TableItem | undefined): LockoutState | undefined {
  if (item === undefined) return undefined;
  const failures = Array.isArray(item.failures) ? item.failures.filter((t): t is number => typeof t === 'number') : [];
  return typeof item.lockedUntil === 'number' ? { failures, lockedUntil: item.lockedUntil } : { failures };
}

/** LockoutStore over the single table, using version-conditioned writes. */
export class TableLockoutStore implements LockoutStore {
  constructor(private readonly client: TableClient) {}

  async status(identifier: string, now: Date): Promise<LockoutStatus> {
    return lockoutStatus(readState(await this.client.get(lockoutKey(identifier))), now.getTime());
  }

  async recordFailure(identifier: string, now: Date): Promise<LockoutStatus> {
    const key = lockoutKey(identifier);
    const nowMs = now.getTime();
    for (let attempt = 1; ; attempt++) {
      const existing = await this.client.get(key);
      const previousVersion = typeof existing?.[VERSION_ATTRIBUTE] === 'number' ? (existing[VERSION_ATTRIBUTE] as number) : 0;
      const next = applyFailure(readState(existing), nowMs);
      const expiresMs = Math.max(nowMs + LOCKOUT_WINDOW_MS, next.lockedUntil ?? 0);
      const item: TableItem = {
        ...key,
        failures: next.failures,
        ...(next.lockedUntil !== undefined ? { lockedUntil: next.lockedUntil } : {}),
        ttl: Math.ceil(expiresMs / 1000),
        [VERSION_ATTRIBUTE]: previousVersion + 1,
      };
      try {
        await this.client.put(
          item,
          existing === undefined ? { kind: 'mustNotExist' } : { kind: 'versionEquals', version: previousVersion },
        );
        return lockoutStatus(next, nowMs);
      } catch (err) {
        // A concurrent attempt changed the counter: re-read and re-apply.
        if (err instanceof ConditionFailedError && attempt < MAX_WRITE_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  async reset(identifier: string): Promise<void> {
    await this.client.delete(lockoutKey(identifier));
  }
}
