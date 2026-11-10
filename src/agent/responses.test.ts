import { describe, expect, it } from 'vitest';
import { parseAgentResponse } from './responses.js';

const meal = { name: 'Omelette', ingredients: [{ name: 'egg', quantity: 2, unit: 'count' }], steps: ['Whisk', 'Cook'] };

describe('parseAgentResponse', () => {
  it('parses an ad hoc response and defaults attributes to []', () => {
    const r = parseAgentResponse('ad_hoc', JSON.stringify({ mode: 'ad_hoc', suggestions: [meal] }));
    expect(r).toEqual({ ok: true, value: { mode: 'ad_hoc', suggestions: [{ ...meal, attributes: [] }] } });
  });

  it('parses a plan response', () => {
    const r = parseAgentResponse('plan', JSON.stringify({ mode: 'plan', meals: [meal, { ...meal, attributes: ['quick'] }] }));
    expect(r.ok && r.value.meals.map((m) => m.attributes)).toEqual([[], ['quick']]);
  });

  it('parses refine updated and clarification outcomes', () => {
    const updated = parseAgentResponse(
      'refine',
      JSON.stringify({ mode: 'refine', outcome: 'updated', artifact: { type: 'plan', day: '2025-02-03', meal } }),
    );
    expect(updated.ok && updated.value.outcome).toBe('updated');

    const grocery = parseAgentResponse(
      'refine',
      JSON.stringify({
        mode: 'refine',
        outcome: 'updated',
        artifact: { type: 'grocery_list', entries: [{ name: 'milk', quantity: 1, unit: 'l' }] },
      }),
    );
    expect(grocery.ok).toBe(true);

    const clar = parseAgentResponse('refine', JSON.stringify({ mode: 'refine', outcome: 'clarification', message: 'Which day?' }));
    expect(clar).toEqual({ ok: true, value: { mode: 'refine', outcome: 'clarification', message: 'Which day?' } });
  });

  it.each([
    ['not JSON', 'ad_hoc', '{oops', /not valid JSON/],
    ['wrong mode', 'ad_hoc', JSON.stringify({ mode: 'plan', meals: [] }), /mode must be "ad_hoc"/],
    ['array root', 'plan', '[]', /response must be an object/],
    ['missing suggestions', 'ad_hoc', JSON.stringify({ mode: 'ad_hoc' }), /suggestions must be an array/],
    [
      'negative quantity',
      'ad_hoc',
      JSON.stringify({ mode: 'ad_hoc', suggestions: [{ ...meal, ingredients: [{ name: 'egg', quantity: -1, unit: 'count' }] }] }),
      /suggestions\[0\]\.ingredients\[0\]\.quantity/,
    ],
    ['empty name', 'plan', JSON.stringify({ mode: 'plan', meals: [{ ...meal, name: ' ' }] }), /meals\[0\]\.name/],
    ['non-string step', 'plan', JSON.stringify({ mode: 'plan', meals: [{ ...meal, steps: [1] }] }), /steps\[0\]/],
    [
      'bad plan day',
      'refine',
      JSON.stringify({ mode: 'refine', outcome: 'updated', artifact: { type: 'plan', day: 'Monday', meal } }),
      /artifact\.day/,
    ],
    ['unknown outcome', 'refine', JSON.stringify({ mode: 'refine', outcome: 'done' }), /outcome/],
  ] as const)('rejects %s', (_label, mode, text, pattern) => {
    const r = parseAgentResponse(mode, text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(pattern);
  });
});
