/**
 * Household, Invitation, and membership operations
 * (Requirements 10.1, 10.2, 10.3, 10.4, 10.6, 10.7, 10.8), plus the
 * Household and member reads used by the Client_App (13.6, 13.8).
 *
 * Business rules come from the pure domain modules (household.ts,
 * invitations.ts). This service loads records through a HouseholdRepository
 * bound to the target Household, applies the rule, and persists the result in
 * one all-or-nothing transaction so a failed save leaves prior state intact.
 *
 * Non-members get NOT_A_MEMBER for any household-specific operation, whether
 * or not the Household exists, so existence is not disclosed.
 */
import {
  createHousehold,
  removeMember,
  resolveActiveHousehold,
  type ActiveHouseholdScope,
} from '../../domain/household.js';
import {
  acceptInvitation,
  createInvitation,
  declineInvitation,
  isInvalidInvitationError,
  type InvitationError,
} from '../../domain/invitations.js';
import type {
  Household,
  HouseholdId,
  Invitation,
  InvitationId,
  Invitee,
  Membership,
  UserId,
} from '../../domain/types.js';
import {
  InvalidKeyError,
  KeyPrefix,
  assertKeyComponent,
  invitationGsi2,
  pendingInvitationGsi3,
  membershipGsi1,
  sortKeys,
} from '../../data/keys.js';
import { GlobalLookups, HouseholdRepository, type StoredRecord } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import {
  INVALID_INVITATION_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  SAVE_DID_NOT_COMPLETE_MESSAGE,
  fail,
  ok,
  type ServiceResult,
} from './errors.js';

/** Authenticated caller, from verified Cognito JWT claims (authorizer, task 15.1). */
export interface Caller {
  userId: UserId;
  email?: string;
}

export interface MembershipDeps {
  client: TableClient;
  now: () => Date;
  newId: () => string;
}

const HOUSEHOLD_NAME_MAX = 100;

/** Upper bound on Households returned by `GET /households`. */
export const MAX_LISTED_HOUSEHOLDS = 50;

/** One entry of `GET /households` (Requirement 13.6). */
export interface HouseholdSummary {
  householdId: HouseholdId;
  name: string;
  role: Membership['role'];
  ownerUserId: UserId;
}

/** One entry of `GET /households/{id}/members` (Requirement 13.8). */
export interface MemberSummary {
  userId: UserId;
  email?: string;
  role: Membership['role'];
  joinedAt: string;
}

interface LoadedHousehold {
  repo: HouseholdRepository;
  household: Household;
  memberships: Membership[];
}

function isValidId(value: unknown): value is string {
  try {
    assertKeyComponent('id', value);
    return true;
  } catch (err) {
    if (err instanceof InvalidKeyError) return false;
    throw err;
  }
}

const notAMember = <T>(): ServiceResult<T> => fail('NOT_A_MEMBER', NOT_A_MEMBER_MESSAGE);
const invalidInvitation = <T>(): ServiceResult<T> => fail('INVALID_INVITATION', INVALID_INVITATION_MESSAGE);
const saveFailed = <T>(): ServiceResult<T> => fail('SAVE_DID_NOT_COMPLETE', SAVE_DID_NOT_COMPLETE_MESSAGE);

function parseInvitee(input: unknown): Invitee | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { email, userId } = input as { email?: unknown; userId?: unknown };
  if (typeof email === 'string' && userId === undefined) return { kind: 'email', email };
  if (typeof userId === 'string' && email === undefined) return { kind: 'userId', userId };
  return undefined;
}

function invitationErrorResult<T>(error: InvitationError): ServiceResult<T> {
  if (isInvalidInvitationError(error)) return invalidInvitation();
  switch (error.code) {
    case 'NOT_HOUSEHOLD_OWNER':
      return fail('NOT_HOUSEHOLD_OWNER', error.message);
    case 'ALREADY_A_MEMBER':
      return fail('ALREADY_A_MEMBER', error.message);
    default:
      return fail('INVALID_REQUEST', error.message);
  }
}

export class MembershipService {
  private readonly lookups: GlobalLookups;

