/**
 * Single-table key construction (design.md, Data Models).
 *
 * Every tenant record lives under a partition key of the form
 * `HH#{householdId}`. The only non-tenant partition is the User mirror record
 * (`USER#{userId}`). GSI1 indexes memberships by user; GSI2 indexes
 * invitations by id for accept/decline lookups; GSI3 is a sparse index of
 * pending invitations ordered by expiry, read only by the expiry sweep.
 *
 * Identifiers are validated before they are embedded in a key: they must be
 * non-empty and must not contain the `#` delimiter. This prevents one id from
 * forging a key that collides with another entity or another Household's
 * partition (Requirement 1.4).
 */
import type {
  ConversationId,
  HouseholdId,
  InvitationId,
  MealId,
  PlanId,
  PreferenceId,
  SessionId,
  SuggestionId,
  UserId,
} from '../domain/types.js';

export const KEY_DELIMITER = '#';

export const KeyPrefix = {
  household: 'HH#',
  user: 'USER#',
  member: 'MEMBER#',
  invite: 'INVITE#',
  meal: 'MEAL#',
  plan: 'PLAN#',
  suggestion: 'SUGGESTION#',
  prefMemory: 'PREF_MEMORY#',
  grocery: 'GROCERY#',
  conversation: 'CONVERSATION#',
} as const;

export const SingletonSortKey = {
  householdMeta: 'META',
  userProfile: 'PROFILE',
  preferenceProfile: 'PREFERENCE_PROFILE',
  fridge: 'FRIDGE',
} as const;

export const GSI1_NAME = 'GSI1';
export const GSI2_NAME = 'GSI2';
export const GSI3_NAME = 'GSI3';

/** GSI3 partition holding every pending Invitation (sparse; see pendingInvitationGsi3). */
export const PENDING_INVITATIONS_GSI3PK = 'INVITE_PENDING';

/** Primary key of a table item. */
export interface TableKey {
  PK: string;
  SK: string;
}

/** Optional secondary-index keys carried by an item. */
export interface IndexKeys {
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI3PK?: string;
  GSI3SK?: string;
}

export class InvalidKeyError extends Error {
  override readonly name = 'InvalidKeyError';
  constructor(
    readonly field: string,
    readonly value: unknown,
  ) {
    super(`Invalid ${field} for key construction: must be a non-empty string without '${KEY_DELIMITER}'`);
  }
}

