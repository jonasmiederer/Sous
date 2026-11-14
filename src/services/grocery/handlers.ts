/**
 * Thin API Gateway handler for the Grocery Service.
 *
 *   POST /plans/{id}/grocery-list   generate (or rebuild) the plan's Grocery_List
 *   GET  /plans/{id}/grocery-list   read the stored list (404 GROCERY_LIST_NOT_FOUND)
 *   PUT  /plans/{id}/grocery-list   replace the entries with a manual edit { entries }
 *   DELETE /plans/{id}/grocery-list delete the plan's list
 *
 * Standalone lists live in shoppingListHandlers.ts.
 *
 * The request's Active_Household scope was already resolved and
 * membership-verified by the authorizer (task 15.1). The handler calls the
 * household-bound GroceryService and maps results to HTTP responses:
 * 201 when the list was created, 200 when an existing list was replaced.
 * Error bodies carry a code and message only.
 */
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { GroceryServiceError, GroceryServiceErrorCode } from './errors.js';
import { GroceryService, type Clock } from './groceryService.js';

export interface AuthorizedGroceryRequest {
  /** Already-authorized Active_Household scope. */
  scope: ActiveHouseholdScope;
  pathParameters?: Record<string, string | undefined> | null;
  /** Raw request body (PUT only). */
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type GroceryServiceFor = (scope: { householdId: ActiveHouseholdScope['householdId'] }) => GroceryService;

export const GROCERY_ERROR_STATUS: Readonly<Record<GroceryServiceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  PLAN_NOT_FOUND: 404,
  GROCERY_LIST_NOT_FOUND: 404,
  SHOPPING_LIST_NOT_FOUND: 404,
  TOO_MANY_SHOPPING_LISTS: 409,
  PLAN_INCONSISTENT: 422,
  GROCERY_CONFLICT: 409,
  SAVE_DID_NOT_COMPLETE: 503,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

export function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function errorResponse(error: GroceryServiceError): HttpResponse {
  return respond(GROCERY_ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
}

export function createGroceryHandlers(serviceFor: GroceryServiceFor) {
  return {
    generateGroceryList: async (req: AuthorizedGroceryRequest): Promise<HttpResponse> => {
      try {
        const result = await serviceFor(req.scope).generate(req.pathParameters?.id);
        if (!result.ok) return errorResponse(result.error);
        const { groceryList, version, created } = result.value;
        return respond(created ? 201 : 200, { groceryList, version });
      } catch {
        return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
      }
    },

    getGroceryList: async (req: AuthorizedGroceryRequest): Promise<HttpResponse> => {
      try {
        const result = await serviceFor(req.scope).get(req.pathParameters?.id);
        if (!result.ok) return errorResponse(result.error);
        const { groceryList, version, sourcePlanVersion } = result.value;
        return respond(200, { groceryList, version, sourcePlanVersion });
      } catch {
        return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
      }
    },

    deleteGroceryList: async (req: AuthorizedGroceryRequest): Promise<HttpResponse> => {
      try {
        const result = await serviceFor(req.scope).deletePlanList(req.pathParameters?.id);
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      } catch {
        return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
      }
    },

    updateGroceryList: async (req: AuthorizedGroceryRequest): Promise<HttpResponse> => {
      try {
        let body: unknown;
        try {
          body = typeof req.body === 'string' && req.body.trim() !== '' ? JSON.parse(req.body) : undefined;
        } catch {
          body = undefined;
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return errorResponse({ code: 'INVALID_REQUEST', message: 'Request body must be a JSON object with "entries".' });
        }
        const result = await serviceFor(req.scope).updateEntries(req.pathParameters?.id, (body as { entries?: unknown }).entries);
        if (!result.ok) return errorResponse(result.error);
        const { groceryList, version, sourcePlanVersion } = result.value;
        return respond(200, { groceryList, version, sourcePlanVersion });
      } catch {
        return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
      }
    },
  };
}

export interface GroceryServiceFactoryConfig {
  tableClient: TableClient;
  clock?: Clock;
  maxWriteAttempts?: number;
}

/** Builds a GroceryService bound to the given Household partition. */
export function groceryServiceFactory(config: GroceryServiceFactoryConfig): GroceryServiceFor {
  const clock = config.clock ?? { now: () => new Date() };
  return (scope) =>
    new GroceryService({
      repository: new HouseholdRepository(config.tableClient, scope.householdId),
      clock,
      ...(config.maxWriteAttempts !== undefined ? { maxWriteAttempts: config.maxWriteAttempts } : {}),
    });
}
