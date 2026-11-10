import {
  BatchCreateMemoryRecordsCommand,
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it } from 'vitest';
import { InMemoryMemoryClient } from '../../test/fakes/inMemoryMemoryClient.js';
import {
  AgentCoreMemoryClient,
  MemoryUnavailableError,
  type AgentCoreMemorySender,
} from './memoryClient.js';

type Handler = (command: object, signal?: AbortSignal) => Promise<unknown>;

/** Records real SDK command objects and answers with a scripted handler. */
function sender(handler: Handler): AgentCoreMemorySender & { commands: object[] } {
  const commands: object[] = [];
  return {
    commands,
    send(command, options) {
      commands.push(command);
      return handler(command, options?.abortSignal);
    },
  };
}

const MEMORY_ID = 'sousMemory-abcdefghij';
const hh = { householdId: 'hh-1', userId: 'user-42', role: 'member' as const };
const conv = { householdId: 'hh-1', conversationId: 'conv-1' };

const record = (id: string, text: string, namespaces: string[], meta: Record<string, string> = {}) => ({
  memoryRecordId: id,
  content: { text },
  memoryStrategyId: 'pref',
  namespaces,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  metadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { stringValue: v }])),
});

it('accepts the real BedrockAgentCoreClient as its sender', () => {
  const sdk: AgentCoreMemorySender = new BedrockAgentCoreClient({ region: 'us-east-1' });
  expect(() => new AgentCoreMemoryClient({ client: sdk, memoryId: MEMORY_ID })).not.toThrow();
});

describe('AgentCoreMemoryClient short-term memory', () => {
  it('writes a turn as a conversational event addressed by household actor and conversation session', async () => {
    const s = sender(async () => ({}));
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await client.appendConversationTurn(conv, {
      role: 'user',
      text: 'make it spicier',
      timestamp: '2025-01-01T10:00:00.000Z',
    });
    const cmd = s.commands[0];
    expect(cmd).toBeInstanceOf(CreateEventCommand);
    expect((cmd as CreateEventCommand).input).toMatchObject({
      memoryId: MEMORY_ID,
      actorId: 'hh-1',
      sessionId: 'conv-1',
      payload: [{ conversational: { role: 'USER', content: { text: 'make it spicier' } } }],
    });
  });

  it('lists turns oldest first across pages, keeping input order for equal timestamps', async () => {
    const ev = (id: string, iso: string, role: 'USER' | 'ASSISTANT', text: string) => ({
      memoryId: MEMORY_ID,
      actorId: 'hh-1',
      sessionId: 'conv-1',
      eventId: id,
      eventTimestamp: new Date(iso),
      payload: [{ conversational: { role, content: { text } } }],
    });
    const pages = [
      { events: [ev('3', '2025-01-01T10:02:00Z', 'USER', 'c'), ev('2', '2025-01-01T10:01:00Z', 'ASSISTANT', 'b1')], nextToken: 't' },
      {
        events: [
          ev('2b', '2025-01-01T10:01:00Z', 'ASSISTANT', 'b2'),
          ev('1', '2025-01-01T10:00:00Z', 'USER', 'a'),
          // Foreign event must be ignored even if the service returned it.
          { ...ev('x', '2025-01-01T09:00:00Z', 'USER', 'leak'), actorId: 'hh-2' },
        ],
      },
    ];
    let call = 0;
    const s = sender(async () => pages[call++]);
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    const turns = await client.listConversationTurns(conv);
    expect(turns.map((t) => t.text)).toEqual(['a', 'b1', 'b2', 'c']);
    expect(turns[0]).toEqual({ role: 'user', text: 'a', timestamp: '2025-01-01T10:00:00.000Z' });
    expect(s.commands).toHaveLength(2);
    expect((s.commands[1] as ListEventsCommand).input).toMatchObject({ nextToken: 't', actorId: 'hh-1' });
  });

  it('wraps short-term service failures in MemoryUnavailableError', async () => {
    const s = sender(async () => {
      throw new Error('ThrottlingException');
    });
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await expect(client.listConversationTurns(conv)).rejects.toBeInstanceOf(MemoryUnavailableError);
  });
});

