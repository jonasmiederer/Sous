import { beforeEach, describe, expect, it } from 'vitest';
import { ConditionFailedError } from '../../data/errors.js';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { Meal, MealPlan } from '../../domain/types.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { mealAttributes, planAttributes } from '../plans/records.js';
import { MEAL_PLAN_CHANGED_DETAIL_TYPE, MEAL_PLAN_CHANGED_SOURCE, type MealPlanChangedEvent } from '../plans/events.js';
import {
  createGroceryHandlers,
  createMealPlanChangedConsumer,
  groceryServiceFactory,
  GroceryRegenerationRetryableError,
  type ConsumerLogger,
} from './index.js';

const HH = 'hh-1';
const OTHER_HH = 'hh-2';
const NOW = new Date('2025-01-06T12:00:00.000Z');
const TS = '2025-01-01T00:00:00.000Z';
const scope = { userId: 'u-1', householdId: HH, role: 'owner' as const };

const pasta: Meal = {
  mealId: 'm-pasta',
  name: 'Pasta',
  ingredients: [
    { name: 'Tomato', quantity: 3, unit: 'pcs' },
    { name: 'Pasta', quantity: 200, unit: 'g' },
  ],
  steps: ['Cook'],
  attributes: [],
};
const salad: Meal = {
  mealId: 'm-salad',
  name: 'Salad',
  ingredients: [
    { name: 'tomato', quantity: 2, unit: 'pcs' },
    { name: 'Lettuce', quantity: 1, unit: 'head' },
  ],
  steps: ['Mix'],
  attributes: [],
};
const soup: Meal = {
  mealId: 'm-soup',
  name: 'Soup',
  ingredients: [{ name: 'Carrot', quantity: 4, unit: 'pcs' }],
  steps: ['Boil'],
  attributes: [],
};

const plan: MealPlan = {
  planId: 'p-1',
  householdId: HH,
  startDate: '2025-01-06',
  endDate: '2025-01-07',
  rangeDays: 2,
  days: [
    { day: '2025-01-06', mealId: pasta.mealId },
    { day: '2025-01-07', mealId: salad.mealId },
  ],
};

const silentLogger: ConsumerLogger = { info: () => {}, warn: () => {}, error: () => {} };

function event(detail: Partial<MealPlanChangedEvent> = {}) {
  return {
    source: MEAL_PLAN_CHANGED_SOURCE,
    'detail-type': MEAL_PLAN_CHANGED_DETAIL_TYPE,
    detail: {
      type: 'MealPlanChanged',
      householdId: HH,
      planId: plan.planId,
      change: 'day_replaced',
      day: '2025-01-07',
      mealId: soup.mealId,
      planVersion: 2,
      occurredAt: TS,
      ...detail,
    },
  };
}

