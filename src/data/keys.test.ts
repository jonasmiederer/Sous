import { describe, expect, it } from 'vitest';
import {
  InvalidKeyError,
  householdPk,
  invitationGsi2,
  keys,
  membershipGsi1,
  parseHouseholdPk,
  sortKeys,
  userPk,
} from './keys.js';

describe('key builders', () => {
  it('builds partition keys', () => {
    expect(householdPk('h1')).toBe('HH#h1');
    expect(userPk('u1')).toBe('USER#u1');
  });

  it('places every tenant entity under the HH# partition with the expected sort key', () => {
    const h = 'h1';
    expect(keys.household(h)).toEqual({ PK: 'HH#h1', SK: 'META' });
    expect(keys.membership(h, 'u1')).toEqual({ PK: 'HH#h1', SK: 'MEMBER#u1' });
    expect(keys.invitation(h, 'i1')).toEqual({ PK: 'HH#h1', SK: 'INVITE#i1' });
    expect(keys.meal(h, 'm1')).toEqual({ PK: 'HH#h1', SK: 'MEAL#m1' });
    expect(keys.plan(h, 'p1')).toEqual({ PK: 'HH#h1', SK: 'PLAN#p1' });
    expect(keys.suggestion(h, 's1', 'g1')).toEqual({ PK: 'HH#h1', SK: 'SUGGESTION#s1#g1' });
    expect(keys.preferenceProfile(h)).toEqual({ PK: 'HH#h1', SK: 'PREFERENCE_PROFILE' });
    expect(keys.prefMemory(h, 'pm1')).toEqual({ PK: 'HH#h1', SK: 'PREF_MEMORY#pm1' });
    expect(keys.fridge(h)).toEqual({ PK: 'HH#h1', SK: 'FRIDGE' });
    expect(keys.grocery(h, 'p1')).toEqual({ PK: 'HH#h1', SK: 'GROCERY#p1' });
    expect(keys.conversation(h, 'c1')).toEqual({ PK: 'HH#h1', SK: 'CONVERSATION#c1' });
  });

  it('builds the user mirror key outside any Household partition', () => {
    expect(keys.user('u1')).toEqual({ PK: 'USER#u1', SK: 'PROFILE' });
  });

  it('builds GSI keys', () => {
    expect(membershipGsi1('h1', 'u1')).toEqual({ GSI1PK: 'USER#u1', GSI1SK: 'HH#h1' });
    expect(invitationGsi2('i1')).toEqual({ GSI2PK: 'INVITE#i1' });
  });

  it('session prefix matches only that session’s suggestion keys', () => {
    const prefix = sortKeys.suggestionSession('s1');
    expect(sortKeys.suggestion('s1', 'g1').startsWith(prefix)).toBe(true);
    expect(sortKeys.suggestion('s10', 'g1').startsWith(prefix)).toBe(false);
  });

  it.each(['', 'a#b', '#', undefined as unknown as string])('rejects invalid id %j', (bad) => {
    expect(() => householdPk(bad)).toThrow(InvalidKeyError);
    expect(() => keys.meal('h1', bad)).toThrow(InvalidKeyError);
  });

  it('parses household partition keys', () => {
    expect(parseHouseholdPk('HH#h1')).toBe('h1');
    expect(parseHouseholdPk('USER#u1')).toBeUndefined();
    expect(parseHouseholdPk('HH#')).toBeUndefined();
  });
});
