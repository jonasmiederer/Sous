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

describe('PUT /plans/{id}/grocery-list', () => {
  let handlers: ReturnType<typeof createGroceryHandlers>;
  const put = (id: string | undefined, body: unknown) =>
    handlers.updateGroceryList({ scope, pathParameters: { id }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const get = () => handlers.getGroceryList({ scope, pathParameters: { id: plan.planId } });

  beforeEach(async () => {
    const table = new InMemoryTableClient();
    const repo = new HouseholdRepository(table, HH);
    await repo.create(sortKeys.meal(meal.mealId), mealAttributes(meal, plan.planId, TS));
    await repo.create(sortKeys.plan(plan.planId), planAttributes(plan, TS, TS));
    handlers = createGroceryHandlers(groceryServiceFactory({ tableClient: table, clock: { now: () => NOW } }));
  });

  it('returns 404 when no list exists yet', async () => {
    const res = await put(plan.planId, { entries: [] });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('GROCERY_LIST_NOT_FOUND');
  });

  it('replaces the entries, keeps generatedAt and sourcePlanVersion, and bumps the version', async () => {
    const generated = JSON.parse((await handlers.generateGroceryList({ scope, pathParameters: { id: plan.planId } })).body);
    const res = await put(plan.planId, {
      entries: [
        { name: '  Pasta  ', quantity: 300, unit: 'grams' },
        { name: 'Basil', quantity: 1, unit: 'bunch' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe(2);
    expect(body.groceryList.generatedAt).toBe(generated.groceryList.generatedAt);
    expect(body.groceryList.entries).toEqual([
      { name: 'Pasta', quantity: 300, unit: 'g' },
      { name: 'Basil', quantity: 1, unit: 'bunch' },
    ]);
    expect(JSON.parse((await get()).body)).toEqual({ ...body, sourcePlanVersion: 1 });
  });

  it('allows removing every entry', async () => {
    await handlers.generateGroceryList({ scope, pathParameters: { id: plan.planId } });
    expect((await put(plan.planId, { entries: [] })).statusCode).toBe(200);
    expect(JSON.parse((await get()).body).groceryList.entries).toEqual([]);
  });

  it.each([
    [{}],
    [{ entries: 'x' }],
    [{ entries: [{ name: ' ', quantity: 1, unit: 'g' }] }],
    [{ entries: [{ name: 'Salt', quantity: 0, unit: 'g' }] }],
    [{ entries: [{ name: 'Salt', quantity: '1', unit: 'g' }] }],
    ['not json'],
  ])('rejects invalid input %j with 400 and writes nothing', async (body) => {
    const generated = JSON.parse((await handlers.generateGroceryList({ scope, pathParameters: { id: plan.planId } })).body);
    const res = await put(plan.planId, body);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse((await get()).body).groceryList.entries).toEqual(generated.groceryList.entries);
  });

  it('rejects an invalid plan id', async () => {
    expect((await put('bad#id', { entries: [] })).statusCode).toBe(400);
  });
});

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
