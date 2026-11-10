import { beforeEach, describe, expect, it } from 'vitest';

import type { PlanPayload } from '../../agent/payload.js';
import type { AgentMeal } from '../../agent/responses.js';
import { PLAN_DEADLINE_MS } from '../../agent/runtimeClient.js';
import { ConditionFailedError } from '../../data/errors.js';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import { FakeSuggestionAgentClient } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryMemoryClient } from '../../../test/fakes/inMemoryMemoryClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { PlanService, type PlanServiceDeps } from './planService.js';
import { InMemoryPlanEventPublisher } from './testing/inMemoryPlanEventPublisher.js';

const HH = 'hh1';
const NOW = new Date('2025-03-03T10:00:00.000Z');

const meal = (name: string, ingredient = 'rice'): AgentMeal => ({
  name,
  ingredients: [{ name: ingredient, quantity: 1, unit: 'cup' }],
  steps: ['Cook.'],
  attributes: [],
});

const mealsFor = (p: PlanPayload, prefix = 'Meal') =>
  Array.from({ length: p.rangeDays }, (_, i) => meal(`${prefix} ${i + 1}`));

let table: InMemoryTableClient;
let repo: HouseholdRepository;
let agent: FakeSuggestionAgentClient;
let events: InMemoryPlanEventPublisher;
let counter: number;

function service(overrides: Partial<PlanServiceDeps> = {}): PlanService {
  return new PlanService({
    repository: repo,
    agent,
    events,
    memory: new InMemoryMemoryClient(),
    clock: { now: () => NOW },
    ids: { next: () => `id${++counter}` },
    ...overrides,
  });
}

async function seedProfile(excludedIngredients: string[] = [], dietaryConstraints: string[] = []) {
  await repo.upsert(sortKeys.preferenceProfile(), {
    householdId: HH,
    likes: ['pasta'],
    dislikes: [],
    excludedIngredients,
    dietaryConstraints,
    acceptances: [],
    updatedAt: NOW.toISOString(),
  });
}

/** Items other than the preference profile and fridge. */
const planItems = () => table.dump().filter((i) => i.SK.startsWith('PLAN#') || i.SK.startsWith('MEAL#'));

beforeEach(() => {
  table = new InMemoryTableClient();
  repo = new HouseholdRepository(table, HH);
  agent = new FakeSuggestionAgentClient();
  events = new InMemoryPlanEventPublisher();
  counter = 0;
});

