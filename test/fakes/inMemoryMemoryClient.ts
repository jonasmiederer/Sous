/**
 * In-memory MemoryClient for tests. Derives namespaces with the same pure
 * builders as AgentCoreMemoryClient, records every namespace it addresses
 * (for Property 34), and supports failure injection. Injected long-term read
 * failures resolve to the degraded result, matching the real client.
 */
import {
  MemoryUnavailableError,
  type ConversationTurn,
  type HouseholdPreferenceRead,
  type HouseholdPreferenceWrite,
  type HouseholdSoftPreference,
  type MemoryClient,
  type ReadPreferencesOptions,
} from '../../src/agent/memoryClient.js';
import {
  longTermNamespace,
  shortTermNamespace,
  type ConversationMemoryScope,
  type HouseholdMemoryScope,
} from '../../src/agent/memoryNamespaces.js';

export type MemoryOperation =
  | 'appendConversationTurn'
  | 'listConversationTurns'
  | 'writeHouseholdPreference'
  | 'readHouseholdPreferences';

export interface MemoryCall {
  op: MemoryOperation;
  memory: 'short-term' | 'long-term';
  namespace: string;
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryMemoryClient implements MemoryClient {
  private readonly turns = new Map<string, ConversationTurn[]>();
  private readonly preferences = new Map<string, HouseholdSoftPreference[]>();
  private readonly failures: Array<{ op: MemoryOperation; error: Error }> = [];

  /** Every addressed namespace, in call order. */
  readonly calls: MemoryCall[] = [];

  /** Makes the next call of `op` fail. Long-term reads degrade instead of throwing. */
  failNext(op: MemoryOperation, error: Error = new MemoryUnavailableError('injected failure')): void {
    this.failures.push({ op, error });
  }

  /** Seeds a long-term preference directly (e.g. as if extracted by AgentCore). */
  seedPreference(scope: HouseholdMemoryScope, preference: HouseholdPreferenceWrite): void {
    const ns = longTermNamespace(scope);
    const list = this.preferences.get(ns) ?? [];
    list.push({ ...clone(preference), householdId: ns });
    this.preferences.set(ns, list);
  }

  /** Namespaces addressed by long-term operations. */
  longTermNamespaces(): string[] {
    return this.calls.filter((c) => c.memory === 'long-term').map((c) => c.namespace);
  }

  private takeFailure(op: MemoryOperation): Error | undefined {
    const i = this.failures.findIndex((f) => f.op === op);
    return i === -1 ? undefined : this.failures.splice(i, 1)[0]?.error;
  }

  async appendConversationTurn(scope: ConversationMemoryScope, turn: ConversationTurn): Promise<void> {
    const ns = shortTermNamespace(scope);
    this.calls.push({ op: 'appendConversationTurn', memory: 'short-term', namespace: ns });
    const failure = this.takeFailure('appendConversationTurn');
    if (failure) throw failure;
    const list = this.turns.get(ns) ?? [];
    list.push(clone(turn));
    this.turns.set(ns, list);
  }

  async listConversationTurns(scope: ConversationMemoryScope): Promise<ConversationTurn[]> {
    const ns = shortTermNamespace(scope);
    this.calls.push({ op: 'listConversationTurns', memory: 'short-term', namespace: ns });
    const failure = this.takeFailure('listConversationTurns');
    if (failure) throw failure;
    const indexed = (this.turns.get(ns) ?? []).map((turn, index) => ({ turn, index }));
    indexed.sort(
      (a, b) => Date.parse(a.turn.timestamp) - Date.parse(b.turn.timestamp) || a.index - b.index,
    );
    return indexed.map((t) => clone(t.turn));
  }

  async writeHouseholdPreference(
    scope: HouseholdMemoryScope,
    preference: HouseholdPreferenceWrite,
  ): Promise<void> {
    const ns = longTermNamespace(scope);
    this.calls.push({ op: 'writeHouseholdPreference', memory: 'long-term', namespace: ns });
    const failure = this.takeFailure('writeHouseholdPreference');
    if (failure) throw failure;
    this.seedPreference(scope, preference);
  }

  async readHouseholdPreferences(
    scope: HouseholdMemoryScope,
    options: ReadPreferencesOptions = {},
  ): Promise<HouseholdPreferenceRead> {
    const ns = longTermNamespace(scope);
    this.calls.push({ op: 'readHouseholdPreferences', memory: 'long-term', namespace: ns });
    if (this.takeFailure('readHouseholdPreferences')) return { entries: [], degraded: true };
    const all = this.preferences.get(ns) ?? [];
    const limited = options.maxResults === undefined ? all : all.slice(0, options.maxResults);
    return { entries: limited.map(clone), degraded: false };
  }
}
