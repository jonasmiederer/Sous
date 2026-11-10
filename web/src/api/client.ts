/**
 * Framework-free HTTP client for the Sous API (Requirements 13.5, 13.16, 13.17).
 *
 * - Every non-public call sends `Authorization: <ID token>`. The ID token is
 *   used (not the access token) because membership code reads its `email` claim.
 * - Every Household call also sends `X-Active-Household`. With no selected
 *   Household the call throws `NoActiveHouseholdError` and `fetch` is never called.
 * - Each request has its own timeout (AbortController).
 * - A token within 60 s of expiry, or a `401` response, triggers one
 *   single-flight refresh; the failed request is retried once. When renewal
 *   fails, `onAuthFailure` runs so the session layer can sign the User out.
 *
 * The session source and the refresh function are injected; this module does
 * not know about React, storage, or Cognito.
 */
import { ApiError } from './errors';
import type { WireError } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** `public`: no identity. `user`: ID token only. `household`: ID token and Active_Household. */
export type EndpointAccess = 'public' | 'user' | 'household';

export const ACTIVE_HOUSEHOLD_HEADER = 'X-Active-Household';
/** Refresh proactively when the ID token expires within this window. */
export const REFRESH_MARGIN_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

/** The part of the stored session the client needs. */
export interface ClientSession {
  idToken: string;
  /** Epoch milliseconds at which the ID token expires. */
  expiresAt: number;
}

export interface ApiClientConfig {
  /** API base URL without a trailing slash (RuntimeConfig.apiUrl). */
  apiUrl: string;
}

export interface ApiClientOptions {
  config: ApiClientConfig;
  getSession: () => ClientSession | null | undefined;
  /** Renews the tokens and returns the new session, or null (or throws) when renewal failed. */
  refreshSession: () => Promise<ClientSession | null | undefined>;
  getActiveHouseholdId: () => string | null | undefined;
  /** Called when there is no usable session or renewal failed. */
  onAuthFailure?: () => void;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface RequestSpec {
  method: HttpMethod;
  /** Path starting with `/`, with ids already URL-encoded. */
  path: string;
  access: EndpointAccess;
  body?: unknown;
  timeoutMs?: number;
  /** Caller cancellation (e.g. TanStack Query). An aborted call rejects with the abort reason. */
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly config: ApiClientConfig;
  request<T>(spec: RequestSpec): Promise<T>;
}

export class NoActiveHouseholdError extends Error {
  override readonly name = 'NoActiveHouseholdError';
  constructor() {
    super('No household is selected.');
  }
}

/**
 * Parses a `retry-after` header: delta-seconds or an HTTP date.
 * Returns whole seconds (never negative), or undefined when absent or malformed.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - nowMs) / 1000));
}

/** Error code for a response without a usable `{ error: { code } }` body (e.g. API Gateway errors). */
function fallbackCode(status: number): string {
  if (status === 401) return 'AUTHENTICATION_REQUIRED';
  if (status === 429) return 'TOO_MANY_REQUESTS';
  if (status === 404) return 'NOT_FOUND';
  return 'INTERNAL_ERROR';
}

function readWireError(value: unknown): WireError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? (error as WireError) : undefined;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

type Attempt = { kind: 'response'; status: number; headers: Headers; text: string };

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const baseUrl = options.config.apiUrl.replace(/\/+$/, '');
  let inflightRefresh: Promise<ClientSession | null> | null = null;

  function authFailure(): ApiError {
    options.onAuthFailure?.();
    return new ApiError({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
  }

  /** Single-flight refresh: concurrent callers share one renewal. */
  function refreshOnce(): Promise<ClientSession | null> {
    if (inflightRefresh === null) {
      inflightRefresh = (async () => {
        try {
          const session = await options.refreshSession();
          return session && session.idToken ? session : null;
        } catch {
          return null;
        }
      })().finally(() => {
        inflightRefresh = null;
      });
    }
    return inflightRefresh;
  }

  async function currentToken(): Promise<string> {
    const session = options.getSession();
    if (!session || !session.idToken) throw authFailure();
    if (session.expiresAt - now() > REFRESH_MARGIN_MS) return session.idToken;
    const renewed = await refreshOnce();
    if (renewed === null) throw authFailure();
    return renewed.idToken;
  }

  /** Token to retry with after a 401 sent with `usedToken`. */
  async function tokenAfterUnauthorized(usedToken: string): Promise<string> {
    // Another request may already have renewed the session.
    const session = options.getSession();
    if (session && session.idToken && session.idToken !== usedToken && session.expiresAt - now() > REFRESH_MARGIN_MS) {
      return session.idToken;
    }
    const renewed = await refreshOnce();
    if (renewed === null) throw authFailure();
    return renewed.idToken;
  }

  async function send(spec: RequestSpec, headers: Record<string, string>): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (spec.signal) {
      if (spec.signal.aborted) controller.abort();
      else spec.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      const init: RequestInit = { method: spec.method, headers, signal: controller.signal };
      if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
      const response = await fetchImpl(`${baseUrl}${spec.path}`, init);
      // Reading the body stays inside the timeout.
      const text = await response.text();
      return { kind: 'response', status: response.status, headers: response.headers, text };
    } catch (err) {
      if (timedOut) throw new ApiError({ status: 0, code: 'REQUEST_TIMEOUT' });
      if (spec.signal?.aborted) throw spec.signal.reason ?? err;
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  function toResult<T>(attempt: Attempt): T {
    const parsed = parseJson(attempt.text);
    if (attempt.status >= 200 && attempt.status < 300) {
      if (!parsed.ok) throw new ApiError({ status: attempt.status, code: 'INTERNAL_ERROR', message: 'Response was not valid JSON.' });
      return parsed.value as T;
    }
    const wire = parsed.ok ? readWireError(parsed.value) : undefined;
    const retryAfterSeconds = parseRetryAfter(attempt.headers.get('retry-after'), now());
    return throwError(attempt.status, wire, retryAfterSeconds);
  }

  function throwError(status: number, wire: WireError | undefined, retryAfterSeconds: number | undefined): never {
    throw new ApiError({
      status,
      code: wire?.code ?? fallbackCode(status),
      ...(wire?.message !== undefined ? { message: wire.message } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(wire !== undefined ? { body: wire } : {}),
    });
  }

  async function request<T>(spec: RequestSpec): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';

    if (spec.access === 'household') {
      const householdId = options.getActiveHouseholdId();
      if (!householdId) throw new NoActiveHouseholdError();
      headers[ACTIVE_HOUSEHOLD_HEADER] = householdId;
    }

    if (spec.access === 'public') return toResult<T>(await send(spec, headers));

    const token = await currentToken();
    const first = await send(spec, { ...headers, Authorization: token });
    if (first.status !== 401) return toResult<T>(first);

    const retryToken = await tokenAfterUnauthorized(token);
    const second = await send(spec, { ...headers, Authorization: retryToken });
    if (second.status === 401) throw authFailure();
    return toResult<T>(second);
  }

  return { config: { apiUrl: baseUrl }, request };
}
