/**
 * Pure namespace builders for AgentCore Memory (Requirements 1.4, 9.7, 10.6).
 *
 * - Short-term Conversation turns live at the logical namespace
 *   `{householdId}:{conversationId}` (Conversation.memorySessionId).
 * - Long-term household preference memory lives at `{householdId}` only. It
 *   is never derived from a userId or a conversationId.
 *
 * Physical mapping onto the AgentCore Memory data plane:
 * - Events (short-term) are addressed by `actorId` + `sessionId`. AgentCore's
 *   sessionId pattern is `[a-zA-Z0-9][a-zA-Z0-9-_]*` and cannot contain ':',
 *   so the logical `{householdId}:{conversationId}` maps to
 *   `actorId = householdId`, `sessionId = conversationId`. The actor is the
 *   Household, never the acting User.
 * - Because the actor is the Household, a long-term extraction strategy with
 *   namespace template `{actorId}` writes records into exactly `{householdId}`.
 *
 * Ids are validated against `[A-Za-z0-9][A-Za-z0-9_-]*` so no id can contain
 * ':' or '/' and smuggle in another Household's namespace.
 */

import type { ConversationId, HouseholdId } from '../domain/types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** AgentCore sessionId maximum length. */
export const MAX_CONVERSATION_ID_LENGTH = 100;
/** Keeps the household actor/namespace well within AgentCore limits. */
export const MAX_HOUSEHOLD_ID_LENGTH = 100;

export class InvalidMemoryIdError extends Error {
  override readonly name = 'InvalidMemoryIdError';
  readonly code = 'INVALID_MEMORY_ID' as const;
  constructor(
    readonly field: 'householdId' | 'conversationId',
    message: string,
  ) {
    super(message);
  }
}

function validateId(
  field: 'householdId' | 'conversationId',
  value: unknown,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidMemoryIdError(field, `${field} must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw new InvalidMemoryIdError(field, `${field} must be at most ${maxLength} characters.`);
  }
  if (!ID_PATTERN.test(value)) {
    throw new InvalidMemoryIdError(
      field,
      `${field} may contain only letters, digits, '-' and '_' and must start with a letter or digit.`,
    );
  }
  return value;
}

export function validateHouseholdId(householdId: unknown): HouseholdId {
  return validateId('householdId', householdId, MAX_HOUSEHOLD_ID_LENGTH);
}

export function validateConversationId(conversationId: unknown): ConversationId {
  return validateId('conversationId', conversationId, MAX_CONVERSATION_ID_LENGTH);
}

/** Active_Household scope. Only `householdId` is read; any userId is ignored. */
export interface HouseholdMemoryScope {
  readonly householdId: HouseholdId;
}

export interface ConversationMemoryScope extends HouseholdMemoryScope {
  readonly conversationId: ConversationId;
}

/** Long-term household preference memory namespace: exactly `{householdId}`. */
export function longTermNamespace(scope: HouseholdMemoryScope): string {
  return validateHouseholdId(scope.householdId);
}

/** Logical short-term namespace: `{householdId}:{conversationId}`. */
export function shortTermNamespace(scope: ConversationMemoryScope): string {
  const householdId = validateHouseholdId(scope.householdId);
  const conversationId = validateConversationId(scope.conversationId);
  return `${householdId}:${conversationId}`;
}

/** AgentCore actorId for every event: the Household itself, never a User. */
export function householdActorId(scope: HouseholdMemoryScope): string {
  return validateHouseholdId(scope.householdId);
}

/** AgentCore event address for a Conversation's short-term turns. */
export interface ShortTermEventAddress {
  actorId: string;
  sessionId: string;
  /** Logical `{householdId}:{conversationId}`. */
  namespace: string;
}

export function shortTermEventAddress(scope: ConversationMemoryScope): ShortTermEventAddress {
  return {
    actorId: householdActorId(scope),
    sessionId: validateConversationId(scope.conversationId),
    namespace: shortTermNamespace(scope),
  };
}
