/**
 * Household-scoped repository over the single table.
 *
 * A HouseholdRepository is bound to one Active_Household at construction and
 * builds every read, query, and write with `PK = HH#{activeHouseholdId}`.
 * Callers pass only sort keys, so they cannot address another Household's
 * partition (Requirement 1.4). Results are re-checked against the bound
 * partition as defense in depth. Membership verification (that the session
 * User belongs to the Active_Household) happens before a repository is
 * created, in the authorization layer.
 *
 * Write helpers never throw for storage failures. They return a WriteResult;
 * on failure the error is a SaveDidNotCompleteError and the prior persisted
 * record is unchanged, because each write is one conditional item write or an
 * all-or-nothing transaction (Requirement 8.6).
 */
import type { HouseholdId, InvitationId, UserId } from '../domain/types.js';
import { toSaveDidNotComplete, type WriteResult } from './errors.js';
import {
  GSI1_NAME,
  GSI2_NAME,
  KeyPrefix,
  householdPk,
  invitationGsi2,
  keys,
  parseHouseholdPk,
  userPk,
  type IndexKeys,
  type TableKey,
} from './keys.js';
import {
  VERSION_ATTRIBUTE,
  type QueryInput,
  type TableClient,
  type TableItem,
  type TransactWriteOp,
  type WriteCondition,
} from './tableClient.js';

/** Attribute names managed by the data layer; callers may not set them directly. */
export const RESERVED_ATTRIBUTES = [
  'PK',
  'SK',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI3PK',
  'GSI3SK',
  VERSION_ATTRIBUTE,
] as const;

export type Attributes = Record<string, unknown>;

/** A stored record as returned to callers: attributes plus its version. */
export interface StoredRecord<T extends Attributes = Attributes> {
  sk: string;
  version: number;
  attributes: T;
}

export class TenantIsolationViolationError extends Error {
  override readonly name = 'TenantIsolationViolationError';
  constructor(expectedPk: string, actualPk: unknown) {
    super(`Item outside the active Household partition (expected ${expectedPk}, got ${String(actualPk)})`);
  }
}

export interface PutOptions {
  indexKeys?: IndexKeys;
}

export type HouseholdTransactOp =
  | { kind: 'create'; sk: string; attributes: Attributes; indexKeys?: IndexKeys }
  | { kind: 'replaceIfVersion'; sk: string; expectedVersion: number; attributes: Attributes; indexKeys?: IndexKeys }
  | { kind: 'upsert'; sk: string; attributes: Attributes; indexKeys?: IndexKeys; previousVersion?: number }
  | { kind: 'delete'; sk: string; condition?: WriteCondition };

function assertNoReservedAttributes(attributes: Attributes): void {
  for (const name of RESERVED_ATTRIBUTES) {
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      throw new Error(`Attribute "${name}" is managed by the data layer and cannot be set directly`);
    }
  }
}

function toStoredRecord<T extends Attributes>(item: TableItem): StoredRecord<T> {
  const attributes: Attributes = {};
  for (const [k, v] of Object.entries(item)) {
    if (!(RESERVED_ATTRIBUTES as readonly string[]).includes(k)) attributes[k] = v;
  }
  const version = typeof item[VERSION_ATTRIBUTE] === 'number' ? (item[VERSION_ATTRIBUTE] as number) : 0;
  return { sk: item.SK, version, attributes: attributes as T };
}

async function attempt(write: () => Promise<void>): Promise<WriteResult> {
  try {
    await write();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toSaveDidNotComplete(err) };
  }
}

