import { describe, expect, it } from 'vitest';
import {
  MAX_DIETARY_CONSTRAINT_LENGTH,
  addDietaryConstraint,
  emptyPreferenceProfile,
  recordAcceptance,
  recordFeedback,
} from './preferences.js';
import type { PreferenceProfile } from './types.js';

const T0 = '2025-01-01T00:00:00.000Z';
const T1 = '2025-01-02T00:00:00.000Z';

function profile(overrides: Partial<PreferenceProfile> = {}): PreferenceProfile {
  return { ...emptyPreferenceProfile('hh-1', T0), ...overrides };
}

function frozenCopy(p: PreferenceProfile): PreferenceProfile {
  return structuredClone(p);
}

describe('recordFeedback (6.1)', () => {
  it('records a like and updates the timestamp without mutating input', () => {
    const before = profile();
    const snapshot = frozenCopy(before);
    const after = recordFeedback(before, 'Lasagna', 'like', T1);
    expect(after.likes).toEqual(['Lasagna']);
    expect(after.dislikes).toEqual([]);
    expect(after.updatedAt).toBe(T1);
    expect(before).toEqual(snapshot);
  });

  it('records a dislike', () => {
    expect(recordFeedback(profile(), 'Curry', 'dislike', T1).dislikes).toEqual(['Curry']);
  });

  it('latest feedback wins and the item is not duplicated', () => {
    const p = profile({ likes: ['lasagna'] });
    const disliked = recordFeedback(p, ' Lasagna ', 'dislike', T1);
    expect(disliked.likes).toEqual([]);
    expect(disliked.dislikes).toEqual(['Lasagna']);
    const again = recordFeedback(disliked, 'lasagna', 'dislike', T1);
    expect(again.dislikes).toEqual(['lasagna']);
  });
});

describe('recordAcceptance (6.3)', () => {
  it('records an acceptance once and does not mutate input', () => {
    const before = profile();
    const once = recordAcceptance(before, 'meal-1', T1);
    const twice = recordAcceptance(once, 'meal-1', T1);
    expect(once.acceptances).toEqual(['meal-1']);
    expect(twice.acceptances).toEqual(['meal-1']);
    expect(once.updatedAt).toBe(T1);
    expect(before.acceptances).toEqual([]);
  });
});

describe('addDietaryConstraint (6.5, 6.6)', () => {
  it('stores a valid constraint (trimmed)', () => {
    const before = profile();
    const result = addDietaryConstraint(before, '  vegetarian ', T1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.dietaryConstraints).toEqual(['vegetarian']);
      expect(result.profile.updatedAt).toBe(T1);
    }
    expect(before.dietaryConstraints).toEqual([]);
  });

  it('accepts exactly 200 characters and rejects 201 as too_long', () => {
    const ok = addDietaryConstraint(profile(), 'a'.repeat(MAX_DIETARY_CONSTRAINT_LENGTH), T1);
    expect(ok.ok).toBe(true);
    const tooLong = addDietaryConstraint(profile(), 'a'.repeat(MAX_DIETARY_CONSTRAINT_LENGTH + 1), T1);
    expect(tooLong).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('counts astral characters as one character each', () => {
    const emoji = '🥦'.repeat(MAX_DIETARY_CONSTRAINT_LENGTH);
    expect(addDietaryConstraint(profile(), emoji, T1).ok).toBe(true);
  });

  it.each(['', '   ', '\n\t'])('rejects empty/whitespace input %j', (input) => {
    expect(addDietaryConstraint(profile(), input, T1)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects duplicates case-insensitively and leaves the profile unchanged', () => {
    const before = profile({ dietaryConstraints: ['No Nuts'] });
    const snapshot = frozenCopy(before);
    const result = addDietaryConstraint(before, ' no nuts', T1);
    expect(result).toMatchObject({ ok: false, reason: 'duplicate' });
    if (!result.ok) expect(result.message).toMatch(/duplicate/i);
    expect(before).toEqual(snapshot);
  });
});
