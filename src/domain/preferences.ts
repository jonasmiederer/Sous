/**
 * Pure Preference_Profile mutations (Requirements 6.1, 6.3, 6.5, 6.6).
 *
 * Every function returns a new profile and never mutates its input. Callers
 * supply `now` so the functions stay deterministic; persistence (conditional
 * writes, 6.2) is handled by the service layer.
 */
import type {
  FeedbackValue,
  HouseholdId,
  IsoTimestamp,
  MealId,
  PreferenceProfile,
} from './types.js';

/** Maximum dietary constraint length in characters (Requirement 6.5). */
export const MAX_DIETARY_CONSTRAINT_LENGTH = 200;

/** An empty profile for a Household that has none yet. */
export function emptyPreferenceProfile(householdId: HouseholdId, now: IsoTimestamp): PreferenceProfile {
  return {
    householdId,
    likes: [],
    dislikes: [],
    excludedIngredients: [],
    dietaryConstraints: [],
    acceptances: [],
    updatedAt: now,
  };
}

/** Case- and surrounding-whitespace-insensitive key used for set semantics. */
export function normalizePreferenceKey(value: string): string {
  return value.trim().toLowerCase();
}

function withoutKey(values: readonly string[], key: string): string[] {
  return values.filter((v) => normalizePreferenceKey(v) !== key);
}

function containsKey(values: readonly string[], key: string): boolean {
  return values.some((v) => normalizePreferenceKey(v) === key);
}

function cloneProfile(profile: PreferenceProfile): PreferenceProfile {
  return {
    ...profile,
    likes: [...profile.likes],
    dislikes: [...profile.dislikes],
    excludedIngredients: [...profile.excludedIngredients],
    dietaryConstraints: [...profile.dietaryConstraints],
    acceptances: [...profile.acceptances],
  };
}

/**
 * Record like/dislike Feedback on a Meal_Suggestion (Requirement 6.1).
 *
 * The item ends up in exactly one of `likes` / `dislikes`: the latest
 * Feedback wins and replaces any opposite or repeated entry for the same item.
 */
export function recordFeedback(
  profile: PreferenceProfile,
  item: string,
  value: FeedbackValue,
  now: IsoTimestamp,
): PreferenceProfile {
  const name = item.trim();
  const key = normalizePreferenceKey(name);
  const next = cloneProfile(profile);
  next.likes = withoutKey(profile.likes, key);
  next.dislikes = withoutKey(profile.dislikes, key);
  if (value === 'like') next.likes.push(name);
  else next.dislikes.push(name);
  next.updatedAt = now;
  return next;
}

/** Record acceptance of a Meal_Suggestion into a Meal_Plan (Requirement 6.3). */
export function recordAcceptance(
  profile: PreferenceProfile,
  mealId: MealId,
  now: IsoTimestamp,
): PreferenceProfile {
  const next = cloneProfile(profile);
  if (!next.acceptances.includes(mealId)) next.acceptances.push(mealId);
  next.updatedAt = now;
  return next;
}

export type DietaryConstraintRejectionReason = 'empty' | 'too_long' | 'duplicate';

export type DietaryConstraintResult =
  | { ok: true; profile: PreferenceProfile }
  | { ok: false; reason: DietaryConstraintRejectionReason; message: string };

const REJECTION_MESSAGES: Readonly<Record<DietaryConstraintRejectionReason, string>> = {
  empty: 'Dietary constraint must not be empty.',
  too_long: `Dietary constraint must be at most ${MAX_DIETARY_CONSTRAINT_LENGTH} characters.`,
  duplicate: 'Dietary constraint duplicates an existing constraint.',
};

/** Validate a dietary constraint against a profile without changing it. */
export function validateDietaryConstraint(
  profile: PreferenceProfile,
  constraint: string,
): DietaryConstraintRejectionReason | null {
  const trimmed = constraint.trim();
  if (trimmed.length === 0) return 'empty';
  // Count Unicode code points so astral characters count as one character.
  if ([...trimmed].length > MAX_DIETARY_CONSTRAINT_LENGTH) return 'too_long';
  if (containsKey(profile.dietaryConstraints, normalizePreferenceKey(trimmed))) return 'duplicate';
  return null;
}

/**
 * Add a dietary constraint (Requirements 6.5, 6.6). Whitespace-only input is
 * empty; duplicates are detected case-insensitively after trimming. On
 * rejection the input profile is untouched and the reason is returned.
 */
export function addDietaryConstraint(
  profile: PreferenceProfile,
  constraint: string,
  now: IsoTimestamp,
): DietaryConstraintResult {
  const reason = validateDietaryConstraint(profile, constraint);
  if (reason !== null) return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
  const next = cloneProfile(profile);
  next.dietaryConstraints.push(constraint.trim());
  next.updatedAt = now;
  return { ok: true, profile: next };
}
