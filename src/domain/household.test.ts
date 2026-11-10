import { describe, expect, it } from 'vitest';
import {
  createHousehold,
  isMember,
  removeMember,
  resolveActiveHousehold,
} from './household.js';
import type { Household, Membership } from './types.js';

const NOW = '2025-01-01T00:00:00.000Z';

function setup(): { household: Household; memberships: Membership[] } {
  const created = createHousehold({ householdId: 'h1', name: 'Home', creatorUserId: 'owner', createdAt: NOW });
  if (!created.ok) throw new Error('setup failed');
  const member: Membership = { householdId: 'h1', userId: 'alice', role: 'member', joinedAt: NOW };
  return { household: created.value.household, memberships: [created.value.ownerMembership, member] };
}

describe('createHousehold', () => {
  it('records the creator as owner and member and sets the memory namespace', () => {
    const r = createHousehold({ householdId: 'h1', name: ' Home ', creatorUserId: 'u1', createdAt: NOW });
    expect(r).toEqual({
      ok: true,
      value: {
        household: { householdId: 'h1', name: 'Home', ownerUserId: 'u1', createdAt: NOW, preferenceMemoryNamespace: 'h1' },
        ownerMembership: { householdId: 'h1', userId: 'u1', role: 'owner', joinedAt: NOW },
      },
    });
  });

  it('rejects an empty name or ids', () => {
    for (const input of [
      { householdId: 'h1', name: '  ', creatorUserId: 'u1', createdAt: NOW },
      { householdId: '', name: 'Home', creatorUserId: 'u1', createdAt: NOW },
      { householdId: 'h1', name: 'Home', creatorUserId: '', createdAt: NOW },
    ]) {
      const r = createHousehold(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVALID_HOUSEHOLD_INPUT');
    }
  });
});

describe('resolveActiveHousehold', () => {
  it('scopes to a household the user belongs to', () => {
    const { memberships } = setup();
    expect(resolveActiveHousehold('alice', 'h1', memberships)).toEqual({
      ok: true,
      value: { userId: 'alice', householdId: 'h1', role: 'member' },
    });
  });

  it('rejects a household the user does not belong to', () => {
    const { memberships } = setup();
    const r = resolveActiveHousehold('alice', 'h2', memberships);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_A_MEMBER');
  });

  it("does not accept another user's membership", () => {
    const { memberships } = setup();
    const r = resolveActiveHousehold('mallory', 'h1', memberships);
    expect(r.ok).toBe(false);
  });
});

describe('removeMember', () => {
  it('removes a non-owner member and revokes access', () => {
    const { household, memberships } = setup();
    const r = removeMember(household, memberships, 'owner', 'alice');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.removed.userId).toBe('alice');
    expect(isMember(r.value.remaining, 'alice', 'h1')).toBe(false);
    expect(resolveActiveHousehold('alice', 'h1', r.value.remaining).ok).toBe(false);
    expect(isMember(r.value.remaining, 'owner', 'h1')).toBe(true);
  });

  it('rejects removal of the owner and leaves memberships unchanged', () => {
    const { household, memberships } = setup();
    const before = structuredClone(memberships);
    const r = removeMember(household, memberships, 'owner', 'owner');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('CANNOT_REMOVE_OWNER');
    expect(memberships).toEqual(before);
  });

  it('rejects removal by a non-owner', () => {
    const { household, memberships } = setup();
    const r = removeMember(household, memberships, 'alice', 'alice');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_HOUSEHOLD_OWNER');
  });

  it('rejects removal of a non-member', () => {
    const { household, memberships } = setup();
    const r = removeMember(household, memberships, 'owner', 'bob');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NOT_A_MEMBER');
  });
});
