/**
 * Shared request authorization for every Household-scoped orchestration
 * entry point (Requirements 1.5, 1.6, 1.7).
 *
 * Authentication
 *   Token verification (signature, issuer, audience, expiry) happens at the
 *   edge: API Gateway's Cognito JWT authorizer (HTTP API) or Cognito User
 *   Pool authorizer (REST API), configured in IaC (task 16.1). Requests with
 *   a missing or invalid token never reach a Lambda. As defense in depth,
 *   every entry point here still rejects an event that carries no verified
 *   `sub` claim with 401 AUTHENTICATION_REQUIRED and no data. JWTs are never
 *   parsed or verified by hand in Lambda.
 *
 * Active_Household
 *   The client sends the selected Household on every request in the
 *   `X-Active-Household` header (header name matched case-insensitively).
 *   Membership is re-verified on each request with a strongly consistent read
 *   of `HH#{householdId} / MEMBER#{userId}`; there is no server-side session
 *   cache, so a removed member is denied on their very next request.
 *
 *   A missing header, a malformed id, and a Household the caller is not a
 *   member of all return the same 403 NOT_A_MEMBER response. Using one
 *   response for all three means the API never reveals whether a Household
 *   exists, and it fits the 401/403 contract the service handlers expect.
 *
 * Consistency
 *   Membership checks use the base table (ConsistentRead). GSIs are eventually
 *   consistent and are never used for authorization decisions.
 */
import { callerFromEvent, type ApiEvent } from '../../auth/handlers.js';
import { assertKeyComponent, sortKeys } from '../../../data/keys.js';
import { HouseholdRepository } from '../../../data/repository.js';
import type { TableClient } from '../../../data/tableClient.js';
import { resolveActiveHousehold, type ActiveHouseholdScope } from '../../../domain/household.js';
import type { Membership } from '../../../domain/types.js';

export const ACTIVE_HOUSEHOLD_HEADER = 'x-active-household';

/** API Gateway proxy event (REST v1 or HTTP API v2) fields read by entry points. */
export interface AuthorizedApiEvent extends ApiEvent {
  headers?: Record<string, string | undefined> | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type ScopeDenial = {
  ok: false;
  status: 401 | 403;
  code: 'AUTHENTICATION_REQUIRED' | 'NOT_A_MEMBER';
  message: string;
};

export type ScopeResolution = { ok: true; scope: ActiveHouseholdScope } | ScopeDenial;

export type ActiveHouseholdResolver = (event: AuthorizedApiEvent) => Promise<ScopeResolution>;

const AUTHENTICATION_REQUIRED: ScopeDenial = {
  ok: false,
  status: 401,
  code: 'AUTHENTICATION_REQUIRED',
  message: 'Authentication is required.',
};

const NOT_A_MEMBER: ScopeDenial = {
  ok: false,
  status: 403,
  code: 'NOT_A_MEMBER',
  message: 'You do not have access to this household.',
};

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export function jsonResponse(statusCode: number, payload: unknown): HttpResponse {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(payload) };
}

export function denialResponse(denial: ScopeDenial): HttpResponse {
  return jsonResponse(denial.status, { error: { code: denial.code, message: denial.message } });
}

const INTERNAL_ERROR = (): HttpResponse =>
  jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });

/** Reads a header by case-insensitive name; undefined when absent. */
export function headerValue(event: AuthorizedApiEvent, name: string): string | undefined {
  const headers = event.headers;
  if (headers === undefined || headers === null) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

function validHouseholdId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  try {
    return assertKeyComponent('householdId', value);
  } catch {
    return undefined;
  }
}

/**
 * Builds the per-request Active_Household resolver. Storage errors propagate
 * (fail closed): callers turn them into a generic 500 with no data.
 */
export function createActiveHouseholdResolver(table: TableClient): ActiveHouseholdResolver {
  return async (event) => {
    const caller = callerFromEvent(event);
    if (caller === undefined) return AUTHENTICATION_REQUIRED;

    const householdId = validHouseholdId(headerValue(event, ACTIVE_HOUSEHOLD_HEADER));
    if (householdId === undefined) return NOT_A_MEMBER;
    let memberSk: string;
    try {
      memberSk = sortKeys.member(caller.userId);
    } catch {
      return AUTHENTICATION_REQUIRED; // a `sub` that cannot form a key is not a usable identity
    }

    const record = await new HouseholdRepository(table, householdId).get<Membership & Record<string, unknown>>(memberSk);
    const memberships = record === undefined ? [] : [record.attributes];
    const scope = resolveActiveHousehold(caller.userId, householdId, memberships);
    return scope.ok ? { ok: true, scope: scope.value } : NOT_A_MEMBER;
  };
}

/** Wraps a resolver so storage errors become a denial-free 500 response. */
async function resolveSafely(
  resolve: ActiveHouseholdResolver,
  event: AuthorizedApiEvent,
): Promise<ScopeResolution | 'error'> {
  try {
    return await resolve(event);
  } catch (err) {
    console.error('authorization error', { error: err instanceof Error ? err.name : 'UnknownError' });
    return 'error';
  }
}

export type ScopedHandler<E extends AuthorizedApiEvent = AuthorizedApiEvent> = (
  event: E,
  scope: ActiveHouseholdScope,
) => Promise<HttpResponse>;

/**
 * Runs `handler` only after authentication and Active_Household membership
 * have been verified for this request. Denials return 401/403 with no data.
 */
export function withActiveHousehold<E extends AuthorizedApiEvent>(
  resolve: ActiveHouseholdResolver,
  handler: ScopedHandler<E>,
): (event: E) => Promise<HttpResponse> {
  return async (event) => {
    const resolution = await resolveSafely(resolve, event);
    if (resolution === 'error') return INTERNAL_ERROR();
    if (!resolution.ok) return denialResponse(resolution);
    try {
      return await handler(event, resolution.scope);
    } catch (err) {
      console.error('handler error', { error: err instanceof Error ? err.name : 'UnknownError' });
      return INTERNAL_ERROR();
    }
  };
}

/**
 * Adapts the resolver to handlers that call it themselves (the Suggestions
 * handler's ScopeResolver). Storage errors are reported as 403 with no data
 * because that contract has no 5xx branch; the request still fails closed.
 */
export function toScopeResolver(resolve: ActiveHouseholdResolver): ActiveHouseholdResolver {
  return async (event) => {
    const resolution = await resolveSafely(resolve, event);
    return resolution === 'error' ? NOT_A_MEMBER : resolution;
  };
}

// ---------------------------------------------------------------------------
// Event helpers shared by Lambda entry modules
// ---------------------------------------------------------------------------

/** HTTP API `routeKey`, or `${httpMethod} ${resource}` for REST APIs. */
export function routeOf(event: AuthorizedApiEvent): string {
  if (event.routeKey !== undefined && event.routeKey !== '$default') return event.routeKey;
  return `${event.httpMethod ?? ''} ${event.resource ?? ''}`;
}

/** Decodes a possibly base64-encoded proxy body to text. */
export function bodyText(event: AuthorizedApiEvent): string | null {
  if (event.body === undefined || event.body === null) return null;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** Dispatches an already-authorized request by route; unknown routes are 404. */
export function scopedRouter<E extends AuthorizedApiEvent>(routes: Record<string, ScopedHandler<E>>): ScopedHandler<E> {
  return async (event, scope) => {
    const handler = routes[routeOf(event)];
    if (handler === undefined) return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    return handler(event, scope);
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing environment variable ${name}`);
  return value;
}
