import { describe, expect, it } from 'vitest';

import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import { FakeSuggestionAgentClient } from '../../../test/fakes/fakeSuggestionAgentClient.js';
import { InMemoryMemoryClient } from '../../../test/fakes/inMemoryMemoryClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { conversationServiceFactory, createConversationHandlers } from './handlers.js';

const scope: ActiveHouseholdScope = { userId: 'u-1', householdId: 'hh-1', role: 'member' };

async function setup() {
  const table = new InMemoryTableClient();
  await new HouseholdRepository(table, 'hh-1').create(sortKeys.grocery('plan-1'), {
    householdId: 'hh-1',
    planId: 'plan-1',
    entries: [{ name: 'rice', quantity: 1, unit: 'cup' }],
    generatedAt: '2025-01-01T00:00:00.000Z',
  });
  const agent = new FakeSuggestionAgentClient();
  const handlers = createConversationHandlers(
    conversationServiceFactory({ table, agent, memory: new InMemoryMemoryClient() }),
  );
  return { handlers, agent };
}

describe('conversation handlers', () => {
  it('creates a conversation (201) and returns a clarification (200)', async () => {
    const { handlers } = await setup();
    const created = await handlers.createConversation(
      { body: JSON.stringify({ targetArtifactType: 'grocery_list', targetArtifactId: 'plan-1' }) },
      scope,
    );
    expect(created.statusCode).toBe(201);
    const { conversation } = JSON.parse(created.body);
    expect(conversation.memorySessionId).toBe(`hh-1:${conversation.conversationId}`);

    const msg = await handlers.postMessage(
      { pathParameters: { id: conversation.conversationId }, body: JSON.stringify({ message: 'remove rice?' }) },
      scope,
    );
    expect(msg.statusCode).toBe(200);
    expect(JSON.parse(msg.body)).toEqual({ outcome: 'clarification', message: 'Could you clarify?' });
  });

  it('maps malformed input to 400 and unknown conversations to 404', async () => {
    const { handlers } = await setup();
    expect((await handlers.createConversation({ body: '{"targetArtifactType":"suggestion","targetArtifactId":"s"}' }, scope)).statusCode).toBe(400);
    expect((await handlers.createConversation({ body: 'not json' }, scope)).statusCode).toBe(400);
    expect((await handlers.postMessage({ pathParameters: { id: 'missing' }, body: '{"message":"hi"}' }, scope)).statusCode).toBe(404);
  });

  it('maps an agent timeout to 504', async () => {
    const { handlers, agent } = await setup();
    const created = await handlers.createConversation(
      { body: JSON.stringify({ targetArtifactType: 'grocery_list', targetArtifactId: 'plan-1' }) },
      scope,
    );
    const { conversation } = JSON.parse(created.body);
    agent.failWith({ kind: 'timeout', timeoutMs: 15_000, message: 'slow' });
    const msg = await handlers.postMessage(
      { pathParameters: { id: conversation.conversationId }, body: '{"message":"remove rice"}' },
      scope,
    );
    expect(msg.statusCode).toBe(504);
  });
});
