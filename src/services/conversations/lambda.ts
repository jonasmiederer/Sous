/**
 * Lambda entry point for the Conversation Service routes.
 * Environment: TABLE_NAME, AGENT_RUNTIME_ARN, MEMORY_ID, EVENT_BUS_NAME.
 *
 * Plan refinements publish MealPlanChanged (day_replaced) so the Grocery
 * Service regenerates the plan's list.
 */
import type { ActiveHouseholdScope } from '../../domain/household.js';
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
import { EventBridgePlanEventPublisher } from '../plans/events.js';
import { agentFromEnv, memoryFromEnv, tableFromEnv } from '../shared/runtime.js';
import { conversationServiceFactory, createConversationHandlers, type HttpRequest } from './handlers.js';
import { publishPlanRefinement } from './planEvents.js';

type ConversationHandler = (req: HttpRequest, scope: ActiveHouseholdScope) => Promise<HttpResponse>;

/** Adapts an authorized proxy event to the Conversation handler shape. */
export const asConversationRoute =
  (h: ConversationHandler): ScopedHandler =>
  (event, scope) =>
    h({ body: bodyText(event), pathParameters: event.pathParameters ?? null }, scope);

function build(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const table = tableFromEnv();
  const conversations = createConversationHandlers(
    conversationServiceFactory({
      table,
      agent: agentFromEnv(),
      memory: memoryFromEnv(),
      onPlanChanged: publishPlanRefinement(
        new EventBridgePlanEventPublisher({ eventBusName: requireEnv('EVENT_BUS_NAME') }),
      ),
    }),
  );
  return withActiveHousehold(
    createActiveHouseholdResolver(table),
    scopedRouter({
      'POST /conversations': asConversationRoute(conversations.createConversation),
      'POST /conversations/{id}/messages': asConversationRoute(conversations.postMessage),
    }),
  );
}

let cached: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;

export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  cached ??= build();
  return cached(event);
}
