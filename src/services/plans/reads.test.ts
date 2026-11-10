import { beforeEach, describe, expect, it } from 'vitest';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { Meal, MealPlan } from '../../domain/types.js';
import { FakeSuggestionAgentClient } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { createPlanHandlers, planServiceFactory } from './handlers.js';
import { MAX_LISTED_PLANS } from './planService.js';
import { mealAttributes, planAttributes } from './records.js';
import { InMemoryPlanEventPublisher } from './testing/inMemoryPlanEventPublisher.js';

const scope: ActiveHouseholdScope = { userId: 'u1', householdId: 'hh1', role: 'owner' };
const other: ActiveHouseholdScope = { userId: 'u2', householdId: 'hh2', role: 'owner' };
const parse = (body: string) => JSON.parse(body) as Record<string, any>;

function planFor(householdId: string, planId: string, mealIds: string[]): MealPlan {
  const days = mealIds.map((mealId, i) => ({ day: `2025-03-${String(i + 1).padStart(2, '0')}`, mealId }));
  return {
    planId,
    householdId,
    startDate: days[0]!.day,
    endDate: days[days.length - 1]!.day,
    rangeDays: days.length,
    days,
  };
}

const meal = (mealId: string, name: string): Meal => ({
  mealId,
  name,
  ingredients: [{ name: 'rice', quantity: 100, unit: 'g' }],
  steps: ['Cook'],
  attributes: [],
});

let table: InMemoryTableClient;
let handlers: ReturnType<typeof createPlanHandlers>;

beforeEach(() => {
  table = new InMemoryTableClient();
  handlers = createPlanHandlers(
    planServiceFactory({
      tableClient: table,
      agent: new FakeSuggestionAgentClient(),
      events: new InMemoryPlanEventPublisher(),
      clock: { now: () => new Date('2025-03-03T00:00:00Z') },
      ids: { next: () => 'unused' },
    }),
  );
});

async function storePlan(householdId: string, plan: MealPlan, createdAt: string, meals: Meal[] = []): Promise<void> {
  const repo = new HouseholdRepository(table, householdId);
  for (const m of meals) expect((await repo.create(sortKeys.meal(m.mealId), mealAttributes(m, plan.planId, createdAt))).ok).toBe(true);
  expect((await repo.create(sortKeys.plan(plan.planId), planAttributes(plan, createdAt, createdAt))).ok).toBe(true);
}

describe('GET /plans', () => {
  it('returns an empty list when the Household has no plans', async () => {
    const res = await handlers.listPlans({ scope });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual({ plans: [] });
  });

  it('returns summaries newest first, capped at 20, from the Active_Household only', async () => {
    for (let i = 0; i < 25; i++) {
      const createdAt = new Date(Date.UTC(2025, 0, 1 + i)).toISOString();
      await storePlan('hh1', planFor('hh1', `p${String(i).padStart(2, '0')}`, ['m1']), createdAt);
    }
    await storePlan('hh2', planFor('hh2', 'foreign', ['m1']), '2030-01-01T00:00:00.000Z');

    const res = await handlers.listPlans({ scope });
    expect(res.statusCode).toBe(200);
    const { plans } = parse(res.body);
    expect(plans).toHaveLength(MAX_LISTED_PLANS);
    expect(plans[0]).toEqual({ planId: 'p24', startDate: '2025-03-01', endDate: '2025-03-01', rangeDays: 1 });
    expect(plans.map((p: { planId: string }) => p.planId)).toEqual(
      Array.from({ length: 20 }, (_, k) => `p${String(24 - k).padStart(2, '0')}`),
    );
    expect(plans.some((p: { planId: string }) => p.planId === 'foreign')).toBe(false);
  });
});

describe('GET /plans/{id}', () => {
  it('returns the plan, its Meals in day order, and the version', async () => {
    const meals = [meal('m-b', 'Bowl'), meal('m-a', 'Curry')];
    await storePlan('hh1', planFor('hh1', 'p1', ['m-b', 'm-a', 'm-b']), '2025-03-01T00:00:00.000Z', meals);

    const res = await handlers.getPlan({ scope, pathParameters: { id: 'p1' } });
    expect(res.statusCode).toBe(200);
    const body = parse(res.body);
    expect(body.version).toBe(1);
    expect(body.plan).toEqual(planFor('hh1', 'p1', ['m-b', 'm-a', 'm-b']));
    expect(body.meals).toEqual(meals);
  });

  it('returns 404 PLAN_NOT_FOUND for an unknown plan or another Household’s plan', async () => {
    await storePlan('hh2', planFor('hh2', 'p-foreign', ['m1']), '2025-03-01T00:00:00.000Z', [meal('m1', 'X')]);
    for (const id of ['missing', 'p-foreign']) {
      const res = await handlers.getPlan({ scope, pathParameters: { id } });
      expect(res.statusCode).toBe(404);
      expect(parse(res.body).error.code).toBe('PLAN_NOT_FOUND');
    }
    expect((await handlers.getPlan({ scope: other, pathParameters: { id: 'p-foreign' } })).statusCode).toBe(200);
  });

  it('rejects an invalid plan id with 400', async () => {
    const res = await handlers.getPlan({ scope, pathParameters: { id: 'a#b' } });
    expect(res.statusCode).toBe(400);
    expect(parse(res.body).error.code).toBe('INVALID_REQUEST');
  });
});
