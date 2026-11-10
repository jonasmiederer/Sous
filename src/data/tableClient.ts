/**
 * Narrow table-client interface over the DynamoDB single table, plus the
 * production adapter over the AWS SDK v3 DynamoDBDocumentClient.
 *
 * The interface deliberately exposes only key-addressed reads/writes and
 * partition-key queries. There is no scan operation, so request-path code
 * cannot issue a cross-partition scan (Requirement 1.4). Write conditions are
 * a small structured set that an in-memory fake can evaluate exactly.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { mapDynamoError } from './errors.js';
import { GSI1_NAME, GSI2_NAME, GSI3_NAME, type IndexKeys, type TableKey } from './keys.js';

/** A stored item: primary key, optional index keys, and arbitrary attributes. */
export type TableItem = TableKey & IndexKeys & Record<string, unknown>;

export type WriteCondition =
  | { kind: 'mustNotExist' }
  | { kind: 'mustExist' }
  /** Item must exist and its numeric `version` attribute must equal `version`. */
  | { kind: 'versionEquals'; version: number };

export const VERSION_ATTRIBUTE = 'version';

export type IndexName = typeof GSI1_NAME | typeof GSI2_NAME | typeof GSI3_NAME;

export interface QueryInput {
  /** Partition key value: table PK, or GSI1PK/GSI2PK/GSI3PK when indexName is set. */
  partitionKey: string;
  indexName?: IndexName;
  /** Restricts to items whose sort key (SK or GSI1SK) begins with this prefix. */
  sortKeyPrefix?: string;
  /** Restricts to items whose sort key is strictly less than this value. Exclusive with sortKeyPrefix. */
  sortKeyBefore?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export interface QueryOutput {
  items: TableItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}

export type TransactWriteOp =
  | { kind: 'put'; item: TableItem; condition?: WriteCondition }
  | { kind: 'delete'; key: TableKey; condition?: WriteCondition };

/**
 * Errors: writes throw ConditionFailedError when the condition does not hold
 * and StorageError otherwise (see errors.ts). A failed write must not modify
 * any item; `transactWrite` is all-or-nothing.
 */
export interface TableClient {
  get(key: TableKey): Promise<TableItem | undefined>;
  put(item: TableItem, condition?: WriteCondition): Promise<void>;
  delete(key: TableKey, condition?: WriteCondition): Promise<void>;
  query(input: QueryInput): Promise<QueryOutput>;
  transactWrite(ops: TransactWriteOp[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// DocumentClient adapter
// ---------------------------------------------------------------------------

interface ConditionParams {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

export function conditionToExpression(condition: WriteCondition | undefined): ConditionParams {
  if (condition === undefined) return {};
  switch (condition.kind) {
    case 'mustNotExist':
      return { ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'PK' } };
    case 'mustExist':
      return { ConditionExpression: 'attribute_exists(#pk)', ExpressionAttributeNames: { '#pk': 'PK' } };
    case 'versionEquals':
      return {
        ConditionExpression: 'attribute_exists(#pk) AND #version = :expectedVersion',
        ExpressionAttributeNames: { '#pk': 'PK', '#version': VERSION_ATTRIBUTE },
        ExpressionAttributeValues: { ':expectedVersion': condition.version },
      };
  }
}

function sortKeyAttribute(indexName: IndexName | undefined): string | undefined {
  if (indexName === undefined) return 'SK';
  if (indexName === GSI1_NAME) return 'GSI1SK';
  if (indexName === GSI3_NAME) return 'GSI3SK';
  return undefined; // GSI2 has a partition key only.
}

function partitionKeyAttribute(indexName: IndexName | undefined): string {
  if (indexName === GSI1_NAME) return 'GSI1PK';
  if (indexName === GSI2_NAME) return 'GSI2PK';
  if (indexName === GSI3_NAME) return 'GSI3PK';
  return 'PK';
}

export function buildQueryParams(tableName: string, input: QueryInput): QueryCommandInput {
  const pkAttr = partitionKeyAttribute(input.indexName);
  const skAttr = sortKeyAttribute(input.indexName);
  const names: Record<string, string> = { '#pk': pkAttr };
  const values: Record<string, unknown> = { ':pk': input.partitionKey };
  let expr = '#pk = :pk';
  if (input.sortKeyPrefix !== undefined) {
    if (skAttr === undefined) throw new Error(`Index ${String(input.indexName)} has no sort key`);
    names['#sk'] = skAttr;
    values[':skPrefix'] = input.sortKeyPrefix;
    expr += ' AND begins_with(#sk, :skPrefix)';
  } else if (input.sortKeyBefore !== undefined) {
    if (skAttr === undefined) throw new Error(`Index ${String(input.indexName)} has no sort key`);
    names['#sk'] = skAttr;
    values[':skBefore'] = input.sortKeyBefore;
    expr += ' AND #sk < :skBefore';
  }
  return {
    TableName: tableName,
    // Base-table queries are strongly consistent so a change committed by one
    // member is visible to every other member on their next read (Req 1.6).
    // GSIs only support eventually consistent reads; they are lookup aids
    // (e.g. "list my households") and are never used for authorization.
    ...(input.indexName !== undefined ? { IndexName: input.indexName } : { ConsistentRead: true }),
    KeyConditionExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(input.limit !== undefined ? { Limit: input.limit } : {}),
    ...(input.exclusiveStartKey !== undefined ? { ExclusiveStartKey: input.exclusiveStartKey } : {}),
  };
}

/** Production TableClient over a DynamoDBDocumentClient. */
export class DocumentTableClient implements TableClient {
  constructor(
    private readonly doc: Pick<DynamoDBDocumentClient, 'send'>,
    private readonly tableName: string,
  ) {}

  async get(key: TableKey): Promise<TableItem | undefined> {
    try {
      const out = await this.doc.send(
        new GetCommand({ TableName: this.tableName, Key: { PK: key.PK, SK: key.SK }, ConsistentRead: true }),
      );
      return out.Item as TableItem | undefined;
    } catch (err) {
      throw mapDynamoError(err);
    }
  }

  async put(item: TableItem, condition?: WriteCondition): Promise<void> {
    try {
      await this.doc.send(new PutCommand({ TableName: this.tableName, Item: item, ...conditionToExpression(condition) }));
    } catch (err) {
      throw mapDynamoError(err);
    }
  }

  async delete(key: TableKey, condition?: WriteCondition): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tableName, Key: { PK: key.PK, SK: key.SK }, ...conditionToExpression(condition) }),
      );
    } catch (err) {
      throw mapDynamoError(err);
    }
  }

  async query(input: QueryInput): Promise<QueryOutput> {
    try {
      const out = await this.doc.send(new QueryCommand(buildQueryParams(this.tableName, input)));
      return {
        items: (out.Items ?? []) as TableItem[],
        ...(out.LastEvaluatedKey !== undefined ? { lastEvaluatedKey: out.LastEvaluatedKey } : {}),
      };
    } catch (err) {
      throw mapDynamoError(err);
    }
  }

  async transactWrite(ops: TransactWriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: ops.map((op) =>
            op.kind === 'put'
              ? { Put: { TableName: this.tableName, Item: op.item, ...conditionToExpression(op.condition) } }
              : {
                  Delete: {
                    TableName: this.tableName,
                    Key: { PK: op.key.PK, SK: op.key.SK },
                    ...conditionToExpression(op.condition),
                  },
                },
          ),
        }),
      );
    } catch (err) {
      throw mapDynamoError(err);
    }
  }
}
