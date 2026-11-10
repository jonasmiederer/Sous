import { describe, expect, it } from 'vitest';

import { planOutlineSchema, responseSchema } from './schemas.js';

describe('tool input schemas', () => {
  // Claude rejects these keywords at the top level of a tool input schema.
  it.each(['ad_hoc', 'plan', 'refine'] as const)('%s has no top-level oneOf/allOf/anyOf', (mode) => {
    const schema = responseSchema(mode);
    expect(schema.type).toBe('object');
    for (const key of ['oneOf', 'allOf', 'anyOf', 'not', 'enum']) expect(schema).not.toHaveProperty(key);
  });

  it('plan outline asks for exactly one name per day', () => {
    expect(planOutlineSchema(5)).toMatchObject({
      properties: { names: { minItems: 5, maxItems: 5 } },
    });
  });
});