describe('Grocery Service', () => {
  let table: InMemoryTableClient;
  let repo: HouseholdRepository;
  let handlers: ReturnType<typeof createGroceryHandlers>;
  let consume: ReturnType<typeof createMealPlanChangedConsumer>;

  beforeEach(async () => {
    table = new InMemoryTableClient();
    repo = new HouseholdRepository(table, HH);
    for (const meal of [pasta, salad, soup]) {
      expect((await repo.create(sortKeys.meal(meal.mealId), mealAttributes(meal, plan.planId, TS))).ok).toBe(true);
    }
    expect((await repo.create(sortKeys.plan(plan.planId), planAttributes(plan, TS, TS))).ok).toBe(true);
    expect(
      (await repo.upsert(sortKeys.fridge(), { items: [{ name: 'tomato', quantity: 1, unit: 'pcs' }], updatedAt: TS }))
        .ok,
    ).toBe(true);
    const factory = groceryServiceFactory({ tableClient: table, clock: { now: () => NOW } });
    handlers = createGroceryHandlers(factory);
    consume = createMealPlanChangedConsumer(factory, silentLogger);
  });

  const generate = (id: string | undefined = plan.planId, s = scope) =>
    handlers.generateGroceryList({ scope: s, pathParameters: { id } });

  async function replaceSecondDayWithSoup(): Promise<void> {
    const stored = await repo.get(sortKeys.plan(plan.planId));
    const updated: MealPlan = { ...plan, days: [plan.days[0]!, { day: '2025-01-07', mealId: soup.mealId }] };
    expect((await repo.replaceIfVersion(sortKeys.plan(plan.planId), stored!.version, planAttributes(updated, TS, TS))).ok).toBe(
      true,
    );
  }

  describe('POST /plans/{id}/grocery-list', () => {
    it('creates a consolidated list with fridge subtraction, associated with plan and Household', async () => {
      const res = await generate();
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.version).toBe(1);
      expect(body.groceryList).toEqual({
        householdId: HH,
        planId: plan.planId,
        generatedAt: NOW.toISOString(),
        entries: expect.arrayContaining([
          { name: 'tomato', quantity: 4, unit: 'piece' }, // 3 + 2 - 1 in fridge
          { name: 'pasta', quantity: 200, unit: 'g' },
          { name: 'lettuce', quantity: 1, unit: 'head' },
        ]),
      });
      expect(body.groceryList.entries).toHaveLength(3);

      const stored = await repo.get(sortKeys.grocery(plan.planId));
      expect(stored?.attributes).toEqual({ ...body.groceryList, sourcePlanVersion: 1 });
    });

    it('replaces an existing list using its stored version', async () => {
      await generate();
      await replaceSecondDayWithSoup();
      const res = await generate();
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.version).toBe(2);
      expect(body.groceryList.entries.map((e: { name: string }) => e.name).sort()).toEqual(['carrot', 'pasta', 'tomato']);
      expect((await repo.get(sortKeys.grocery(plan.planId)))?.attributes.sourcePlanVersion).toBe(2);
    });

    it('returns 404 for a missing plan and for another Household’s plan', async () => {
      expect((await generate('nope')).statusCode).toBe(404);
      expect((await generate(plan.planId, { ...scope, householdId: OTHER_HH })).statusCode).toBe(404);
      expect(table.dump().some((i) => String(i.SK).startsWith('GROCERY#'))).toBe(false);
    });

    it('returns 400 for an invalid plan id', async () => {
      expect((await generate('bad#id')).statusCode).toBe(400);
      expect((await handlers.generateGroceryList({ scope, pathParameters: {} })).statusCode).toBe(400);
    });

    it('returns 422 and writes nothing when the plan references a missing Meal', async () => {
      const broken: MealPlan = { ...plan, planId: 'p-broken', days: [{ day: '2025-01-06', mealId: 'm-gone' }] };
      await repo.create(sortKeys.plan(broken.planId), planAttributes(broken, TS, TS));
      const res = await generate(broken.planId);
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body).error.code).toBe('PLAN_INCONSISTENT');
      expect(await repo.get(sortKeys.grocery(broken.planId))).toBeUndefined();
    });

    it('retries after losing a concurrent-write race', async () => {
      table.failNext('put', new ConditionFailedError());
      const res = await generate();
      expect(res.statusCode).toBe(201);
      expect(await repo.get(sortKeys.grocery(plan.planId))).toBeDefined();
    });

    it('returns 503 on a storage write failure and leaves the prior list unchanged', async () => {
      await generate();
      const before = await repo.get(sortKeys.grocery(plan.planId));
      await replaceSecondDayWithSoup();
      table.failNext('put');
      const res = await generate();
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error.code).toBe('SAVE_DID_NOT_COMPLETE');
      expect(await repo.get(sortKeys.grocery(plan.planId))).toEqual(before);
    });

    it('returns 500 without details on a storage read failure', async () => {
      table.failNext('get');
      const res = await generate();
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('MealPlanChanged consumer', () => {
    it('skips plans that have no Grocery_List yet', async () => {
      await replaceSecondDayWithSoup();
      expect(await consume(event())).toEqual({ status: 'skipped', reason: 'no_grocery_list' });
      expect(await repo.get(sortKeys.grocery(plan.planId))).toBeUndefined();
    });

    it('regenerates an existing list from the current stored plan', async () => {
      await generate();
      await replaceSecondDayWithSoup();
      // Event body names a different meal; the consumer must use the stored plan.
      const result = await consume(event({ mealId: 'm-ignored' }));
      expect(result.status).toBe('regenerated');
      const stored = await repo.get(sortKeys.grocery(plan.planId));
      expect(stored?.attributes.sourcePlanVersion).toBe(2);
      expect(stored?.attributes.entries).toEqual(
        expect.arrayContaining([
          { name: 'carrot', quantity: 4, unit: 'piece' },
          { name: 'tomato', quantity: 2, unit: 'piece' },
          { name: 'pasta', quantity: 200, unit: 'g' },
        ]),
      );
      expect(stored?.attributes.entries).toHaveLength(3);

      // Regenerated list equals fresh generation on the changed plan.
      const fresh = JSON.parse((await generate()).body).groceryList;
      expect(stored?.attributes.entries).toEqual(fresh.entries);
    });

    it('drops stale and duplicate events by planVersion', async () => {
      await generate();
      await replaceSecondDayWithSoup();
      await consume(event({ planVersion: 2 }));
      const before = await repo.get(sortKeys.grocery(plan.planId));
      expect(await consume(event({ planVersion: 2 }))).toEqual({ status: 'skipped', reason: 'stale_event' });
      expect(await consume(event({ planVersion: 1 }))).toEqual({ status: 'skipped', reason: 'stale_event' });
      expect(await repo.get(sortKeys.grocery(plan.planId))).toEqual(before);
    });

    it('binds to the event Household and never touches another partition', async () => {
      await generate();
      await replaceSecondDayWithSoup();
      expect(await consume(event({ householdId: OTHER_HH }))).toEqual({ status: 'skipped', reason: 'plan_not_found' });
      expect((await repo.get(sortKeys.grocery(plan.planId)))?.attributes.sourcePlanVersion).toBe(1);
    });

    it('ignores malformed events without retrying', async () => {
      const bad = [
        { ...event(), source: 'other' },
        { ...event(), 'detail-type': 'Other' },
        { ...event(), detail: 'x' },
        event({ householdId: 'a#b' }),
        event({ planId: '' }),
        event({ planVersion: 0 }),
        event({ change: 'nope' as MealPlanChangedEvent['change'] }),
      ];
      for (const e of bad) {
        expect((await consume(e)).status).toBe('ignored');
      }
    });

    it('throws on transient storage failures so the event is retried', async () => {
      await generate();
      await replaceSecondDayWithSoup();
      table.failNext('get');
      await expect(consume(event())).rejects.toThrow();
      table.failNext('put');
      await expect(consume(event())).rejects.toBeInstanceOf(GroceryRegenerationRetryableError);
      expect((await repo.get(sortKeys.grocery(plan.planId)))?.attributes.sourcePlanVersion).toBe(1);
      // The retry succeeds.
      expect((await consume(event())).status).toBe('regenerated');
    });

    it('throws when the plan read is older than the event (retryable)', async () => {
      await generate();
      await expect(consume(event({ planVersion: 5 }))).rejects.toThrow(/older than event/);
    });
  });
});
