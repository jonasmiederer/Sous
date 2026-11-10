/**
 * Test harness: an in-memory Storage, a scripted fetch, unsigned JWTs, and a
 * helper that renders the real providers and routes in a MemoryRouter.
 */
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppRoot } from '../App';
import { createAppServices, type AppServices } from '../app/services';
import { SESSION_STORAGE_KEY, activeHouseholdKey, type StoredSession } from '../auth/session';
import type { RuntimeConfig } from '../config/runtimeConfig';

export const TEST_CONFIG: RuntimeConfig = {
  apiUrl: 'https://api.test',
  region: 'eu-west-1',
  userPoolId: 'eu-west-1_pool',
  userPoolClientId: 'client-123',
};
export const COGNITO_URL = 'https://cognito-idp.eu-west-1.amazonaws.com/';

export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  keys() {
    return [...this.map.keys()];
  }
}

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An unsigned JWT with the given claims. */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: 'none' }))}.${base64Url(JSON.stringify(claims))}.sig`;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** `METHOD url` (e.g. `GET https://api.test/households`, `POST cognito:SignUp`) → response or responder. */
export type Routes = Record<string, FakeResponse | ((call: RecordedCall) => FakeResponse)>;

export function fakeFetch(routes: Routes) {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const call: RecordedCall = { url, method, headers, body };
    calls.push(call);
    const target = headers['x-amz-target'];
    const key = url === COGNITO_URL && target ? `POST cognito:${target.split('.').pop()}` : `${method} ${url}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    const res = typeof route === 'function' ? route(call) : route;
    return new Response(res.body === undefined ? '' : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json', ...res.headers },
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

export const NOW = Date.UTC(2030, 0, 1);
export const USER = { userId: 'user-1', email: 'ana@example.com' };

export function testSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    idToken: makeJwt({ sub: USER.userId, exp: NOW / 1000 + 3600 }),
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: NOW + 3600_000,
    user: USER,
    ...overrides,
  };
}

export interface RenderAppOptions {
  path?: string;
  routes?: Routes;
  session?: StoredSession | null;
  activeHouseholdId?: string;
  storage?: MemoryStorage;
}

export function renderApp(options: RenderAppOptions = {}) {
  const storage = options.storage ?? new MemoryStorage();
  if (options.session) storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(options.session));
  if (options.session && options.activeHouseholdId) {
    storage.setItem(activeHouseholdKey(options.session.user.userId), options.activeHouseholdId);
  }
  const net = fakeFetch(options.routes ?? {});
  const services: AppServices = createAppServices({
    config: TEST_CONFIG,
    storage,
    fetch: net.fetch,
    now: () => NOW,
    queryDefaults: { queries: { retry: false } },
  });
  const view = render(
    <MemoryRouter initialEntries={[options.path ?? '/']}>
      <AppRoot services={services} />
    </MemoryRouter>,
  );
  return { ...view, storage, services, calls: net.calls };
}

export const HOUSEHOLDS_URL = `${TEST_CONFIG.apiUrl}/households`;
export const ONE_HOUSEHOLD = { households: [{ householdId: 'hh-1', name: 'Home', role: 'owner', ownerUserId: USER.userId }] };
