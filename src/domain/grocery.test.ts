import { describe, expect, it } from 'vitest';
import { buildGroceryList, consolidateIngredients, subtractFridge } from './grocery.js';
import type { FridgeInventory, Ingredient, Meal, MealPlan } from './types.js';

const NOW = '2025-01-31T12:00:00.000Z';

function meal(mealId: string, ingredients: Ingredient[]): Meal {
  return { mealId, name: mealId, ingredients, steps: ['cook'], attributes: [] };
}

function plan(mealIds: string[], householdId = 'hh-1'): MealPlan {
  return {
    planId: 'plan-1',
    householdId,
    startDate: '2025-02-01',
    endDate: '2025-02-07',
    rangeDays: mealIds.length,
    days: mealIds.map((mealId, i) => ({ day: `2025-02-0${i + 1}`, mealId })),
  };
}

function fridge(items: Ingredient[], householdId = 'hh-1'): FridgeInventory {
  return { householdId, items, updatedAt: NOW };
}

describe('buildGroceryList', () => {
  it('returns an empty list associated with plan and Household for an empty plan (7.6, 7.7)', () => {
    const result = buildGroceryList({ plan: plan([]), meals: [], generatedAt: NOW });
    expect(result).toEqual({
      ok: true,
      value: { householdId: 'hh-1', planId: 'plan-1', entries: [], generatedAt: NOW },
    });
  });

  it('covers every ingredient and sums compatible occurrences across meals and repeated days (7.1, 7.2)', () => {
    const meals = [
      meal('m1', [
        { name: 'Onion', quantity: 1, unit: '' },
        { name: 'rice', quantity: 200, unit: 'g' },
      ]),
      meal('m2', [
        { name: ' onion ', quantity: 2, unit: 'pieces' },
        { name: 'Rice', quantity: 100, unit: 'grams' },
      ]),
    ];
    const result = buildGroceryList({ plan: plan(['m1', 'm2', 'm1']), meals, generatedAt: NOW });
    expect(result.ok && result.value.entries).toEqual([
      { name: 'onion', quantity: 4, unit: 'piece' },
      { name: 'rice', quantity: 500, unit: 'g' },
    ]);
  });

  it('keeps incompatible units as separate entries (7.3)', () => {
    const meals = [
      meal('m1', [
        { name: 'flour', quantity: 500, unit: 'g' },
        { name: 'flour', quantity: 1, unit: 'kg' },
        { name: 'flour', quantity: 2, unit: 'cup' },
      ]),
    ];
    const result = buildGroceryList({ plan: plan(['m1']), meals, generatedAt: NOW });
    expect(result.ok && result.value.entries).toEqual([
      { name: 'flour', quantity: 2, unit: 'cup' },
      { name: 'flour', quantity: 500, unit: 'g' },
      { name: 'flour', quantity: 1, unit: 'kg' },
    ]);
  });

  it('subtracts matching fridge quantities and omits fully covered items (7.4)', () => {
    const meals = [
      meal('m1', [
        { name: 'milk', quantity: 500, unit: 'ml' },
        { name: 'eggs', quantity: 3, unit: '' },
        { name: 'butter', quantity: 50, unit: 'g' },
      ]),
    ];
    const result = buildGroceryList({
      plan: plan(['m1']),
      meals,
      fridge: fridge([
        { name: 'Milk', quantity: 200, unit: 'milliliters' },
        { name: 'eggs', quantity: 6, unit: 'piece' },
        // Incompatible unit: must not be subtracted from 50 g.
        { name: 'butter', quantity: 1, unit: 'kg' },
      ]),
      generatedAt: NOW,
    });
    expect(result.ok && result.value.entries).toEqual([
      { name: 'butter', quantity: 50, unit: 'g' },
      { name: 'milk', quantity: 300, unit: 'ml' },
    ]);
  });

  it('removes floating-point noise when summing and subtracting', () => {
    const meals = [
      meal('m1', [
        { name: 'oil', quantity: 0.1, unit: 'l' },
        { name: 'oil', quantity: 0.2, unit: 'l' },
        { name: 'salt', quantity: 0.1, unit: 'tsp' },
        { name: 'salt', quantity: 0.2, unit: 'tsp' },
      ]),
    ];
    const result = buildGroceryList({
      plan: plan(['m1']),
      meals,
      fridge: fridge([{ name: 'salt', quantity: 0.3, unit: 'tsp' }]),
      generatedAt: NOW,
    });
    expect(result.ok && result.value.entries).toEqual([{ name: 'oil', quantity: 0.3, unit: 'l' }]);
  });

  it('is independent of meal and ingredient order', () => {
    const a = meal('a', [
      { name: 'Tomato', quantity: 2, unit: '' },
      { name: 'basil', quantity: 1, unit: 'bunch' },
    ]);
    const b = meal('b', [
      { name: 'garlic', quantity: 3, unit: 'cloves' },
      { name: 'tomato', quantity: 1, unit: 'piece' },
    ]);
    const first = buildGroceryList({ plan: plan(['a', 'b']), meals: [a, b], generatedAt: NOW });
    const second = buildGroceryList({
      plan: plan(['b', 'a']),
      meals: [b, { ...a, ingredients: [...a.ingredients].reverse() }],
      generatedAt: NOW,
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.entries).toEqual(first.value.entries);
  });

  it('returns MISSING_MEAL listing every unresolved mealId', () => {
    const result = buildGroceryList({
      plan: plan(['m1', 'x', 'y', 'x']),
      meals: [meal('m1', [{ name: 'rice', quantity: 1, unit: 'cup' }])],
      generatedAt: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('MISSING_MEAL');
      expect(result.error.missingMealIds).toEqual(['x', 'y']);
    }
  });

  it('rejects negative or non-finite ingredient quantities', () => {
    for (const quantity of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = buildGroceryList({
        plan: plan(['m1']),
        meals: [meal('m1', [{ name: 'rice', quantity, unit: 'g' }])],
        generatedAt: NOW,
      });
      expect(!result.ok && result.error.code).toBe('INVALID_QUANTITY');
    }
  });

  it('rejects a fridge inventory from another Household', () => {
    const result = buildGroceryList({
      plan: plan(['m1']),
      meals: [meal('m1', [{ name: 'rice', quantity: 1, unit: 'g' }])],
      fridge: fridge([], 'hh-other'),
      generatedAt: NOW,
    });
    expect(!result.ok && result.error.code).toBe('HOUSEHOLD_MISMATCH');
  });
});

describe('consolidateIngredients / subtractFridge', () => {
  it('ignores non-positive or non-finite fridge quantities', () => {
    const entries = consolidateIngredients([{ name: 'rice', quantity: 100, unit: 'g' }]);
    expect(
      subtractFridge(entries, [
        { name: 'rice', quantity: -50, unit: 'g' },
        { name: 'rice', quantity: Number.NaN, unit: 'g' },
      ]),
    ).toEqual([{ name: 'rice', quantity: 100, unit: 'g' }]);
  });
});
