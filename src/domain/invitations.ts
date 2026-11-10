/**
 * Invitation lifecycle state machine.
 *
 * Pure functions: no I/O and no clock reads. Callers inject `now` as an
 * ISO-8601 timestamp, load the relevant records, apply these rules, and
 * persist the results.
 *
 * Lifecycle:
 *   pending --accept--> accepted
 *   pending --decline--> declined
 *   pending --(now >= expiresAt)--> expired   (sweep, or evaluated at accept/decline time)
 * accepted, declined and expired are terminal.
 *
 * Expiry boundary: an Invitation expires exactly 7 days after creation.
 * `expiresAt = createdAt + 7 * 24h`, and the Invitation is expired when
 * `now >= expiresAt`. An acceptance at `expiresAt - 1ms` succeeds; an
 * acceptance at exactly `expiresAt` is rejected.
 *
 * Requirements: 10.2, 10.3, 10.4, 10.5
 */
import type {
  Household,
  Invitation,
  InvitationId,
  Invitee,
  IsoTimestamp,
  Membership,
  UserId,
} from './types.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationErrorCode =
  | 'INVALID_INVITATION_INPUT'
  | 'NOT_HOUSEHOLD_OWNER'
  /** Invitation is malformed or not addressed to the acting person. */
  | 'INVITATION_INVALID'
  | 'INVITATION_ALREADY_USED'
  | 'INVITATION_DECLINED'
  | 'INVITATION_EXPIRED'
  | 'ALREADY_A_MEMBER';

export interface InvitationError {
  code: InvitationErrorCode;
  message: string;
}

export type InvitationResult<T> = { ok: true; value: T } | { ok: false; error: InvitationError };

function fail<T>(code: InvitationErrorCode, message: string): InvitationResult<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Error codes that callers may map to the single "invitation is invalid"
 * response required by Requirement 10.4.
 */
export const INVALID_INVITATION_CODES: readonly InvitationErrorCode[] = [
  'INVITATION_INVALID',
  'INVITATION_ALREADY_USED',
  'INVITATION_DECLINED',
  'INVITATION_EXPIRED',
];

export function isInvalidInvitationError(error: InvitationError): boolean {
  return INVALID_INVITATION_CODES.includes(error.code);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parseTimestamp(ts: IsoTimestamp): number | undefined {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Returns `createdAt + 7 days` as an ISO timestamp, or undefined if `createdAt` is invalid. */
export function computeExpiresAt(createdAt: IsoTimestamp): IsoTimestamp | undefined {
  const ms = parseTimestamp(createdAt);
  return ms === undefined ? undefined : new Date(ms + INVITATION_TTL_MS).toISOString();
}

/**
 * True when the Invitation's expiry time has been reached (`now >= expiresAt`).
 * An unparseable `expiresAt` or `now` is treated as expired (fail closed).
 */
export function hasExpiryPassed(invitation: Invitation, now: IsoTimestamp): boolean {
  const expiresMs = parseTimestamp(invitation.expiresAt);
  const nowMs = parseTimestamp(now);
  if (expiresMs === undefined || nowMs === undefined) return true;
  return nowMs >= expiresMs;
}

/**
 * The Invitation's status as of `now`: a stored `pending` Invitation whose
 * expiry has passed is reported as `expired` even before the sweep runs.
 */
export function effectiveStatus(invitation: Invitation, now: IsoTimestamp): Invitation['status'] {
  if (invitation.status === 'pending' && hasExpiryPassed(invitation, now)) return 'expired';
  return invitation.status;
}

// ---------------------------------------------------------------------------
// Invitee validation and matching
// ---------------------------------------------------------------------------

// Sanity check only: one "@", non-empty local part, a dot in the domain, no whitespace.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeInvitee(invitee: Invitee): InvitationResult<Invitee> {
  if (invitee.kind === 'email') {
    const email = normalizeEmail(invitee.email);
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return fail('INVALID_INVITATION_INPUT', 'Invitee email address is not valid.');
    }
    return { ok: true, value: { kind: 'email', email } };
  }
  const userId = invitee.userId.trim();
  if (userId.length === 0) {
    return fail('INVALID_INVITATION_INPUT', 'Invitee user id must not be empty.');
  }
  return { ok: true, value: { kind: 'userId', userId } };
}

/** The identity of the person acting on an Invitation. */
export interface InvitationActor {
  userId: UserId;
  /** The actor's login email, when known. Required to act on email Invitations. */
  email?: string;
}

function actorMatchesInvitee(actor: InvitationActor, invitee: Invitee): boolean {
  if (invitee.kind === 'userId') return actor.userId === invitee.userId;
  return actor.email !== undefined && normalizeEmail(actor.email) === normalizeEmail(invitee.email);
}

