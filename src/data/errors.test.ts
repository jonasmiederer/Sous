import { describe, expect, it } from 'vitest';
import {
  ConditionFailedError,
  SaveDidNotCompleteError,
  StorageError,
  mapDynamoError,
  toSaveDidNotComplete,
} from './errors.js';

const awsError = (name: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(name), { name, ...extra });

describe('mapDynamoError', () => {
  it('maps ConditionalCheckFailedException to ConditionFailedError', () => {
    expect(mapDynamoError(awsError('ConditionalCheckFailedException'))).toBeInstanceOf(ConditionFailedError);
  });

  it('maps a transaction cancelled by a condition to ConditionFailedError', () => {
    const err = awsError('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    expect(mapDynamoError(err)).toBeInstanceOf(ConditionFailedError);
  });

  it('maps a transaction cancelled for other reasons to StorageError', () => {
    const err = awsError('TransactionCanceledException', { CancellationReasons: [{ Code: 'ThrottlingError' }] });
    expect(mapDynamoError(err)).toBeInstanceOf(StorageError);
  });

  it.each([awsError('ProvisionedThroughputExceededException'), new Error('network'), 'string', undefined])(
    'maps other failures (%j) to StorageError',
    (err) => {
      expect(mapDynamoError(err)).toBeInstanceOf(StorageError);
    },
  );
});

describe('toSaveDidNotComplete', () => {
  it('reports condition failures with reason condition_failed', () => {
    const e = toSaveDidNotComplete(awsError('ConditionalCheckFailedException'));
    expect(e).toBeInstanceOf(SaveDidNotCompleteError);
    expect(e.reason).toBe('condition_failed');
    expect(e.code).toBe('SAVE_DID_NOT_COMPLETE');
  });

  it('reports other failures with reason storage_error and keeps the cause', () => {
    const cause = new Error('boom');
    const e = toSaveDidNotComplete(cause);
    expect(e.reason).toBe('storage_error');
    expect(e.cause).toBe(cause);
  });

  it('passes an existing SaveDidNotCompleteError through', () => {
    const e = new SaveDidNotCompleteError('condition_failed');
    expect(toSaveDidNotComplete(e)).toBe(e);
  });
});
