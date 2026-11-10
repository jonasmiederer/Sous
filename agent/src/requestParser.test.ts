import { describe, expect, it } from 'vitest';
import { buildAdHocPayload, buildPlanPayload, buildRefinePayload } from '../../src/agent/payload.js';
import type { PreferenceProfile } from '../../src/domain/types.js';
import { parseAgentRequest } from './requestParser.js';

const profile = {
  likes: ['pasta'],
  dislikes: ['olives'],
  excludedIngredients: ['peanut'],
  dietaryConstraints: ['no pork'],
  acceptances: [],
  updatedAt: '2025-01-01T00:00:00.000Z',
} as unknown as PreferenceProfile;

const meal = { name: 'Soup', ingredients: [{ name: 'leek', quantity: 2, unit: 'piece' }], steps: ['Cook'], attributes: [] };

const adHoc = () =>
  buildAdHocPayload({
    householdId: 'hh-1',
    preferenceProfile: profile,
    fridgeInventory: [{ name: 'egg', quantity: 6, unit: 'piece' }],
    presets: ['healthy', 'quick'],
    contextInput: 'something warm',
    rejectedSuggestionNames: ['Chili'],
  });
const plan = () => buildPlanPayload({ householdId: 'hh-1', preferenceProfile: null, rangeDays: 7 });
const refine = () =>
  buildRefinePayload({
    householdId: 'hh-1',
    preferenceProfile: profile,
    conversationId: 'conv-1',
    contextInput: 'make it vegetarian',
    targetArtifactType: 'plan',
    priorTurns: [{ role: 'user', text: 'hi', timestamp: '2025-01-01T00:00:00.000Z' }],
    currentArtifact: { type: 'plan', days: [{ day: '2025-01-01', meal }] },
  });

function expectInvalid(value: unknown, message?: RegExp): void {
  const result = parseAgentRequest(value);
  expect(result.ok).toBe(false);
  if (!result.ok && message) expect(result.message).toMatch(message);
}

describe('parseAgentRequest: accepted payloads', () => {
  it.each([
    ['ad_hoc', adHoc],
    ['plan', plan],
    ['refine', refine],
  ])('accepts a %s payload built by src/agent/payload.ts unchanged', (_mode, build) => {
    const payload = build();
    expect(parseAgentRequest(JSON.parse(JSON.stringify(payload)))).toEqual({ ok: true, request: payload });
  });

  it('accepts householdPreferenceMemory on any mode', () => {
    const memory = [{ statement: 'loves lasagna', polarity: 'favorite' }, { statement: 'no coconut' }];
    for (const payload of [adHoc(), plan(), refine()]) {
      const result = parseAgentRequest({ ...payload, householdPreferenceMemory: memory });
      expect(result.ok && result.request.householdPreferenceMemory).toEqual(memory);
    }
  });

  it('drops unknown extra fields', () => {
    const result = parseAgentRequest({ ...plan(), extra: 1 });
    expect(result.ok && 'extra' in result.request).toBe(false);
  });

  it('accepts contextInput of exactly 500 code points, counting emoji as one', () => {
    expect(parseAgentRequest({ ...adHoc(), contextInput: '🍝'.repeat(500) }).ok).toBe(true);
  });

  it.each([1, 31])('accepts rangeDays %i', (rangeDays) => {
    expect(parseAgentRequest({ ...plan(), rangeDays }).ok).toBe(true);
  });
});

describe('parseAgentRequest: rejected payloads', () => {
  it.each([null, 'text', 42, []])('rejects non-object %o', (value) => expectInvalid(value));

  it('rejects an unrecognized mode', () => expectInvalid({ ...adHoc(), mode: 'chat' }, /mode/));

  it('rejects an invalid householdId', () => {
    expectInvalid({ ...adHoc(), householdId: 'bad id!', preferenceMemoryNamespace: 'bad id!' }, /householdId/);
  });

  it('rejects a namespace that differs from householdId', () => {
    expectInvalid({ ...adHoc(), preferenceMemoryNamespace: 'hh-2' }, /preferenceMemoryNamespace/);
    const { preferenceMemoryNamespace: _, ...rest } = adHoc();
    expectInvalid(rest, /preferenceMemoryNamespace/);
  });

  it('rejects unrecognized and conflicting presets', () => {
    expectInvalid({ ...adHoc(), presets: ['spicy'] }, /Unrecognized/);
    expectInvalid({ ...adHoc(), presets: ['quick', 'fine dining'] });
  });

  it('rejects contextInput over 500 code points', () => {
    expectInvalid({ ...adHoc(), contextInput: 'a'.repeat(501) }, /500/);
    expectInvalid({ ...refine(), contextInput: '🍝'.repeat(501) }, /500/);
  });

  it.each([0, 32, 2.5, '7'])('rejects rangeDays %o', (rangeDays) => {
    expectInvalid({ ...plan(), rangeDays }, /rangeDays/);
  });

  it('rejects a currentArtifact whose type differs from targetArtifactType', () => {
    expectInvalid({ ...refine(), currentArtifact: { type: 'suggestion', meal } }, /targetArtifactType/);
  });

  it('rejects refine payloads with bad fields', () => {
    expectInvalid({ ...refine(), targetArtifactType: 'recipe' }, /targetArtifactType/);
    expectInvalid({ ...refine(), conversationId: '' }, /conversationId/);
    const { contextInput: _, ...noMessage } = refine();
    expectInvalid(noMessage, /contextInput/);
    expectInvalid({ ...refine(), priorTurns: [{ role: 'system', text: 'x', timestamp: 't' }] }, /role/);
  });

  it('rejects wrongly typed base fields', () => {
    expectInvalid({ ...adHoc(), fridgeInventory: [{ name: 'egg', quantity: -1, unit: 'piece' }] }, /quantity/);
    expectInvalid({ ...adHoc(), preferenceProfile: { likes: [] } }, /dislikes/);
    expectInvalid({ ...adHoc(), rejectedSuggestionNames: [1] }, /rejectedSuggestionNames/);
    expectInvalid({ ...adHoc(), householdPreferenceMemory: [{ polarity: 'like' }] }, /statement/);
    const { presets: _, ...noPresets } = adHoc();
    expectInvalid(noPresets, /presets/);
  });
});
