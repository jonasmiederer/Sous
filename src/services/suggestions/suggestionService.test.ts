import { describe, expect, it } from 'vitest';
import type { AgentMeal } from '../../agent/responses.js';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { PreferenceProfile } from '../../domain/types.js';
import { FakeSuggestionAgentClient, type FakeAgentHandlers } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryMemoryClient } from '../../../test/fakes/inMemoryMemoryClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { createSuggestionsHandler } from './handler.js';
import { SuggestionService, type AdHocPayloadWithMemory } from './suggestionService.js';

const HH = 'hh1';
const scope: ActiveHouseholdScope = { userId: 'u1', householdId: HH, role: 'owner' };
const NOW = Date.parse('2025-01-01T12:00:00.000Z');

const meal = (name: string, ingredients: string[] = ['rice'], extra: Partial<AgentMeal> = {}): AgentMeal => ({
  name,
  ingredients: ingredients.map((n) => ({ name: n, quantity: 1, unit: 'cup' })),
  steps: ['Cook it.'],
  attributes: [],
  ...extra,
});

const profile = (over: Partial<PreferenceProfile> = {}): PreferenceProfile => ({
  householdId: HH,
  likes: [],
  dislikes: [],
  excludedIngredients: [],
  dietaryConstraints: [],
  acceptances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
  ...over,
});

function setup(handlers: FakeAgentHandlers = {}, opts: { deadlineMs?: number; memoryReadBudgetMs?: number } = {}) {
  const table = new InMemoryTableClient();
  const agent = new FakeSuggestionAgentClient(handlers);
  const memory = new InMemoryMemoryClient();
  let n = 0;
  const repo = new HouseholdRepository(table, HH);
  const service = new SuggestionService({
    repositoryFor: (id) => new HouseholdRepository(table, id),
    agent,
    memory,
    now: () => NOW,
    newId: () => `id${++n}`,
    ...opts,
  });
  const writes = () => table.calls.filter((c) => c.op === 'put' || c.op === 'transactWrite' || c.op === 'delete');
  return { table, agent, memory, repo, service, writes };
}

const adHoc = (suggestions: AgentMeal[]): FakeAgentHandlers => ({ ad_hoc: () => ({ mode: 'ad_hoc', suggestions }) });

describe('SuggestionService validation (before generation)', () => {
  it('rejects Context_Input over 500 characters without invoking the agent or reading data', async () => {
    const { service, agent, table } = setup();
    const result = await service.suggest(scope, { contextInput: 'x'.repeat(501) });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONTEXT_INPUT_TOO_LONG' } });
    expect(agent.calls).toHaveLength(0);
    expect(table.calls).toHaveLength(0);
  });

  it('accepts exactly 500 characters, counting code points', async () => {
    const { service } = setup();
    expect((await service.suggest(scope, { contextInput: '🍕'.repeat(500) })).ok).toBe(true);
  });

  it('rejects unrecognized and conflicting presets without invoking the agent', async () => {
    const { service, agent } = setup();
    expect(await service.suggest(scope, { presets: ['spicy'] })).toMatchObject({
      ok: false,
      error: { code: 'UNRECOGNIZED_PRESET' },
    });
    expect(await service.suggest(scope, { presets: ['quick', 'fine dining'] })).toMatchObject({
      ok: false,
      error: { code: 'PRESET_CONFLICT' },
    });
    expect(agent.calls).toHaveLength(0);
  });
});

