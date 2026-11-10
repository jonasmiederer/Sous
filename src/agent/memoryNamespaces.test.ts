import { describe, expect, it } from 'vitest';
import {
  InvalidMemoryIdError,
  householdActorId,
  longTermNamespace,
  shortTermEventAddress,
  shortTermNamespace,
} from './memoryNamespaces.js';

describe('memory namespace builders', () => {
  it('long-term namespace is exactly the householdId and ignores any userId', () => {
    const scope = { householdId: 'hh-1', userId: 'user-9', role: 'member' as const };
    expect(longTermNamespace(scope)).toBe('hh-1');
    expect(householdActorId(scope)).toBe('hh-1');
  });

  it('short-term namespace is {householdId}:{conversationId}', () => {
    expect(shortTermNamespace({ householdId: 'hh-1', conversationId: 'conv_2' })).toBe('hh-1:conv_2');
  });

  it('short-term event address uses the Household as actor and the Conversation as session', () => {
    expect(shortTermEventAddress({ householdId: 'hh-1', conversationId: 'c1' })).toEqual({
      actorId: 'hh-1',
      sessionId: 'c1',
      namespace: 'hh-1:c1',
    });
  });

  it.each(['', 'hh:2', 'hh/2', '../hh-2', '-hh', 'hh 2', 'a'.repeat(101)])(
    'rejects invalid householdId %j',
    (householdId) => {
      expect(() => longTermNamespace({ householdId })).toThrow(InvalidMemoryIdError);
    },
  );

  it('rejects conversation ids that would escape the session', () => {
    expect(() => shortTermNamespace({ householdId: 'hh-1', conversationId: 'x:hh-2' })).toThrow(
      InvalidMemoryIdError,
    );
    expect(() => shortTermNamespace({ householdId: 'hh-1', conversationId: '' })).toThrow(
      InvalidMemoryIdError,
    );
  });

  it('rejects non-string ids', () => {
    expect(() => longTermNamespace({ householdId: undefined as unknown as string })).toThrow(
      InvalidMemoryIdError,
    );
  });
});
