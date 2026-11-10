/**
 * Fridge Service core (Requirements 4.3, 4.4, 4.6).
 *
 * Bound to one Active_Household through its HouseholdRepository. PUT /fridge
 * replaces the single FRIDGE record with the recorded items using
 * replaceFridgeInventory from domain/fridge.ts:
 *
 *   - a recording with zero valid items is rejected (NO_VALID_ITEMS) and
 *     nothing is written, so the prior inventory is preserved (4.4);
 *   - otherwise the new inventory contains exactly the valid recorded items
 *     (4.3, 4.6); invalid items are dropped and their indexes reported.
 *
 * Writes use optimistic concurrency (`create` when absent, `replaceIfVersion`
 * otherwise) with a bounded re-read-and-retry on version conflicts. Each write
 * is one conditional PutItem: it commits atomically or leaves the stored
 * inventory unchanged (NOT_SAVED). The operation is raced against a 3s
 * deadline (4.3); after the deadline no new write is started.
 *
 * Stored shape: the record's attributes are exactly the FridgeInventory
 * fields (householdId, items, updatedAt), as read by the other services.
 */
import { sortKeys } from '../../data/keys.js';
import type { Attributes, HouseholdRepository, StoredRecord } from '../../data/repository.js';
import { replaceFridgeInventory } from '../../domain/fridge.js';
import type { FridgeInventory, Ingredient } from '../../domain/types.js';

export const DEFAULT_FRIDGE_DEADLINE_MS = 3_000;
export const DEFAULT_MAX_WRITE_ATTEMPTS = 3;
/** Guard against oversized recordings. */
export const MAX_FRIDGE_ITEMS = 500;

export type FridgeErrorCode = 'INVALID_REQUEST' | 'NO_VALID_ITEMS' | 'FRIDGE_CONFLICT' | 'NOT_SAVED' | 'TIMEOUT';

export interface FridgeError {
  code: FridgeErrorCode;
  message: string;
}

export type FridgeResult<T> = { ok: true; value: T } | { ok: false; error: FridgeError };

export const FRIDGE_ERROR_MESSAGES = {
  noValidItems: 'The fridge recording contains no valid items; the existing inventory was kept.',
  notSaved: 'The fridge inventory was not saved; the previously saved inventory is unchanged.',
  conflict: 'The fridge inventory was changed by someone else at the same time; please try again.',
  timeout:
    'Saving the fridge inventory took too long. Writes are atomic, so it was either fully saved or not at all; reload to check.',
} as const;

const fail = (code: FridgeErrorCode, message: string): { ok: false; error: FridgeError } => ({
  ok: false,
  error: { code, message },
});

export interface Clock {
  now(): Date;
}

export interface FridgeServiceDeps {
  repository: HouseholdRepository;
  clock?: Clock;
  deadlineMs?: number;
  maxAttempts?: number;
}

export interface SavedFridge {
  inventory: FridgeInventory;
  version: number;
}

export interface ReplacedFridge extends SavedFridge {
  /** Indexes (into the submitted items) of entries dropped as invalid. */
  droppedIndexes: number[];
}

const isIngredient = (v: unknown): v is Ingredient =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Ingredient).name === 'string' &&
  typeof (v as Ingredient).quantity === 'number' &&
  typeof (v as Ingredient).unit === 'string';

export function toFridgeInventory(householdId: string, a: Attributes): FridgeInventory {
  return {
    householdId,
    items: Array.isArray(a.items)
      ? a.items.filter(isIngredient).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
      : [],
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
}

/** The exact attribute shape persisted for the FRIDGE record. */
export function fridgeAttributes(inv: FridgeInventory): Attributes {
  return {
    householdId: inv.householdId,
    items: inv.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    updatedAt: inv.updatedAt,
  };
}

const TIMED_OUT = Symbol('timed_out');

export class FridgeService {
  private readonly clock: Clock;
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: FridgeServiceDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_FRIDGE_DEADLINE_MS;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS);
  }

  /** GET /fridge: the stored inventory, or null when none exists yet. */
  async getInventory(): Promise<FridgeResult<SavedFridge | null>> {
    const record = await this.deps.repository.get(sortKeys.fridge());
    if (record === undefined) return { ok: true, value: null };
    return {
      ok: true,
      value: { inventory: toFridgeInventory(this.deps.repository.householdId, record.attributes), version: record.version },
    };
  }

  /** PUT /fridge with `{ items: [{ name, quantity, unit }, ...] }`. */
  async replaceInventory(input: { items?: unknown }): Promise<FridgeResult<ReplacedFridge>> {
    if (!Array.isArray(input.items)) return fail('INVALID_REQUEST', '"items" must be an array.');
    if (input.items.length > MAX_FRIDGE_ITEMS) {
      return fail('INVALID_REQUEST', `"items" must contain at most ${MAX_FRIDGE_ITEMS} entries.`);
    }
    // Empty or all-invalid recordings are rejected before any storage access.
    const probe = replaceFridgeInventory(this.deps.repository.householdId, undefined, input.items, '');
    if (!probe.ok) return fail('NO_VALID_ITEMS', FRIDGE_ERROR_MESSAGES.noValidItems);

    const items: readonly unknown[] = input.items;
    const state = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        state.expired = true;
        resolve(TIMED_OUT);
      }, this.deadlineMs);
    });
    try {
      const result = await Promise.race([this.write(items, state), timeout]);
      return result === TIMED_OUT ? fail('TIMEOUT', FRIDGE_ERROR_MESSAGES.timeout) : result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async write(items: readonly unknown[], state: { expired: boolean }): Promise<FridgeResult<ReplacedFridge>> {
    const repo = this.deps.repository;
    const sk = sortKeys.fridge();
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let record: StoredRecord | undefined;
      try {
        record = await repo.get(sk);
      } catch {
        return fail('NOT_SAVED', FRIDGE_ERROR_MESSAGES.notSaved);
      }
      const prior = record ? toFridgeInventory(repo.householdId, record.attributes) : undefined;
      const result = replaceFridgeInventory(repo.householdId, prior, items, this.clock.now().toISOString());
      if (!result.ok) return fail('NO_VALID_ITEMS', FRIDGE_ERROR_MESSAGES.noValidItems);

      if (state.expired) return fail('TIMEOUT', FRIDGE_ERROR_MESSAGES.timeout);
      const attributes = fridgeAttributes(result.inventory);
      const write = record
        ? await repo.replaceIfVersion(sk, record.version, attributes)
        : await repo.create(sk, attributes);
      if (write.ok) {
        return {
          ok: true,
          value: {
            inventory: result.inventory,
            version: record ? record.version + 1 : 1,
            droppedIndexes: result.droppedIndexes,
          },
        };
      }
      if (write.error.reason !== 'condition_failed') return fail('NOT_SAVED', FRIDGE_ERROR_MESSAGES.notSaved);
    }
    return fail('FRIDGE_CONFLICT', FRIDGE_ERROR_MESSAGES.conflict);
  }
}
