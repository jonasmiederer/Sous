/**
 * Thin API Gateway handlers for the Preference Service.
 *
 *   GET  /preferences                                       read the Household Preference_Profile
 *   POST /preferences/feedback     { item, value }          item: Meal_Suggestion/Meal name or id; value: like|dislike (6.1)
 *   POST /preferences/acceptances  { mealId }               record an acceptance (6.3)
 *   POST /preferences/constraints  { constraint }           add a dietary constraint (6.5, 6.6)
 *
 * Each request carries an Active_Household scope already resolved and
 * membership-verified by the authorizer (task 15.1). Handlers parse the body,
 * call the household-bound PreferenceService, and map results to HTTP
 * responses. Error bodies carry a code and message (plus a reason for
 * rejected dietary constraints) only.
 */
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { PreferenceError, PreferenceErrorCode, PreferenceResult } from './errors.js';
import { PreferenceService, type Clock, type SavedProfile } from './preferenceService.js';

export interface AuthorizedPreferenceRequest {
  scope: ActiveHouseholdScope;
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type PreferenceServiceFor = (scope: ActiveHouseholdScope) => PreferenceService;

export const PREFERENCE_ERROR_STATUS: Readonly<Record<PreferenceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  INVALID_DIETARY_CONSTRAINT: 400,
  PROFILE_CONFLICT: 409,
  NOT_SAVED: 503,
  TIMEOUT: 504,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function errorResponse(error: PreferenceError): HttpResponse {
  return respond(PREFERENCE_ERROR_STATUS[error.code], { error });
}

function parseBody(body: string | null | undefined): PreferenceResult<Record<string, unknown>> {
  const invalid = (message: string) => ({ ok: false as const, error: { code: 'INVALID_REQUEST' as const, message } });
  if (body === undefined || body === null || body.trim() === '') return invalid('Request body is required.');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return invalid('Request body must be valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('Request body must be a JSON object.');
  }
  return { ok: true, value: value as Record<string, unknown> };
}

async function guarded(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch {
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  }
}

function mutationHandler(
  serviceFor: PreferenceServiceFor,
  call: (service: PreferenceService, body: Record<string, unknown>) => Promise<PreferenceResult<SavedProfile>>,
) {
  return (req: AuthorizedPreferenceRequest): Promise<HttpResponse> =>
    guarded(async () => {
      const body = parseBody(req.body);
      if (!body.ok) return errorResponse(body.error);
      const result = await call(serviceFor(req.scope), body.value);
      return result.ok ? respond(200, result.value) : errorResponse(result.error);
    });
}

export function createPreferenceHandlers(serviceFor: PreferenceServiceFor) {
  return {
    getProfile: (req: AuthorizedPreferenceRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).getProfile();
        if (!result.ok) return errorResponse(result.error);
        return respond(200, result.value ?? { profile: null });
      }),
    recordFeedback: mutationHandler(serviceFor, (s, b) => s.recordFeedback({ item: b.item, value: b.value })),
    recordAcceptance: mutationHandler(serviceFor, (s, b) => s.recordAcceptance({ mealId: b.mealId })),
    addDietaryConstraint: mutationHandler(serviceFor, (s, b) => s.addDietaryConstraint({ constraint: b.constraint })),
  };
}

export interface PreferenceServiceFactoryConfig {
  tableClient: TableClient;
  clock?: Clock;
  deadlineMs?: number;
  maxAttempts?: number;
}

/** Builds a PreferenceService bound to the request's Active_Household partition. */
export function preferenceServiceFactory(config: PreferenceServiceFactoryConfig): PreferenceServiceFor {
  return (scope) =>
    new PreferenceService({
      repository: new HouseholdRepository(config.tableClient, scope.householdId),
      ...(config.clock ? { clock: config.clock } : {}),
      ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    });
}
