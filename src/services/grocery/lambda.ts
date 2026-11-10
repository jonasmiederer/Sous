/**
 * Lambda entry points for the Grocery Service.
 *
 *   handler                 API Gateway: POST and GET /plans/{id}/grocery-list
 *   mealPlanChangedHandler  EventBridge rule target for MealPlanChanged (7.5)
 *
 * Environment: TABLE_NAME.
 */
import type { TableClient } from '../../data/tableClient.js';
import {
  createActiveHouseholdResolver,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
} from '../shared/authorization/index.js';
import { tableFromEnv } from '../shared/runtime.js';
import { createMealPlanChangedConsumer, type ConsumerResult, type EventBridgeEnvelope } from './consumer.js';
import { createGroceryHandlers, groceryServiceFactory } from './handlers.js';

let table: TableClient | undefined;
const sharedTable = (): TableClient => (table ??= tableFromEnv());

function buildApi(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const grocery = createGroceryHandlers(groceryServiceFactory({ tableClient: sharedTable() }));
  return withActiveHousehold(
    createActiveHouseholdResolver(sharedTable()),
    scopedRouter({
      'POST /plans/{id}/grocery-list': (event, scope) =>
        grocery.generateGroceryList({ scope, pathParameters: event.pathParameters ?? null }),
      'GET /plans/{id}/grocery-list': (event, scope) =>
        grocery.getGroceryList({ scope, pathParameters: event.pathParameters ?? null }),
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
