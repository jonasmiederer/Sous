import { describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../test/fakes/inMemoryTableClient.js';
import { SaveDidNotCompleteError } from './errors.js';
import { KeyPrefix, invitationGsi2, keys, membershipGsi1, sortKeys } from './keys.js';
import { GlobalLookups, HouseholdRepository, TenantIsolationViolationError } from './repository.js';

describe('HouseholdRepository', () => {
  it('scopes every query to the Active_Household partition', async () => {
    const client = new InMemoryTableClient();
    const a = new HouseholdRepository(client, 'hA');
    const b = new HouseholdRepository(client, 'hB');
    await a.create(sortKeys.meal('m1'), { name: 'A meal' });
    await b.create(sortKeys.meal('m1'), { name: 'B meal' });

    const meals = await a.query(KeyPrefix.meal);
    expect(meals.map((m) => m.attributes.name)).toEqual(['A meal']);
    expect((await b.get(sortKeys.meal('m1')))?.attributes.name).toBe('B meal');
    expect(client.calls.filter((c) => c.op === 'query').every((c) => (c.input as { partitionKey: string }).partitionKey === 'HH#hA')).toBe(true);
  });

  it('create fails with save-did-not-complete when the record exists, leaving it unchanged', async () => {
    const client = new InMemoryTableClient();
    const repo = new HouseholdRepository(client, 'h1');
    expect(await repo.create('FRIDGE', { items: [1] })).toEqual({ ok: true });
    const result = await repo.create('FRIDGE', { items: [2] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SaveDidNotCompleteError);
      expect(result.error.reason).toBe('condition_failed');
    }
    expect(await repo.get('FRIDGE')).toEqual({ sk: 'FRIDGE', version: 1, attributes: { items: [1] } });
  });

  it('replaceIfVersion enforces optimistic concurrency and bumps the version', async () => {
    const repo = new HouseholdRepository(new InMemoryTableClient(), 'h1');
    await repo.create('PREFERENCE_PROFILE', { likes: [] });
    expect((await repo.replaceIfVersion('PREFERENCE_PROFILE', 1, { likes: ['x'] })).ok).toBe(true);
    const stale = await repo.replaceIfVersion('PREFERENCE_PROFILE', 1, { likes: ['y'] });
    expect(stale.ok).toBe(false);
    expect(await repo.get('PREFERENCE_PROFILE')).toEqual({ sk: 'PREFERENCE_PROFILE', version: 2, attributes: { likes: ['x'] } });
  });

  it('maps storage failures to save-did-not-complete and leaves prior state unchanged', async () => {
    const client = new InMemoryTableClient();
    const repo = new HouseholdRepository(client, 'h1');
    await repo.upsert('FRIDGE', { items: ['old'] });
    const before = client.dump();
    client.failNext('put');
    const result = await repo.upsert('FRIDGE', { items: ['new'] }, { previousVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('storage_error');
    expect(client.dump()).toEqual(before);
  });

  it('transact is all-or-nothing', async () => {
    const client = new InMemoryTableClient();
    const repo = new HouseholdRepository(client, 'h1');
    await repo.create('META', { name: 'existing' });
    const before = client.dump();
    const result = await repo.transact([
      { kind: 'create', sk: sortKeys.member('u1'), attributes: { role: 'owner' } },
      { kind: 'create', sk: 'META', attributes: { name: 'dup' } },
    ]);
    expect(result.ok).toBe(false);
    expect(client.dump()).toEqual(before);
  });

  it('rejects data-layer-managed attributes', async () => {
    const repo = new HouseholdRepository(new InMemoryTableClient(), 'h1');
    await expect(repo.create('META', { PK: 'HH#other' })).rejects.toThrow(/managed by the data layer/);
  });

  it('rejects items returned from another partition', async () => {
    const client = new InMemoryTableClient();
    client.get = async () => ({ PK: 'HH#other', SK: 'META' });
    await expect(new HouseholdRepository(client, 'h1').get('META')).rejects.toBeInstanceOf(TenantIsolationViolationError);
  });

  it('rejects an invalid Active_Household id', () => {
    expect(() => new HouseholdRepository(new InMemoryTableClient(), 'a#b')).toThrow();
  });
});

describe('GlobalLookups', () => {
  it('lists a user’s households via GSI1 and resolves invitations via GSI2', async () => {
    const client = new InMemoryTableClient();
    for (const h of ['h1', 'h2']) {
      await new HouseholdRepository(client, h).create(sortKeys.member('u1'), { role: 'member' }, {
        indexKeys: membershipGsi1(h, 'u1'),
      });
    }
    await new HouseholdRepository(client, 'h3').create(sortKeys.member('u2'), { role: 'owner' }, {
      indexKeys: membershipGsi1('h3', 'u2'),
    });
    await new HouseholdRepository(client, 'h2').create(sortKeys.invitation('i1'), { status: 'pending' }, {
      indexKeys: invitationGsi2('i1'),
    });

    const lookups = new GlobalLookups(client);
    expect((await lookups.listHouseholdIdsForUser('u1')).sort()).toEqual(['h1', 'h2']);
    expect(await lookups.findInvitationHousehold('i1')).toBe('h2');
    expect(await lookups.findInvitationHousehold('missing')).toBeUndefined();
  });

  it('creates and reads user mirror records', async () => {
    const client = new InMemoryTableClient();
    const lookups = new GlobalLookups(client);
    expect((await lookups.createUser('u1', { identifier: 'a@b.c' })).ok).toBe(true);
    expect((await lookups.createUser('u1', { identifier: 'x@y.z' })).ok).toBe(false);
    expect((await lookups.getUser('u1'))?.attributes).toEqual({ identifier: 'a@b.c' });
    expect(client.dump()[0]).toMatchObject(keys.user('u1'));
  });
});
