/**
 * Thin API Gateway handlers for the Fridge Service.
 *
 *   GET /fridge                                         read the Household Fridge_Inventory
 *   PUT /fridge  { items: [{ name, quantity, unit }] }  replace it (4.3, 4.4, 4.6)
 *
 * Each request carries an Active_Household scope already resolved and
 * membership-verified by the authorizer (task 15.1).
 */
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import {
  FridgeService,
  type Clock,
  type FridgeError,
  type FridgeErrorCode,
  type FridgeResult,
} from './fridgeService.js';

export interface AuthorizedFridgeRequest {
  scope: ActiveHouseholdScope;
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type FridgeServiceFor = (scope: ActiveHouseholdScope) => FridgeService;

export const FRIDGE_ERROR_STATUS: Readonly<Record<FridgeErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NO_VALID_ITEMS: 400,
  FRIDGE_CONFLICT: 409,
  NOT_SAVED: 503,
  TIMEOUT: 504,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function errorResponse(error: FridgeError): HttpResponse {
  return respond(FRIDGE_ERROR_STATUS[error.code], { error });
}

async function guarded(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch {
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  }
}

function parseBody(body: string | null | undefined): FridgeResult<Record<string, unknown>> {
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

export function createFridgeHandlers(serviceFor: FridgeServiceFor) {
  return {
    getInventory: (req: AuthorizedFridgeRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).getInventory();
        if (!result.ok) return errorResponse(result.error);
        return respond(200, result.value ?? { inventory: null });
      }),
    replaceInventory: (req: AuthorizedFridgeRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body.ok) return errorResponse(body.error);
        const result = await serviceFor(req.scope).replaceInventory({
          items: body.value.items,
          clear: body.value.clear,
        });
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),
  };
}

export interface FridgeServiceFactoryConfig {
  tableClient: TableClient;
  clock?: Clock;
  deadlineMs?: number;
  maxAttempts?: number;
}

/** Builds a FridgeService bound to the request's Active_Household partition. */
export function fridgeServiceFactory(config: FridgeServiceFactoryConfig): FridgeServiceFor {
  return (scope) =>
    new FridgeService({
      repository: new HouseholdRepository(config.tableClient, scope.householdId),
      ...(config.clock ? { clock: config.clock } : {}),
      ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    });
}