/** Validates an identifier before it is embedded in a key. */
export function assertKeyComponent(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes(KEY_DELIMITER)) {
    throw new InvalidKeyError(field, value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Partition keys
// ---------------------------------------------------------------------------

export function householdPk(householdId: HouseholdId): string {
  return KeyPrefix.household + assertKeyComponent('householdId', householdId);
}

export function userPk(userId: UserId): string {
  return KeyPrefix.user + assertKeyComponent('userId', userId);
}

// ---------------------------------------------------------------------------
// Sort keys (all within a Household partition, except userProfileSk)
// ---------------------------------------------------------------------------

export const sortKeys = {
  householdMeta: (): string => SingletonSortKey.householdMeta,
  userProfile: (): string => SingletonSortKey.userProfile,
  member: (userId: UserId): string => KeyPrefix.member + assertKeyComponent('userId', userId),
  invitation: (invitationId: InvitationId): string =>
    KeyPrefix.invite + assertKeyComponent('invitationId', invitationId),
  meal: (mealId: MealId): string => KeyPrefix.meal + assertKeyComponent('mealId', mealId),
  plan: (planId: PlanId): string => KeyPrefix.plan + assertKeyComponent('planId', planId),
  suggestion: (sessionId: SessionId, suggestionId: SuggestionId): string =>
    KeyPrefix.suggestion +
    assertKeyComponent('sessionId', sessionId) +
    KEY_DELIMITER +
    assertKeyComponent('suggestionId', suggestionId),
  /** Prefix for all suggestions of one request session. */
  suggestionSession: (sessionId: SessionId): string =>
    KeyPrefix.suggestion + assertKeyComponent('sessionId', sessionId) + KEY_DELIMITER,
  preferenceProfile: (): string => SingletonSortKey.preferenceProfile,
  prefMemory: (preferenceId: PreferenceId): string =>
    KeyPrefix.prefMemory + assertKeyComponent('preferenceId', preferenceId),
  fridge: (): string => SingletonSortKey.fridge,
  grocery: (planId: PlanId): string => KeyPrefix.grocery + assertKeyComponent('planId', planId),
  conversation: (conversationId: ConversationId): string =>
    KeyPrefix.conversation + assertKeyComponent('conversationId', conversationId),
} as const;

// ---------------------------------------------------------------------------
// Full primary keys
// ---------------------------------------------------------------------------

export const keys = {
  user: (userId: UserId): TableKey => ({ PK: userPk(userId), SK: sortKeys.userProfile() }),
  household: (householdId: HouseholdId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.householdMeta(),
  }),
  membership: (householdId: HouseholdId, userId: UserId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.member(userId),
  }),
  invitation: (householdId: HouseholdId, invitationId: InvitationId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.invitation(invitationId),
  }),
  meal: (householdId: HouseholdId, mealId: MealId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.meal(mealId),
  }),
  plan: (householdId: HouseholdId, planId: PlanId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.plan(planId),
  }),
  suggestion: (householdId: HouseholdId, sessionId: SessionId, suggestionId: SuggestionId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.suggestion(sessionId, suggestionId),
  }),
  preferenceProfile: (householdId: HouseholdId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.preferenceProfile(),
  }),
  prefMemory: (householdId: HouseholdId, preferenceId: PreferenceId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.prefMemory(preferenceId),
  }),
  fridge: (householdId: HouseholdId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.fridge(),
  }),
  grocery: (householdId: HouseholdId, planId: PlanId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.grocery(planId),
  }),
  conversation: (householdId: HouseholdId, conversationId: ConversationId): TableKey => ({
    PK: householdPk(householdId),
    SK: sortKeys.conversation(conversationId),
  }),
} as const;

// ---------------------------------------------------------------------------
// Secondary-index keys
// ---------------------------------------------------------------------------

/** GSI1 on a Membership item: list a user's Households. */
export function membershipGsi1(householdId: HouseholdId, userId: UserId): Required<Pick<IndexKeys, 'GSI1PK' | 'GSI1SK'>> {
  return { GSI1PK: userPk(userId), GSI1SK: householdPk(householdId) };
}

/**
 * GSI3 on a pending Invitation item: `INVITE_PENDING` / `{expiresAt}#{invitationId}`.
 *
 * The index is sparse. Only invitation creation sets these keys; accept,
 * decline and the expiry sweep rewrite the item without them, which removes
 * it from the index. The sweep can therefore find every pending Invitation
 * whose expiry has passed with one range query, without scanning the table.
 * `expiresAt` must be a `Date#toISOString()` value so that string order
 * equals time order.
 */
export function pendingInvitationGsi3(
  invitationId: InvitationId,
  expiresAt: string,
): Required<Pick<IndexKeys, 'GSI3PK' | 'GSI3SK'>> {
  return {
    GSI3PK: PENDING_INVITATIONS_GSI3PK,
    GSI3SK: assertKeyComponent('expiresAt', expiresAt) + KEY_DELIMITER + assertKeyComponent('invitationId', invitationId),
  };
}

/** GSI2 on an Invitation item: direct lookup by invitation id. */
export function invitationGsi2(invitationId: InvitationId): Required<Pick<IndexKeys, 'GSI2PK'>> {
  return { GSI2PK: KeyPrefix.invite + assertKeyComponent('invitationId', invitationId) };
}

/** Extracts the householdId from an `HH#...` partition key, or undefined. */
export function parseHouseholdPk(pk: string): HouseholdId | undefined {
  if (!pk.startsWith(KeyPrefix.household)) return undefined;
  const id = pk.slice(KeyPrefix.household.length);
  return id.length > 0 && !id.includes(KEY_DELIMITER) ? id : undefined;
}