describe('generatePlan', () => {
  it('generates and persists a weekly plan with one Meal per consecutive day', async () => {
    await seedProfile(['coconut']);
    const result = await service().generatePlan({ weekly: true, startDate: '2025-03-10' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { plan, meals } = result.value;
    expect(plan.householdId).toBe(HH);
    expect(plan.rangeDays).toBe(7);
    expect(plan.startDate).toBe('2025-03-10');
    expect(plan.endDate).toBe('2025-03-16');
    expect(plan.days.map((d) => d.day)).toEqual([
      '2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15', '2025-03-16',
    ]);
    expect(plan.days.map((d) => d.mealId)).toEqual(meals.map((m) => m.mealId));

    const payload = agent.lastPayload as PlanPayload;
    expect(payload.mode).toBe('plan');
    expect(payload.rangeDays).toBe(7);
    expect(payload.preferenceProfile?.excludedIngredients).toEqual(['coconut']);
    expect(agent.calls[0]?.effectiveTimeoutMs).toBeLessThanOrEqual(PLAN_DEADLINE_MS);

    const stored = await repo.get(sortKeys.plan(plan.planId));
    expect(stored?.attributes.days).toEqual(plan.days);
    for (const m of meals) expect((await repo.get(sortKeys.meal(m.mealId)))?.attributes.name).toBe(m.name);
    expect(planItems().every((i) => i.PK === `HH#${HH}`)).toBe(true);
  });

  it('accepts custom ranges of 1 and 31 days and defaults startDate to today', async () => {
    await seedProfile();
    const one = await service().generatePlan({ rangeDays: 1 });
    const max = await service().generatePlan({ rangeDays: 31 });
    expect(one.ok && one.value.plan.days).toEqual([{ day: '2025-03-03', mealId: expect.any(String) }]);
    expect(max.ok && max.value.plan.days.length).toBe(31);
  });

  it.each([0, 32, -1, 2.5, '7', undefined])('rejects rangeDays %s with the 1-31 error and stores nothing', async (rangeDays) => {
    await seedProfile();
    const result = await service().generatePlan({ rangeDays });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_RANGE', message: expect.stringContaining('1 and 31') } });
    expect(agent.calls).toHaveLength(0);
    expect(planItems()).toHaveLength(0);
  });

  it('generates a plan without a Preference_Profile, sending a null profile to the agent', async () => {
    const result = await service().generatePlan({ weekly: true });
    expect(result.ok && result.value.plan.days.length).toBe(7);
    expect(agent.calls).toHaveLength(1);
    expect(agent.lastPayload?.preferenceProfile).toBeNull();
  });

  it('rejects over-length context input before invoking the agent', async () => {
    await seedProfile();
    const result = await service().generatePlan({ rangeDays: 3, contextInput: 'x'.repeat(501) });
    expect(!result.ok && result.error.code).toBe('CONTEXT_TOO_LONG');
    expect(agent.calls).toHaveLength(0);
  });

  it('re-requests once when the agent returns the wrong number of Meals', async () => {
    await seedProfile();
    let calls = 0;
    agent.setHandlers({ plan: (p) => ({ mode: 'plan', meals: ++calls === 1 ? [meal('Only one')] : mealsFor(p) }) });
    const result = await service().generatePlan({ rangeDays: 3 });
    expect(result.ok && result.value.plan.days.length).toBe(3);
    expect(agent.calls).toHaveLength(2);
  });

  it('fails and stores nothing when every attempt contains an excluded Meal', async () => {
    await seedProfile(['coconut']);
    agent.setHandlers({
      plan: (p) => ({ mode: 'plan', meals: [...mealsFor(p).slice(1), meal('Curry', 'coconut milk')] }),
    });
    const result = await service().generatePlan({ rangeDays: 4 });
    expect(!result.ok && result.error.code).toBe('GENERATION_FAILED');
    expect(agent.calls).toHaveLength(2);
    expect(planItems()).toHaveLength(0);
  });

  it('enforces dietary constraints on agent Meals', async () => {
    await seedProfile([], ['vegetarian']);
    agent.setHandlers({ plan: (p) => ({ mode: 'plan', meals: [meal('Steak', 'beef'), ...mealsFor(p).slice(1)] }) });
    const result = await service({ maxGenerationAttempts: 1 }).generatePlan({ rangeDays: 2 });
    expect(!result.ok && result.error.code).toBe('GENERATION_FAILED');
    expect(planItems()).toHaveLength(0);
  });

  it('returns a timeout error and stores nothing when the agent times out', async () => {
    await seedProfile();
    agent.failWith({ kind: 'timeout', timeoutMs: PLAN_DEADLINE_MS, message: 'late' });
    const result = await service().generatePlan({ weekly: true });
    expect(!result.ok && result.error.code).toBe('GENERATION_TIMEOUT');
    expect(agent.calls).toHaveLength(1);
    expect(planItems()).toHaveLength(0);
  });

  it('clamps a looser deadline to the 28s plan deadline', async () => {
    await seedProfile();
    const result = await service({ deadlineMs: 60_000 }).generatePlan({ rangeDays: 2 });
    expect(result.ok).toBe(true);
    expect(agent.calls[0]?.options.timeoutMs).toBeGreaterThan(0);
    expect(agent.calls[0]?.options.timeoutMs).toBeLessThanOrEqual(28_000);
  });

  it('enforces the deadline even if the agent never responds', async () => {
    await seedProfile();
    agent.setHandlers({ plan: () => new Promise(() => undefined) });
    const result = await service({ deadlineMs: 30 }).generatePlan({ rangeDays: 2 });
    expect(!result.ok && result.error.code).toBe('GENERATION_TIMEOUT');
    expect(planItems()).toHaveLength(0);
  });

  it('returns a generation error when the agent invocation fails', async () => {
    await seedProfile();
    agent.failWith({ kind: 'invocation_failed', message: 'boom' });
    const result = await service().generatePlan({ rangeDays: 2 });
    expect(!result.ok && result.error.code).toBe('GENERATION_FAILED');
    expect(agent.calls).toHaveLength(1);
  });

  it('stores nothing when the transaction fails', async () => {
    await seedProfile();
    table.failNext('transactWrite');
    const result = await service().generatePlan({ rangeDays: 5 });
    expect(!result.ok && result.error.code).toBe('SAVE_DID_NOT_COMPLETE');
    expect(planItems()).toHaveLength(0);
  });

  it('still generates when the soft-memory read is degraded', async () => {
    await seedProfile();
    const memory = new InMemoryMemoryClient();
    memory.failNext('readHouseholdPreferences');
    const result = await service({ memory }).generatePlan({ rangeDays: 2 });
    expect(result.ok).toBe(true);
    expect(memory.longTermNamespaces()).toEqual([HH]);
  });
});

describe('day edits', () => {
  async function weeklyPlan() {
    await seedProfile(['coconut']);
    const result = await service().generatePlan({ weekly: true, startDate: '2025-03-10' });
    if (!result.ok) throw new Error('setup failed');
    return result.value.plan;
  }

  it('replaces only the targeted day and emits MealPlanChanged', async () => {
    const plan = await weeklyPlan();
    agent.setHandlers({ plan: (p) => ({ mode: 'plan', meals: mealsFor(p, 'New') }) });

    const result = await service().replaceDay(plan.planId, '2025-03-12', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((agent.lastPayload as PlanPayload).rangeDays).toBe(1);

    const newMealId = result.value.meals[0]?.mealId;
    expect(result.value.plan.days).toEqual(plan.days.map((d) => (d.day === '2025-03-12' ? { ...d, mealId: newMealId } : d)));
    const stored = await repo.get(sortKeys.plan(plan.planId));
    expect(stored?.attributes.days).toEqual(result.value.plan.days);
    expect(stored?.version).toBe(2);
    expect((await repo.get(sortKeys.meal(newMealId as string)))?.attributes.name).toBe('New 1');

    expect(events.events).toEqual([
      expect.objectContaining({
        type: 'MealPlanChanged',
        householdId: HH,
        planId: plan.planId,
        change: 'day_replaced',
        day: '2025-03-12',
        mealId: newMealId,
        planVersion: 2,
      }),
    ]);
    expect(result.value.eventPublished).toBe(true);
  });

  it('replaces a day with a supplied Meal, rejecting one that violates an exclusion', async () => {
    const plan = await weeklyPlan();
    const callsBefore = agent.calls.length;

    const rejected = await service().replaceDay(plan.planId, '2025-03-10', { meal: meal('Curry', 'coconut') });
    expect(!rejected.ok && rejected.error.code).toBe('MEAL_EXCLUDED');
    expect((await repo.get(sortKeys.plan(plan.planId)))?.version).toBe(1);

    const accepted = await service().replaceDay(plan.planId, '2025-03-10', { meal: meal('Risotto') });
    expect(accepted.ok && accepted.value.meals[0]?.name).toBe('Risotto');
    expect(agent.calls.length).toBe(callsBefore);
  });

  it('rejects edits on unknown plans or days', async () => {
    const plan = await weeklyPlan();
    expect(await service().replaceDay('missing', '2025-03-10', {})).toMatchObject({ error: { code: 'PLAN_NOT_FOUND' } });
    expect(await service().replaceDay(plan.planId, '2025-04-01', {})).toMatchObject({ error: { code: 'DAY_NOT_FOUND' } });
    expect(await service().replaceDay(plan.planId, '2025-02-30', {})).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(events.events).toHaveLength(0);
  });

  it('reports a conflict and keeps the plan when the version check fails', async () => {
    const plan = await weeklyPlan();
    table.failNext('transactWrite', new ConditionFailedError());
    const result = await service().replaceDay(plan.planId, '2025-03-10', { meal: meal('Risotto') });
    expect(!result.ok && result.error.code).toBe('PLAN_CONFLICT');
    expect((await repo.get(sortKeys.plan(plan.planId)))?.attributes.days).toEqual(plan.days);
    expect(events.events).toHaveLength(0);
  });

  it('leaves the plan unchanged when agent generation for a day fails', async () => {
    const plan = await weeklyPlan();
    agent.failWith({ kind: 'invocation_failed', message: 'down' });
    const result = await service().replaceDay(plan.planId, '2025-03-10', {});
    expect(!result.ok && result.error.code).toBe('GENERATION_FAILED');
    expect((await repo.get(sortKeys.plan(plan.planId)))?.version).toBe(1);
  });

  it('deletes a whole plan and its grocery list, keeping Meal records and emitting no event', async () => {
    const plan = await weeklyPlan();
    await repo.create(sortKeys.grocery(plan.planId), { planId: plan.planId, items: [] });
    events.events.length = 0;

    const result = await service().deletePlan(plan.planId);
    expect(result).toEqual({ ok: true, value: { planId: plan.planId } });
    expect(await repo.get(sortKeys.plan(plan.planId))).toBeUndefined();
    expect(await repo.get(sortKeys.grocery(plan.planId))).toBeUndefined();
    expect(table.dump().filter((i) => i.SK.startsWith('MEAL#')).length).toBeGreaterThan(0);
    expect(events.events).toHaveLength(0);

    expect(await service().deletePlan(plan.planId)).toMatchObject({ ok: false, error: { code: 'PLAN_NOT_FOUND' } });
    expect(await service().deletePlan('a#b')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('removes a day, keeping the range, and emits day_removed', async () => {
    const plan = await weeklyPlan();
    const result = await service().removeDay(plan.planId, '2025-03-11');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.days).toEqual(plan.days.filter((d) => d.day !== '2025-03-11'));
    expect(result.value.plan.rangeDays).toBe(7);
    expect(events.events[0]).toMatchObject({ change: 'day_removed', day: '2025-03-11', planId: plan.planId, householdId: HH });
    expect(events.events[0]).not.toHaveProperty('mealId');

    expect(await service().removeDay(plan.planId, '2025-03-11')).toMatchObject({ error: { code: 'DAY_NOT_FOUND' } });
  });

  it('adds a day by filling a gap or extending the range up to 31 days', async () => {
    const plan = await weeklyPlan();
    expect(await service().addDay(plan.planId, { day: '2025-03-10', meal: meal('Dup') })).toMatchObject({
      error: { code: 'DAY_ALREADY_ASSIGNED' },
    });

    const extended = await service().addDay(plan.planId, { day: '2025-03-18', meal: meal('Tacos') });
    expect(extended.ok).toBe(true);
    if (!extended.ok) return;
    expect(extended.value.plan.endDate).toBe('2025-03-18');
    expect(extended.value.plan.rangeDays).toBe(9);
    expect(extended.value.plan.days.at(-1)).toEqual({ day: '2025-03-18', mealId: extended.value.meals[0]?.mealId });
    expect(extended.value.plan.days.slice(0, 7)).toEqual(plan.days);
    expect(events.events[0]).toMatchObject({ change: 'day_added', day: '2025-03-18' });

    expect(await service().addDay(plan.planId, { day: '2025-04-10', meal: meal('Far') })).toMatchObject({
      error: { code: 'INVALID_RANGE' },
    });
  });

  it('keeps a committed edit when publishing the event fails', async () => {
    const plan = await weeklyPlan();
    events.failNext();
    const result = await service().removeDay(plan.planId, '2025-03-10');
    expect(result.ok && result.value.eventPublished).toBe(false);
    expect((await repo.get(sortKeys.plan(plan.planId)))?.version).toBe(2);
  });
});