describe('SuggestionService generation', () => {
  it('passes Context_Input, presets, profile, fridge, and soft memory to the agent', async () => {
    const { service, agent, repo, memory } = setup();
    await repo.upsert(sortKeys.preferenceProfile(), { ...profile({ likes: ['pasta'] }) });
    await repo.upsert(sortKeys.fridge(), { householdId: HH, items: [{ name: 'egg', quantity: 2, unit: 'piece' }], updatedAt: 'x' });
    memory.seedPreference({ householdId: HH }, {
      preferenceId: 'p1',
      statement: 'I love lasagna',
      polarity: 'favorite',
      sourceConversationId: 'c1',
      extractedAt: '2025-01-01T00:00:00.000Z',
    });

    const result = await service.suggest(scope, { contextInput: 'craving noodles', presets: ['healthy', 'quick'] });

    expect(result.ok).toBe(true);
    const payload = agent.lastPayload as AdHocPayloadWithMemory;
    expect(payload).toMatchObject({
      mode: 'ad_hoc',
      householdId: HH,
      preferenceMemoryNamespace: HH,
      contextInput: 'craving noodles',
      presets: ['healthy', 'quick'],
      preferenceProfile: { likes: ['pasta'] },
      fridgeInventory: [{ name: 'egg', quantity: 2, unit: 'piece' }],
      rejectedSuggestionNames: [],
      householdPreferenceMemory: [{ statement: 'I love lasagna', polarity: 'favorite' }],
    });
    expect(agent.calls[0]?.effectiveTimeoutMs).toBeLessThanOrEqual(10_000);
    expect(memory.longTermNamespaces()).toEqual([HH]);
  });

  it('returns 1-3 well-formed suggestions, dropping malformed ones and capping at 3', async () => {
    const { service } = setup(
      adHoc([meal('A'), meal(' '), meal('B', []), meal('C', ['rice'], { steps: ['  '] }), meal('D'), meal('E'), meal('F')]),
    );
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.suggestions.map((s) => s.name)).toEqual(['A', 'D', 'E']);
    for (const s of result.value.suggestions) {
      expect(s.ingredients.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
      expect(s.householdId).toBe(HH);
    }
  });

  it('removes suggestions with excluded ingredients or dietary-constraint violations', async () => {
    const { service, repo } = setup(
      adHoc([meal('Coconut curry', ['coconut milk']), meal('Steak', ['beef']), meal('Dal', ['lentils'])]),
    );
    await repo.upsert(sortKeys.preferenceProfile(), { ...profile({ excludedIngredients: ['coconut'], dietaryConstraints: ['vegetarian'] }) });
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.suggestions.map((s) => s.name)).toEqual(['Dal']);
    expect(result.value.preferenceApplied).toBe(true);
    expect(result.value.notice).toBeUndefined();
  });

  it('ranks suggestions that use fridge items first', async () => {
    const { service, repo } = setup(adHoc([meal('Plain rice', ['rice']), meal('Omelette', ['eggs', 'Egg'])]));
    await repo.upsert(sortKeys.fridge(), { householdId: HH, items: [{ name: 'egg', quantity: 2, unit: 'piece' }], updatedAt: 'x' });
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.suggestions.map((s) => s.name)).toEqual(['Omelette', 'Plain rice']);
  });

  it('generates without filtering and indicates when no Preference_Profile exists (2.3)', async () => {
    const { service, agent } = setup();
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.preferenceApplied).toBe(false);
    expect(result.value.notice).toMatch(/no household preference profile/i);
    expect(result.value.suggestions.every((s) => s.preferenceApplied === false)).toBe(true);
    expect(agent.lastPayload?.preferenceProfile).toBeNull();
  });

  it('proceeds with degraded soft memory when the memory read fails', async () => {
    const { service, memory } = setup();
    memory.failNext('readHouseholdPreferences');
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.softPreferencesDegraded).toBe(true);
  });

  it('persists the returned suggestions under the request session', async () => {
    const { service, repo } = setup();
    const result = await service.suggest(scope, {});
    if (!result.ok) throw new Error(result.error.code);
    const stored = await repo.query(sortKeys.suggestionSession(result.value.sessionId));
    expect(stored.map((r) => r.attributes.name)).toEqual(['Fake Meal']);
    expect(stored[0]?.attributes.ttl).toBe(Math.floor(NOW / 1000) + 24 * 60 * 60);
  });
});

