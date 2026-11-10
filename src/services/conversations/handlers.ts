/**
 * Thin API Gateway handlers for the Conversation Service.
 *
 *   POST /conversations                 { targetArtifactType, targetArtifactId, sessionId? }
 *   POST /conversations/{id}/messages   { message }
 *
 * Each handler receives an Active_Household scope that the authorizer layer
 * (task 15.1) has already verified; the service is built per request with a
 * repository bound to that Household.
 */
import type { MemoryClient } from '../../agent/memoryClient.js';
import type { SuggestionAgentClient } from '../../agent/runtimeClient.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { ConversationTarget } from './artifacts.js';
import {
  ConversationService,
  type ConversationErrorCode,
  type ConversationServiceDeps,
} from './service.js';

export interface HttpRequest {
  body?: string | null;
  pathParameters?: Record<string, string | undefined> | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type ConversationServiceFactory = (scope: ActiveHouseholdScope) => ConversationService;

export const ERROR_STATUS: Readonly<Record<ConversationErrorCode, number>> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  CANNOT_APPLY: 422,
  MEMORY_UNAVAILABLE: 503,
  AGENT_UNAVAILABLE: 503,
  TIMEOUT: 504,
  SAVE_FAILED: 500,
};

function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(code: ConversationErrorCode, message: string): HttpResponse {
  return json(ERROR_STATUS[code], { error: { code, message } });
}

function parseBody(req: HttpRequest): Record<string, unknown> | undefined {
  if (!req.body) return undefined;
  try {
    const v: unknown = JSON.parse(req.body);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Maps a request body to a ConversationTarget, or undefined if malformed. */
export function parseTarget(body: Record<string, unknown>): ConversationTarget | undefined {
  const { targetArtifactType: type, targetArtifactId: id, sessionId } = body;
  if (!nonEmpty(id)) return undefined;
  if (type === 'suggestion') return nonEmpty(sessionId) ? { type, sessionId, suggestionId: id } : undefined;
  if (type === 'plan' || type === 'grocery_list') return { type, planId: id };
  return undefined;
}

async function guarded(run: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await run();
  } catch {
    return json(500, { error: { code: 'INTERNAL', message: 'Something went wrong; nothing was changed.' } });
  }
}

export function createConversationHandlers(factory: ConversationServiceFactory) {
  return {
    createConversation: (req: HttpRequest, scope: ActiveHouseholdScope) =>
      guarded(async () => {
        const body = parseBody(req);
        const target = body && parseTarget(body);
        if (!target) {
          return errorResponse(
            'INVALID_REQUEST',
            'Provide targetArtifactType (suggestion, plan, grocery_list), targetArtifactId, and sessionId for suggestions.',
          );
        }
        const result = await factory(scope).createConversation(target);
        return result.ok ? json(201, { conversation: result.conversation }) : errorResponse(result.error.code, result.error.message);
      }),

    postMessage: (req: HttpRequest, scope: ActiveHouseholdScope) =>
      guarded(async () => {
        const conversationId = req.pathParameters?.id;
        if (!nonEmpty(conversationId)) return errorResponse('NOT_FOUND', 'The conversation was not found.');
        const body = parseBody(req);
        if (!body) return errorResponse('INVALID_REQUEST', 'Provide a JSON body with a message.');
        const result = await factory(scope).sendMessage(conversationId, body.message);
        if (!result.ok) return errorResponse(result.error.code, result.error.message);
        return result.outcome === 'clarification'
          ? json(200, { outcome: 'clarification', message: result.message })
          : json(200, { outcome: 'updated', artifact: result.artifact });
      }),
  };
}

/** Builds a factory that binds a new repository to each request's Active_Household. */
export function conversationServiceFactory(
  deps: { table: TableClient; agent: SuggestionAgentClient; memory: MemoryClient } & Omit<
    ConversationServiceDeps,
    'repository' | 'agent' | 'memory'
  >,
): ConversationServiceFactory {
  const { table, ...rest } = deps;
  return (scope) => new ConversationService({ ...rest, repository: new HouseholdRepository(table, scope.householdId) });
}
