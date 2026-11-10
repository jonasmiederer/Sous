/**
 * Storage error model.
 *
 * Table clients throw `ConditionFailedError` when a write's condition does not
 * hold and `StorageError` for any other failure. Repository write helpers map
 * both to `SaveDidNotCompleteError` (Requirement 8.6). Because every write is a
 * single conditional PutItem/DeleteItem or an all-or-nothing transaction, the
 * prior persisted record is unchanged whenever this error is returned.
 */

/** A write's condition (existence or expected version) did not hold. */
export class ConditionFailedError extends Error {
  override readonly name = 'ConditionFailedError';
  constructor(message = 'Conditional check failed', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Any non-condition storage failure (throttling, network, service error). */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(message = 'Storage operation failed', options?: { cause?: unknown }) {
    super(message, options);
  }
}

export type SaveFailureReason = 'condition_failed' | 'storage_error';

/** Returned when a save did not complete; the prior record is unchanged. */
export class SaveDidNotCompleteError extends Error {
  override readonly name = 'SaveDidNotCompleteError';
  readonly code = 'SAVE_DID_NOT_COMPLETE' as const;
  constructor(
    readonly reason: SaveFailureReason,
    options?: { cause?: unknown },
  ) {
    super('The save did not complete; the previously saved data is unchanged.', options);
  }
}

/** Write result: success, or a save-did-not-complete error. Never throws. */
export type WriteResult = { ok: true } | { ok: false; error: SaveDidNotCompleteError };

const CONDITION_FAILED_NAMES = new Set(['ConditionalCheckFailedException']);

function errorName(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'name' in err) {
    const name = (err as { name: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

/**
 * Maps a raw AWS SDK error to the storage error model. A
 * TransactionCanceledException counts as a condition failure only when at
 * least one cancellation reason is ConditionalCheckFailed.
 */
export function mapDynamoError(err: unknown): ConditionFailedError | StorageError {
  if (err instanceof ConditionFailedError || err instanceof StorageError) return err;
  const name = errorName(err);
  if (name !== undefined && CONDITION_FAILED_NAMES.has(name)) {
    return new ConditionFailedError(undefined, { cause: err });
  }
  if (name === 'TransactionCanceledException') {
    const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
    if (reasons.some((r) => r?.Code === 'ConditionalCheckFailed')) {
      return new ConditionFailedError('Transaction condition failed', { cause: err });
    }
  }
  return new StorageError(undefined, { cause: err });
}

/** Maps any error raised during a write to a SaveDidNotCompleteError. */
export function toSaveDidNotComplete(err: unknown): SaveDidNotCompleteError {
  if (err instanceof SaveDidNotCompleteError) return err;
  const mapped = mapDynamoError(err);
  return new SaveDidNotCompleteError(
    mapped instanceof ConditionFailedError ? 'condition_failed' : 'storage_error',
    { cause: err },
  );
}
