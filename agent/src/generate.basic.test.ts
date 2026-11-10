import { describe, expect, it } from 'vitest';
import { buildAdHocPayload, buildPlanPayload, buildRefinePayload } from '../../src/agent/payload.js';
import type { HouseholdPreferenceRead } from '../../src/agent/memoryClient.js';
import { parseAgentResponseValue } from '../../src/agent/responses.js';
import type { PreferenceProfile } from '../../src/domain/types.js';
import { FakeModelClient, failedResult, okResult } from '../test/fakeModelClient.js';
import type { AgentConfig } from './config.js';
import { checkPlanChunk, checkRefineResponse, filterAdHocSuggestions } from './contractChecks.js';
import { generate, planChunks } from './generate.js';
import { decodeRequestData } from './prompts.js';
import type { AdHocRequest, AgentRequest } from './requestParser.js';
import { MemorySoftPreferenceSource, type SoftPreferenceRead, type SoftPreferenceSource } from './softPreferences.js';

const profile = {
  likes: [],
  dislikes: [],
  excludedIngredients: ['coconut'],
  dietaryConstraints: ['no pork'],
  acceptances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
} as unknown as PreferenceProfile;

const config: AgentConfig = {
  port: 8080,
  modelId: 'model',
  bedrockRegion: 'us-east-1',
  memoryId: 'mem',
  budgetsMs: { ad_hoc: 8_000, refine: 13_000, plan: 26_000 },
  adHocSuggestionCount: 2,
  planChunkDays: 4,
};

function meal(name: string, ingredient = 'leek') {
  return { name, ingredients: [{ name: ingredient, quantity: 1, unit: 'piece' }], steps: ['Cook'], attributes: [] };
}

