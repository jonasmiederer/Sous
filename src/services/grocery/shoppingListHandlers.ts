/**
 * API Gateway handlers for standalone shopping lists.
 *
 *   GET    /shopping-lists                 { shoppingLists: summaries }
 *   POST   /shopping-lists                 { name?, entries? } -> 201 { shoppingList, version }
 *   GET    /shopping-lists/{id}            { shoppingList, version }
 *   PUT    /shopping-lists/{id}            { name?, entries? } replace
 *   POST   /shopping-lists/{id}/items      { items } add and consolidate
 *   DELETE /shopping-lists/{id}            { deleted: true }
 */
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { Clock } from './groceryService.js';
import { errorResponse, respond, type AuthorizedGroceryRequest, type HttpResponse } from './handlers.js';
import { ShoppingListService } from './shoppingListService.js';

export type ShoppingListServiceFor = (scope: { householdId: ActiveHouseholdScope['householdId'] }) => ShoppingListService;

function parseBody(raw: string | null | undefined): Record<string, unknown> | undefined {
  try {
    const body: unknown = typeof raw === 'string' && raw.trim() !== '' ? JSON.parse(raw) : {};
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function guarded(run: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await run();
  } catch {
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  }
}

const badBody = () => errorResponse({ code: 'INVALID_REQUEST', message: 'Request body must be a JSON object.' });

export function createShoppingListHandlers(serviceFor: ShoppingListServiceFor) {
  return {
    listShoppingLists: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const result = await serviceFor(req.scope).list();
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    createShoppingList: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body) return badBody();
        const result = await serviceFor(req.scope).create({ name: body.name, entries: body.entries });
        return result.ok ? respond(201, result.value) : errorResponse(result.error);
      }),

    getShoppingList: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const result = await serviceFor(req.scope).get(req.pathParameters?.id);
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    updateShoppingList: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body) return badBody();
        const result = await serviceFor(req.scope).update(req.pathParameters?.id, { name: body.name, entries: body.entries });
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    addShoppingListItems: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body) return badBody();
        const result = await serviceFor(req.scope).addItems(req.pathParameters?.id, body.items);
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    deleteShoppingList: (req: AuthorizedGroceryRequest) =>
      guarded(async () => {
        const result = await serviceFor(req.scope).delete(req.pathParameters?.id);
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),
  };
}

export interface ShoppingListServiceFactoryConfig {
  tableClient: TableClient;
  clock?: Clock;
  newId?: () => string;
}

export function shoppingListServiceFactory(config: ShoppingListServiceFactoryConfig): ShoppingListServiceFor {
  const clock = config.clock ?? { now: () => new Date() };
  return (scope) =>
    new ShoppingListService({
      repository: new HouseholdRepository(config.tableClient, scope.householdId),
      clock,
      ...(config.newId ? { newId: config.newId } : {}),
    });
}
