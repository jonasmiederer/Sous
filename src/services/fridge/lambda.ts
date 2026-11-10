/**
 * Lambda entry point for the Fridge Service routes. Environment: TABLE_NAME.
 */
import {
  bodyText,
  createActiveHouseholdResolver,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
} from '../shared/authorization/index.js';
import { tableFromEnv } from '../shared/runtime.js';
import { createFridgeHandlers, fridgeServiceFactory } from './handlers.js';

function build(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const table = tableFromEnv();
  const fridge = createFridgeHandlers(fridgeServiceFactory({ tableClient: table }));
  return withActiveHousehold(
    createActiveHouseholdResolver(table),
    scopedRouter({
      'GET /fridge': (event, scope) => fridge.getInventory({ scope, body: bodyText(event) }),
      'PUT /fridge': (event, scope) => fridge.replaceInventory({ scope, body: bodyText(event) }),
    }),
  );
}

let cached: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;
export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  cached ??= build();
  return cached(event);
}