class FakeSoftPreferences implements SoftPreferenceSource {
  readonly calls: Array<{ householdId: string; query?: string }> = [];
  constructor(private readonly result: SoftPreferenceRead | Error = { entries: [], degraded: false }) {}
  async read(householdId: string, query?: string): Promise<SoftPreferenceRead> {
    this.calls.push(query === undefined ? { householdId } : { householdId, query });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function adHoc(extra: Partial<AdHocRequest> = {}): AdHocRequest {
  return {
    ...buildAdHocPayload({
      householdId: 'hh-1',
      preferenceProfile: profile,
      fridgeInventory: [],
      presets: [],
      rejectedSuggestionNames: ['Chili'],
    }),
    ...extra,
  };
}

function userData(request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }): Record<string, unknown> {
  const block = request.messages[0]?.content[0];
  return decodeRequestData(block?.text ?? '') as Record<string, unknown>;
}

describe('filterAdHocSuggestions', () => {
  it('drops rejected names (trimmed, case-insensitive), excluded meals, and duplicates, and keeps at most 3', () => {
    const kept = filterAdHocSuggestions(
      [meal('  chili '), meal('Curry', 'coconut milk'), meal('Ramen', 'pork belly'), meal('Soup'), meal('soup'), meal('A'), meal('B'), meal('C')],
      adHoc(),
    );
    expect(kept.map((m) => m.name)).toEqual(['Soup', 'A', 'B']);
  });
});

describe('contract checks', () => {
  it('rejects a plan chunk with the wrong count or an excluded meal', () => {
    const request = buildPlanPayload({ householdId: 'hh-1', preferenceProfile: profile, fridgeInventory: [], presets: [], rangeDays: 2 });
    expect(checkPlanChunk({ mode: 'plan', meals: [meal('A')] }, 2, request)).toEqual({
      ok: false,
      message: 'response.meals must contain exactly 2 items, got 1',
    });
    expect(checkPlanChunk({ mode: 'plan', meals: [meal('A'), meal('B', 'coconut')] }, 2, request).ok).toBe(false);
    expect(checkPlanChunk({ mode: 'plan', meals: [meal('A'), meal('B')] }, 2, request).ok).toBe(true);
  });

  it('requires refine output to target the requested type and an existing plan day', () => {
    const request = buildRefinePayload({
      householdId: 'hh-1',
      preferenceProfile: profile,
      fridgeInventory: [],
      presets: [],
      conversationId: 'conv-1',
      contextInput: 'swap Monday',
      targetArtifactType: 'plan',
      currentArtifact: { type: 'plan', days: [{ day: '2025-01-06', meal: meal('A') }] },
    });
    expect(checkRefineResponse({ mode: 'refine', outcome: 'updated', artifact: { type: 'suggestion', meal: meal('X') } }, request).ok).toBe(false);
    expect(
      checkRefineResponse({ mode: 'refine', outcome: 'updated', artifact: { type: 'plan', day: '2025-01-07', meal: meal('X') } }, request).ok,
    ).toBe(false);
    expect(
      checkRefineResponse({ mode: 'refine', outcome: 'updated', artifact: { type: 'plan', day: '2025-01-06', meal: meal('X') } }, request).ok,
    ).toBe(true);
    expect(checkRefineResponse({ mode: 'refine', outcome: 'clarification', message: 'Which day?' }, request).ok).toBe(true);
  });
});

describe('planChunks', () => {
  it('splits a range into consecutive chunks', () => {
    expect(planChunks(9, 4)).toEqual([
      { firstDay: 1, dayCount: 4 },
      { firstDay: 5, dayCount: 4 },
      { firstDay: 9, dayCount: 1 },
    ]);
  });
});

describe('generate: ad hoc', () => {
  it('returns filtered suggestions from one model call and reads memory once at the household namespace', async () => {
    const model = new FakeModelClient([okResult({ mode: 'ad_hoc', suggestions: [meal('Chili'), meal('Soup')] })]);
    const soft = new FakeSoftPreferences({ entries: [{ statement: 'loves lasagna' }], degraded: false });
    const result = await generate(adHoc(), { model, softPreferences: soft, config });
    expect(result).toMatchObject({ ok: true, response: { mode: 'ad_hoc', suggestions: [{ name: 'Soup' }] } });
    expect(model.callCount).toBe(1);
    expect(soft.calls).toEqual([{ householdId: 'hh-1' }]);
    expect(userData(model.requests[0]!).softPreferences).toEqual([{ strength: 'soft', statement: 'loves lasagna' }]);
  });

  it('does not read memory when the request includes householdPreferenceMemory, even empty', async () => {
    const model = new FakeModelClient([okResult({ mode: 'ad_hoc', suggestions: [meal('Soup')] })]);
    const soft = new FakeSoftPreferences();
    const result = await generate(adHoc({ householdPreferenceMemory: [] }), { model, softPreferences: soft, config });
    expect(result.ok).toBe(true);
    expect(soft.calls).toHaveLength(0);
  });

  it('continues without soft preferences when memory fails', async () => {
    const model = new FakeModelClient([okResult({ mode: 'ad_hoc', suggestions: [meal('Soup')] })]);
    const result = await generate(adHoc(), { model, softPreferences: new FakeSoftPreferences(new Error('down')), config });
    expect(result).toMatchObject({ ok: true, meta: { softPreferences: 'degraded' } });
    expect(userData(model.requests[0]!).softPreferences).toEqual([]);
  });

  it('repairs once with the validator message as a tool_result, then succeeds', async () => {
    const model = new FakeModelClient([
      okResult({ mode: 'ad_hoc', suggestions: [meal('Chili')] }, 'tu-1'),
      okResult({ mode: 'ad_hoc', suggestions: [meal('Soup')] }),
    ]);
    const result = await generate(adHoc(), { model, softPreferences: new FakeSoftPreferences(), config });
    expect(result.ok).toBe(true);
    expect(model.callCount).toBe(2);
    const repair = model.requests[1]!.messages;
    expect(repair.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(repair[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu-1', status: 'error' });
    expect((repair[2]!.content[0] as { text: string }).text).toContain('rejectedNames');
  });

  it('fails with GENERATION_FAILED after a nonconforming repair and never calls the model a third time', async () => {
    const model = new FakeModelClient([failedResult('no_structured_output'), okResult({ mode: 'plan', meals: [] })]);
    const result = await generate(adHoc(), { model, softPreferences: new FakeSoftPreferences(), config });
    expect(result).toMatchObject({ ok: false, code: 'GENERATION_FAILED' });
    expect(model.callCount).toBe(2);
  });

  it('skips the repair call when less than 3 s of budget remains', async () => {
    let clock = 0;
    const model = new FakeModelClient([
      (_req) => {
        clock = 5_500; // 2.5 s left of the 8 s budget
        return okResult({ mode: 'ad_hoc', suggestions: [] });
      },
    ]);
    const result = await generate(adHoc(), { model, softPreferences: new FakeSoftPreferences(), config, now: () => clock });
    expect(result).toMatchObject({ ok: false, code: 'GENERATION_FAILED' });
    expect(model.callCount).toBe(1);
  });

  it('returns GENERATION_TIMEOUT when the budget runs out', async () => {
    const model = new FakeModelClient([], { fallback: okResult({ mode: 'ad_hoc', suggestions: [meal('Soup')] }), delayMs: 1_000 });
    const result = await generate(adHoc(), {
      model,
      softPreferences: new FakeSoftPreferences(),
      config: { ...config, budgetsMs: { ...config.budgetsMs, ad_hoc: 20 } },
    });
    expect(result).toMatchObject({ ok: false, code: 'GENERATION_TIMEOUT' });
  });
});

describe('generate: plan', () => {
  const plan = (rangeDays: number): AgentRequest => ({
    ...buildPlanPayload({ householdId: 'hh-1', preferenceProfile: profile, fridgeInventory: [], presets: [], rangeDays }),
    householdPreferenceMemory: [],
  });

  function chunkModel(failChunkStartingAt?: number) {
    return new FakeModelClient([], {
      fallback: (req) => {
        const days = userData(req).days as { dayNumbers: number[] };
        if (days.dayNumbers[0] === failChunkStartingAt) return okResult({ mode: 'plan', meals: [] });
        return okResult({ mode: 'plan', meals: days.dayNumbers.map((d) => meal(`Day ${d}`)) });
      },
    });
  }

  it('generates chunks and merges them in day order', async () => {
    const model = chunkModel();
    const result = await generate(plan(9), { model, softPreferences: new FakeSoftPreferences(), config });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseAgentResponseValue('plan', result.response).ok).toBe(true);
    expect((result.response as { meals: Array<{ name: string }> }).meals.map((m) => m.name)).toEqual(
      Array.from({ length: 9 }, (_, i) => `Day ${i + 1}`),
    );
    expect(model.callCount).toBe(3);
    expect(model.requests.map((r) => r.tool.inputSchema)).toContainEqual(
      expect.objectContaining({ properties: expect.objectContaining({ meals: expect.objectContaining({ minItems: 1, maxItems: 1 }) }) }),
    );
  });

  it('fails the whole plan when one chunk stays nonconforming after its repair', async () => {
    const model = chunkModel(5);
    const result = await generate(plan(8), { model, softPreferences: new FakeSoftPreferences(), config });
    expect(result).toMatchObject({ ok: false, code: 'GENERATION_FAILED' });
    expect(model.callCount).toBeLessThanOrEqual(4);
  });
});

describe('generate: refine', () => {
  it('treats a wrong artifact type as nonconforming and returns a valid clarification after repair', async () => {
    const request = buildRefinePayload({
      householdId: 'hh-1',
      preferenceProfile: null,
      fridgeInventory: [],
      presets: [],
      conversationId: 'conv-1',
      contextInput: 'make it spicier',
      targetArtifactType: 'suggestion',
    });
    const model = new FakeModelClient([
      okResult({ mode: 'refine', outcome: 'updated', artifact: { type: 'grocery_list', entries: [] } }),
      okResult({ mode: 'refine', outcome: 'clarification', message: 'How spicy?' }),
    ]);
    const result = await generate(request, { model, softPreferences: new FakeSoftPreferences(), config });
    expect(result).toMatchObject({ ok: true, response: { mode: 'refine', outcome: 'clarification' } });
    expect(model.callCount).toBe(2);
  });
});

describe('MemorySoftPreferenceSource', () => {
  it('reads only the household namespace and maps entries', async () => {
    const scopes: unknown[] = [];
    const source = new MemorySoftPreferenceSource({
      readHouseholdPreferences: async (scope): Promise<HouseholdPreferenceRead> => {
        scopes.push(scope);
        return {
          degraded: false,
          entries: [{ householdId: 'hh-1', preferenceId: 'p1', statement: 'no coconut', polarity: 'dislike', extractedAt: '2025-01-01T00:00:00.000Z' }],
        };
      },
    });
    expect(await source.read('hh-1')).toEqual({ degraded: false, entries: [{ statement: 'no coconut', polarity: 'dislike' }] });
    expect(scopes).toEqual([{ householdId: 'hh-1' }]);
  });

  it('degrades on rejection or timeout', async () => {
    const failing = new MemorySoftPreferenceSource({ readHouseholdPreferences: () => Promise.reject(new Error('x')) });
    expect(await failing.read('hh-1')).toEqual({ entries: [], degraded: true });
    const hanging = new MemorySoftPreferenceSource({ readHouseholdPreferences: () => new Promise(() => {}) }, 10);
    expect(await hanging.read('hh-1')).toEqual({ entries: [], degraded: true });
  });

  it('exposes no write or turn methods', () => {
    const source = new MemorySoftPreferenceSource({ readHouseholdPreferences: async () => ({ entries: [], degraded: false }) });
    expect(source).not.toHaveProperty('writeHouseholdPreference');
    expect(source).not.toHaveProperty('appendConversationTurn');
    expect(source).not.toHaveProperty('listConversationTurns');
  });
});
