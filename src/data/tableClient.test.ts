import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { ConditionFailedError, StorageError } from './errors.js';
import { buildQueryParams, conditionToExpression, DocumentTableClient } from './tableClient.js';

describe('conditionToExpression', () => {
  it('translates each condition kind', () => {
    expect(conditionToExpression(undefined)).toEqual({});
    expect(conditionToExpression({ kind: 'mustNotExist' }).ConditionExpression).toBe('attribute_not_exists(#pk)');
    expect(conditionToExpression({ kind: 'mustExist' }).ConditionExpression).toBe('attribute_exists(#pk)');
    expect(conditionToExpression({ kind: 'versionEquals', version: 3 })).toMatchObject({
      ConditionExpression: 'attribute_exists(#pk) AND #version = :expectedVersion',
      ExpressionAttributeValues: { ':expectedVersion': 3 },
    });
  });
});

describe('buildQueryParams', () => {
  it('queries the base table by partition key and sort-key prefix', () => {
    expect(buildQueryParams('T', { partitionKey: 'HH#h1', sortKeyPrefix: 'MEAL#' })).toEqual({
      TableName: 'T',
      ConsistentRead: true,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
      ExpressionAttributeValues: { ':pk': 'HH#h1', ':skPrefix': 'MEAL#' },
    });
  });

  it('uses GSI key attributes when an index is named', () => {
    const p = buildQueryParams('T', { indexName: 'GSI1', partitionKey: 'USER#u1', sortKeyPrefix: 'HH#' });
    expect(p.IndexName).toBe('GSI1');
    // GSIs do not support strongly consistent reads.
    expect(p).not.toHaveProperty('ConsistentRead');
    expect(p.ExpressionAttributeNames).toEqual({ '#pk': 'GSI1PK', '#sk': 'GSI1SK' });
    expect(buildQueryParams('T', { indexName: 'GSI2', partitionKey: 'INVITE#i1' }).ExpressionAttributeNames).toEqual({
      '#pk': 'GSI2PK',
    });
  });

  it('rejects a sort-key prefix on GSI2 (partition key only)', () => {
    expect(() => buildQueryParams('T', { indexName: 'GSI2', partitionKey: 'INVITE#i1', sortKeyPrefix: 'x' })).toThrow();
  });
});

describe('DocumentTableClient', () => {
  const fakeDoc = (handler: (cmd: unknown) => unknown) => ({ send: async (cmd: unknown) => handler(cmd) }) as never;

  it('sends commands with the table name and consistent reads', async () => {
    const sent: unknown[] = [];
    const client = new DocumentTableClient(
      fakeDoc((cmd) => {
        sent.push(cmd);
        return cmd instanceof QueryCommand ? { Items: [] } : {};
      }),
      'T',
    );
    await client.get({ PK: 'HH#h1', SK: 'META' });
    await client.put({ PK: 'HH#h1', SK: 'META', name: 'n' }, { kind: 'mustNotExist' });
    await client.query({ partitionKey: 'HH#h1' });
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect((sent[0] as GetCommand).input).toMatchObject({ TableName: 'T', ConsistentRead: true });
    expect(sent[1]).toBeInstanceOf(PutCommand);
    expect((sent[1] as PutCommand).input.ConditionExpression).toBe('attribute_not_exists(#pk)');
    const query = sent.find((c) => c instanceof QueryCommand) as QueryCommand;
    expect(query.input).toMatchObject({ TableName: 'T', ConsistentRead: true });
  });

  it('maps SDK errors to the storage error model', async () => {
    const conditional = new DocumentTableClient(
      fakeDoc(() => {
        throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
      }),
      'T',
    );
    await expect(conditional.put({ PK: 'HH#h1', SK: 'META' })).rejects.toBeInstanceOf(ConditionFailedError);

    const other = new DocumentTableClient(
      fakeDoc(() => {
        throw new Error('network');
      }),
      'T',
    );
    await expect(other.get({ PK: 'HH#h1', SK: 'META' })).rejects.toBeInstanceOf(StorageError);
  });
});
