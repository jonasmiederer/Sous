/**
 * Lambda entry point for the Preference Service routes. Environment: TABLE_NAME.
 */
import {
  bodyText,
  createActiveHouseholdResolver,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
  type ScopedHandler,
} from '../shared/authorization/index.js';
import { tableFromEnv } from '../shared/runtime.js';
import { createPreferenceHandlers, preferenceServiceFactory, type AuthorizedPreferenceRequest } from './handlers.js';

type PreferenceHandler = (req: AuthorizedPreferenceRequest) => Promise<HttpResponse>;

const asRoute =
  (h: PreferenceHandler): ScopedHandler =>
  (event, scope) =>
    h({ scope, body: bodyText(event) });

function build(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const table = tableFromEnv();
  const preferences = createPreferenceHandlers(preferenceServiceFactory({ tableClient: table }));
  return withActiveHousehold(
    createActiveHouseholdResolver(table),
    scopedRouter({
      'GET /preferences': asRoute(preferences.getProfile),
      'POST /preferences/feedback': asRoute(preferences.recordFeedback),
      'POST /preferences/acceptances': asRoute(preferences.recordAcceptance),
      'POST /preferences/constraints': asRoute(preferences.addDietaryConstraint),
    }),
  );
}

let cached: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;
export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  cached ??= build();
  return cached(event);
}
