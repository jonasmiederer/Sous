import { beforeEach, describe, expect, it } from 'vitest';

import type { RefinePayload } from '../../agent/payload.js';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { GroceryList, Meal, MealPlan, MealSuggestion, PreferenceProfile } from '../../domain/types.js';
import { FakeSuggestionAgentClient } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryMemoryClient } from '../../../test/fakes/inMemoryMemoryClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { ConversationService } from './service.js';

const HH = 'hh-1';

const suggestion: MealSuggestion = {
  suggestionId: 'sug-1',
  sessionId: 'sess-1',
  householdId: HH,
  name: 'Chili',
  ingredients: [{ name: 'bean', quantity: 2, unit: 'cup' }],
  steps: ['Simmer.'],
  presetContext: ['quick'],
  preferenceApplied: true,
};

const meal = (id: string, name: string): Meal => ({
  mealId: id,
  name,
  ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }],
  steps: ['Cook.'],
  attributes: [],
});

const plan: MealPlan = {
  planId: 'plan-1',
  householdId: HH,
  startDate: '2025-01-01',
  endDate: '2025-01-02',
  rangeDays: 2,
  days: [
    { day: '2025-01-01', mealId: 'm1' },
    { day: '2025-01-02', mealId: 'm2' },
  ],
};

const grocery: GroceryList = {
  householdId: HH,
  planId: 'plan-1',
  entries: [{ name: 'rice', quantity: 2, unit: 'cup' }],
  generatedAt: '2025-01-01T00:00:00.000Z',
};

const profile: PreferenceProfile = {
  householdId: HH,
  likes: [],
  dislikes: [],
  excludedIngredients: ['peanut'],
  dietaryConstraints: [],
  acceptances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
};

let table: InMemoryTableClient;
let repo: HouseholdRepository;
let agent: FakeSuggestionAgentClient;
let memory: InMemoryMemoryClient;
let clockMs: number;
let ids: number;

function service(extra: Partial<ConstructorParameters<typeof ConversationService>[0]> = {}) {
  return new ConversationService({
    repository: repo,
    agent,
    memory,
    now: () => new Date(clockMs),
    newId: () => `id-${++ids}`,
    ...extra,
  });
}

beforeEach(async () => {
  table = new InMemoryTableClient();
  repo = new HouseholdRepository(table, HH);
  agent = new FakeSuggestionAgentClient();
  memory = new InMemoryMemoryClient();
  clockMs = Date.parse('2025-01-01T12:00:00.000Z');
  ids = 0;
  await repo.create(sortKeys.suggestion('sess-1', 'sug-1'), { ...suggestion });
  await repo.create(sortKeys.plan('plan-1'), { ...plan });
  await repo.create(sortKeys.meal('m1'), { ...meal('m1', 'Rice Bowl') });
  await repo.create(sortKeys.meal('m2'), { ...meal('m2', 'Fried Rice') });
  await repo.create(sortKeys.grocery('plan-1'), { ...grocery });
  await repo.create(sortKeys.preferenceProfile(), { ...profile });
});

async function start(svc: ConversationService, type: 'suggestion' | 'plan' | 'grocery_list') {
  const target =
    type === 'suggestion'
      ? ({ type, sessionId: 'sess-1', suggestionId: 'sug-1' } as const)
      : ({ type, planId: 'plan-1' } as const);
  const r = await svc.createConversation(target);
  if (!r.ok) throw new Error(r.error.message);
  return r.conversation;
}

describe('createConversation', () => {
  it('persists metadata scoped to the Active_Household with memorySessionId', async () => {
    const svc = service();
    const c = await start(svc, 'suggestion');
    expect(c).toMatchObject({
      conversationId: 'id-1',
      householdId: HH,
      memorySessionId: `${HH}:id-1`,
      targetArtifactType: 'suggestion',
      targetArtifactId: 'sug-1',
      targetSessionId: 'sess-1',
    });
    const stored = await repo.get(sortKeys.conversation('id-1'));
    expect(stored?.attributes).toMatchObject({ memorySessionId: `${HH}:id-1` });
  });

  it('rejects a target that does not exist in the Household', async () => {
    const r = await service().createConversation({ type: 'plan', planId: 'nope' });
    expect(r).toMatchObject({ ok: false, error: { code: 'TARGET_NOT_FOUND' } });
  });

  it('cannot load a Conversation of another Household', async () => {
    const c = await start(service(), 'plan');
    const other = new ConversationService({
      repository: new HouseholdRepository(table, 'hh-2'),
      agent,
      memory,
    });
    expect(await other.getConversation(c.conversationId)).toBeUndefined();
    const r = await other.sendMessage(c.conversationId, 'hi');
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(agent.calls).toHaveLength(0);
  });
});

