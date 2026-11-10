import { describe, expect, it } from 'vitest';
import { createHousehold } from './household.js';
import {
  acceptInvitation,
  createInvitation,
  declineInvitation,
  effectiveStatus,
  isInvalidInvitationError,
  sweepExpiredInvitations,
} from './invitations.js';
import type { Household, Invitation, Membership } from './types.js';

const CREATED = '2025-01-01T00:00:00.000Z';
const EXPIRES = '2025-01-08T00:00:00.000Z';
const JUST_BEFORE_EXPIRY = '2025-01-07T23:59:59.999Z';

function setup(): { household: Household; memberships: Membership[] } {
  const r = createHousehold({ householdId: 'h1', name: 'Home', creatorUserId: 'owner', createdAt: CREATED });
  if (!r.ok) throw new Error('setup failed');
  return { household: r.value.household, memberships: [r.value.ownerMembership] };
}

function invite(invitee: Invitation['invitee'] = { kind: 'email', email: 'bob@example.com' }): Invitation {
  const { household } = setup();
  const r = createInvitation({ household, actorUserId: 'owner', invitationId: 'i1', invitee, now: CREATED });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const bob = { userId: 'bob', email: 'Bob@Example.com' };

describe('createInvitation', () => {
  it('creates a pending invitation for the household and invitee expiring 7 days later', () => {
    const { household } = setup();
    const r = createInvitation({
      household,
      actorUserId: 'owner',
      invitationId: 'i1',
      invitee: { kind: 'email', email: '  Bob@Example.COM ' },
      now: CREATED,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        invitationId: 'i1',
        householdId: 'h1',
        invitee: { kind: 'email', email: 'bob@example.com' },
        status: 'pending',
        createdAt: CREATED,
        expiresAt: EXPIRES,
      },
    });
  });

  it('accepts a user-id invitee', () => {
    expect(invite({ kind: 'userId', userId: 'bob' }).invitee).toEqual({ kind: 'userId', userId: 'bob' });
  });

  it('rejects invitations from a non-owner', () => {
    const { household } = setup();
    const r = createInvitation({
      household,
      actorUserId: 'alice',
      invitationId: 'i1',
      invitee: { kind: 'email', email: 'bob@example.com' },
      now: CREATED,
    });
    expect(r.ok === false && r.error.code).toBe('NOT_HOUSEHOLD_OWNER');
  });

  it.each([
    { kind: 'email' as const, email: '' },
    { kind: 'email' as const, email: 'not-an-email' },
    { kind: 'email' as const, email: 'a b@example.com' },
    { kind: 'userId' as const, userId: '   ' },
  ])('rejects invalid invitee %j', (invitee) => {
    const { household } = setup();
    const r = createInvitation({ household, actorUserId: 'owner', invitationId: 'i1', invitee, now: CREATED });
    expect(r.ok === false && r.error.code).toBe('INVALID_INVITATION_INPUT');
  });

  it('rejects an invalid creation timestamp', () => {
    const { household } = setup();
    const r = createInvitation({
      household,
      actorUserId: 'owner',
      invitationId: 'i1',
      invitee: { kind: 'userId', userId: 'bob' },
      now: 'not-a-date',
    });
    expect(r.ok === false && r.error.code).toBe('INVALID_INVITATION_INPUT');
  });
});

describe('acceptInvitation', () => {
  it('adds the invitee as a member just before the 7-day boundary', () => {
    const { memberships } = setup();
    const inv = invite();
    const r = acceptInvitation(inv, bob, memberships, JUST_BEFORE_EXPIRY);
    expect(r).toEqual({
      ok: true,
      value: {
        invitation: { ...inv, status: 'accepted' },
        membership: { householdId: 'h1', userId: 'bob', role: 'member', joinedAt: JUST_BEFORE_EXPIRY },
      },
    });
    expect(inv.status).toBe('pending');
  });

  it('rejects acceptance at exactly 7 days as expired', () => {
    const { memberships } = setup();
    const r = acceptInvitation(invite(), bob, memberships, EXPIRES);
    expect(r.ok === false && r.error.code).toBe('INVITATION_EXPIRED');
  });

  it.each([
    ['accepted', 'INVITATION_ALREADY_USED'],
    ['declined', 'INVITATION_DECLINED'],
    ['expired', 'INVITATION_EXPIRED'],
  ] as const)('rejects a %s invitation with %s', (status, code) => {
    const { memberships } = setup();
    const r = acceptInvitation({ ...invite(), status }, bob, memberships, CREATED);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(isInvalidInvitationError(r.error)).toBe(true);
    }
  });

  it('rejects acceptance by someone other than the invitee', () => {
    const { memberships } = setup();
    const r = acceptInvitation(invite(), { userId: 'eve', email: 'eve@example.com' }, memberships, CREATED);
    expect(r.ok === false && r.error.code).toBe('INVITATION_INVALID');
    const byId = acceptInvitation(invite({ kind: 'userId', userId: 'bob' }), { userId: 'eve' }, memberships, CREATED);
    expect(byId.ok === false && byId.error.code).toBe('INVITATION_INVALID');
  });

  it('rejects acceptance by an existing member', () => {
    const { memberships } = setup();
    const existing: Membership = { householdId: 'h1', userId: 'bob', role: 'member', joinedAt: CREATED };
    const r = acceptInvitation(invite(), bob, [...memberships, existing], CREATED);
    expect(r.ok === false && r.error.code).toBe('ALREADY_A_MEMBER');
  });
});

describe('declineInvitation', () => {
  it('declines a pending invitation', () => {
    const inv = invite();
    expect(declineInvitation(inv, bob, CREATED)).toEqual({ ok: true, value: { ...inv, status: 'declined' } });
  });

  it('rejects declining an already-accepted or expired invitation', () => {
    const accepted = declineInvitation({ ...invite(), status: 'accepted' }, bob, CREATED);
    expect(accepted.ok === false && accepted.error.code).toBe('INVITATION_ALREADY_USED');
    const expired = declineInvitation(invite(), bob, EXPIRES);
    expect(expired.ok === false && expired.error.code).toBe('INVITATION_EXPIRED');
  });
});

describe('expiry evaluation and sweep', () => {
  it('reports a pending invitation as expired from exactly 7 days', () => {
    const inv = invite();
    expect(effectiveStatus(inv, JUST_BEFORE_EXPIRY)).toBe('pending');
    expect(effectiveStatus(inv, EXPIRES)).toBe('expired');
  });

  it('marks only pending invitations at or past expiry', () => {
    const base = invite();
    const due: Invitation = { ...base, invitationId: 'due' };
    const notYet: Invitation = { ...base, invitationId: 'later', expiresAt: '2025-01-09T00:00:00.000Z' };
    const accepted: Invitation = { ...base, invitationId: 'acc', status: 'accepted' };
    const declined: Invitation = { ...base, invitationId: 'dec', status: 'declined' };
    const swept = sweepExpiredInvitations([due, notYet, accepted, declined], EXPIRES);
    expect(swept).toEqual([{ ...due, status: 'expired' }]);
    expect(sweepExpiredInvitations([due], JUST_BEFORE_EXPIRY)).toEqual([]);
  });
});
