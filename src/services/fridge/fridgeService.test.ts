import { beforeEach, describe, expect, it } from 'vitest';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { FridgeService } from './fridgeService.js';
import { createFridgeHandlers, fridgeServiceFactory } from './handlers.js';

const clock = { now: () => new Date('2025-03-03T10:00:00Z') };
let table: InMemoryTableClient;
let service: FridgeService;

const stored = (hh = 'hh1') => table.dump().find((i) => i.PK === `HH#${hh}` && i.SK === sortKeys.fridge());

beforeEach(() => {
  table = new InMemoryTableClient();
  service = new FridgeService({ repository: new HouseholdRepository(table, 'hh1'), clock });
});

describe('FridgeService', () => {
  it('creates the inventory with the shared storage shape (4.3)', async () => {
    const r = await service.replaceInventory({ items: [{ name: 'eggs', quantity: 6, unit: 'piece' }] });
    expect(r.ok).toBe(true);
    const { PK, SK, version, ...attributes } = stored()!;
    expect(version).toBe(1);
    expect(attributes).toEqual({
      householdId: 'hh1',
      items: [{ name: 'eggs', quantity: 6, unit: 'piece' }],
      updatedAt: '2025-03-03T10:00:00.000Z',
    });
  });

  it('replaces the previous inventory entirely and reports dropped items (4.6)', async () => {
    await service.replaceInventory({ items: [{ name: 'eggs', quantity: 6, unit: 'piece' }] });
    const r = await service.replaceInventory({
      items: [{ name: 'milk', quantity: 1, unit: 'l' }, { name: '', quantity: 1, unit: 'g' }],
    });
    expect(r.ok && r.value.droppedIndexes).toEqual([1]);
    expect(r.ok && r.value.version).toBe(2);
    expect(stored()!.items).toEqual([{ name: 'milk', quantity: 1, unit: 'l' }]);
  });

  it('rejects empty or all-invalid recordings and preserves the prior inventory (4.4)', async () => {
    await service.replaceInventory({ items: [{ name: 'eggs', quantity: 6, unit: 'piece' }] });
    const before = stored();
    for (const items of [[], [{ name: 'x', quantity: 0, unit: 'g' }]]) {
      const r = await service.replaceInventory({ items });
      expect(r).toMatchObject({ ok: false, error: { code: 'NO_VALID_ITEMS' } });
    }
    expect(stored()).toEqual(before);
  });

  it('rejects a non-array body before touching storage', async () => {
    const r = await service.replaceInventory({ items: 'eggs' });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(table.calls).toHaveLength(0);
  });

  it('returns NOT_SAVED and leaves the inventory unchanged on a write failure', async () => {
    await service.replaceInventory({ items: [{ name: 'eggs', quantity: 6, unit: 'piece' }] });
    const before = stored();
    table.failNext('put');
    const r = await service.replaceInventory({ items: [{ name: 'milk', quantity: 1, unit: 'l' }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_SAVED' } });
    expect(stored()).toEqual(before);
  });

  it('times out within the deadline and starts no write after it', async () => {
    const origGet = table.get.bind(table);
    table.get = async (key) => {
      await new Promise((r) => setTimeout(r, 50));
      return origGet(key);
    };
    const slow = new FridgeService({ repository: new HouseholdRepository(table, 'hh1'), clock, deadlineMs: 10 });
    const r = await slow.replaceInventory({ items: [{ name: 'eggs', quantity: 1, unit: 'piece' }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    await new Promise((res) => setTimeout(res, 80));
    expect(stored()).toBeUndefined();
  });
});

describe('fridge handlers', () => {
  const scope: ActiveHouseholdScope = { userId: 'u1', householdId: 'hh1', role: 'owner' };
  const parse = (body: string) => JSON.parse(body) as Record<string, any>;

  it('PUT /fridge then GET /fridge round-trips within the Active_Household', async () => {
    const handlers = createFridgeHandlers(fridgeServiceFactory({ tableClient: table, clock }));
    const put = await handlers.replaceInventory({
      scope,
      body: JSON.stringify({ items: [{ name: 'rice', quantity: 500, unit: 'g' }] }),
    });
    expect(put.statusCode).toBe(200);
    const get = await handlers.getInventory({ scope });
    expect(parse(get.body).inventory.items).toEqual([{ name: 'rice', quantity: 500, unit: 'g' }]);
    const otherGet = await handlers.getInventory({ scope: { ...scope, householdId: 'hh2' } });
    expect(parse(otherGet.body)).toEqual({ inventory: null });
  });

  it('maps an empty recording to 400 NO_VALID_ITEMS and bad JSON to 400 INVALID_REQUEST', async () => {
    const handlers = createFridgeHandlers(fridgeServiceFactory({ tableClient: table, clock }));
    const empty = await handlers.replaceInventory({ scope, body: '{"items":[]}' });
    expect(empty.statusCode).toBe(400);
    expect(parse(empty.body).error.code).toBe('NO_VALID_ITEMS');
    const bad = await handlers.replaceInventory({ scope, body: '{' });
    expect(parse(bad.body).error.code).toBe('INVALID_REQUEST');
  });
});
