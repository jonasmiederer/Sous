/**
 * Read-only access to household long-term preference memory for the
 * Suggestion_Agent (design.md, "Soft preferences"; Requirements 12.9–12.11).
 *
 * `SoftPreferenceSource` exposes a single `read` operation. The agent has no
 * code path that appends Conversation turns or writes preference records:
 * the wrapped client is held privately and only `readHouseholdPreferences`
 * is ever called on it. Reads are best-effort and bounded by
 * `SOFT_PREFERENCE_READ_TIMEOUT_MS`; any failure or timeout yields
 * `{ entries: [], degraded: true }` so generation continues without
 * Soft_Preferences (12.10).
 */

import {
  AgentCoreMemoryClient,
  type AgentCoreMemorySender,
  type MemoryClient,
} from '../../src/agent/memoryClient.js';
import type { SoftPreferenceEntry } from './requestParser.js';

/** Long-term memory read budget inside the agent (design.md: 1.5 s). */
export const SOFT_PREFERENCE_READ_TIMEOUT_MS = 1_500;

export interface SoftPreferenceRead {
  entries: SoftPreferenceEntry[];
  /** True when the read failed or timed out and no Soft_Preferences were used. */
  degraded: boolean;
}

export interface SoftPreferenceSource {
  /** Reads namespace `{householdId}`. Never rejects. */
  read(householdId: string, query?: string): Promise<SoftPreferenceRead>;
}

/** The only memory operation the agent depends on. */
export type HouseholdPreferenceReader = Pick<MemoryClient, 'readHouseholdPreferences'>;

const DEGRADED: SoftPreferenceRead = Object.freeze({ entries: [], degraded: true }) as SoftPreferenceRead;

export class MemorySoftPreferenceSource implements SoftPreferenceSource {
  readonly #reader: HouseholdPreferenceReader;
  readonly #timeoutMs: number;

  constructor(reader: HouseholdPreferenceReader, timeoutMs: number = SOFT_PREFERENCE_READ_TIMEOUT_MS) {
    this.#reader = reader;
    this.#timeoutMs = timeoutMs;
  }

  async read(householdId: string, query?: string): Promise<SoftPreferenceRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SoftPreferenceRead>((resolve) => {
      timer = setTimeout(() => resolve({ entries: [], degraded: true }), this.#timeoutMs);
      timer.unref?.();
    });
    const read = (async (): Promise<SoftPreferenceRead> => {
      const options = query !== undefined && query.trim().length > 0 ? { query } : {};
      const result = await this.#reader.readHouseholdPreferences({ householdId }, options);
      return {
        degraded: result.degraded,
        entries: result.entries.map((e) => {
          const entry: SoftPreferenceEntry = { statement: e.statement };
          if (e.polarity !== undefined) entry.polarity = e.polarity;
          return entry;
        }),
      };
    })().catch(() => ({ ...DEGRADED, entries: [] }));
    try {
      return await Promise.race([read, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AgentCoreSoftPreferenceConfig {
  client: AgentCoreMemorySender;
  memoryId: string;
  preferenceStrategyId?: string;
}

/** Soft-preference source over AgentCore Memory with the 1.5 s read timeout. */
export function createAgentCoreSoftPreferenceSource(config: AgentCoreSoftPreferenceConfig): SoftPreferenceSource {
  const memory = new AgentCoreMemoryClient({
    client: config.client,
    memoryId: config.memoryId,
    longTermReadTimeoutMs: SOFT_PREFERENCE_READ_TIMEOUT_MS,
    ...(config.preferenceStrategyId !== undefined ? { preferenceStrategyId: config.preferenceStrategyId } : {}),
  });
  return new MemorySoftPreferenceSource(memory);
}
