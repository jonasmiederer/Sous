import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { INVITATION_TTL_MS } from '../../domain/invitations.js';
import { GlobalLookups } from '../../data/repository.js';
import { MembershipService, type Caller } from './membershipService.js';

const owner: Caller = { userId: 'owner-1', email: 'owner@example.com' };
const guest: Caller = { userId: 'guest-1', email: 'Guest@Example.com' };
const stranger: Caller = { userId: 'stranger-1', email: 'stranger@example.com' };

describe('MembershipService', () => {
  let table: InMemoryTableClient;
  let clock: number;
  let seq: number;
  let svc: MembershipService;

  beforeEach(() => {
    table = new InMemoryTableClient();
    clock = Date.parse('2025-03-01T10:00:00Z');
    seq = 0;
    svc = new MembershipService({ client: table, now: () => new Date(clock), newId: () => `id-${++seq}` });
  });

  async function newHousehold(): Promise<string> {
    const r = await svc.createHousehold(owner, { name: 'Home' });
    if (!r.ok) throw new Error(r.error.code);
    return r.value.household.householdId;
  }

  async function invite(householdId: string, body: unknown = { email: 'guest@example.com' }): Promise<string> {
    const r = await svc.inviteMember(owner, householdId, body);
    if (!r.ok) throw new Error(r.error.code);
    return r.value.invitationId;
  }

  it('creates a Household with the creator as owner and member, indexed for lookup (10.1)', async () => {
    const r = await svc.createHousehold(owner, { name: '  Home  ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.household).toMatchObject({ name: 'Home', ownerUserId: owner.userId, preferenceMemoryNamespace: r.value.household.householdId });
    expect(r.value.membership.role).toBe('owner');
    expect(await new GlobalLookups(table).listHouseholdIdsForUser(owner.userId)).toEqual([r.value.household.householdId]);
  });

  it('rejects an empty Household name', async () => {
    const r = await svc.createHousehold(owner, { name: '   ' });
    expect(r.ok || r.error.code).toBe('INVALID_REQUEST');
  });

  it('creates pending Invitations only for the owner (10.2)', async () => {
    const hh = await newHousehold();
    const r = await svc.inviteMember(owner, hh, { email: 'guest@example.com' });
    expect(r.ok && r.value).toMatchObject({
      householdId: hh,
      status: 'pending',
      invitee: { kind: 'email', email: 'guest@example.com' },
      expiresAt: new Date(clock + INVITATION_TTL_MS).toISOString(),
    });
    await svc.acceptInvitation(guest, r.ok ? r.value.invitationId : '');
    const nonOwner = await svc.inviteMember(guest, hh, { email: 'x@example.com' });
    expect(nonOwner.ok || nonOwner.error.code).toBe('NOT_HOUSEHOLD_OWNER');
    const nonMember = await svc.inviteMember(stranger, hh, { email: 'x@example.com' });
    expect(nonMember.ok || nonMember.error.code).toBe('NOT_A_MEMBER');
  });

  it('accepts a pending, unexpired Invitation and grants access (10.3)', async () => {
    const hh = await newHousehold();
    const inv = await invite(hh);
    const r = await svc.acceptInvitation(guest, inv);
    expect(r.ok && r.value.membership).toMatchObject({ householdId: hh, userId: guest.userId, role: 'member' });
    const scope = await svc.setActiveHousehold(guest, { householdId: hh });
    expect(scope).toEqual({ ok: true, value: { userId: guest.userId, householdId: hh, role: 'member' } });
    expect(await new GlobalLookups(table).listHouseholdIdsForUser(guest.userId)).toEqual([hh]);
  });

  it('returns one invalid-invitation error for used, declined, expired, unknown, or misaddressed Invitations (10.4, 10.5)', async () => {
    const hh = await newHousehold();

    const used = await invite(hh);
    await svc.acceptInvitation(guest, used);
    const declined = await invite(hh, { email: 'other@example.com' });
    await svc.declineInvitation({ userId: 'other-1', email: 'other@example.com' }, declined);
    const expiring = await invite(hh, { email: 'late@example.com' });
    const misaddressed = await invite(hh, { email: 'someone@example.com' });

    const cases: Array<[Caller, string]> = [
      [guest, used],
      [{ userId: 'other-1', email: 'other@example.com' }, declined],
      [stranger, misaddressed],
      [stranger, 'does-not-exist'],
      [stranger, 'bad#id'],
    ];
    for (const [caller, id] of cases) {
      const r = await svc.acceptInvitation(caller, id);
      expect(r.ok || r.error.code).toBe('INVALID_INVITATION');
    }

    clock += INVITATION_TTL_MS; // exactly at expiry
    const late = await svc.acceptInvitation({ userId: 'late-1', email: 'late@example.com' }, expiring);
    expect(late.ok || late.error.code).toBe('INVALID_INVITATION');
    // No member was added by any rejected acceptance.
    const members = table.dump().filter((i) => i.PK === `HH#${hh}` && i.SK.startsWith('MEMBER#'));
    expect(members.map((m) => m.userId).sort()).toEqual([guest.userId, owner.userId]);
  });

  it('leaves the Invitation pending when the acceptance save fails', async () => {
    const hh = await newHousehold();
    const inv = await invite(hh);
    table.failNext('transactWrite');
    const r = await svc.acceptInvitation(guest, inv);
    expect(r.ok || r.error.code).toBe('SAVE_DID_NOT_COMPLETE');
    expect((await svc.acceptInvitation(guest, inv)).ok).toBe(true);
  });

  it('lets the owner remove a member, revoking access (10.7)', async () => {
    const hh = await newHousehold();
    await svc.acceptInvitation(guest, await invite(hh));

    const notOwner = await svc.removeMember(guest, hh, owner.userId);
    expect(notOwner.ok || notOwner.error.code).toBe('NOT_HOUSEHOLD_OWNER');

    const r = await svc.removeMember(owner, hh, guest.userId);
    expect(r.ok && r.value.removed.userId).toBe(guest.userId);
    const scope = await svc.setActiveHousehold(guest, { householdId: hh });
    expect(scope.ok || scope.error.code).toBe('NOT_A_MEMBER');
  });

  it('never removes the Household_Owner (10.8)', async () => {
    const hh = await newHousehold();
    const r = await svc.removeMember(owner, hh, owner.userId);
    expect(r.ok || r.error.code).toBe('CANNOT_REMOVE_OWNER');
    expect((await svc.setActiveHousehold(owner, { householdId: hh })).ok).toBe(true);
  });

  it('lists only Households whose membership exists in the base table (13.6)', async () => {
    const a = await newHousehold();
    const b = await newHousehold();
    await svc.acceptInvitation(guest, await invite(a));
    await svc.acceptInvitation(guest, await invite(b));
    await svc.removeMember(owner, b, guest.userId);
    // Simulate GSI1 lag: a stale index entry still points the guest at Household b.
    await table.put({ PK: 'STALE', SK: 'X', GSI1PK: `USER#${guest.userId}`, GSI1SK: `HH#${b}` });

    const guestList = await svc.listHouseholds(guest);
    expect(guestList).toEqual({
      ok: true,
      value: { households: [{ householdId: a, name: 'Home', role: 'member', ownerUserId: owner.userId }] },
    });
    const ownerList = await svc.listHouseholds(owner);
    expect(ownerList.ok && ownerList.value.households.map((h) => [h.householdId, h.role]).sort()).toEqual(
      [[a, 'owner'], [b, 'owner']].sort(),
    );
    expect(await svc.listHouseholds(stranger)).toEqual({ ok: true, value: { households: [] } });
  });

  it('lists members with email from the USER# mirror only to members (13.8, 1.5)', async () => {
    const hh = await newHousehold();
    await svc.acceptInvitation(guest, await invite(hh));
    await new GlobalLookups(table).createUser(owner.userId, { userId: owner.userId, identifier: 'owner@example.com' });

    const r = await svc.listMembers(guest, hh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = Object.fromEntries(r.value.members.map((m) => [m.userId, m]));
    expect(byId[owner.userId]).toEqual({
      userId: owner.userId,
      email: 'owner@example.com',
      role: 'owner',
      joinedAt: new Date(clock).toISOString(),
    });
    // No mirror record for the guest: email is omitted.
    expect(byId[guest.userId]).toEqual({ userId: guest.userId, role: 'member', joinedAt: new Date(clock).toISOString() });

    for (const id of [hh, 'unknown', 'bad#id', undefined]) {
      const denied = await svc.listMembers(stranger, id);
      expect(denied.ok || denied.error.code).toBe('NOT_A_MEMBER');
    }
  });

  it('scopes the Active_Household only to Households the user belongs to (10.6)', async () => {
    const a = await newHousehold();
    const b = await newHousehold();
    expect(await svc.setActiveHousehold(owner, { householdId: b })).toEqual({
      ok: true,
      value: { userId: owner.userId, householdId: b, role: 'owner' },
    });
    for (const householdId of [a, 'unknown', 'bad#id', undefined]) {
      const r = await svc.setActiveHousehold(stranger, { householdId });
      expect(r.ok || r.error.code).toBe('NOT_A_MEMBER');
    }
  });
});
