/**
 * Lambda entry points for the Grocery Service.
 *
 *   handler                 API Gateway: POST, GET and PUT /plans/{id}/grocery-list
 *   mealPlanChangedHandler  EventBridge rule target for MealPlanChanged (7.5)
 *
 * Environment: TABLE_NAME.
 */
import type { TableClient } from '../../data/tableClient.js';
import {
  bodyText,
  createActiveHouseholdResolver,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
} from '../shared/authorization/index.js';
import { tableFromEnv } from '../shared/runtime.js';
import { createMealPlanChangedConsumer, type ConsumerResult, type EventBridgeEnvelope } from './consumer.js';
import { createGroceryHandlers, groceryServiceFactory } from './handlers.js';
import { createShoppingListHandlers, shoppingListServiceFactory } from './shoppingListHandlers.js';

let table: TableClient | undefined;
const sharedTable = (): TableClient => (table ??= tableFromEnv());

function buildApi(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const grocery = createGroceryHandlers(groceryServiceFactory({ tableClient: sharedTable() }));
  const lists = createShoppingListHandlers(shoppingListServiceFactory({ tableClient: sharedTable() }));
  const idParam = (event: AuthorizedApiEvent) => event.pathParameters ?? null;
  return withActiveHousehold(
    createActiveHouseholdResolver(sharedTable()),
    scopedRouter({
      'DELETE /plans/{id}/grocery-list': (event, scope) =>
        grocery.deleteGroceryList({ scope, pathParameters: idParam(event) }),
      'GET /shopping-lists': (_event, scope) => lists.listShoppingLists({ scope }),
      'POST /shopping-lists': (event, scope) => lists.createShoppingList({ scope, body: bodyText(event) }),
      'GET /shopping-lists/{id}': (event, scope) => lists.getShoppingList({ scope, pathParameters: idParam(event) }),
      'PUT /shopping-lists/{id}': (event, scope) =>
        lists.updateShoppingList({ scope, pathParameters: idParam(event), body: bodyText(event) }),
      'POST /shopping-lists/{id}/items': (event, scope) =>
        lists.addShoppingListItems({ scope, pathParameters: idParam(event), body: bodyText(event) }),
      'DELETE /shopping-lists/{id}': (event, scope) =>
        lists.deleteShoppingList({ scope, pathParameters: idParam(event) }),
      'POST /plans/{id}/grocery-list': (event, scope) =>
        grocery.generateGroceryList({ scope, pathParameters: event.pathParameters ?? null }),
      'GET /plans/{id}/grocery-list': (event, scope) =>
        grocery.getGroceryList({ scope, pathParameters: event.pathParameters ?? null }),
      'PUT /plans/{id}/grocery-list': (event, scope) =>
        grocery.updateGroceryList({ scope, pathParameters: event.pathParameters ?? null, body: bodyText(event) }),
    }),
  );
}

let api: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;
export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  api ??= buildApi();
  return api(event);
}

let consumer: ((event: EventBridgeEnvelope) => Promise<ConsumerResult>) | undefined;
export async function mealPlanChangedHandler(event: EventBridgeEnvelope): Promise<ConsumerResult> {
  consumer ??= createMealPlanChangedConsumer(groceryServiceFactory({ tableClient: sharedTable() }));
  return consumer(event);
}