describe('sendMessage', () => {
  it('sends all prior turns and the current artifact, within the 15s bound', async () => {
    const svc = service();
    const c = await start(svc, 'suggestion');
    agent.setHandlers({ refine: () => ({ mode: 'refine', outcome: 'clarification', message: 'Which part?' }) });
    await svc.sendMessage(c.conversationId, 'make it spicy');
    await svc.sendMessage(c.conversationId, 'the sauce');

    const payload = agent.lastPayload as RefinePayload;
    expect(payload.priorTurns?.map((t) => [t.role, t.text])).toEqual([
      ['user', 'make it spicy'],
      ['assistant', 'Which part?'],
    ]);
    expect(payload.currentArtifact).toEqual({
      type: 'suggestion',
      meal: { name: 'Chili', ingredients: suggestion.ingredients, steps: ['Simmer.'], attributes: [] },
    });
    expect(payload.preferenceProfile?.excludedIngredients).toEqual(['peanut']);
    expect(agent.calls.at(-1)?.effectiveTimeoutMs).toBeLessThanOrEqual(15_000);
    expect(memory.calls.every((m) => m.namespace === `${HH}:${c.conversationId}`)).toBe(true);
  });

  it('suggestion refinement replaces only changed fields and keeps the rest', async () => {
    const svc = service();
    const c = await start(svc, 'suggestion');
    agent.setHandlers({
      refine: () => ({
        mode: 'refine',
        outcome: 'updated',
        artifact: {
          type: 'suggestion',
          meal: { name: 'Chili', ingredients: [{ name: 'lentil', quantity: 2, unit: 'cup' }], steps: ['Simmer.'], attributes: [] },
        },
      }),
    });
    const r = await svc.sendMessage(c.conversationId, 'use lentils');
    expect(r).toMatchObject({ ok: true, outcome: 'updated', artifact: { changedFields: ['ingredients'] }, memoryRecorded: true });
    const stored = await repo.get<MealSuggestion & Record<string, unknown>>(sortKeys.suggestion('sess-1', 'sug-1'));
    expect(stored?.attributes).toEqual({ ...suggestion, ingredients: [{ name: 'lentil', quantity: 2, unit: 'cup' }] });
  });

  it('plan refinement changes only the named day', async () => {
    const svc = service();
    const c = await start(svc, 'plan');
    agent.setHandlers({
      refine: () => ({
        mode: 'refine',
        outcome: 'updated',
        artifact: { type: 'plan', day: '2025-01-02', meal: { name: 'Paella', ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }], steps: ['Cook.'], attributes: [] } },
      }),
    });
    const r = await svc.sendMessage(c.conversationId, 'make Thursday paella');
    expect(r.ok).toBe(true);
    const stored = await repo.get<MealPlan & Record<string, unknown>>(sortKeys.plan('plan-1'));
    expect(stored?.attributes.days[0]).toEqual({ day: '2025-01-01', mealId: 'm1' });
    const newId = stored!.attributes.days[1]!.mealId;
    expect(newId).not.toBe('m2');
    expect((await repo.get<Meal & Record<string, unknown>>(sortKeys.meal(newId)))?.attributes.name).toBe('Paella');
  });

  it('plan refinement reports the change with the committed plan version', async () => {
    const events: unknown[] = [];
    const svc = service({ onPlanChanged: async (e) => void events.push(e) });
    const c = await start(svc, 'plan');
    agent.setHandlers({
      refine: () => ({
        mode: 'refine',
        outcome: 'updated',
        artifact: { type: 'plan', day: '2025-01-02', meal: { name: 'Paella', ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }], steps: ['Cook.'], attributes: [] } },
      }),
    });
    const before = await repo.get(sortKeys.plan('plan-1'));
    const r = await svc.sendMessage(c.conversationId, 'make Thursday paella');
    expect(r.ok).toBe(true);
    const stored = await repo.get<MealPlan & Record<string, unknown>>(sortKeys.plan('plan-1'));
    expect(stored!.version).toBe(before!.version + 1);
    expect(events).toEqual([
      {
        householdId: HH,
        planId: 'plan-1',
        day: '2025-01-02',
        mealId: stored!.attributes.days[1]!.mealId,
        planVersion: stored!.version,
      },
    ]);
  });

  it('rejects a plan day that does not exist and an excluded meal, without writing', async () => {
    const svc = service();
    const c = await start(svc, 'plan');
    const before = table.dump();

    agent.setHandlers({
      refine: () => ({ mode: 'refine', outcome: 'updated', artifact: { type: 'plan', day: '2025-02-01', meal: meal('x', 'Soup') } }),
    });
    expect(await svc.sendMessage(c.conversationId, 'change Feb 1')).toMatchObject({ ok: false, error: { code: 'CANNOT_APPLY' } });

    agent.setHandlers({
      refine: () => ({
        mode: 'refine',
        outcome: 'updated',
        artifact: {
          type: 'plan',
          day: '2025-01-01',
          meal: { ...meal('x', 'Satay'), ingredients: [{ name: 'peanut butter', quantity: 1, unit: 'tbsp' }] },
        },
      }),
    });
    expect(await svc.sendMessage(c.conversationId, 'make it satay')).toMatchObject({ ok: false, error: { code: 'CANNOT_APPLY' } });

    expect(table.dump()).toEqual(before);
    expect(await memory.listConversationTurns({ householdId: HH, conversationId: c.conversationId })).toEqual([]);
  });

  it('grocery refinement replaces entries without re-consolidating', async () => {
    const svc = service();
    const c = await start(svc, 'grocery_list');
    const entries = [
      { name: 'rice', quantity: 2, unit: 'cup' },
      { name: 'rice', quantity: 1, unit: 'cup' },
    ];
    agent.setHandlers({ refine: () => ({ mode: 'refine', outcome: 'updated', artifact: { type: 'grocery_list', entries } }) });
    const r = await svc.sendMessage(c.conversationId, 'add another cup of rice separately');
    expect(r.ok).toBe(true);
    const stored = await repo.get<GroceryList & Record<string, unknown>>(sortKeys.grocery('plan-1'));
    expect(stored?.attributes).toMatchObject({ planId: 'plan-1', householdId: HH, entries });
  });

  it('timeout and clarification leave the artifact unchanged', async () => {
    const svc = service();
    const c = await start(svc, 'grocery_list');
    const before = table.dump();

    agent.failWith({ kind: 'timeout', timeoutMs: 15_000, message: 'slow' });
    expect(await svc.sendMessage(c.conversationId, 'remove rice')).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(await memory.listConversationTurns({ householdId: HH, conversationId: c.conversationId })).toEqual([]);

    agent.setHandlers({ refine: () => ({ mode: 'refine', outcome: 'clarification', message: 'Which item?' }) });
    expect(await svc.sendMessage(c.conversationId, 'remove it')).toMatchObject({ ok: true, outcome: 'clarification' });
    expect(table.dump()).toEqual(before);
  });

  it('treats a response arriving after the 15s bound as a timeout', async () => {
    const svc = service();
    const c = await start(svc, 'grocery_list');
    const before = table.dump();
    agent.setHandlers({
      refine: () => {
        clockMs += 15_001;
        return { mode: 'refine', outcome: 'updated', artifact: { type: 'grocery_list', entries: [] } };
      },
    });
    expect(await svc.sendMessage(c.conversationId, 'clear it')).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(table.dump()).toEqual(before);
  });

  it('rejects empty or over-length messages without invoking the agent', async () => {
    const svc = service();
    const c = await start(svc, 'plan');
    expect(await svc.sendMessage(c.conversationId, '  ')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(await svc.sendMessage(c.conversationId, 'x'.repeat(501))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(agent.calls).toHaveLength(0);
  });

  it('returns MEMORY_UNAVAILABLE when prior turns cannot be read', async () => {
    const svc = service();
    const c = await start(svc, 'plan');
    memory.failNext('listConversationTurns');
    expect(await svc.sendMessage(c.conversationId, 'hi')).toMatchObject({ ok: false, error: { code: 'MEMORY_UNAVAILABLE' } });
    expect(agent.calls).toHaveLength(0);
  });

  it('returns SAVE_FAILED and leaves the artifact unchanged when the write fails', async () => {
    const svc = service();
    const c = await start(svc, 'grocery_list');
    const before = table.dump();
    agent.setHandlers({ refine: () => ({ mode: 'refine', outcome: 'updated', artifact: { type: 'grocery_list', entries: [] } }) });
    table.failNext('put');
    expect(await svc.sendMessage(c.conversationId, 'clear it')).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
    expect(table.dump()).toEqual(before);
  });
});
