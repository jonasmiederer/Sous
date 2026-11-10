import { beforeEach, describe, expect, it } from 'vitest';

import type { PutEventsCommand, PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import { FakeSuggestionAgentClient } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { EventBridgePlanEventPublisher, type MealPlanChangedEvent } from './events.js';
import { createPlanHandlers, planServiceFactory } from './handlers.js';
import { InMemoryPlanEventPublisher } from './testing/inMemoryPlanEventPublisher.js';

const scope: ActiveHouseholdScope = { userId: 'u1', householdId: 'hh1', role: 'owner' };

let table: InMemoryTableClient;
let handlers: ReturnType<typeof createPlanHandlers>;

beforeEach(async () => {
  table = new InMemoryTableClient();
  let n = 0;
  handlers = createPlanHandlers(
    planServiceFactory({
      tableClient: table,
      agent: new FakeSuggestionAgentClient(),
      events: new InMemoryPlanEventPublisher(),
      clock: { now: () => new Date('2025-03-03T00:00:00Z') },
      ids: { next: () => `id${++n}` },
    }),
  );
  await new HouseholdRepository(table, 'hh1').upsert(sortKeys.preferenceProfile(), {
    likes: [], dislikes: [], excludedIngredients: [], dietaryConstraints: [], acceptances: [],
  });
});

const parse = (body: string) => JSON.parse(body) as Record<string, any>;

describe('plan handlers', () => {
  it('POST /plans returns 201 with the plan scoped to the Active_Household', async () => {
    const res = await handlers.generatePlan({ scope, body: JSON.stringify({ weekly: true }) });
    expect(res.statusCode).toBe(201);
    const body = parse(res.body);
    expect(body.plan.householdId).toBe('hh1');
    expect(body.plan.days).toHaveLength(7);
  });

  it('maps validation failures to 400 and malformed JSON to INVALID_REQUEST', async () => {
    const range = await handlers.generatePlan({ scope, body: JSON.stringify({ rangeDays: 40 }) });
    expect(range.statusCode).toBe(400);
    expect(parse(range.body).error.code).toBe('INVALID_RANGE');

    const bad = await handlers.generatePlan({ scope, body: '{nope' });
    expect(bad.statusCode).toBe(400);
    expect(parse(bad.body).error.code).toBe('INVALID_REQUEST');
  });

  it('does not reach another Household’s plan', async () => {
    const created = parse((await handlers.generatePlan({ scope, body: '{"rangeDays":2}' })).body);
    const other: ActiveHouseholdScope = { userId: 'u2', householdId: 'hh2', role: 'owner' };
    const res = await handlers.removeDay({ scope: other, pathParameters: { id: created.plan.planId, day: '2025-03-03' } });
    expect(res.statusCode).toBe(404);
  });

  it('PUT, POST and DELETE day endpoints edit the plan', async () => {
    const created = parse((await handlers.generatePlan({ scope, body: '{"rangeDays":2}' })).body);
    const id = created.plan.planId;

    const put = await handlers.replaceDay({ scope, pathParameters: { id, day: '2025-03-04' }, body: null });
    expect(put.statusCode).toBe(200);
    expect(parse(put.body).change).toBe('day_replaced');

    const post = await handlers.addDay({ scope, pathParameters: { id }, body: '{"day":"2025-03-05"}' });
    expect(post.statusCode).toBe(201);
    expect(parse(post.body).plan.days).toHaveLength(3);

    const del = await handlers.removeDay({ scope, pathParameters: { id, day: '2025-03-03' } });
    expect(del.statusCode).toBe(200);
    expect(parse(del.body).plan.days.map((d: { day: string }) => d.day)).toEqual(['2025-03-04', '2025-03-05']);
  });
});

describe('EventBridgePlanEventPublisher', () => {
  const event: MealPlanChangedEvent = {
    type: 'MealPlanChanged',
    householdId: 'hh1',
    planId: 'p1',
    change: 'day_removed',
    day: '2025-03-03',
    planVersion: 2,
    occurredAt: '2025-03-03T00:00:00.000Z',
  };

  it('sends one MealPlanChanged entry to the configured bus', async () => {
    const sent: PutEventsCommand[] = [];
    const publisher = new EventBridgePlanEventPublisher({
      eventBusName: 'sous-bus',
      client: { send: async (c) => (sent.push(c), { FailedEntryCount: 0, Entries: [{}], $metadata: {} }) },
    });
    await publisher.publishMealPlanChanged(event);
    const entry = sent[0]?.input.Entries?.[0];
    expect(entry).toMatchObject({ EventBusName: 'sous-bus', Source: 'sous.plans', DetailType: 'MealPlanChanged' });
    expect(JSON.parse(entry?.Detail ?? '')).toEqual(event);
  });

  it('rejects when EventBridge reports a failed entry', async () => {
    const output: PutEventsCommandOutput = {
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'InternalFailure', ErrorMessage: 'x' }],
      $metadata: {},
    };
    const publisher = new EventBridgePlanEventPublisher({ eventBusName: 'b', client: { send: async () => output } });
    await expect(publisher.publishMealPlanChanged(event)).rejects.toThrow('InternalFailure');
  });
});
