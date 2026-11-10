/**
 * Scheduled Invitation expiry sweep (Requirement 10.5).
 *
 * An EventBridge Scheduler schedule (infra/lib/sousStack.ts) invokes this job
 * hourly. It sets every pending Invitation whose 7-day expiry has passed to
 * `expired`. Acceptance and decline already evaluate expiry themselves, so the
 * sweep only makes the stored status match; an Invitation is never usable past
 * its expiry even if the sweep is late.
 *
 * Access pattern: GSI3 is a sparse index containing only pending Invitations
 * (`GSI3PK = INVITE_PENDING`, `GSI3SK = {expiresAt}#{invitationId}`). Only
 * invitation creation sets these keys; accept, decline and this sweep rewrite
 * the item without them, which drops it from the index. One range query
 * (`GSI3SK < {now}$`) returns exactly the pending Invitations due for expiry,
 * so the job never scans the table and its cost grows with the number of due
 * Invitations, not the table size.
 *
 * Each candidate is re-read from the base table (strongly consistent, because
 * GSIs are eventually consistent) and rewritten with `replaceIfVersion` against
 * the version just read. A concurrent accept or decline bumps the version, so
 * the sweep's write fails its condition and can never overwrite an accepted or
 * declined Invitation. The job is idempotent: a retry or overlapping run finds
 * nothing left to do for Invitations it already expired.
 */
import { invitationGsi2, GSI3_NAME, PENDING_INVITATIONS_GSI3PK, parseHouseholdPk, sortKeys } from '../../data/keys.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import { sweepExpiredInvitations } from '../../domain/invitations.js';
import type { Invitation } from '../../domain/types.js';

export interface ExpirySweepResult {
  /** Index entries read. */
  examined: number;
  /** Invitations set to expired by this run. */
  expired: number;
  /** Candidates that needed no change (already decided, not yet due, or gone). */
  skipped: number;
  /** Candidates whose read or write failed; they stay pending and are retried next run. */
  failed: number;
}

export interface SweepLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export class ExpirySweepIncompleteError extends Error {
  override readonly name = 'ExpirySweepIncompleteError';
  constructor(readonly result: ExpirySweepResult) {
    super(`Invitation expiry sweep left ${result.failed} invitation(s) unprocessed`);
  }
}

const PAGE_SIZE = 100;

/**
 * Exclusive upper bound for GSI3SK covering every Invitation with
 * `expiresAt <= now`. Sort keys are `{expiresAt}#{id}` with fixed-width ISO
 * timestamps, and `$` (0x24) sorts directly after `#` (0x23).
 */
export function dueBefore(now: Date): string {
  return `${now.toISOString()}$`;
}

async function expireOne(
  table: TableClient,
  householdId: string,
  invitationId: string,
  nowIso: string,
): Promise<'expired' | 'skipped' | 'failed'> {
  const repo = new HouseholdRepository(table, householdId);
  const sk = sortKeys.invitation(invitationId);
  const record = await repo.get<Invitation & Record<string, unknown>>(sk);
  if (record === undefined) return 'skipped';
  const [expired] = sweepExpiredInvitations([record.attributes], nowIso);
  if (expired === undefined) return 'skipped';
  const write = await repo.replaceIfVersion(sk, record.version, { ...expired }, { indexKeys: invitationGsi2(invitationId) });
  if (write.ok) return 'expired';
  // A failed condition means the Invitation changed since the read (for
  // example it was accepted); the next run re-evaluates it if still pending.
  return write.error.reason === 'condition_failed' ? 'skipped' : 'failed';
}

/** Expires every pending Invitation due at `now`. Never throws for per-item failures. */
export async function sweepPendingInvitations(
  table: TableClient,
  now: Date,
  logger: SweepLogger = { warn: (m, d) => console.warn(m, d ?? {}) },
): Promise<ExpirySweepResult> {
  const nowIso = now.toISOString();
  const result: ExpirySweepResult = { examined: 0, expired: 0, skipped: 0, failed: 0 };
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await table.query({
      indexName: GSI3_NAME,
      partitionKey: PENDING_INVITATIONS_GSI3PK,
      sortKeyBefore: dueBefore(now),
      limit: PAGE_SIZE,
      ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
    });
    for (const item of page.items) {
      result.examined += 1;
      const householdId = parseHouseholdPk(item.PK);
      const invitationId = item.invitationId;
      if (householdId === undefined || typeof invitationId !== 'string') {
        logger.warn('Skipping malformed pending-invitation index entry', { sk: item.SK });
        result.skipped += 1;
        continue;
      }
      try {
        result[await expireOne(table, householdId, invitationId, nowIso)] += 1;
      } catch (err) {
        logger.warn('Invitation expiry failed', { error: err instanceof Error ? err.name : 'UnknownError' });
        result.failed += 1;
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return result;
}
