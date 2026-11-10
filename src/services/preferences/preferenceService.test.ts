import { beforeEach, describe, expect, it } from 'vitest';
import { sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { TableItem, WriteCondition } from '../../data/tableClient.js';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { PreferenceService } from './preferenceService.js';

const clock = { now: () => new Date('2025-03-03T10:00:00Z') };
let table: InMemoryTableClient;
let service: PreferenceService;

const stored = () => table.dump().find((i) => i.PK === 'HH#hh1' && i.SK === sortKeys.preferenceProfile());

beforeEach(() => {
  table = new InMemoryTableClient();
  service = new PreferenceService({ repository: new HouseholdRepository(table, 'hh1'), clock });
});

describe('PreferenceService', () => {
  it('creates the profile on first feedback with the shared storage shape (6.1)', async () => {
    const r = await service.recordFeedback({ item: '  Lasagna ', value: 'like' });
    expect(r.ok).toBe(true);
    const { PK, SK, version, ...attributes } = stored()!;
    expect(version).toBe(1);
    expect(attributes).toEqual({
      householdId: 'hh1',
      likes: ['Lasagna'],
      dislikes: [],
      excludedIngredients: [],
      dietaryConstraints: [],
      acceptances: [],
      updatedAt: '2025-03-03T10:00:00.000Z',
    });
  });

  it('latest feedback wins and updates via replaceIfVersion', async () => {
    await service.recordFeedback({ item: 'Curry', value: 'like' });
    const r = await service.recordFeedback({ item: 'curry', value: 'dislike' });
    expect(r.ok && r.value.version).toBe(2);
    expect(stored()!.likes).toEqual([]);
    expect(stored()!.dislikes).toEqual(['curry']);
  });

  it('records acceptances (6.3) and valid dietary constraints (6.5)', async () => {
    await service.recordAcceptance({ mealId: 'meal-1' });
    const r = await service.addDietaryConstraint({ constraint: 'vegetarian' });
    expect(r.ok).toBe(true);
    expect(stored()!.acceptances).toEqual(['meal-1']);
    expect(stored()!.dietaryConstraints).toEqual(['vegetarian']);
  });

  it('rejects invalid constraints with a reason and leaves the profile unchanged (6.6)', async () => {
    await service.addDietaryConstraint({ constraint: 'vegan' });
    const before = stored();
    for (const [constraint, reason] of [
      ['   ', 'empty'],
      ['x'.repeat(201), 'too_long'],
      ['VEGAN', 'duplicate'],
    ] as const) {
      const r = await service.addDietaryConstraint({ constraint });
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_DIETARY_CONSTRAINT', reason } });
    }
    expect(stored()).toEqual(before);
  });

  it('validates request fields before touching storage', async () => {
    expect((await service.recordFeedback({ item: 'Soup', value: 'meh' })).ok).toBe(false);
    expect((await service.recordFeedback({ item: '', value: 'like' })).ok).toBe(false);
    expect((await service.recordFeedback({ item: 42, value: 'like' })).ok).toBe(false);
    expect((await service.recordAcceptance({ mealId: 'm'.repeat(201) })).ok).toBe(false);
    expect((await service.addDietaryConstraint({ constraint: null })).ok).toBe(false);
    expect(table.calls).toHaveLength(0);
  });

  it('returns NOT_SAVED and leaves the stored profile unchanged on a write failure (6.2)', async () => {
    await service.recordFeedback({ item: 'Tacos', value: 'like' });
    const before = stored();
    table.failNext('put');
    const r = await service.recordFeedback({ item: 'Tacos', value: 'dislike' });
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_SAVED' } });
    expect(stored()).toEqual(before);
  });

  it('returns NOT_SAVED on a read failure without writing', async () => {
    table.failNext('get');
    const r = await service.recordAcceptance({ mealId: 'm1' });
    expect(r).toMatchObject({ ok: false, error: { code: 'NOT_SAVED' } });
    expect(stored()).toBeUndefined();
  });

  it('retries on a version conflict and keeps the concurrent writer’s change', async () => {
    await service.recordFeedback({ item: 'Pho', value: 'like' });
    // Another member writes between our read and our write.
    let first = true;
    const origPut = table.put.bind(table);
    table.put = async (item: TableItem, condition?: WriteCondition) => {
      if (first) {
        first = false;
        const other = new PreferenceService({ repository: new HouseholdRepository(table, 'hh1'), clock });
        await other.recordFeedback({ item: 'Ramen', value: 'like' });
      }
      return origPut(item, condition);
    };
    const r = await service.addDietaryConstraint({ constraint: 'no nuts' });
    expect(r.ok).toBe(true);
    expect(stored()!.likes).toEqual(['Pho', 'Ramen']);
    expect(stored()!.dietaryConstraints).toEqual(['no nuts']);
    expect(stored()!.version).toBe(3);
  });

  it('returns PROFILE_CONFLICT when conflicts persist past the attempt limit', async () => {
    await service.recordFeedback({ item: 'Pho', value: 'like' });
    const limited = new PreferenceService({ repository: new HouseholdRepository(table, 'hh1'), clock, maxAttempts: 1 });
    const origGet = table.get.bind(table);
    table.get = async (key) => {
      const item = await origGet(key);
      // Simulate a concurrent commit after our read by bumping the stored version.
      await table.put({ ...item!, version: (item!.version as number) + 1 });
      return item;
    };
    const before = stored();
    const r = await limited.recordFeedback({ item: 'Pho', value: 'dislike' });
    expect(r).toMatchObject({ ok: false, error: { code: 'PROFILE_CONFLICT' } });
    expect(stored()!.likes).toEqual(before!.likes);
  });

  it('times out within the deadline and starts no write after it', async () => {
    const origGet = table.get.bind(table);
    table.get = async (key) => {
      await new Promise((r) => setTimeout(r, 50));
      return origGet(key);
    };
    const slow = new PreferenceService({ repository: new HouseholdRepository(table, 'hh1'), clock, deadlineMs: 10 });
    const r = await slow.recordFeedback({ item: 'Soup', value: 'like' });
    expect(r).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    await new Promise((res) => setTimeout(res, 80));
    expect(stored()).toBeUndefined();
  });

  it('getProfile returns null when absent and the stored profile otherwise', async () => {
    expect(await service.getProfile()).toEqual({ ok: true, value: null });
    await service.recordFeedback({ item: 'Soup', value: 'like' });
    const r = await service.getProfile();
    expect(r.ok && r.value?.profile.likes).toEqual(['Soup']);
  });
});
