import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { GSI3_NAME, PENDING_INVITATIONS_GSI3PK, sortKeys } from '../../data/keys.js';
import { GlobalLookups, HouseholdRepository } from '../../data/repository.js';
import { INVITATION_TTL_MS } from '../../domain/invitations.js';
import type { Invitation } from '../../domain/types.js';
import { dueBefore, sweepPendingInvitations } from './expirySweep.js';
import { MembershipService, type Caller } from './membershipService.js';

const owner: Caller = { userId: 'owner-1', email: 'owner@example.com' };
const guest: Caller = { userId: 'guest-1', email: 'guest@example.com' };
const T0 = Date.parse('2025-03-01T10:00:00.000Z');

describe('sweepPendingInvitations', () => {
  let table: InMemoryTableClient;
  let clock: number;
  let seq: number;
  let svc: MembershipService;
  let householdId: string;

  beforeEach(async () => {
    table = new InMemoryTableClient();
    clock = T0;
    seq = 0;
    svc = new MembershipService({ client: table, now: () => new Date(clock), newId: () => `id-${++seq}` });
    const hh = await svc.createHousehold(owner, { name: 'Home' });
    if (!hh.ok) throw new Error(hh.error.code);
    householdId = hh.value.household.householdId;
  });

  async function invite(email: string): Promise<string> {
    const r = await svc.inviteMember(owner, householdId, { email });
    if (!r.ok) throw new Error(r.error.code);
    return r.value.invitationId;
  }

  async function status(invitationId: string): Promise<string | undefined> {
    const rec = await new HouseholdRepository(table, householdId).get<Invitation & Record<string, unknown>>(
      sortKeys.invitation(invitationId),
    );
    return rec?.attributes.status;
  }

  const pendingIndex = async () =>
    (await table.query({ indexName: GSI3_NAME, partitionKey: PENDING_INVITATIONS_GSI3PK })).items.length;

  it('expires pending invitations at exactly 7 days and leaves younger ones pending', async () => {
    const old = await invite('a@example.com');
    clock = T0 + 1;
    const young = await invite('b@example.com');

    const r = await sweepPendingInvitations(table, new Date(T0 + INVITATION_TTL_MS));
    expect(r).toEqual({ examined: 1, expired: 1, skipped: 0, failed: 0 });
    expect(await status(old)).toBe('expired');
    expect(await status(young)).toBe('pending');
    // The expired invitation leaves the sparse index but keeps its GSI2 lookup.
    expect(await pendingIndex()).toBe(1);
    expect(await new GlobalLookups(table).findInvitationHousehold(old)).toBe(householdId);

    // Re-running is a no-op for already expired invitations.
    expect((await sweepPendingInvitations(table, new Date(T0 + INVITATION_TTL_MS))).expired).toBe(0);
  });

  it('never overwrites an accepted or declined invitation', async () => {
    const accepted = await invite('guest@example.com');
    const declined = await invite('c@example.com');
    expect((await svc.acceptInvitation(guest, accepted)).ok).toBe(true);
    expect((await svc.declineInvitation({ userId: 'c', email: 'c@example.com' }, declined)).ok).toBe(true);
    expect(await pendingIndex()).toBe(0);

    const r = await sweepPendingInvitations(table, new Date(T0 + 2 * INVITATION_TTL_MS));
    expect(r.expired).toBe(0);
    expect(await status(accepted)).toBe('accepted');
    expect(await status(declined)).toBe('declined');
  });

  it('skips an invitation that changed between the index read and the write', async () => {
    const id = await invite('guest@example.com');
    const repo = new HouseholdRepository(table, householdId);
    const rec = await repo.get<Invitation & Record<string, unknown>>(sortKeys.invitation(id));
    // Simulate a concurrent accept that bumps the version after the sweep's read.
    const realGet = table.get.bind(table);
    table.get = async (key) => {
      const item = await realGet(key);
      if (key.SK === sortKeys.invitation(id)) {
        await repo.replaceIfVersion(rec!.sk, rec!.version, { ...rec!.attributes, status: 'accepted' });
      }
      return item;
    };
    const r = await sweepPendingInvitations(table, new Date(T0 + INVITATION_TTL_MS));
    expect(r).toMatchObject({ expired: 0, skipped: 1, failed: 0 });
    table.get = realGet;
    expect(await status(id)).toBe('accepted');
  });

  it('counts storage failures without aborting the run', async () => {
    await invite('a@example.com');
    await invite('b@example.com');
    table.failNext('get');
    const r = await sweepPendingInvitations(table, new Date(T0 + INVITATION_TTL_MS), { warn: () => undefined });
    expect(r).toMatchObject({ examined: 2, expired: 1, failed: 1 });
  });

  it('dueBefore covers expiresAt == now and excludes later expiries', () => {
    const now = new Date(T0);
    expect(`${now.toISOString()}#id` < dueBefore(now)).toBe(true);
    expect(`${new Date(T0 + 1).toISOString()}#id` < dueBefore(now)).toBe(false);
  });
});
