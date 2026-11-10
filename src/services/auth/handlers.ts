/**
 * Thin API Gateway handler for the Auth & Membership Service.
 *
 * Routes by HTTP API `routeKey` ("POST /auth/login") or, for REST APIs, by
 * `${httpMethod} ${resource}`. Parses JSON bodies, extracts the caller from
 * authorizer claims, delegates to the service core, and maps ServiceResults to
 * HTTP responses. Errors never include request bodies or passwords.
 */
import { HTTP_STATUS, type ServiceResult } from './errors.js';
import type { LoginService } from './loginService.js';
import type { Caller, MembershipService } from './membershipService.js';

/** The subset of API Gateway (HTTP API v2 or REST v1) proxy events we read. */
export interface ApiEvent {
  routeKey?: string;
  httpMethod?: string;
  resource?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    authorizer?: {
      /** HTTP API JWT authorizer. */
      jwt?: { claims?: Record<string, unknown> };
      /** REST API Cognito authorizer. */
      claims?: Record<string, unknown>;
    };
  };
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function respond(statusCode: number, payload: unknown, extraHeaders: Record<string, string> = {}): ApiResponse {
  return { statusCode, headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(payload) };
}

function errorResponse(code: keyof typeof HTTP_STATUS, message: string): ApiResponse {
  return respond(HTTP_STATUS[code], { error: { code, message } });
}

function toResponse<T>(result: ServiceResult<T>, successStatus = 200): ApiResponse {
  if (result.ok) return respond(successStatus, result.value);
  const { code, message, retryAfterSeconds } = result.error;
  return respond(
    HTTP_STATUS[code],
    { error: { code, message } },
    retryAfterSeconds !== undefined ? { 'retry-after': String(retryAfterSeconds) } : {},
  );
}

type ParsedBody = { ok: true; value: unknown } | { ok: false };

function parseBody(event: ApiEvent): ParsedBody {
  if (event.body === undefined || event.body === null || event.body === '') return { ok: true, value: {} };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Reads the caller from verified authorizer claims (`sub`, `email`). */
export function callerFromEvent(event: ApiEvent): Caller | undefined {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? event.requestContext?.authorizer?.claims;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || sub.length === 0) return undefined;
  const email = claims?.email;
  return typeof email === 'string' ? { userId: sub, email } : { userId: sub };
}

function routeOf(event: ApiEvent): string {
  if (event.routeKey !== undefined && event.routeKey !== '$default') return event.routeKey;
  return `${event.httpMethod ?? ''} ${event.resource ?? ''}`;
}

export interface AuthHandlerDeps {
  login: LoginService;
  membership: MembershipService;
}

type AuthedRoute = (caller: Caller, body: unknown, path: Record<string, string | undefined>) => Promise<ApiResponse>;

export function createAuthHandler(deps: AuthHandlerDeps): (event: ApiEvent) => Promise<ApiResponse> {
  const { login, membership } = deps;

  const authed: Record<string, AuthedRoute> = {
    'GET /households': async (c) => toResponse(await membership.listHouseholds(c)),
    'GET /households/{id}/members': async (c, _b, p) => toResponse(await membership.listMembers(c, p.id)),
    'POST /households': async (c, b) => toResponse(await membership.createHousehold(c, b), 201),
    'POST /households/{id}/invitations': async (c, b, p) =>
      toResponse(await membership.inviteMember(c, p.id, b), 201),
    'POST /invitations/{id}/accept': async (c, _b, p) => toResponse(await membership.acceptInvitation(c, p.id)),
    'POST /invitations/{id}/decline': async (c, _b, p) => toResponse(await membership.declineInvitation(c, p.id)),
    'DELETE /households/{id}/members/{userId}': async (c, _b, p) =>
      toResponse(await membership.removeMember(c, p.id, p.userId)),
    'PUT /session/active-household': async (c, b) => toResponse(await membership.setActiveHousehold(c, b)),
  };

  return async (event) => {
    try {
      const route = routeOf(event);
      const body = parseBody(event);
      if (!body.ok) return errorResponse('INVALID_REQUEST', 'Request body must be valid JSON.');

      if (route === 'POST /auth/login') {
        const { identifier, password } = (body.value ?? {}) as { identifier?: unknown; password?: unknown };
        return toResponse(await login.login({ identifier, password }));
      }

      const handler = authed[route];
      if (handler === undefined) return errorResponse('NOT_FOUND', 'Route not found.');
      const caller = callerFromEvent(event);
      if (caller === undefined) return errorResponse('AUTHENTICATION_REQUIRED', 'Authentication is required.');
      return await handler(caller, body.value, event.pathParameters ?? {});
    } catch (err) {
      console.error('auth service error', { error: err instanceof Error ? err.name : 'UnknownError' });
      return errorResponse('INTERNAL_ERROR', 'The request could not be completed.');
    }
  };
}
