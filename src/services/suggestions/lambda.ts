/**
 * Lambda entry point for `POST /suggestions`.
 * Environment: TABLE_NAME, AGENT_RUNTIME_ARN, MEMORY_ID (see shared/runtime.ts).
 */
import { randomUUID } from 'node:crypto';
import { HouseholdRepository } from '../../data/repository.js';
import {
  createActiveHouseholdResolver,
  toScopeResolver,
  type AuthorizedApiEvent,
} from '../shared/authorization/index.js';
import { agentFromEnv, memoryFromEnv, tableFromEnv } from '../shared/runtime.js';
import { createSuggestionsHandler, type ApiGatewayEvent, type ApiGatewayResult } from './handler.js';
import { SuggestionService } from './suggestionService.js';

function build(): (event: ApiGatewayEvent) => Promise<ApiGatewayResult> {
  const table = tableFromEnv();
  const resolve = toScopeResolver(createActiveHouseholdResolver(table));
  return createSuggestionsHandler({
    service: new SuggestionService({
      repositoryFor: (householdId) => new HouseholdRepository(table, householdId),
      agent: agentFromEnv(),
      memory: memoryFromEnv(),
      now: Date.now,
      newId: randomUUID,
    }),
    resolveScope: (event) => resolve(event as AuthorizedApiEvent),
  });
}

let cached: ((event: ApiGatewayEvent) => Promise<ApiGatewayResult>) | undefined;

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
  cached ??= build();
  return cached(event);
}
