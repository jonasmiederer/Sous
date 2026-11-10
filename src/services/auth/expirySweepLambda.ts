/**
 * Lambda entry point for the scheduled Invitation expiry sweep (Requirement 10.5).
 * Invoked by an EventBridge Scheduler schedule. Environment: TABLE_NAME.
 *
 * Throws when any Invitation could not be processed so the invocation is
 * reported as failed (Scheduler retry policy, CloudWatch errors metric). The
 * sweep is idempotent, so a retry is safe.
 */
import type { TableClient } from '../../data/tableClient.js';
import { tableFromEnv } from '../shared/runtime.js';
import { ExpirySweepIncompleteError, sweepPendingInvitations, type ExpirySweepResult } from './expirySweep.js';

let table: TableClient | undefined;

export async function handler(): Promise<ExpirySweepResult> {
  table ??= tableFromEnv();
  const result = await sweepPendingInvitations(table, new Date());
  console.info('Invitation expiry sweep finished', { ...result });
  if (result.failed > 0) throw new ExpirySweepIncompleteError(result);
  return result;
}