async function queryAll(client: TableClient, input: QueryInput): Promise<TableItem[]> {
  const items: TableItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.query({ ...input, ...(exclusiveStartKey ? { exclusiveStartKey } : {}) });
    items.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

export class HouseholdRepository {
  readonly householdId: HouseholdId;
  readonly partitionKey: string;

  constructor(
    private readonly client: TableClient,
    activeHouseholdId: HouseholdId,
  ) {
    this.partitionKey = householdPk(activeHouseholdId); // validates the id
    this.householdId = activeHouseholdId;
  }

  private key(sk: string): TableKey {
    if (typeof sk !== 'string' || sk.length === 0) throw new Error('Sort key must be a non-empty string');
    return { PK: this.partitionKey, SK: sk };
  }

  private assertInPartition(item: TableItem): TableItem {
    if (item.PK !== this.partitionKey) throw new TenantIsolationViolationError(this.partitionKey, item.PK);
    return item;
  }

  private buildItem(sk: string, attributes: Attributes, version: number, indexKeys?: IndexKeys): TableItem {
    assertNoReservedAttributes(attributes);
    return { ...attributes, ...(indexKeys ?? {}), ...this.key(sk), [VERSION_ATTRIBUTE]: version };
  }

  async get<T extends Attributes = Attributes>(sk: string): Promise<StoredRecord<T> | undefined> {
    const item = await this.client.get(this.key(sk));
    return item === undefined ? undefined : toStoredRecord<T>(this.assertInPartition(item));
  }

  /** Queries the Active_Household partition, optionally by sort-key prefix. Follows pagination. */
  async query<T extends Attributes = Attributes>(sortKeyPrefix?: string): Promise<StoredRecord<T>[]> {
    const items = await queryAll(this.client, {
      partitionKey: this.partitionKey,
      ...(sortKeyPrefix !== undefined ? { sortKeyPrefix } : {}),
    });
    return items.map((item) => toStoredRecord<T>(this.assertInPartition(item)));
  }

  /** Writes a new record (version 1); fails if one already exists at this key. */
  async create(sk: string, attributes: Attributes, options: PutOptions = {}): Promise<WriteResult> {
    const item = this.buildItem(sk, attributes, 1, options.indexKeys);
    return attempt(() => this.client.put(item, { kind: 'mustNotExist' }));
  }

  /**
   * Replaces a record only if its stored version equals `expectedVersion`
   * (optimistic concurrency); the new version is expectedVersion + 1.
   */
  async replaceIfVersion(
    sk: string,
    expectedVersion: number,
    attributes: Attributes,
    options: PutOptions = {},
  ): Promise<WriteResult> {
    const item = this.buildItem(sk, attributes, expectedVersion + 1, options.indexKeys);
    return attempt(() => this.client.put(item, { kind: 'versionEquals', version: expectedVersion }));
  }

  /**
   * Creates or fully replaces a record in one atomic item write. Use for
   * singleton records whose writes need not detect concurrent changes.
   * Version is reset to `previousVersion + 1` when supplied, else 1.
   */
  async upsert(
    sk: string,
    attributes: Attributes,
    options: PutOptions & { previousVersion?: number } = {},
  ): Promise<WriteResult> {
    const item = this.buildItem(sk, attributes, (options.previousVersion ?? 0) + 1, options.indexKeys);
    return attempt(() => this.client.put(item));
  }

  async delete(sk: string, condition?: WriteCondition): Promise<WriteResult> {
    const key = this.key(sk);
    return attempt(() => this.client.delete(key, condition));
  }

  /**
   * All-or-nothing multi-item write within the Active_Household partition.
   * Invalid input (bad sort key, reserved attribute) throws instead of
   * returning a save failure, since it is a programming error.
   */
  async transact(ops: HouseholdTransactOp[]): Promise<WriteResult> {
    const raw = ops.map((op): TransactWriteOp => {
      switch (op.kind) {
        case 'create':
          return {
            kind: 'put',
            item: this.buildItem(op.sk, op.attributes, 1, op.indexKeys),
            condition: { kind: 'mustNotExist' },
          };
        case 'replaceIfVersion':
          return {
            kind: 'put',
            item: this.buildItem(op.sk, op.attributes, op.expectedVersion + 1, op.indexKeys),
            condition: { kind: 'versionEquals', version: op.expectedVersion },
          };
        case 'upsert':
          return {
            kind: 'put',
            item: this.buildItem(op.sk, op.attributes, (op.previousVersion ?? 0) + 1, op.indexKeys),
          };
        case 'delete':
          return { kind: 'delete', key: this.key(op.sk), ...(op.condition ? { condition: op.condition } : {}) };
      }
    });
    return attempt(() => this.client.transactWrite(raw));
  }
}

/**
 * Non-tenant lookups that cannot be scoped to an Active_Household because they
 * resolve which Household applies. Each is a single-partition query on the
 * user partition or a GSI partition; none is a scan. GSI reads are eventually
 * consistent, so callers that authorize on the result must re-read the base
 * item through a HouseholdRepository.
 */
export class GlobalLookups {
  constructor(private readonly client: TableClient) {}

  async getUser<T extends Attributes = Attributes>(userId: UserId): Promise<StoredRecord<T> | undefined> {
    const item = await this.client.get(keys.user(userId));
    return item === undefined ? undefined : toStoredRecord<T>(item);
  }

  async createUser(userId: UserId, attributes: Attributes): Promise<WriteResult> {
    assertNoReservedAttributes(attributes);
    const item: TableItem = { ...attributes, ...keys.user(userId), [VERSION_ATTRIBUTE]: 1 };
    return attempt(() => this.client.put(item, { kind: 'mustNotExist' }));
  }

  /** Household ids the user is a member of, via GSI1 (`USER#{userId}` → `HH#{householdId}`). */
  async listHouseholdIdsForUser(userId: UserId): Promise<HouseholdId[]> {
    const items = await queryAll(this.client, {
      indexName: GSI1_NAME,
      partitionKey: userPk(userId),
      sortKeyPrefix: KeyPrefix.household,
    });
    const ids: HouseholdId[] = [];
    for (const item of items) {
      const id = typeof item.GSI1SK === 'string' ? parseHouseholdPk(item.GSI1SK) : undefined;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  /** Resolves the Household owning an invitation, via GSI2 (`INVITE#{invitationId}`). */
  async findInvitationHousehold(invitationId: InvitationId): Promise<HouseholdId | undefined> {
    const { GSI2PK } = invitationGsi2(invitationId);
    const out = await this.client.query({ indexName: GSI2_NAME, partitionKey: GSI2PK, limit: 1 });
    const item = out.items[0];
    return item === undefined ? undefined : parseHouseholdPk(item.PK);
  }
}
