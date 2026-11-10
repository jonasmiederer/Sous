/**
 * Grocery-list consolidation and fridge subtraction.
 *
 * Pure functions: no I/O and no clock reads. The Grocery Service loads the
 * Meal_Plan, the Meals it references, and the Fridge_Inventory, calls
 * `buildGroceryList`, and persists the result.
 *
 * Behavior:
 * - Every ingredient of every Meal assigned to a plan day is included. A Meal
 *   used on several days contributes its ingredients once per day (7.1).
 * - Occurrences with the same normalized name and canonical unit are summed
 *   into one entry; other occurrences stay separate (7.2, 7.3). Grouping uses
 *   `compatibilityKey`, so no cross-unit conversion happens.
 * - Fridge items with the same compatibility key are subtracted; entries whose
 *   remaining quantity is zero or less are omitted (7.4).
 * - A plan with zero days yields an empty list (7.6).
 * - The list carries the plan's planId and householdId (7.7).
 *
 * Determinism: entries use the normalized name and canonical unit (so the
 * output does not depend on which occurrence was seen first) and are sorted
 * by compatibility key with a plain code-unit comparison. Quantities are
 * rounded to QUANTITY_DECIMALS places to remove floating-point noise such as
 * 0.1 + 0.2 = 0.30000000000000004.
 *
 * Errors (returned, not thrown):
 * - MISSING_MEAL: a plan day references a mealId not present in `meals`.
 *   Nothing is built; the error lists every missing mealId.
 * - INVALID_QUANTITY: a planned ingredient has a negative or non-finite
 *   quantity.
 * - HOUSEHOLD_MISMATCH: the Fridge_Inventory belongs to another Household.
 *
 * Fridge items with non-finite or non-positive quantities are ignored.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7
 */
import type {
  FridgeInventory,
  GroceryEntry,
  GroceryList,
  Ingredient,
  IsoTimestamp,
  Meal,
  MealId,
  MealPlan,
} from './types.js';
import { canonicalUnit, compatibilityKey, normalizeIngredientName } from './units.js';

/** Decimal places kept for grocery quantities. */
export const QUANTITY_DECIMALS = 6;
const QUANTITY_FACTOR = 10 ** QUANTITY_DECIMALS;

export function roundQuantity(value: number): number {
  const rounded = Math.round(value * QUANTITY_FACTOR) / QUANTITY_FACTOR;
  // Normalize -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

export type GroceryErrorCode = 'MISSING_MEAL' | 'INVALID_QUANTITY' | 'HOUSEHOLD_MISMATCH';

export interface GroceryError {
  code: GroceryErrorCode;
  message: string;
  /** Present for MISSING_MEAL: distinct missing ids in plan-day order. */
  missingMealIds?: MealId[];
}

export type GroceryResult<T> = { ok: true; value: T } | { ok: false; error: GroceryError };

export interface BuildGroceryListInput {
  plan: MealPlan;
  /** Meals referenced by the plan. Extra Meals are ignored. */
  meals: readonly Meal[];
  fridge?: FridgeInventory;
  generatedAt: IsoTimestamp;
}

interface Bucket {
  name: string;
  unit: string;
  quantity: number;
}

function addToBuckets(buckets: Map<string, Bucket>, item: Ingredient): void {
  const key = compatibilityKey(item);
  const existing = buckets.get(key);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    buckets.set(key, {
      name: normalizeIngredientName(item.name),
      unit: canonicalUnit(item.unit),
      quantity: item.quantity,
    });
  }
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sum ingredient occurrences by compatibility key. Returns entries sorted by
 * key with rounded quantities. Exposed for reuse and testing.
 */
export function consolidateIngredients(items: readonly Ingredient[]): GroceryEntry[] {
  const buckets = new Map<string, Bucket>();
  for (const item of items) addToBuckets(buckets, item);
  return [...buckets.entries()]
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([, b]) => ({ name: b.name, unit: b.unit, quantity: roundQuantity(b.quantity) }));
}

/**
 * Subtract fridge quantities from consolidated entries (same compatibility
 * key only) and drop entries that are fully covered. Input order is kept.
 */
export function subtractFridge(
  entries: readonly GroceryEntry[],
  fridgeItems: readonly Ingredient[],
): GroceryEntry[] {
  const available = new Map<string, number>();
  for (const item of fridgeItems) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
    const key = compatibilityKey(item);
    available.set(key, (available.get(key) ?? 0) + item.quantity);
  }
  const result: GroceryEntry[] = [];
  for (const entry of entries) {
    const remaining = roundQuantity(entry.quantity - (available.get(compatibilityKey(entry)) ?? 0));
    if (remaining > 0) result.push({ ...entry, quantity: remaining });
  }
  return result;
}

/** Build the consolidated Grocery_List for a Meal_Plan. */
export function buildGroceryList(input: BuildGroceryListInput): GroceryResult<GroceryList> {
  const { plan, meals, fridge, generatedAt } = input;

  if (fridge && fridge.householdId !== plan.householdId) {
    return {
      ok: false,
      error: {
        code: 'HOUSEHOLD_MISMATCH',
        message: 'Fridge inventory does not belong to the plan Household.',
      },
    };
  }

  const mealsById = new Map<MealId, Meal>();
  for (const meal of meals) mealsById.set(meal.mealId, meal);

  const missing: MealId[] = [];
  const occurrences: Ingredient[] = [];
  for (const day of plan.days) {
    const meal = mealsById.get(day.mealId);
    if (!meal) {
      if (!missing.includes(day.mealId)) missing.push(day.mealId);
      continue;
    }
    for (const ingredient of meal.ingredients) {
      if (!Number.isFinite(ingredient.quantity) || ingredient.quantity < 0) {
        return {
          ok: false,
          error: {
            code: 'INVALID_QUANTITY',
            message: `Ingredient "${ingredient.name}" in meal ${meal.mealId} has an invalid quantity.`,
          },
        };
      }
      occurrences.push(ingredient);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'MISSING_MEAL',
        message: `Plan references unknown meals: ${missing.join(', ')}.`,
        missingMealIds: missing,
      },
    };
  }

  const entries = subtractFridge(consolidateIngredients(occurrences), fridge?.items ?? []);

  return {
    ok: true,
    value: {
      householdId: plan.householdId,
      planId: plan.planId,
      entries,
      generatedAt,
    },
  };
}
