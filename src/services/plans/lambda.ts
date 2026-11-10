/**
 * Lambda entry point for the Plan Service routes.
 * Environment: TABLE_NAME, AGENT_RUNTIME_ARN, MEMORY_ID, EVENT_BUS_NAME.
 */
import {
  bodyText,
  createActiveHouseholdResolver,
  requireEnv,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
  type ScopedHandler,
} from '../shared/authorization/index.js';
import { agentFromEnv, memoryFromEnv, tableFromEnv } from '../shared/runtime.js';
import { EventBridgePlanEventPublisher } from './events.js';
import { createPlanHandlers, planServiceFactory, type AuthorizedPlanRequest } from './handlers.js';

type PlanHandler = (req: AuthorizedPlanRequest) => Promise<HttpResponse>;

/** Adapts an authorized proxy event to the Plan handler request shape. */
export const asPlanRoute =
  (h: PlanHandler): ScopedHandler =>
  (event, scope) =>
    h({ scope, pathParameters: event.pathParameters ?? null, body: bodyText(event) });

function build(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const table = tableFromEnv();
  const plans = createPlanHandlers(
    planServiceFactory({
      tableClient: table,
      agent: agentFromEnv(),
      memory: memoryFromEnv(),
      events: new EventBridgePlanEventPublisher({ eventBusName: requireEnv('EVENT_BUS_NAME') }),
    }),
  );
  return withActiveHousehold(
    createActiveHouseholdResolver(table),
    scopedRouter({
      'POST /plans': asPlanRoute(plans.generatePlan),
      'PUT /plans/{id}/days/{day}': asPlanRoute(plans.replaceDay),
      'POST /plans/{id}/days': asPlanRoute(plans.addDay),
      'DELETE /plans/{id}/days/{day}': asPlanRoute(plans.removeDay),
      'GET /plans': asPlanRoute(plans.listPlans),
      'GET /plans/{id}': asPlanRoute(plans.getPlan),
    }),
  );
}

let cached: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;

export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  cached ??= build();
  return cached(event);
}
