/**
 * Household creation, Active_Household scoping, and member removal rules.
 *
 * Pure functions: no I/O. Callers (the Auth & Membership Service) load the
 * relevant records, apply these rules, and persist the results.
 *
 * Requirements: 10.1, 10.6, 10.7, 10.8
 */
import type { Household, HouseholdId, IsoTimestamp, Membership, UserId } from './types.js';

export type HouseholdErrorCode =
  | 'INVALID_HOUSEHOLD_INPUT'
  | 'NOT_A_MEMBER'
  | 'NOT_HOUSEHOLD_OWNER'
  | 'CANNOT_REMOVE_OWNER';

export interface HouseholdError {
  code: HouseholdErrorCode;
  message: string;
}

export type HouseholdResult<T> = { ok: true; value: T } | { ok: false; error: HouseholdError };

function fail<T>(code: HouseholdErrorCode, message: string): HouseholdResult<T> {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Creation (10.1)
// ---------------------------------------------------------------------------

export interface CreateHouseholdInput {
  householdId: HouseholdId;
  name: string;
  creatorUserId: UserId;
  createdAt: IsoTimestamp;
}

export interface CreatedHousehold {
  household: Household;
  /** The creator's membership, with role `owner`. */
  ownerMembership: Membership;
}

/**
 * Creates a Household whose creator is both the Household_Owner and a member.
 * The long-term preference memory namespace is always the householdId.
 */
export function createHousehold(input: CreateHouseholdInput): HouseholdResult<CreatedHousehold> {
  const name = input.name.trim();
  if (input.householdId.length === 0) {
    return fail('INVALID_HOUSEHOLD_INPUT', 'Household id must not be empty.');
  }
  if (input.creatorUserId.length === 0) {
    return fail('INVALID_HOUSEHOLD_INPUT', 'Creator user id must not be empty.');
  }
  if (name.length === 0) {
    return fail('INVALID_HOUSEHOLD_INPUT', 'Household name must not be empty.');
  }
  const household: Household = {
    householdId: input.householdId,
    name,
    ownerUserId: input.creatorUserId,
    createdAt: input.createdAt,
    preferenceMemoryNamespace: input.householdId,
  };
  const ownerMembership: Membership = {
    householdId: input.householdId,
    userId: input.creatorUserId,
    role: 'owner',
    joinedAt: input.createdAt,
  };
  return { ok: true, value: { household, ownerMembership } };
}

// ---------------------------------------------------------------------------
// Active_Household scoping (10.6)
// ---------------------------------------------------------------------------

/** Finds the membership of `userId` in `householdId`, if any. */
export function findMembership(
  memberships: readonly Membership[],
  userId: UserId,
  householdId: HouseholdId,
): Membership | undefined {
  return memberships.find((m) => m.userId === userId && m.householdId === householdId);
}

export function isMember(
  memberships: readonly Membership[],
  userId: UserId,
  householdId: HouseholdId,
): boolean {
  return findMembership(memberships, userId, householdId) !== undefined;
}

export interface ActiveHouseholdScope {
  userId: UserId;
  householdId: HouseholdId;
  role: Membership['role'];
}

/**
 * Scopes a request to `targetHouseholdId` only when the authenticated User's
 * membership set contains it; otherwise returns NOT_A_MEMBER. The error does
 * not reveal whether the target Household exists.
 */
export function resolveActiveHousehold(
  userId: UserId,
  targetHouseholdId: HouseholdId,
  userMemberships: readonly Membership[],
): HouseholdResult<ActiveHouseholdScope> {
  const membership = findMembership(userMemberships, userId, targetHouseholdId);
  if (membership === undefined) {
    return fail('NOT_A_MEMBER', 'You do not have access to this household.');
  }
  return { ok: true, value: { userId, householdId: targetHouseholdId, role: membership.role } };
}

// ---------------------------------------------------------------------------
// Member removal (10.7, 10.8)
// ---------------------------------------------------------------------------

export interface MemberRemoval {
  removed: Membership;
  /** The Household's memberships after removal. */
  remaining: Membership[];
}

/**
 * Removes `targetUserId` from `household`. Only the Household_Owner may remove
 * members, and the Household_Owner can never be removed. On error the input
 * memberships are left as they were (inputs are never mutated).
 */
export function removeMember(
  household: Household,
  memberships: readonly Membership[],
  actorUserId: UserId,
  targetUserId: UserId,
): HouseholdResult<MemberRemoval> {
  const householdMemberships = memberships.filter((m) => m.householdId === household.householdId);
  if (actorUserId !== household.ownerUserId) {
    return fail('NOT_HOUSEHOLD_OWNER', 'Only the household owner can remove members.');
  }
  if (targetUserId === household.ownerUserId) {
    return fail('CANNOT_REMOVE_OWNER', 'The household owner cannot be removed.');
  }
  const removed = householdMemberships.find((m) => m.userId === targetUserId);
  if (removed === undefined) {
    return fail('NOT_A_MEMBER', 'That user is not a member of this household.');
  }
  return {
    ok: true,
    value: { removed, remaining: householdMemberships.filter((m) => m.userId !== targetUserId) },
  };
}
