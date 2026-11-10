/**
 * API Gateway Lambda handler for `POST /suggestions`.
 *
 * Authentication (Cognito authorizer) and Active_Household membership
 * verification are task 15.1. This handler takes an injected
 * `resolveScope` that turns the authorized request into an
 * ActiveHouseholdScope, or into a 401/403 with no Household data.
 *
 * The event/result types are the minimal subset shared by API Gateway REST
 * (payload v1) and HTTP API (payload v2) proxy integrations.
 */
import type { ActiveHouseholdScope } from '../../domain/household.js';
import { SUGGESTION_ERROR_STATUS, type SuggestionError } from './errors.js';
import type { SuggestionService } from './suggestionService.js';

export interface ApiGatewayEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined> | null;
  requestContext?: unknown;
}

export interface ApiGatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type ScopeResolution =
  | { ok: true; scope: ActiveHouseholdScope }
  | { ok: false; status: 401 | 403; code: 'AUTHENTICATION_REQUIRED' | 'NOT_A_MEMBER'; message: string };

export type ScopeResolver = (event: ApiGatewayEvent) => Promise<ScopeResolution> | ScopeResolution;

export interface SuggestionsHandlerDeps {
  service: SuggestionService;
  resolveScope: ScopeResolver;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function respond(statusCode: number, body: unknown): ApiGatewayResult {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

export function errorResponse(error: SuggestionError): ApiGatewayResult {
  return respond(SUGGESTION_ERROR_STATUS[error.code], { error });
}

type ParsedBody = { ok: true; value: unknown } | { ok: false };

function parseBody(event: ApiGatewayEvent): ParsedBody {
  if (event.body === undefined || event.body === null || event.body === '') return { ok: true, value: {} };
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createSuggestionsHandler(deps: SuggestionsHandlerDeps) {
  return async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResult> {
    const resolution = await deps.resolveScope(event);
    if (!resolution.ok) {
      return respond(resolution.status, { error: { code: resolution.code, message: resolution.message } });
    }
    const body = parseBody(event);
    if (!body.ok) {
      return errorResponse({ code: 'INVALID_REQUEST', message: 'The request body must be valid JSON.' });
    }
    try {
      const result = await deps.service.suggest(resolution.scope, body.value);
      return result.ok ? respond(200, result.value) : errorResponse(result.error);
    } catch {
      // Unexpected defect: return a generic error without internal details.
      return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
    }
  };
}
