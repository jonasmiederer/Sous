/**
 * Standalone, named shopping lists (not tied to a Meal_Plan).
 *
 * A household can keep several lists, create empty ones, add meal ingredients
 * to any of them, edit them and delete them. Each list is one record at
 * SHOPLIST#{listId}; writes use optimistic concurrency and retry on a lost
 * race. Items added to a list are consolidated with the existing entries
 * (same normalized name and canonical unit are summed).
 */
import { randomUUID } from 'node:crypto';

import { sortKeys, KeyPrefix } from '../../data/keys.js';
import type { HouseholdRepository, StoredRecord } from '../../data/repository.js';
import { consolidateIngredients } from '../../domain/grocery.js';
import type { Ingredient } from '../../domain/types.js';
import {
  GROCERY_ERROR_MESSAGES,
  groceryError,
  type GroceryServiceResult,
} from './errors.js';
import { DEFAULT_MAX_WRITE_ATTEMPTS, MAX_GROCERY_ENTRIES, parseEntries, type Clock } from './groceryService.js';

export const MAX_SHOPPING_LISTS = 50;
export const MAX_LIST_NAME_LENGTH = 80;
export const DEFAULT_LIST_NAME = 'Grocery list';

export interface ShoppingList {
  listId: string;
  name: string;
  entries: Ingredient[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredShoppingList {
  shoppingList: ShoppingList;
  version: number;
}

export interface ShoppingListSummary {
  listId: string;
  name: string;
  itemCount: number;
  updatedAt: string;
}

export interface ShoppingListServiceDeps {
  repository: HouseholdRepository;
  clock: Clock;
  newId?: () => string;
  maxWriteAttempts?: number;
}

const isIngredient = (v: unknown): v is Ingredient =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Ingredient).name === 'string' &&
  typeof (v as Ingredient).quantity === 'number' &&
  typeof (v as Ingredient).unit === 'string';

function parseName(value: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, name: DEFAULT_LIST_NAME };
  if (typeof value !== 'string') return { ok: false, message: '"name" must be a string.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { ok: true, name: DEFAULT_LIST_NAME };
  if (name.length > MAX_LIST_NAME_LENGTH) {
    return { ok: false, message: `"name" must be at most ${MAX_LIST_NAME_LENGTH} characters.` };
  }
  return { ok: true, name };
}

function toShoppingList(listId: string, record: StoredRecord): ShoppingList {
  const a = record.attributes;
  return {
    listId,
    name: typeof a.name === 'string' && a.name !== '' ? a.name : DEFAULT_LIST_NAME,
    entries: Array.isArray(a.entries) ? a.entries.filter(isIngredient).map((e) => ({ ...e })) : [],
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
}

export class ShoppingListService {
  private readonly repo: HouseholdRepository;
  private readonly maxWriteAttempts: number;
  private readonly newId: () => string;

  constructor(private readonly deps: ShoppingListServiceDeps) {
    this.repo = deps.repository;
    this.maxWriteAttempts = Math.max(1, deps.maxWriteAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS);
    this.newId = deps.newId ?? randomUUID;
  }

  /** GET /shopping-lists: all lists, most recently changed first. */
  async list(): Promise<GroceryServiceResult<{ shoppingLists: ShoppingListSummary[] }>> {
    const records = await this.repo.query(KeyPrefix.shoppingList);
    const shoppingLists = records
      .map((r) => {
        const list = toShoppingList(r.sk.slice(KeyPrefix.shoppingList.length), r);
        return { listId: list.listId, name: list.name, itemCount: list.entries.length, updatedAt: list.updatedAt };
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return { ok: true, value: { shoppingLists } };
  }

  /** POST /shopping-lists: create a list, optionally with starting entries (empty by default). */
  async create(input: { name?: unknown; entries?: unknown }): Promise<GroceryServiceResult<StoredShoppingList>> {
    const name = parseName(input.name);
    if (!name.ok) return groceryError('INVALID_REQUEST', name.message);
    let entries: Ingredient[] = [];
    if (input.entries !== undefined) {
      const parsed = parseEntries(input.entries);
      if (!parsed.ok) return groceryError('INVALID_REQUEST', parsed.message);
      entries = consolidateIngredients(parsed.entries);
    }

    const existing = await this.repo.query(KeyPrefix.shoppingList);
    if (existing.length >= MAX_SHOPPING_LISTS) {
      return groceryError('TOO_MANY_SHOPPING_LISTS', GROCERY_ERROR_MESSAGES.tooManyShoppingLists);
    }

    const listId = this.newId();
    const sk = this.sortKey(listId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    const now = this.deps.clock.now().toISOString();
    const attributes = { name: name.name, entries, createdAt: now, updatedAt: now };
    const write = await this.repo.create(sk, attributes);
    if (!write.ok) return groceryError('SAVE_DID_NOT_COMPLETE', GROCERY_ERROR_MESSAGES.saveDidNotComplete);
    return { ok: true, value: { shoppingList: { listId, ...attributes }, version: 1 } };
  }

  /** GET /shopping-lists/{id} */
  async get(listId: unknown): Promise<GroceryServiceResult<StoredShoppingList>> {
    const sk = this.sortKey(listId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    const record = await this.repo.get(sk);
    if (record === undefined) return groceryError('SHOPPING_LIST_NOT_FOUND', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    return { ok: true, value: { shoppingList: toShoppingList(listId as string, record), version: record.version } };
  }

  /** PUT /shopping-lists/{id}: replace the entries and/or rename. Entries are stored as given. */
  async update(listId: unknown, input: { name?: unknown; entries?: unknown }): Promise<GroceryServiceResult<StoredShoppingList>> {
    let newName: string | undefined;
    if (input.name !== undefined) {
      const name = parseName(input.name);
      if (!name.ok) return groceryError('INVALID_REQUEST', name.message);
      newName = name.name;
    }
    let newEntries: Ingredient[] | undefined;
    if (input.entries !== undefined) {
      const parsed = parseEntries(input.entries);
      if (!parsed.ok) return groceryError('INVALID_REQUEST', parsed.message);
      newEntries = parsed.entries;
    }
    if (newName === undefined && newEntries === undefined) {
      return groceryError('INVALID_REQUEST', 'Provide "name" or "entries".');
    }
    return this.mutate(listId, (current) => ({
      name: newName ?? current.name,
      entries: newEntries ?? current.entries,
    }));
  }

  /** POST /shopping-lists/{id}/items: add ingredients, summing those that match an existing entry. */
  async addItems(listId: unknown, items: unknown): Promise<GroceryServiceResult<StoredShoppingList>> {
    const parsed = parseEntries(items);
    if (!parsed.ok) return groceryError('INVALID_REQUEST', parsed.message);
    if (parsed.entries.length === 0) return groceryError('INVALID_REQUEST', '"items" must contain at least one item.');
    return this.mutate(listId, (current) => {
      const entries = consolidateIngredients([...current.entries, ...parsed.entries]);
      return { name: current.name, entries };
    }, (entries) =>
      entries.length > MAX_GROCERY_ENTRIES ? `A list can hold at most ${MAX_GROCERY_ENTRIES} items.` : undefined,
    );
  }

  /** DELETE /shopping-lists/{id} */
  async delete(listId: unknown): Promise<GroceryServiceResult<{ deleted: true }>> {
    const sk = this.sortKey(listId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    if ((await this.repo.get(sk)) === undefined) {
      return groceryError('SHOPPING_LIST_NOT_FOUND', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    }
    const result = await this.repo.delete(sk);
    if (!result.ok) return groceryError('SAVE_DID_NOT_COMPLETE', GROCERY_ERROR_MESSAGES.saveDidNotComplete);
    return { ok: true, value: { deleted: true } };
  }

  private async mutate(
    listId: unknown,
    change: (current: ShoppingList) => { name: string; entries: Ingredient[] },
    validate?: (entries: Ingredient[]) => string | undefined,
  ): Promise<GroceryServiceResult<StoredShoppingList>> {
    const sk = this.sortKey(listId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
    for (let attempt = 0; attempt < this.maxWriteAttempts; attempt++) {
      const record = await this.repo.get(sk);
      if (record === undefined) return groceryError('SHOPPING_LIST_NOT_FOUND', GROCERY_ERROR_MESSAGES.shoppingListNotFound);
      const current = toShoppingList(listId as string, record);
      const next = change(current);
      const problem = validate?.(next.entries);
      if (problem !== undefined) return groceryError('INVALID_REQUEST', problem);

      const updated: ShoppingList = { ...current, ...next, updatedAt: this.deps.clock.now().toISOString() };
      const { listId: _omit, ...attributes } = updated;
      const write = await this.repo.replaceIfVersion(sk, record.version, attributes);
      if (write.ok) return { ok: true, value: { shoppingList: updated, version: record.version + 1 } };
      if (write.error.reason !== 'condition_failed') {
        return groceryError('SAVE_DID_NOT_COMPLETE', GROCERY_ERROR_MESSAGES.saveDidNotComplete);
      }
    }
    return groceryError('GROCERY_CONFLICT', GROCERY_ERROR_MESSAGES.conflict);
  }

  private sortKey(listId: unknown): string | undefined {
    try {
      return sortKeys.shoppingList(listId as string);
    } catch {
      return undefined;
    }
  }
}