/** Rejects actions on a non-pending (or time-expired) Invitation with a specific code. */
function checkPending(invitation: Invitation, now: IsoTimestamp): InvitationResult<void> {
  switch (effectiveStatus(invitation, now)) {
    case 'pending':
      return { ok: true, value: undefined };
    case 'accepted':
      return fail('INVITATION_ALREADY_USED', 'This invitation has already been used.');
    case 'declined':
      return fail('INVITATION_DECLINED', 'This invitation was declined.');
    case 'expired':
      return fail('INVITATION_EXPIRED', 'This invitation has expired.');
    default:
      return fail('INVITATION_INVALID', 'This invitation is invalid.');
  }
}

// ---------------------------------------------------------------------------
// Creation (10.2)
// ---------------------------------------------------------------------------

export interface CreateInvitationInput {
  household: Household;
  actorUserId: UserId;
  invitationId: InvitationId;
  invitee: Invitee;
  now: IsoTimestamp;
}

/**
 * Creates a pending Invitation for `household`, issued by its Household_Owner,
 * expiring 7 days after `now`. Emails are stored trimmed and lower-cased.
 */
export function createInvitation(input: CreateInvitationInput): InvitationResult<Invitation> {
  if (input.actorUserId !== input.household.ownerUserId) {
    return fail('NOT_HOUSEHOLD_OWNER', 'Only the household owner can invite members.');
  }
  if (input.invitationId.length === 0) {
    return fail('INVALID_INVITATION_INPUT', 'Invitation id must not be empty.');
  }
  const expiresAt = computeExpiresAt(input.now);
  if (expiresAt === undefined) {
    return fail('INVALID_INVITATION_INPUT', 'Creation time is not a valid timestamp.');
  }
  const invitee = normalizeInvitee(input.invitee);
  if (!invitee.ok) return invitee;
  if (invitee.value.kind === 'userId' && invitee.value.userId === input.household.ownerUserId) {
    return fail('ALREADY_A_MEMBER', 'The household owner is already a member.');
  }
  return {
    ok: true,
    value: {
      invitationId: input.invitationId,
      householdId: input.household.householdId,
      invitee: invitee.value,
      status: 'pending',
      createdAt: new Date(Date.parse(input.now)).toISOString(),
      expiresAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance (10.3, 10.4, 10.5)
// ---------------------------------------------------------------------------

export interface InvitationAcceptance {
  /** The Invitation with status `accepted`. */
  invitation: Invitation;
  /** The new member's Membership in the Invitation's Household. */
  membership: Membership;
}

/**
 * Accepts `invitation` on behalf of `actor`. Succeeds only when the
 * Invitation is pending, its expiry has not passed (`now < expiresAt`), the
 * actor is the invitee, and the actor is not already a member of the
 * Household. On any failure no Membership is produced and inputs are not
 * mutated.
 */
export function acceptInvitation(
  invitation: Invitation,
  actor: InvitationActor,
  householdMemberships: readonly Membership[],
  now: IsoTimestamp,
): InvitationResult<InvitationAcceptance> {
  const pending = checkPending(invitation, now);
  if (!pending.ok) return pending;
  if (!actorMatchesInvitee(actor, invitation.invitee)) {
    return fail('INVITATION_INVALID', 'This invitation is invalid.');
  }
  const alreadyMember = householdMemberships.some(
    (m) => m.householdId === invitation.householdId && m.userId === actor.userId,
  );
  if (alreadyMember) {
    return fail('ALREADY_A_MEMBER', 'You are already a member of this household.');
  }
  return {
    ok: true,
    value: {
      invitation: { ...invitation, status: 'accepted' },
      membership: {
        householdId: invitation.householdId,
        userId: actor.userId,
        role: 'member',
        joinedAt: now,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------

/** Declines a pending, unexpired Invitation addressed to `actor`. */
export function declineInvitation(
  invitation: Invitation,
  actor: InvitationActor,
  now: IsoTimestamp,
): InvitationResult<Invitation> {
  const pending = checkPending(invitation, now);
  if (!pending.ok) return pending;
  if (!actorMatchesInvitee(actor, invitation.invitee)) {
    return fail('INVITATION_INVALID', 'This invitation is invalid.');
  }
  return { ok: true, value: { ...invitation, status: 'declined' } };
}

// ---------------------------------------------------------------------------
// Expiry sweep (10.5)
// ---------------------------------------------------------------------------

/**
 * Returns the Invitations that the scheduled sweep should mark expired: every
 * stored `pending` Invitation with `now >= expiresAt`, as copies with status
 * `expired`. Non-pending and unexpired Invitations are not returned.
 */
export function sweepExpiredInvitations(
  invitations: readonly Invitation[],
  now: IsoTimestamp,
): Invitation[] {
  return invitations
    .filter((inv) => inv.status === 'pending' && hasExpiryPassed(inv, now))
    .map((inv) => ({ ...inv, status: 'expired' as const }));
}
