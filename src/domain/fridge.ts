/**
 * Fridge_Inventory replacement and fridge-aware Meal ranking (pure functions).
 *
 * Requirements 4.3, 4.4, 4.5, 4.6.
 *
 * Valid item definition:
 *   - `name` is a string that is non-empty after normalization
 *     (trim + whitespace collapse, see normalizeIngredientName);
 *   - `quantity` is a finite number strictly greater than 0
 *     (an item you have zero of is not in the fridge);
 *   - `unit` is a string (may be empty; empty resolves to the `piece` unit).
 *
 * A recording is accepted when it contains at least one valid item. Invalid
 * items in an otherwise valid recording are dropped and reported. Valid items
 * are stored exactly as recorded (no rewriting), so reading the inventory back
 * yields precisely the recorded valid items and nothing from the prior one.
 */

import type { FridgeInventory, HouseholdId, Ingredient, IsoTimestamp, Meal } from './types.js';
import { normalizeIngredientName } from './units.js';

/** True iff the value satisfies the valid-item definition above. */
export function isValidFridgeItem(item: unknown): item is Ingredient {
  if (typeof item !== 'object' || item === null) return false;
  const { name, quantity, unit } = item as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    normalizeIngredientName(name).length > 0 &&
    typeof quantity === 'number' &&
    Number.isFinite(quantity) &&
    quantity > 0 &&
    typeof unit === 'string'
  );
}

export type FridgeReplaceResult =
  | {
      ok: true;
      inventory: FridgeInventory;
      /** Indexes (into the recording) of items dropped as invalid. */
      droppedIndexes: number[];
    }
  | {
      ok: false;
      error: { code: 'no_valid_items'; message: string };
      /** The prior inventory, unchanged (undefined if none existed). */
      inventory: FridgeInventory | undefined;
    };

/**
 * Replace the Household's Fridge_Inventory with the recorded items.
 *
 * On success the new inventory contains only the valid recorded items; the
 * previous inventory's items are discarded (4.3, 4.6). If the recording has
 * zero valid items it is rejected and the prior inventory is returned
 * unchanged (4.4). Never mutates its inputs.
 */
export function replaceFridgeInventory(
  householdId: HouseholdId,
  prior: FridgeInventory | undefined,
  recording: readonly unknown[],
  now: IsoTimestamp,
): FridgeReplaceResult {
  const items: Ingredient[] = [];
  const droppedIndexes: number[] = [];
  recording.forEach((item, index) => {
    if (isValidFridgeItem(item)) {
      items.push({ name: item.name, quantity: item.quantity, unit: item.unit });
    } else {
      droppedIndexes.push(index);
    }
  });

  if (items.length === 0) {
    return {
      ok: false,
      error: {
        code: 'no_valid_items',
        message: 'The fridge recording contains no valid items; the existing inventory was kept.',
      },
      inventory: prior,
    };
  }

  return { ok: true, inventory: { householdId, items, updatedAt: now }, droppedIndexes };
}

/** True iff any of the Meal's ingredient names matches a fridge item name (normalized). */
export function mealUsesFridgeItem(meal: Pick<Meal, 'ingredients'>, fridgeItems: readonly Pick<Ingredient, 'name'>[]): boolean {
  const names = new Set(fridgeItems.map((i) => normalizeIngredientName(i.name)));
  return meal.ingredients.some((ing) => names.has(normalizeIngredientName(ing.name)));
}

/**
 * Stable partition: Meals using at least one fridge item come first, then
 * Meals using none; relative order within each group is preserved (4.5).
 * Returns a new array.
 */
export function rankMealsByFridgeUsage<M extends Pick<Meal, 'ingredients'>>(
  meals: readonly M[],
  fridgeItems: readonly Pick<Ingredient, 'name'>[],
): M[] {
  const using: M[] = [];
  const notUsing: M[] = [];
  for (const meal of meals) {
    (mealUsesFridgeItem(meal, fridgeItems) ? using : notUsing).push(meal);
  }
  return [...using, ...notUsing];
}