  constructor(private readonly deps: MembershipDeps) {
    this.lookups = new GlobalLookups(deps.client);
  }

  private repo(householdId: HouseholdId): HouseholdRepository {
    return new HouseholdRepository(this.deps.client, householdId);
  }

  /** Loads META and all memberships; undefined when the Household does not exist. */
  private async load(householdId: HouseholdId): Promise<LoadedHousehold | undefined> {
    const repo = this.repo(householdId);
    const meta = await repo.get<Household & Record<string, unknown>>(sortKeys.householdMeta());
    if (meta === undefined) return undefined;
    const members = await repo.query<Membership & Record<string, unknown>>(KeyPrefix.member);
    return { repo, household: meta.attributes, memberships: members.map((m) => m.attributes) };
  }

  /** Loads the Household only if `caller` is a member of it. */
  private async loadAsMember(
    caller: Caller,
    householdId: unknown,
  ): Promise<ServiceResult<LoadedHousehold & { scope: ActiveHouseholdScope }>> {
    if (!isValidId(householdId)) return notAMember();
    const loaded = await this.load(householdId);
    if (loaded === undefined) return notAMember();
    const scope = resolveActiveHousehold(caller.userId, householdId, loaded.memberships);
    if (!scope.ok) return notAMember();
    return ok({ ...loaded, scope: scope.value });
  }

  // -------------------------------------------------------------------------
  // POST /households (10.1)
  // -------------------------------------------------------------------------

  async createHousehold(caller: Caller, body: unknown): Promise<ServiceResult<{ household: Household; membership: Membership }>> {
    const name = (body as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > HOUSEHOLD_NAME_MAX) {
      return fail('INVALID_REQUEST', `Household name must be 1 to ${HOUSEHOLD_NAME_MAX} characters.`);
    }
    const created = createHousehold({
      householdId: this.deps.newId(),
      name,
      creatorUserId: caller.userId,
      createdAt: this.deps.now().toISOString(),
    });
    if (!created.ok) return fail('INVALID_REQUEST', created.error.message);
    const { household, ownerMembership } = created.value;

    const write = await this.repo(household.householdId).transact([
      { kind: 'create', sk: sortKeys.householdMeta(), attributes: { ...household } },
      {
        kind: 'create',
        sk: sortKeys.member(caller.userId),
        attributes: { ...ownerMembership },
        indexKeys: membershipGsi1(household.householdId, caller.userId),
      },
    ]);
    if (!write.ok) return saveFailed();
    return ok({ household, membership: ownerMembership });
  }

  // -------------------------------------------------------------------------
  // GET /households (13.6)
  // -------------------------------------------------------------------------

  /**
   * Lists the caller's Households. GSI1 is eventually consistent and
   * KEYS_ONLY, so each candidate is re-read from the base table: the
   * Household's META and the caller's own MEMBER# item. Candidates whose
   * membership no longer exists (for example, just removed) are dropped.
   */
  async listHouseholds(caller: Caller): Promise<ServiceResult<{ households: HouseholdSummary[] }>> {
    const ids = [...new Set(await this.lookups.listHouseholdIdsForUser(caller.userId))].slice(0, MAX_LISTED_HOUSEHOLDS);
    const entries = await Promise.all(
      ids.map(async (householdId): Promise<HouseholdSummary | undefined> => {
        const repo = this.repo(householdId);
        const [meta, member] = await Promise.all([
          repo.get<Household & Record<string, unknown>>(sortKeys.householdMeta()),
          repo.get<Membership & Record<string, unknown>>(sortKeys.member(caller.userId)),
        ]);
        if (meta === undefined || member === undefined || member.attributes.userId !== caller.userId) return undefined;
        return {
          householdId,
          name: meta.attributes.name,
          role: member.attributes.role,
          ownerUserId: meta.attributes.ownerUserId,
        };
      }),
    );
    return ok({ households: entries.filter((e): e is HouseholdSummary => e !== undefined) });
  }

  // -------------------------------------------------------------------------
  // GET /households/{id}/members (13.8, 1.5)
  // -------------------------------------------------------------------------