describe('SuggestionService rejected suggestions within a session', () => {
  it('sends rejected names to the agent, filters repeats, and accumulates rejections', async () => {
    let names = ['Tacos'];
    const { service, agent } = setup({ ad_hoc: () => ({ mode: 'ad_hoc', suggestions: names.map((n) => meal(n)) }) });

    const first = await service.suggest(scope, {});
    if (!first.ok) throw new Error(first.error.code);
    const { sessionId } = first.value;
    const tacosId = first.value.suggestions[0]!.suggestionId;

    names = ['tacos ', 'Ramen'];
    const second = await service.suggest(scope, { sessionId, rejectedSuggestionIds: [tacosId] });
    if (!second.ok) throw new Error(second.error.code);
    expect(agent.lastPayload).toMatchObject({ rejectedSuggestionNames: ['Tacos'] });
    expect(second.value.suggestions.map((s) => s.name)).toEqual(['Ramen']);
    expect(second.value.sessionId).toBe(sessionId);

    // The earlier rejection is remembered server-side without resending it.
    names = ['Tacos', 'Pho'];
    const third = await service.suggest(scope, { sessionId });
    if (!third.ok) throw new Error(third.error.code);
    expect(agent.lastPayload).toMatchObject({ rejectedSuggestionNames: ['Tacos'] });
    expect(third.value.suggestions.map((s) => s.name)).toEqual(['Pho']);
  });

  it('returns NO_DISTINCT_SUGGESTIONS when every suggestion repeats a rejected name, writing nothing', async () => {
    const { service, writes } = setup(adHoc([meal('Tacos')]));
    const first = await service.suggest(scope, {});
    if (!first.ok) throw new Error(first.error.code);
    const before = writes().length;
    const result = await service.suggest(scope, {
      sessionId: first.value.sessionId,
      rejectedSuggestionIds: [first.value.suggestions[0]!.suggestionId],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_DISTINCT_SUGGESTIONS', sessionId: first.value.sessionId } });
    expect(writes().length).toBe(before);
  });

  it('rejects ids that are not part of the session', async () => {
    const { service, agent } = setup();
    const result = await service.suggest(scope, { sessionId: 's1', rejectedSuggestionIds: ['nope'] });
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_SUGGESTION' } });
    expect(agent.calls).toHaveLength(0);
  });
});

describe('SuggestionService failure branches leave no partial writes', () => {
  it('returns NO_SUGGESTION_AVAILABLE with a reason and the session id when the agent fails', async () => {
    const { service, agent, writes } = setup();
    agent.failWith({ kind: 'invocation_failed', message: 'boom' });
    const result = await service.suggest(scope, { sessionId: 's1' });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NO_SUGGESTION_AVAILABLE', reason: 'agent_unavailable', sessionId: 's1' },
    });
    expect(writes()).toHaveLength(0);
  });

  it('returns NO_SUGGESTION_AVAILABLE when every suggestion is excluded', async () => {
    const { service, repo, table } = setup(adHoc([meal('Peanut noodles', ['peanut'])]));
    await repo.upsert(sortKeys.preferenceProfile(), { ...profile({ excludedIngredients: ['peanut'] }) });
    const before = table.calls.length;
    const result = await service.suggest(scope, {});
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_SUGGESTION_AVAILABLE', reason: 'all_suggestions_excluded' } });
    expect(table.calls.slice(before).some((c) => c.op === 'transactWrite' || c.op === 'put')).toBe(false);
  });

  it('maps an agent timeout to GENERATION_TIMEOUT', async () => {
    const { service, agent, writes } = setup();
    agent.failWith({ kind: 'timeout', timeoutMs: 10_000, message: 'late' });
    expect(await service.suggest(scope, {})).toMatchObject({ ok: false, error: { code: 'GENERATION_TIMEOUT' } });
    expect(writes()).toHaveLength(0);
  });

  it('times out when the agent exceeds the overall bound, and stores nothing', async () => {
    const { service, writes } = setup(
      { ad_hoc: () => new Promise((resolve) => setTimeout(() => resolve({ mode: 'ad_hoc', suggestions: [meal('Late')] }), 200)) },
      { deadlineMs: 50 },
    );
    expect(await service.suggest(scope, {})).toMatchObject({ ok: false, error: { code: 'GENERATION_TIMEOUT' } });
    await new Promise((r) => setTimeout(r, 250));
    expect(writes()).toHaveLength(0);
  });

  it('returns SAVE_DID_NOT_COMPLETE when persisting fails', async () => {
    const { service, table, repo } = setup();
    table.failNext('transactWrite');
    const result = await service.suggest(scope, { sessionId: 's1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'SAVE_DID_NOT_COMPLETE' } });
    expect(await repo.query(sortKeys.suggestionSession('s1'))).toHaveLength(0);
  });
});

describe('POST /suggestions handler', () => {
  const event = (body: unknown) => ({ body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('returns 200 with suggestions for an authorized request', async () => {
    const { service } = setup();
    const handler = createSuggestionsHandler({ service, resolveScope: () => ({ ok: true, scope }) });
    const res = await handler(event({ presets: ['healthy'] }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).suggestions[0].presetContext).toEqual(['healthy']);
  });

  it('passes through 401/403 from the scope resolver without calling the service', async () => {
    const { service, agent, table } = setup();
    const handler = createSuggestionsHandler({
      service,
      resolveScope: () => ({ ok: false, status: 403, code: 'NOT_A_MEMBER', message: 'no' }),
    });
    const res = await handler(event({}));
    expect(res.statusCode).toBe(403);
    expect(agent.calls).toHaveLength(0);
    expect(table.calls).toHaveLength(0);
  });

  it('maps errors to HTTP statuses', async () => {
    const { service, agent } = setup();
    const handler = createSuggestionsHandler({ service, resolveScope: () => ({ ok: true, scope }) });
    expect((await handler(event('{not json'))).statusCode).toBe(400);
    expect((await handler(event({ contextInput: 'x'.repeat(501) }))).statusCode).toBe(400);
    agent.failWith({ kind: 'timeout', timeoutMs: 10_000, message: 'late' });
    expect((await handler(event({}))).statusCode).toBe(504);
  });
});
