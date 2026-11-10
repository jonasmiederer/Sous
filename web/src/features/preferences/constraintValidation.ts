/**
 * Client-side dietary constraint checks (Requirements 6.5, 6.6, 13.9). They
 * mirror `validateDietaryConstraint` in src/domain/preferences.ts: trimmed,
 * 1–200 code points, and not a case-insensitive duplicate.
 */
import { MAX_DIETARY_CONSTRAINT_LENGTH, normalizePreferenceKey } from '@sous/domain/preferences';
import { codePointLength } from '../../ui';

export { MAX_DIETARY_CONSTRAINT_LENGTH };

export type ConstraintProblem = 'empty' | 'too_long' | 'duplicate';

export function constraintProblem(value: string, existing: readonly string[]): ConstraintProblem | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'empty';
  if (codePointLength(trimmed) > MAX_DIETARY_CONSTRAINT_LENGTH) return 'too_long';
  const key = normalizePreferenceKey(trimmed);
  if (existing.some((c) => normalizePreferenceKey(c) === key)) return 'duplicate';
  return null;
}

export const CONSTRAINT_PROBLEM_MESSAGES: Record<ConstraintProblem, string> = {
  empty: 'Describe the dietary need first.',
  too_long: `Keep it to ${MAX_DIETARY_CONSTRAINT_LENGTH} characters or fewer.`,
  duplicate: 'That one is already on your list.',
};

export function isConstraintProblem(value: unknown): value is ConstraintProblem {
  return value === 'empty' || value === 'too_long' || value === 'duplicate';
}