  /** Lists members of a Household the caller belongs to; email comes from the `USER#` mirror when present. */
  async listMembers(caller: Caller, householdId: unknown): Promise<ServiceResult<{ members: MemberSummary[] }>> {
    const loaded = await this.loadAsMember(caller, householdId);
    if (!loaded.ok) return loaded;
    const members = await Promise.all(
      loaded.value.memberships.map(async (m): Promise<MemberSummary> => {
        const user = await this.lookups.getUser<{ identifier?: unknown }>(m.userId);
        const email = user?.attributes.identifier;
        return {
          userId: m.userId,
          ...(typeof email === 'string' ? { email } : {}),
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );
    return ok({ members });
  }

  // -------------------------------------------------------------------------
  // POST /households/{id}/invitations (10.2)
  // -------------------------------------------------------------------------

  async inviteMember(caller: Caller, householdId: unknown, body: unknown): Promise<ServiceResult<Invitation>> {
    const loaded = await this.loadAsMember(caller, householdId);
    if (!loaded.ok) return loaded;
    const { repo, household, memberships } = loaded.value;

    const invitee = parseInvitee(body);
    if (invitee === undefined) {
      return fail('INVALID_REQUEST', 'Provide exactly one of "email" or "userId" for the invitee.');
    }
    if (invitee.kind === 'userId' && memberships.some((m) => m.userId === invitee.userId)) {
      // Owner-only rule is checked first so non-owners learn nothing about membership.
      if (caller.userId !== household.ownerUserId) {
        return fail('NOT_HOUSEHOLD_OWNER', 'Only the household owner can invite members.');
      }
      return fail('ALREADY_A_MEMBER', 'That user is already a member of this household.');
    }

    const invitationId = this.deps.newId();
    const created = createInvitation({
      household,
      actorUserId: caller.userId,
      invitationId,
      invitee,
      now: this.deps.now().toISOString(),
    });
    if (!created.ok) return invitationErrorResult(created.error);

    const write = await repo.transact([
      {
        kind: 'create',
        sk: sortKeys.invitation(invitationId),
        attributes: { ...created.value },
        // GSI3 lists pending invitations for the expiry sweep; accept/decline
        // rewrite the item without it, removing it from that sparse index.
        indexKeys: { ...invitationGsi2(invitationId), ...pendingInvitationGsi3(invitationId, created.value.expiresAt) },
      },
    ]);
    if (!write.ok) return saveFailed();
    return ok(created.value);
  }

  // -------------------------------------------------------------------------
  // POST /invitations/{id}/accept and /decline (10.3, 10.4, 10.5)
  // -------------------------------------------------------------------------

  /** Resolves an Invitation via GSI2, then re-reads it from the base table. */
  private async loadInvitation(
    invitationId: unknown,
  ): Promise<{ repo: HouseholdRepository; record: StoredRecord<Invitation & Record<string, unknown>> } | undefined> {
    if (!isValidId(invitationId)) return undefined;
    const householdId = await this.lookups.findInvitationHousehold(invitationId);
    if (householdId === undefined) return undefined;
    const repo = this.repo(householdId);
    const record = await repo.get<Invitation & Record<string, unknown>>(sortKeys.invitation(invitationId));
    if (record === undefined || record.attributes.householdId !== householdId) return undefined;
    return { repo, record };
  }

  async acceptInvitation(
    caller: Caller,
    invitationId: unknown,
  ): Promise<ServiceResult<{ invitation: Invitation; membership: Membership }>> {
    const loaded = await this.loadInvitation(invitationId);
    if (loaded === undefined) return invalidInvitation();
    const { repo, record } = loaded;
    const members = await repo.query<Membership & Record<string, unknown>>(KeyPrefix.member);

    const accepted = acceptInvitation(
      record.attributes,
      { userId: caller.userId, ...(caller.email !== undefined ? { email: caller.email } : {}) },
      members.map((m) => m.attributes),
      this.deps.now().toISOString(),
    );
    if (!accepted.ok) return invitationErrorResult(accepted.error);
    const { invitation, membership } = accepted.value;

    const id = invitation.invitationId as InvitationId;
    const write = await repo.transact([
      {
        kind: 'replaceIfVersion',
        sk: sortKeys.invitation(id),
        expectedVersion: record.version,
        attributes: { ...invitation },
        indexKeys: invitationGsi2(id),
      },
      {
        kind: 'create',
        sk: sortKeys.member(caller.userId),
        attributes: { ...membership },
        indexKeys: membershipGsi1(invitation.householdId, caller.userId),
      },
    ]);
    if (!write.ok) return saveFailed();
    return ok({ invitation, membership });
  }

  async declineInvitation(caller: Caller, invitationId: unknown): Promise<ServiceResult<Invitation>> {
    const loaded = await this.loadInvitation(invitationId);
    if (loaded === undefined) return invalidInvitation();
    const { repo, record } = loaded;

    const declined = declineInvitation(
      record.attributes,
      { userId: caller.userId, ...(caller.email !== undefined ? { email: caller.email } : {}) },
      this.deps.now().toISOString(),
    );
    if (!declined.ok) return invitationErrorResult(declined.error);

    const id = declined.value.invitationId;
    const write = await repo.transact([
      {
        kind: 'replaceIfVersion',
        sk: sortKeys.invitation(id),
        expectedVersion: record.version,
        attributes: { ...declined.value },
        indexKeys: invitationGsi2(id),
      },
    ]);
    if (!write.ok) return saveFailed();
    return ok(declined.value);
  }

  // -------------------------------------------------------------------------
  // DELETE /households/{id}/members/{userId} (10.7, 10.8)
  // -------------------------------------------------------------------------

  async removeMember(caller: Caller, householdId: unknown, targetUserId: unknown): Promise<ServiceResult<{ removed: Membership }>> {
    const loaded = await this.loadAsMember(caller, householdId);
    if (!loaded.ok) return loaded;
    const { repo, household, memberships } = loaded.value;
    if (!isValidId(targetUserId)) {
      return caller.userId === household.ownerUserId
        ? fail('MEMBER_NOT_FOUND', 'That user is not a member of this household.')
        : fail('NOT_HOUSEHOLD_OWNER', 'Only the household owner can remove members.');
    }

    const removal = removeMember(household, memberships, caller.userId, targetUserId);
    if (!removal.ok) {
      switch (removal.error.code) {
        case 'NOT_HOUSEHOLD_OWNER':
          return fail('NOT_HOUSEHOLD_OWNER', removal.error.message);
        case 'CANNOT_REMOVE_OWNER':
          return fail('CANNOT_REMOVE_OWNER', removal.error.message);
        default:
          return fail('MEMBER_NOT_FOUND', removal.error.message);
      }
    }

    const write = await repo.transact([
      { kind: 'delete', sk: sortKeys.member(targetUserId), condition: { kind: 'mustExist' } },
    ]);
    if (!write.ok) return saveFailed();
    return ok({ removed: removal.value.removed });
  }

  // -------------------------------------------------------------------------
  // PUT /session/active-household (10.6)
  // -------------------------------------------------------------------------

  /**
   * Verifies the caller is a member of `householdId` with a strongly
   * consistent read of `MEMBER#{userId}` and returns the resulting scope.
   *
   * The selection is not stored server-side: the client sends the returned
   * householdId with each request (the `X-Active-Household` header), and the
   * authorizer / entry points re-verify membership on every request (task
   * 15.1). That keeps removal effective immediately (10.7).
   */
  async setActiveHousehold(caller: Caller, body: unknown): Promise<ServiceResult<ActiveHouseholdScope>> {
    const householdId = (body as { householdId?: unknown } | null)?.householdId;
    if (!isValidId(householdId)) return notAMember();
    const record = await this.repo(householdId).get<Membership & Record<string, unknown>>(sortKeys.member(caller.userId));
    const memberships = record === undefined ? [] : [record.attributes];
    const scope = resolveActiveHousehold(caller.userId, householdId, memberships);
    return scope.ok ? ok(scope.value) : notAMember();
  }
}
