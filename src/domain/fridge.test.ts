import { describe, expect, it } from 'vitest';
import { isValidFridgeItem, mealUsesFridgeItem, rankMealsByFridgeUsage, replaceFridgeInventory } from './fridge.js';
import type { FridgeInventory, Meal } from './types.js';

const NOW = '2025-01-31T12:00:00.000Z';
const prior: FridgeInventory = {
  householdId: 'h1',
  items: [{ name: 'milk', quantity: 1, unit: 'l' }],
  updatedAt: '2025-01-01T00:00:00.000Z',
};

function meal(mealId: string, ...ingredientNames: string[]): Meal {
  return {
    mealId,
    name: mealId,
    ingredients: ingredientNames.map((name) => ({ name, quantity: 1, unit: 'g' })),
    steps: ['cook'],
    attributes: [],
  };
}

describe('isValidFridgeItem', () => {
  it('accepts a named item with positive finite quantity', () => {
    expect(isValidFridgeItem({ name: 'Eggs', quantity: 6, unit: '' })).toBe(true);
  });
  it.each([
    [{ name: '   ', quantity: 1, unit: 'g' }],
    [{ name: 'eggs', quantity: 0, unit: 'g' }],
    [{ name: 'eggs', quantity: -1, unit: 'g' }],
    [{ name: 'eggs', quantity: Number.NaN, unit: 'g' }],
    [{ name: 'eggs', quantity: Infinity, unit: 'g' }],
    [{ name: 'eggs', quantity: 1 }],
    [null],
    ['eggs'],
  ])('rejects %j', (item) => {
    expect(isValidFridgeItem(item)).toBe(false);
  });
});

describe('replaceFridgeInventory', () => {
  it('replaces the prior inventory exactly with the recorded items', () => {
    const items = [
      { name: 'eggs', quantity: 6, unit: 'piece' },
      { name: 'butter', quantity: 250, unit: 'g' },
    ];
    const result = replaceFridgeInventory('h1', prior, items, NOW);
    expect(result).toEqual({
      ok: true,
      inventory: { householdId: 'h1', items, updatedAt: NOW },
      droppedIndexes: [],
    });
  });

  it('drops invalid items but keeps the valid ones', () => {
    const result = replaceFridgeInventory('h1', prior, [{ name: '', quantity: 1, unit: 'g' }, { name: 'eggs', quantity: 2, unit: '' }], NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.inventory.items).toEqual([{ name: 'eggs', quantity: 2, unit: '' }]);
      expect(result.droppedIndexes).toEqual([0]);
    }
  });

  it('rejects an empty recording and returns the prior inventory unchanged', () => {
    const snapshot = structuredClone(prior);
    const result = replaceFridgeInventory('h1', prior, [], NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('no_valid_items');
      expect(result.inventory).toBe(prior);
    }
    expect(prior).toEqual(snapshot);
  });

  it('rejects a recording with only invalid items, with or without a prior inventory', () => {
    const bad = [{ name: 'eggs', quantity: 0, unit: 'g' }];
    expect(replaceFridgeInventory('h1', prior, bad, NOW)).toMatchObject({ ok: false, inventory: prior });
    expect(replaceFridgeInventory('h1', undefined, bad, NOW)).toMatchObject({ ok: false, inventory: undefined });
  });
});

describe('rankMealsByFridgeUsage', () => {
  const fridge = [{ name: '  Spinach ' }, { name: 'eggs' }];

  it('matches ingredient names case- and whitespace-insensitively', () => {
    expect(mealUsesFridgeItem(meal('a', 'SPINACH'), fridge)).toBe(true);
    expect(mealUsesFridgeItem(meal('b', 'rice'), fridge)).toBe(false);
  });

  it('places fridge-using Meals first, preserving relative order in each group', () => {
    const meals = [meal('n1', 'rice'), meal('f1', 'eggs'), meal('n2', 'beef'), meal('f2', 'flour', 'spinach'), meal('n3')];
    expect(rankMealsByFridgeUsage(meals, fridge).map((m) => m.mealId)).toEqual(['f1', 'f2', 'n1', 'n2', 'n3']);
    expect(meals.map((m) => m.mealId)).toEqual(['n1', 'f1', 'n2', 'f2', 'n3']);
  });

  it('keeps the original order when the fridge is empty', () => {
    const meals = [meal('a', 'eggs'), meal('b', 'rice')];
    expect(rankMealsByFridgeUsage(meals, []).map((m) => m.mealId)).toEqual(['a', 'b']);
  });
});
