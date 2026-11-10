/**
 * AgentCore Memory client for Sous (Requirements 1.4, 1.6, 6.2, 9.3, 9.7, 10.6).
 *
 * Short-term memory: Conversation turns are AgentCore events at
 * `actorId = householdId`, `sessionId = conversationId` (logical namespace
 * `{householdId}:{conversationId}`, see memoryNamespaces.ts).
 *
 * Long-term memory: household preference memory records live in the
 * AgentCore namespace `{householdId}`. Every long-term operation takes only an
 * Active_Household scope; the namespace is derived from `householdId` alone,
 * never from a userId or conversationId.
 *
 * Long-term reads are best-effort: on any failure or timeout they resolve to
 * `{ entries: [], degraded: true }` so generation can proceed with the
 * structured Preference_Profile only. Hard exclusions are never enforced here.
 */

import {
  BatchCreateMemoryRecordsCommand,
  CreateEventCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  type BatchCreateMemoryRecordsCommandOutput,
  type Event as AgentCoreEvent,
  type ListEventsCommandOutput,
  type ListMemoryRecordsCommandOutput,
  type MemoryRecordSummary,
  type RetrieveMemoryRecordsCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import type {
  ConversationId,
  HouseholdId,
  HouseholdPreferenceMemoryEntry,
  IsoTimestamp,
  PreferenceMemoryPolarity,
  PreferenceId,
} from '../domain/types.js';
import {
  longTermNamespace,
  shortTermEventAddress,
  validateConversationId,
  type ConversationMemoryScope,
  type HouseholdMemoryScope,
} from './memoryNamespaces.js';

// ---------------------------------------------------------------------------
// Public, mockable interface
// ---------------------------------------------------------------------------

export type ConversationTurnRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationTurnRole;
  text: string;
  timestamp: IsoTimestamp;
}

/**
 * A soft household preference read from long-term memory. Records produced
 * by AgentCore's extraction strategy may lack polarity or a source
 * Conversation, so those fields are optional here.
 */
export interface HouseholdSoftPreference {
  householdId: HouseholdId;
  preferenceId: PreferenceId;
  statement: string;
  polarity?: PreferenceMemoryPolarity;
  sourceConversationId?: ConversationId;
  extractedAt: IsoTimestamp;
}

export interface HouseholdPreferenceRead {
  entries: HouseholdSoftPreference[];
  /** True when the read failed or timed out and the soft bias was omitted. */
  degraded: boolean;
}

export interface ReadPreferencesOptions {
  /** Semantic search query. Omit to list the namespace's records. */
  query?: string;
  maxResults?: number;
}

/** A preference to store in the household's long-term memory. */
export type HouseholdPreferenceWrite = Omit<HouseholdPreferenceMemoryEntry, 'householdId'>;

export interface MemoryClient {
  /** Appends one turn to the Conversation's short-term memory. Throws MemoryUnavailableError. */
  appendConversationTurn(scope: ConversationMemoryScope, turn: ConversationTurn): Promise<void>;
  /** Returns all turns of the Conversation, oldest first. Throws MemoryUnavailableError. */
  listConversationTurns(scope: ConversationMemoryScope): Promise<ConversationTurn[]>;
  /** Stores a soft preference at namespace `{householdId}`. Throws MemoryUnavailableError. */
  writeHouseholdPreference(
    scope: HouseholdMemoryScope,
    preference: HouseholdPreferenceWrite,
  ): Promise<void>;
  /**
   * Best-effort read of namespace `{householdId}`. Never rejects for service
   * failures or timeouts; returns `{ entries: [], degraded: true }` instead.
   * Rejects with InvalidMemoryIdError only for an invalid scope.
   */
  readHouseholdPreferences(
    scope: HouseholdMemoryScope,
    options?: ReadPreferencesOptions,
  ): Promise<HouseholdPreferenceRead>;
}