describe('AgentCoreMemoryClient long-term memory', () => {
  it('writes a preference record only into the household namespace, without a userId', async () => {
    const s = sender(async () => ({ successfulRecords: [], failedRecords: [] }));
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await client.writeHouseholdPreference(hh, {
      preferenceId: 'p1',
      statement: "I don't like coconut",
      polarity: 'dislike',
      sourceConversationId: 'conv-1',
      extractedAt: '2025-01-01T00:00:00.000Z',
    });
    const input = (s.commands[0] as BatchCreateMemoryRecordsCommand).input;
    expect(input.records?.[0]?.namespaces).toEqual(['hh-1']);
    expect(JSON.stringify(input)).not.toContain('user-42');
  });

  it('lists the household namespace and drops records from other namespaces', async () => {
    const s = sender(async () => ({
      memoryRecordSummaries: [
        record('r1', 'favourite meal is lasagna', ['hh-1'], { polarity: 'favorite' }),
        record('r2', 'other household', ['hh-2']),
      ],
    }));
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    const read = await client.readHouseholdPreferences(hh);
    expect(s.commands[0]).toBeInstanceOf(ListMemoryRecordsCommand);
    expect((s.commands[0] as ListMemoryRecordsCommand).input.namespace).toBe('hh-1');
    expect(read).toEqual({
      degraded: false,
      entries: [
        {
          householdId: 'hh-1',
          preferenceId: 'r1',
          statement: 'favourite meal is lasagna',
          polarity: 'favorite',
          extractedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('uses semantic retrieval when a query is given', async () => {
    const s = sender(async () => ({ memoryRecordSummaries: [] }));
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await client.readHouseholdPreferences(hh, { query: 'dinner ideas', maxResults: 5 });
    const cmd = s.commands[0] as RetrieveMemoryRecordsCommand;
    expect(cmd).toBeInstanceOf(RetrieveMemoryRecordsCommand);
    expect(cmd.input).toMatchObject({ namespace: 'hh-1', searchCriteria: { searchQuery: 'dinner ideas', topK: 5 } });
  });

  it('degrades to an empty soft bias when the read fails', async () => {
    const s = sender(async () => {
      throw new Error('ServiceUnavailable');
    });
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await expect(client.readHouseholdPreferences(hh)).resolves.toEqual({ entries: [], degraded: true });
  });

  it('degrades on timeout and aborts the in-flight request', async () => {
    let aborted = false;
    const s = sender(
      (_cmd, signal) =>
        new Promise(() => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    );
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID, longTermReadTimeoutMs: 20 });
    await expect(client.readHouseholdPreferences(hh)).resolves.toEqual({ entries: [], degraded: true });
    expect(aborted).toBe(true);
  });

  it('rejects an invalid household scope before calling the service', async () => {
    const s = sender(async () => ({ memoryRecordSummaries: [] }));
    const client = new AgentCoreMemoryClient({ client: s, memoryId: MEMORY_ID });
    await expect(client.readHouseholdPreferences({ householdId: 'hh-1:x' })).rejects.toThrow();
    expect(s.commands).toHaveLength(0);
  });
});

describe('InMemoryMemoryClient fake', () => {
  it('records namespaces, shares preferences household-wide, and degrades on injected read failure', async () => {
    const fake = new InMemoryMemoryClient();
    await fake.writeHouseholdPreference(
      { householdId: 'hh-1' },
      { preferenceId: 'p1', statement: 'no coconut', polarity: 'dislike', sourceConversationId: 'c1', extractedAt: '2025-01-01T00:00:00.000Z' },
    );
    const otherMemberScope = { ...hh, userId: 'user-7' };
    const otherMember = await fake.readHouseholdPreferences(otherMemberScope);
    expect(otherMember.entries.map((e) => e.statement)).toEqual(['no coconut']);
    expect((await fake.readHouseholdPreferences({ householdId: 'hh-2' })).entries).toEqual([]);
    expect(fake.longTermNamespaces()).toEqual(['hh-1', 'hh-1', 'hh-2']);

    fake.failNext('readHouseholdPreferences');
    expect(await fake.readHouseholdPreferences(hh)).toEqual({ entries: [], degraded: true });
  });

  it('returns short-term turns oldest first', async () => {
    const fake = new InMemoryMemoryClient();
    await fake.appendConversationTurn(conv, { role: 'assistant', text: 'b', timestamp: '2025-01-01T10:01:00Z' });
    await fake.appendConversationTurn(conv, { role: 'user', text: 'a', timestamp: '2025-01-01T10:00:00Z' });
    expect((await fake.listConversationTurns(conv)).map((t) => t.text)).toEqual(['a', 'b']);
    expect(fake.calls[0]?.namespace).toBe('hh-1:conv-1');
  });
});
