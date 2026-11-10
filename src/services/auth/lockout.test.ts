import { describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_WINDOW_MS,
  TableLockoutStore,
  applyFailure,
  hashIdentifier,
  lockoutStatus,
  type LockoutState,
} from './lockout.js';

const MIN = 60 * 1000;

function failAt(times: number[]): LockoutState | undefined {
  let state: LockoutState | undefined;
  for (const t of times) state = applyFailure(state, t);
  return state;
}

describe('lockout rule', () => {
  it('does not lock after 4 failures inside the window', () => {
    const state = failAt([0, 1, 2, 3].map((i) => i * MIN));
    expect(lockoutStatus(state, 4 * MIN).locked).toBe(false);
  });

  it('locks on the 5th failure within 15 minutes, for 15 minutes', () => {
    const fifth = 14 * MIN;
    const state = failAt([0, 1 * MIN, 2 * MIN, 3 * MIN, fifth]);
    expect(lockoutStatus(state, fifth)).toEqual({ locked: true, lockedUntil: fifth + LOCKOUT_DURATION_MS });
    expect(lockoutStatus(state, fifth + LOCKOUT_DURATION_MS - 1).locked).toBe(true);
    expect(lockoutStatus(state, fifth + LOCKOUT_DURATION_MS).locked).toBe(false);
  });

  it('ignores failures that fell out of the 15-minute window', () => {
    const state = failAt([0, 1 * MIN, 2 * MIN, 3 * MIN, LOCKOUT_WINDOW_MS]);
    expect(lockoutStatus(state, LOCKOUT_WINDOW_MS).locked).toBe(false);
  });
});

describe('TableLockoutStore', () => {
  it('stores counters under a hashed key and clears them on reset', async () => {
    const client = new InMemoryTableClient();
    const store = new TableLockoutStore(client);
    const now = new Date('2025-01-01T00:00:00Z');
    for (let i = 0; i < 4; i++) await store.recordFailure('Alice@Example.com', now);
    const items = client.dump();
    expect(items).toHaveLength(1);
    expect(items[0]!.PK).toBe(`LOCKOUT#${hashIdentifier('alice@example.com')}`);
    expect(JSON.stringify(items)).not.toContain('alice');

    // Case and whitespace variants share one counter.
    expect((await store.recordFailure('  alice@example.com', now)).locked).toBe(true);
    expect((await store.status('ALICE@example.com', now)).locked).toBe(true);

    await store.reset('alice@example.com');
    expect(client.dump()).toHaveLength(0);
  });
});