export class MemoryUnavailableError extends Error {
  override readonly name = 'MemoryUnavailableError';
  readonly code = 'MEMORY_UNAVAILABLE' as const;
  constructor(message = 'Conversation memory is unavailable.', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class MemoryTimeoutError extends Error {
  override readonly name = 'MemoryTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`Memory operation exceeded ${timeoutMs}ms.`);
  }
}

export const DEGRADED_PREFERENCE_READ: Readonly<HouseholdPreferenceRead> = Object.freeze({
  entries: [],
  degraded: true,
});

// ---------------------------------------------------------------------------
// AgentCore-backed implementation
// ---------------------------------------------------------------------------

/** Minimal surface of BedrockAgentCoreClient used here (injectable for tests). */
export interface AgentCoreMemorySender {
  send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface AgentCoreMemoryClientConfig {
  client: AgentCoreMemorySender;
  /** AgentCore Memory resource id or ARN. */
  memoryId: string;
  /** Optional strategy id that holds household preference records. */
  preferenceStrategyId?: string;
  /** Deadline for best-effort long-term reads. Default 2000ms. */
  longTermReadTimeoutMs?: number;
  /** Deadline for short-term operations and long-term writes. Default 5000ms. */
  operationTimeoutMs?: number;
  /** Default page size for long-term reads. Default 50. */
  defaultMaxPreferences?: number;
}

const META_PREFERENCE_ID = 'preferenceId';
const META_POLARITY = 'polarity';
const META_SOURCE_CONVERSATION = 'sourceConversationId';
const META_HOUSEHOLD = 'householdId';
const POLARITIES: readonly PreferenceMemoryPolarity[] = ['like', 'dislike', 'favorite', 'avoid-soft'];
/** Upper bound on ListEvents pages so a runaway pagination cannot hang a request. */
const MAX_EVENT_PAGES = 50;
const MAX_STATEMENT_LENGTH = 2000;

/** Runs `fn` with an AbortSignal and rejects with MemoryTimeoutError after `ms`. */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new MemoryTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Orders turns oldest first; equal timestamps keep their input order. */
export function orderTurns(
  turns: ReadonlyArray<{ turn: ConversationTurn; at: number }>,
): ConversationTurn[] {
  return turns
    .map((t, index) => ({ ...t, index }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((t) => t.turn);
}

function toRole(role: ConversationTurnRole): 'USER' | 'ASSISTANT' {
  return role === 'user' ? 'USER' : 'ASSISTANT';
}

function fromRole(role: string | undefined): ConversationTurnRole | undefined {
  if (role === 'USER') return 'user';
  if (role === 'ASSISTANT') return 'assistant';
  return undefined;
}

function parseTimestamp(value: IsoTimestamp, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp.`);
  }
  return date;
}

function isPolarity(value: unknown): value is PreferenceMemoryPolarity {
  return typeof value === 'string' && (POLARITIES as readonly string[]).includes(value);
}

function metaString(record: MemoryRecordSummary, key: string): string | undefined {
  const value = record.metadata?.[key];
  return value && 'stringValue' in value && typeof value.stringValue === 'string'
    ? value.stringValue
    : undefined;
}

/**
 * Maps a memory record to a soft preference. Records that are not in exactly
 * this Household's namespace, or that carry another Household's id, are
 * dropped (defense in depth for Property 34).
 */
export function recordToPreference(
  householdId: HouseholdId,
  record: MemoryRecordSummary,
): HouseholdSoftPreference | undefined {
  if (!record.namespaces?.includes(householdId)) return undefined;
  const taggedHousehold = metaString(record, META_HOUSEHOLD);
  if (taggedHousehold !== undefined && taggedHousehold !== householdId) return undefined;
  const text = record.content && 'text' in record.content ? record.content.text : undefined;
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;

  const polarity = metaString(record, META_POLARITY);
  const source = metaString(record, META_SOURCE_CONVERSATION);
  const at = record.timestamp ?? record.createdAt;
  const preference: HouseholdSoftPreference = {
    householdId,
    preferenceId: metaString(record, META_PREFERENCE_ID) ?? record.memoryRecordId ?? '',
    statement: text,
    extractedAt: at instanceof Date ? at.toISOString() : new Date(0).toISOString(),
  };
  if (isPolarity(polarity)) preference.polarity = polarity;
  if (source !== undefined) preference.sourceConversationId = source;
  return preference.preferenceId ? preference : undefined;
}

export class AgentCoreMemoryClient implements MemoryClient {
  private readonly client: AgentCoreMemorySender;
  private readonly memoryId: string;
  private readonly preferenceStrategyId: string | undefined;
  private readonly longTermReadTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly defaultMaxPreferences: number;

  constructor(config: AgentCoreMemoryClientConfig) {
    if (!config.memoryId) throw new TypeError('memoryId is required.');
    this.client = config.client;
    this.memoryId = config.memoryId;
    this.preferenceStrategyId = config.preferenceStrategyId;
    this.longTermReadTimeoutMs = config.longTermReadTimeoutMs ?? 2000;
    this.operationTimeoutMs = config.operationTimeoutMs ?? 5000;
    this.defaultMaxPreferences = config.defaultMaxPreferences ?? 50;
  }

  async appendConversationTurn(scope: ConversationMemoryScope, turn: ConversationTurn): Promise<void> {
    const { actorId, sessionId } = shortTermEventAddress(scope);
    if (typeof turn.text !== 'string' || turn.text.length === 0) {
      throw new TypeError('Conversation turn text must be non-empty.');
    }
    const eventTimestamp = parseTimestamp(turn.timestamp, 'turn.timestamp');
    const command = new CreateEventCommand({
      memoryId: this.memoryId,
      actorId,
      sessionId,
      eventTimestamp,
      payload: [{ conversational: { role: toRole(turn.role), content: { text: turn.text } } }],
    });
    await this.run(() => withTimeout(this.operationTimeoutMs, (s) => this.client.send(command, { abortSignal: s })));
  }

  async listConversationTurns(scope: ConversationMemoryScope): Promise<ConversationTurn[]> {
    const { actorId, sessionId } = shortTermEventAddress(scope);
    const events = await this.run(() =>
      withTimeout(this.operationTimeoutMs, async (signal) => {
        const all: AgentCoreEvent[] = [];
        let nextToken: string | undefined;
        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const out = (await this.client.send(
            new ListEventsCommand({
              memoryId: this.memoryId,
              actorId,
              sessionId,
              includePayloads: true,
              ...(nextToken ? { nextToken } : {}),
            }),
            { abortSignal: signal },
          )) as ListEventsCommandOutput;
          all.push(...(out.events ?? []));
          nextToken = out.nextToken;
          if (!nextToken) break;
        }
        return all;
      }),
    );

    const collected: Array<{ turn: ConversationTurn; at: number }> = [];
    for (const event of events) {
      // Defense in depth: ignore anything not addressed to this Household's session.
      if (event.actorId !== actorId || event.sessionId !== sessionId) continue;
      const at = event.eventTimestamp instanceof Date ? event.eventTimestamp.getTime() : 0;
      for (const payload of event.payload ?? []) {
        if (!('conversational' in payload) || !payload.conversational) continue;
        const role = fromRole(payload.conversational.role);
        const content = payload.conversational.content;
        const text = content && 'text' in content ? content.text : undefined;
        if (!role || typeof text !== 'string') continue;
        collected.push({ turn: { role, text, timestamp: new Date(at).toISOString() }, at });
      }
    }
    return orderTurns(collected);
  }

  async writeHouseholdPreference(
    scope: HouseholdMemoryScope,
    preference: HouseholdPreferenceWrite,
  ): Promise<void> {
    const namespace = longTermNamespace(scope);
    validateConversationId(preference.sourceConversationId);
    const statement = preference.statement?.trim() ?? '';
    if (statement.length === 0 || statement.length > MAX_STATEMENT_LENGTH) {
      throw new TypeError(`Preference statement must be 1-${MAX_STATEMENT_LENGTH} characters.`);
    }
    if (!isPolarity(preference.polarity)) throw new TypeError('Unknown preference polarity.');
    if (!preference.preferenceId) throw new TypeError('preferenceId is required.');
    const timestamp = parseTimestamp(preference.extractedAt, 'extractedAt');

    const command = new BatchCreateMemoryRecordsCommand({
      memoryId: this.memoryId,
      records: [
        {
          requestIdentifier: preference.preferenceId,
          namespaces: [namespace],
          content: { text: statement },
          timestamp,
          ...(this.preferenceStrategyId ? { memoryStrategyId: this.preferenceStrategyId } : {}),
          metadata: {
            [META_HOUSEHOLD]: { stringValue: namespace },
            [META_PREFERENCE_ID]: { stringValue: preference.preferenceId },
            [META_POLARITY]: { stringValue: preference.polarity },
            [META_SOURCE_CONVERSATION]: { stringValue: preference.sourceConversationId },
          },
        },
      ],
    });
    const out = (await this.run(() =>
      withTimeout(this.operationTimeoutMs, (s) => this.client.send(command, { abortSignal: s })),
    )) as BatchCreateMemoryRecordsCommandOutput;
    if ((out.failedRecords?.length ?? 0) > 0) {
      throw new MemoryUnavailableError('The preference was not saved to household memory.');
    }
  }

  async readHouseholdPreferences(
    scope: HouseholdMemoryScope,
    options: ReadPreferencesOptions = {},
  ): Promise<HouseholdPreferenceRead> {
    // Invalid scope is a caller bug, not a service failure: let it throw.
    const namespace = longTermNamespace(scope);
    const maxResults = options.maxResults ?? this.defaultMaxPreferences;
    try {
      const records = await withTimeout(this.longTermReadTimeoutMs, async (signal) => {
        const strategy = this.preferenceStrategyId ? { memoryStrategyId: this.preferenceStrategyId } : {};
        if (options.query && options.query.trim().length > 0) {
          const out = (await this.client.send(
            new RetrieveMemoryRecordsCommand({
              memoryId: this.memoryId,
              namespace,
              searchCriteria: { searchQuery: options.query, topK: maxResults, ...strategy },
              maxResults,
            }),
            { abortSignal: signal },
          )) as RetrieveMemoryRecordsCommandOutput;
          return out.memoryRecordSummaries ?? [];
        }
        const out = (await this.client.send(
          new ListMemoryRecordsCommand({ memoryId: this.memoryId, namespace, maxResults, ...strategy }),
          { abortSignal: signal },
        )) as ListMemoryRecordsCommandOutput;
        return out.memoryRecordSummaries ?? [];
      });
      const entries = records
        .map((r) => recordToPreference(namespace, r))
        .filter((p): p is HouseholdSoftPreference => p !== undefined);
      return { entries, degraded: false };
    } catch {
      return { entries: [], degraded: true };
    }
  }

  private async run<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof MemoryUnavailableError) throw err;
      throw new MemoryUnavailableError(undefined, { cause: err });
    }
  }
}
