import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { createPreferenceHandlers, preferenceServiceFactory } from './handlers.js';

const scope: ActiveHouseholdScope = { userId: 'u1', householdId: 'hh1', role: 'member' };
const other: ActiveHouseholdScope = { userId: 'u2', householdId: 'hh2', role: 'owner' };
let table: InMemoryTableClient;
let handlers: ReturnType<typeof createPreferenceHandlers>;
const parse = (body: string) => JSON.parse(body) as Record<string, any>;

beforeEach(() => {
  table = new InMemoryTableClient();
  handlers = createPreferenceHandlers(
    preferenceServiceFactory({ tableClient: table, clock: { now: () => new Date('2025-03-03T00:00:00Z') } }),
  );
});

describe('preference handlers', () => {
  it('POST /preferences/feedback stores feedback and GET reads it back', async () => {
    const res = await handlers.recordFeedback({ scope, body: JSON.stringify({ item: 'Lasagna', value: 'like' }) });
    expect(res.statusCode).toBe(200);
    expect(parse(res.body).profile.likes).toEqual(['Lasagna']);
    const get = await handlers.getProfile({ scope });
    expect(parse(get.body).profile.likes).toEqual(['Lasagna']);
  });

  it('keeps preferences isolated per Active_Household', async () => {
    await handlers.recordAcceptance({ scope, body: '{"mealId":"m1"}' });
    expect(parse((await handlers.getProfile({ scope: other })).body)).toEqual({ profile: null });
  });

  it('maps validation errors to 400 with a reason for constraints', async () => {
    const bad = await handlers.addDietaryConstraint({ scope, body: JSON.stringify({ constraint: '' }) });
    expect(bad.statusCode).toBe(400);
    expect(parse(bad.body).error).toMatchObject({ code: 'INVALID_DIETARY_CONSTRAINT', reason: 'empty' });
    expect((await handlers.recordFeedback({ scope, body: '{nope' })).statusCode).toBe(400);
    expect((await handlers.recordFeedback({ scope, body: null })).statusCode).toBe(400);
  });

  it('maps a storage failure to 503 NOT_SAVED', async () => {
    table.failNext('put');
    const res = await handlers.recordFeedback({ scope, body: JSON.stringify({ item: 'Soup', value: 'dislike' }) });
    expect(res.statusCode).toBe(503);
    expect(parse(res.body).error.code).toBe('NOT_SAVED');
  });
});
