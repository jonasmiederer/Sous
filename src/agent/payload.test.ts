import { describe, expect, it } from 'vitest';
import type { PreferenceProfile } from '../domain/types.js';
import { buildAdHocPayload, buildPlanPayload, buildRefinePayload, encodePayload } from './payload.js';

const profile = (): PreferenceProfile => ({
  householdId: 'hh-1',
  likes: ['pasta'],
  dislikes: ['olives'],
  excludedIngredients: ['peanut'],
  dietaryConstraints: ['no shellfish'],
  acceptances: ['meal-1'],
  updatedAt: '2025-01-01T00:00:00.000Z',
});

describe('buildAdHocPayload', () => {
  it('assembles every field and sets preferenceMemoryNamespace from householdId', () => {
    const p = buildAdHocPayload({
      householdId: 'hh-1',
      preferenceProfile: profile(),
      fridgeInventory: [{ name: 'egg', quantity: 6, unit: 'count' }],
      presets: ['healthy', 'quick'],
      contextInput: 'something warm',
      rejectedSuggestionNames: ['Chili'],
    });
    expect(p).toEqual({
      mode: 'ad_hoc',
      householdId: 'hh-1',
      preferenceMemoryNamespace: 'hh-1',
      preferenceProfile: {
        likes: ['pasta'],
        dislikes: ['olives'],
        excludedIngredients: ['peanut'],
        dietaryConstraints: ['no shellfish'],
      },
      fridgeInventory: [{ name: 'egg', quantity: 6, unit: 'count' }],
      presets: ['healthy', 'quick'],
      contextInput: 'something warm',
      rejectedSuggestionNames: ['Chili'],
    });
  });

  it('deep-copies the profile snapshot and inputs', () => {
    const prof = profile();
    const fridge = [{ name: 'egg', quantity: 6, unit: 'count' }];
    const p = buildAdHocPayload({ householdId: 'hh-1', preferenceProfile: prof, fridgeInventory: fridge });
    prof.excludedIngredients.push('milk');
    prof.likes.length = 0;
    fridge[0]!.quantity = 1;
    expect(p.preferenceProfile?.excludedIngredients).toEqual(['peanut']);
    expect(p.preferenceProfile?.likes).toEqual(['pasta']);
    expect(p.fridgeInventory[0]!.quantity).toBe(6);
  });

  it('uses null profile and empty defaults when absent, and omits contextInput', () => {
    const p = buildAdHocPayload({ householdId: 'hh-2', preferenceProfile: null });
    expect(p.preferenceProfile).toBeNull();
    expect(p.fridgeInventory).toEqual([]);
    expect(p.presets).toEqual([]);
    expect(p.rejectedSuggestionNames).toEqual([]);
    expect('contextInput' in p).toBe(false);
  });

  it('ignores any caller-supplied namespace', () => {
    const input = { householdId: 'hh-3', preferenceProfile: null, preferenceMemoryNamespace: 'hh-other' };
    expect(buildAdHocPayload(input).preferenceMemoryNamespace).toBe('hh-3');
  });
});

describe('buildPlanPayload / buildRefinePayload', () => {
  it('builds a plan payload with rangeDays', () => {
    const p = buildPlanPayload({ householdId: 'hh-1', preferenceProfile: profile(), rangeDays: 7 });
    expect(p.mode).toBe('plan');
    expect(p.rangeDays).toBe(7);
    expect(p.preferenceMemoryNamespace).toBe('hh-1');
  });

  it('builds a refine payload with conversationId', () => {
    const p = buildRefinePayload({
      householdId: 'hh-1',
      preferenceProfile: profile(),
      conversationId: 'conv-9',
      contextInput: 'make it vegetarian',
      targetArtifactType: 'suggestion',
    });
    expect(p).toMatchObject({
      mode: 'refine',
      conversationId: 'conv-9',
      contextInput: 'make it vegetarian',
      targetArtifactType: 'suggestion',
      preferenceMemoryNamespace: 'hh-1',
    });
  });

  it('omits priorTurns and currentArtifact when not supplied', () => {
    const p = buildRefinePayload({
      householdId: 'hh-1',
      preferenceProfile: null,
      conversationId: 'conv-1',
      contextInput: 'x',
      targetArtifactType: 'grocery_list',
    });
    expect('priorTurns' in p).toBe(false);
    expect('currentArtifact' in p).toBe(false);
  });

  it('deep-copies prior turns and the current artifact into a refine payload', () => {
    const turns = [
      { role: 'user' as const, text: 'make it spicy', timestamp: '2025-01-01T00:00:00.000Z' },
      { role: 'assistant' as const, text: 'Updated', timestamp: '2025-01-01T00:00:01.000Z' },
    ];
    const meal = { name: 'Chili', ingredients: [{ name: 'bean', quantity: 1, unit: 'cup' }], steps: ['Cook.'], attributes: [] };
    const p = buildRefinePayload({
      householdId: 'hh-1',
      preferenceProfile: null,
      conversationId: 'conv-1',
      contextInput: 'less salt',
      targetArtifactType: 'suggestion',
      priorTurns: turns,
      currentArtifact: { type: 'suggestion', meal },
    });
    turns[0]!.text = 'mutated';
    meal.ingredients[0]!.quantity = 99;
    expect(p.priorTurns).toEqual([
      { role: 'user', text: 'make it spicy', timestamp: '2025-01-01T00:00:00.000Z' },
      { role: 'assistant', text: 'Updated', timestamp: '2025-01-01T00:00:01.000Z' },
    ]);
    expect(p.currentArtifact).toEqual({
      type: 'suggestion',
      meal: { name: 'Chili', ingredients: [{ name: 'bean', quantity: 1, unit: 'cup' }], steps: ['Cook.'], attributes: [] },
    });
  });

  it('encodes the payload as UTF-8 JSON', () => {
    const p = buildPlanPayload({ householdId: 'hh-ü', preferenceProfile: null, rangeDays: 3 });
    expect(JSON.parse(new TextDecoder().decode(encodePayload(p)))).toEqual(p);
  });
});
