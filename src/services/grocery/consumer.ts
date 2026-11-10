/**
 * EventBridge consumer for MealPlanChanged (Requirement 7.5).
 *
 * Retry contract:
 * - Malformed events (wrong source / detail-type, bad detail shape, or a
 *   householdId / planId that is not a valid key component) are permanent
 *   failures: logged and acknowledged, never retried.
 * - PLAN_INCONSISTENT (plan references a missing Meal or invalid quantity) is
 *   also permanent: retrying cannot fix it. Logged and acknowledged.
 * - Storage read errors, save failures, a lost concurrency race after the
 *   service's own retries, and stale plan reads are transient: the handler
 *   throws so Lambda / EventBridge retries the event. A retried event that has
 *   meanwhile been superseded is dropped by the planVersion check.
 *
 * The repository is bound to the event's householdId, and the list is rebuilt
 * from the plan as currently stored (see groceryService.ts for the
 * regeneration policy).
 */
import { assertKeyComponent } from '../../data/keys.js';
import type { HouseholdId, PlanId } from '../../domain/types.js';
import { MEAL_PLAN_CHANGED_DETAIL_TYPE, MEAL_PLAN_CHANGED_SOURCE } from '../plans/events.js';
import type { GroceryServiceFor } from './handlers.js';
import type { RegenerationOutcome } from './groceryService.js';

/** The subset of the EventBridge envelope the consumer reads. */
export interface EventBridgeEnvelope {
  source?: unknown;
  'detail-type'?: unknown;
  detail?: unknown;
}

export interface ValidMealPlanChanged {
  householdId: HouseholdId;
  planId: PlanId;
  planVersion: number;
}

export interface ConsumerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export type ConsumerResult =
  | { status: 'ignored'; reason: string }
  | RegenerationOutcome;

export class GroceryRegenerationRetryableError extends Error {
  override readonly name = 'GroceryRegenerationRetryableError';
}

const CHANGE_KINDS = new Set(['day_added', 'day_removed', 'day_replaced']);

function isKeyComponent(v: unknown): v is string {
  try {
    assertKeyComponent('id', v);
    return true;
  } catch {
    return false;
  }
}

/** Validates the envelope and detail; returns a reason string when invalid. */
export function parseMealPlanChanged(event: EventBridgeEnvelope): ValidMealPlanChanged | string {
  if (event === null || typeof event !== 'object') return 'event is not an object';
  if (event.source !== MEAL_PLAN_CHANGED_SOURCE) return 'unexpected source';
  if (event['detail-type'] !== MEAL_PLAN_CHANGED_DETAIL_TYPE) return 'unexpected detail-type';
  const d = event.detail;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return 'detail is not an object';
  const detail = d as Record<string, unknown>;
  if (detail.type !== MEAL_PLAN_CHANGED_DETAIL_TYPE) return 'detail.type is not MealPlanChanged';
  if (!isKeyComponent(detail.householdId)) return 'invalid householdId';
  if (!isKeyComponent(detail.planId)) return 'invalid planId';
  if (typeof detail.change !== 'string' || !CHANGE_KINDS.has(detail.change)) return 'invalid change';
  if (typeof detail.planVersion !== 'number' || !Number.isInteger(detail.planVersion) || detail.planVersion < 1) {
    return 'invalid planVersion';
  }
  return { householdId: detail.householdId, planId: detail.planId, planVersion: detail.planVersion };
}

const consoleLogger: ConsumerLogger = {
  info: (m, d) => console.info(m, d ?? {}),
  warn: (m, d) => console.warn(m, d ?? {}),
  error: (m, d) => console.error(m, d ?? {}),
};

export function createMealPlanChangedConsumer(serviceFor: GroceryServiceFor, logger: ConsumerLogger = consoleLogger) {
  return async (event: EventBridgeEnvelope): Promise<ConsumerResult> => {
    const parsed = parseMealPlanChanged(event);
    if (typeof parsed === 'string') {
      logger.warn('Ignoring malformed MealPlanChanged event', { reason: parsed });
      return { status: 'ignored', reason: parsed };
    }
    const { householdId, planId, planVersion } = parsed;
    // Storage read errors and stale plan reads propagate so the event is retried.
    const outcome = await serviceFor({ householdId }).regenerate(planId, planVersion);

    if (outcome.status === 'failed') {
      if (outcome.error.code === 'PLAN_INCONSISTENT') {
        logger.error('Grocery list not regenerated: plan is inconsistent', {
          householdId,
          planId,
          planVersion,
          message: outcome.error.message,
        });
        return outcome;
      }
      throw new GroceryRegenerationRetryableError(
        `Grocery list regeneration failed (${outcome.error.code}) for plan ${planId}`,
      );
    }
    logger.info('MealPlanChanged processed', {
      householdId,
      planId,
      planVersion,
      status: outcome.status,
      ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
    });
    return outcome;
  };
}
