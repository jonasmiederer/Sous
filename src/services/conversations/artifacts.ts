/**
 * Loading and updating the artifacts a Conversation refines (Requirements
 * 9.1, 9.2, 9.4). Pure helpers plus Household-scoped repository reads; all
 * reads go through a HouseholdRepository, so an artifact of another Household
 * cannot be addressed.
 *
 * Stored shapes: each artifact record's attributes are the domain type
 * (MealSuggestion at SUGGESTION#{sessionId}#{suggestionId}, MealPlan at
 * PLAN#{planId}, Meal at MEAL#{mealId}, GroceryList at GROCERY#{planId}).
 */
import type { AgentArtifactMeal, RefineCurrentArtifact } from '../../agent/payload.js';
import type { AgentMeal } from '../../agent/responses.js';
import type { StoredRecord, HouseholdRepository } from '../../data/repository.js';
import { sortKeys } from '../../data/keys.js';
import type { GroceryList, Meal, MealPlan, MealSuggestion } from '../../domain/types.js';

/** What a Conversation points at. */
export type ConversationTarget =
  | { type: 'suggestion'; sessionId: string; suggestionId: string }
  | { type: 'plan'; planId: string }
  | { type: 'grocery_list'; planId: string };

export type LoadedArtifact =
  | { type: 'suggestion'; record: StoredRecord<MealSuggestion & Record<string, unknown>> }
  | {
      type: 'plan';
      record: StoredRecord<MealPlan & Record<string, unknown>>;
      /** Meals of the plan keyed by mealId. */
      meals: Map<string, Meal>;
    }
  | { type: 'grocery_list'; record: StoredRecord<GroceryList & Record<string, unknown>> };

export function targetSortKey(target: ConversationTarget): string {
  switch (target.type) {
    case 'suggestion':
      return sortKeys.suggestion(target.sessionId, target.suggestionId);
    case 'plan':
      return sortKeys.plan(target.planId);
    case 'grocery_list':
      return sortKeys.grocery(target.planId);
  }
}

/**
 * Loads the target artifact from the Active_Household partition. Returns
 * undefined when the artifact (or any Meal a plan day references) is missing.
 */
export async function loadArtifact(
  repo: HouseholdRepository,
  target: ConversationTarget,
): Promise<LoadedArtifact | undefined> {
  switch (target.type) {
    case 'suggestion': {
      const record = await repo.get<MealSuggestion & Record<string, unknown>>(targetSortKey(target));
      return record && { type: 'suggestion', record };
    }
    case 'grocery_list': {
      const record = await repo.get<GroceryList & Record<string, unknown>>(targetSortKey(target));
      return record && { type: 'grocery_list', record };
    }
    case 'plan': {
      const record = await repo.get<MealPlan & Record<string, unknown>>(targetSortKey(target));
      if (!record) return undefined;
      const ids = [...new Set(record.attributes.days.map((d) => d.mealId))];
      const loaded = await Promise.all(ids.map((id) => repo.get<Meal & Record<string, unknown>>(sortKeys.meal(id))));
      const meals = new Map<string, Meal>();
      for (const [i, r] of loaded.entries()) {
        if (!r) return undefined;
        meals.set(ids[i]!, r.attributes);
      }
      return { type: 'plan', record, meals };
    }
  }
}

function agentMeal(meal: { name: string; ingredients: Meal['ingredients']; steps: string[]; attributes?: string[] }): AgentArtifactMeal {
  return {
    name: meal.name,
    ingredients: meal.ingredients.map((i) => ({ ...i })),
    steps: [...meal.steps],
    attributes: [...(meal.attributes ?? [])],
  };
}

/** The current artifact as sent to the agent. */
export function toCurrentArtifact(artifact: LoadedArtifact): RefineCurrentArtifact {
  switch (artifact.type) {
    case 'suggestion':
      return { type: 'suggestion', meal: agentMeal(artifact.record.attributes) };
    case 'plan':
      return {
        type: 'plan',
        days: artifact.record.attributes.days.map((d) => ({ day: d.day, meal: agentMeal(artifact.meals.get(d.mealId)!) })),
      };
    case 'grocery_list':
      return { type: 'grocery_list', entries: artifact.record.attributes.entries.map((e) => ({ ...e })) };
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export type SuggestionContentField = 'name' | 'ingredients' | 'steps';

/**
 * Applies the agent's refined Meal to the current suggestion (Requirement 9.1).
 *
 * How unaffected attributes are preserved:
 * - Identity and context fields the agent does not own (suggestionId,
 *   sessionId, householdId, presetContext, preferenceApplied, and any other
 *   stored attribute such as a TTL) are always copied from the current record.
 * - Content fields (name, ingredients, steps) are compared one by one; a field
 *   is replaced only when the agent's value differs from the current value,
 *   otherwise the current value is kept as stored. `changedFields` lists the
 *   fields that were replaced.
 */
export function mergeRefinedSuggestion<T extends MealSuggestion>(
  current: T,
  refined: AgentMeal,
): { suggestion: T; changedFields: SuggestionContentField[] } {
  const next: T = structuredClone(current);
  const changedFields: SuggestionContentField[] = [];
  if (!sameValue(current.name, refined.name)) {
    next.name = refined.name;
    changedFields.push('name');
  }
  if (!sameValue(current.ingredients, refined.ingredients)) {
    next.ingredients = refined.ingredients.map((i) => ({ ...i }));
    changedFields.push('ingredients');
  }
  if (!sameValue(current.steps, refined.steps)) {
    next.steps = [...refined.steps];
    changedFields.push('steps');
  }
  return { suggestion: next, changedFields };
}

/**
 * Returns a copy of `plan` with only `day`'s mealId replaced (Requirement
 * 9.2), or undefined when the plan has no such day.
 */
export function replacePlanDay<T extends MealPlan>(plan: T, day: string, mealId: string): T | undefined {
  if (!plan.days.some((d) => d.day === day)) return undefined;
  const next: T = structuredClone(plan);
  next.days = plan.days.map((d) => (d.day === day ? { day: d.day, mealId } : { ...d }));
  return next;
}

/** A Meal is well-formed when it has a name, at least one ingredient, and at least one step. */
export function isWellFormedMeal(meal: AgentMeal): boolean {
  return meal.name.trim().length > 0 && meal.ingredients.length > 0 && meal.steps.length > 0;
}
