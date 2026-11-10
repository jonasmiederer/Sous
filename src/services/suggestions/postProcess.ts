/**
 * Deterministic post-processing of the agent's ad hoc suggestions. Nothing
 * here is trusted to the model (design.md, "Suggestion_Agent interface"):
 *
 * 1. Well-formedness: non-empty name, >= 1 ingredient, >= 1 non-empty step
 *    (Requirement 2.1).
 * 2. Hard exclusions from the structured Preference_Profile (Requirement 2.2,
 *    6.7). Skipped only when no profile exists (Requirement 2.3). Soft
 *    long-term memory never affects this step (Property 7).
 * 3. Distinctness: drop names already rejected in the session, and duplicate
 *    names within the response (Requirement 2.5).
 * 4. Fridge ranking: Meals using a fridge item first (Requirement 4.5).
 * 5. Cap at 3 (Requirement 2.1).
 */
import type { AgentMeal } from '../../agent/responses.js';
import { enforceHardExclusions } from '../../domain/exclusions.js';
import { rankMealsByFridgeUsage } from '../../domain/fridge.js';
import type { Ingredient, PreferenceProfile } from '../../domain/types.js';

export const MAX_SUGGESTIONS = 3;

/** Comparison key for suggestion names: trimmed, whitespace-collapsed, case-folded. */
export function suggestionNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function isWellFormedMeal(meal: AgentMeal): boolean {
  return (
    typeof meal.name === 'string' &&
    meal.name.trim().length > 0 &&
    Array.isArray(meal.ingredients) &&
    meal.ingredients.length > 0 &&
    Array.isArray(meal.steps) &&
    meal.steps.some((s) => typeof s === 'string' && s.trim().length > 0)
  );
}

export type SelectionOutcome =
  | { kind: 'selected'; meals: AgentMeal[] }
  /** The agent returned nothing usable at all. */
  | { kind: 'none_well_formed' }
  /** Well-formed meals existed, but all broke a hard exclusion. */
  | { kind: 'all_excluded' }
  /** Allowed meals existed, but every one repeated a rejected name. */
  | { kind: 'exhausted_distinct' };

export interface SelectionInput {
  meals: readonly AgentMeal[];
  profile: PreferenceProfile | null;
  rejectedNames: readonly string[];
  fridgeItems: readonly Ingredient[];
  /** Soft long-term memory; passed through to show it is never used for filtering. */
  softMemory?: unknown;
}

export function selectSuggestions(input: SelectionInput): SelectionOutcome {
  const wellFormed = input.meals
    .filter(isWellFormedMeal)
    .map((m) => ({ ...m, steps: m.steps.filter((s) => s.trim().length > 0) }));
  if (wellFormed.length === 0) return { kind: 'none_well_formed' };

  const { allowed } = enforceHardExclusions(wellFormed, input.profile, input.softMemory);
  if (allowed.length === 0) return { kind: 'all_excluded' };

  const rejected = new Set(input.rejectedNames.map(suggestionNameKey));
  const seen = new Set<string>();
  const distinct: AgentMeal[] = [];
  for (const meal of allowed) {
    const key = suggestionNameKey(meal.name);
    if (rejected.has(key) || seen.has(key)) continue;
    seen.add(key);
    distinct.push(meal);
  }
  if (distinct.length === 0) return { kind: 'exhausted_distinct' };

  return { kind: 'selected', meals: rankMealsByFridgeUsage(distinct, input.fridgeItems).slice(0, MAX_SUGGESTIONS) };
}
