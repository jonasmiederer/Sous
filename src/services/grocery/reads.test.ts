import { beforeEach, describe, expect, it } from 'vitest';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { Meal, MealPlan } from '../../domain/types.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { mealAttributes, planAttributes } from '../plans/records.js';
import { createGroceryHandlers, groceryServiceFactory } from './index.js';

const HH = 'hh-1';
const TS = '2025-01-01T00:00:00.000Z';
const NOW = new Date('2025-01-06T12:00:00.000Z');
const scope = { userId: 'u-1', householdId: HH, role: 'owner' as const };

const meal: Meal = {
  mealId: 'm-1',
  name: 'Pasta',
  ingredients: [{ name: 'Pasta', quantity: 200, unit: 'g' }],
  steps: ['Cook'],
  attributes: [],
};
const plan: MealPlan = {
  planId: 'p-1',
  householdId: HH,
  startDate: '2025-01-06',
  endDate: '2025-01-06',
  rangeDays: 1,
  days: [{ day: '2025-01-06', mealId: meal.mealId }],
};

describe('GET /plans/{id}/grocery-list', () => {
  let handlers: ReturnType<typeof createGroceryHandlers>;
  const get = (id: string | undefined, s: { userId: string; householdId: string; role: 'owner' | 'member' } = scope) =>
    handlers.getGroceryList({ scope: s, pathParameters: { id } });

  beforeEach(async () => {
    const table = new InMemoryTableClient();
    const repo = new HouseholdRepository(table, HH);
    await repo.create(sortKeys.meal(meal.mealId), mealAttributes(meal, plan.planId, TS));
    await repo.create(sortKeys.plan(plan.planId), planAttributes(plan, TS, TS));
    handlers = createGroceryHandlers(groceryServiceFactory({ tableClient: table, clock: { now: () => NOW } }));
  });

  it('returns 404 GROCERY_LIST_NOT_FOUND before a list is generated, and does not create one', async () => {
    const res = await get(plan.planId);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('GROCERY_LIST_NOT_FOUND');
    expect((await get(plan.planId)).statusCode).toBe(404);
  });

  it('returns the stored list with version and sourcePlanVersion', async () => {
    const generated = JSON.parse((await handlers.generateGroceryList({ scope, pathParameters: { id: plan.planId } })).body);
    const res = await get(plan.planId);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      groceryList: generated.groceryList,
      version: 1,
      sourcePlanVersion: 1,
    });
  });

  it('is scoped to the Active_Household', async () => {
    await handlers.generateGroceryList({ scope, pathParameters: { id: plan.planId } });
    const res = await get(plan.planId, { userId: 'u-2', householdId: 'hh-2', role: 'owner' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('GROCERY_LIST_NOT_FOUND');
  });

  it('rejects an invalid plan id with 400', async () => {
    expect((await get('bad#id')).statusCode).toBe(400);
    expect((await get(undefined)).statusCode).toBe(400);
  });
});
