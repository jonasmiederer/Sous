import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, NoActiveHouseholdError, parseRetryAfter, type ClientSession } from './client';
import { createEndpoints, ROUTES } from './endpoints';
import { ApiError, ERROR_MESSAGES, GENERIC_ERROR_MESSAGE, messageFor } from './errors';
import { parseRuntimeConfig, RuntimeConfigError } from '../config/runtimeConfig';

const NOW = 1_700_000_000_000;
const API = 'https://api.example.test';

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setup(opts: {
  responses: Array<Response | ((call: Call) => Response | Promise<Response>)>;
  session?: ClientSession | null;
  householdId?: string | null;
  refresh?: () => Promise<ClientSession | null>;
}) {
  const calls: Call[] = [];
  let session: ClientSession | null = opts.session === undefined ? { idToken: 'id-1', expiresAt: NOW + 3_600_000 } : opts.session;
  const queue = [...opts.responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    return typeof next === 'function' ? next(call) : next;
  });
  const refreshSession = vi.fn(
    opts.refresh ??
      (async () => {
        session = { idToken: 'id-2', expiresAt: NOW + 3_600_000 };
        return session;
      }),
  );
  const onAuthFailure = vi.fn();
  const client = createApiClient({
    config: { apiUrl: `${API}/` },
    getSession: () => session,
    refreshSession,
    getActiveHouseholdId: () => (opts.householdId === undefined ? 'hh-1' : opts.householdId),
    onAuthFailure,
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
  });
  return { api: createEndpoints(client), calls, fetchMock, refreshSession, onAuthFailure };
}

const header = (call: Call | undefined, name: string) => (call?.init.headers as Record<string, string>)[name];

afterEach(() => {
  vi.useRealTimers();
});

describe('request headers', () => {
  it('sends the ID token and Active_Household on Household calls', async () => {
    const { api, calls } = setup({ responses: [json(200, { plans: [] })] });
    await expect(api.listPlans()).resolves.toEqual({ plans: [] });
    expect(calls[0]?.url).toBe(`${API}/plans`);
    expect(header(calls[0], 'Authorization')).toBe('id-1');
    expect(header(calls[0], 'X-Active-Household')).toBe('hh-1');
  });

  it('sends only the ID token on user-level calls', async () => {
    const { api, calls } = setup({ responses: [json(200, { households: [] })] });
    await api.listHouseholds();
    expect(header(calls[0], 'Authorization')).toBe('id-1');
    expect(header(calls[0], 'X-Active-Household')).toBeUndefined();
  });

  it('never sends Authorization to /auth/login', async () => {
    const { api, calls } = setup({ responses: [json(200, { kind: 'challenge', challengeName: 'NEW_PASSWORD_REQUIRED' })] });
    await api.login({ identifier: 'a@example.com', password: 'pw-123456' });
    expect(header(calls[0], 'Authorization')).toBeUndefined();
    expect(calls[0]?.init.body).toBe(JSON.stringify({ identifier: 'a@example.com', password: 'pw-123456' }));
  });

  it('throws NoActiveHouseholdError without calling fetch', async () => {
    const { api, fetchMock } = setup({ responses: [], householdId: null });
    await expect(api.getFridge()).rejects.toBeInstanceOf(NoActiveHouseholdError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL-encodes path parameters', async () => {
    const { api, calls } = setup({ responses: [json(200, {})] });
    await api.replaceDay('plan/1', '2025-01-02');
    expect(calls[0]?.url).toBe(`${API}/plans/plan%2F1/days/2025-01-02`);
    expect(calls[0]?.init.method).toBe('PUT');
  });
});

describe('errors', () => {
  it('parses the error body and retry-after', async () => {
    const { api } = setup({
      responses: [
        json(423, { error: { code: 'ACCOUNT_TEMPORARILY_LOCKED', message: 'locked' } }, { 'retry-after': '120' }),
      ],
    });
    const err = await api.login({ identifier: 'a@example.com', password: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 423, code: 'ACCOUNT_TEMPORARILY_LOCKED', retryAfterSeconds: 120 });
    expect((err as ApiError).userMessage).toBe(ERROR_MESSAGES.ACCOUNT_TEMPORARILY_LOCKED);
  });

  it('maps a body without an error code by status', async () => {
    const { api } = setup({ responses: [json(429, { message: 'Too Many Requests' })] });
    await expect(api.getPreferences()).rejects.toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it('reports network failures as NETWORK_ERROR', async () => {
    const { api } = setup({
      responses: [
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    });
    await expect(api.getFridge()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('aborts after the endpoint timeout', async () => {
    vi.useFakeTimers();
    const { api } = setup({
      responses: [
        (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ],
    });
    const pending = api.suggest({}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ROUTES.suggest.timeoutMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('messageFor returns specific and generic messages', () => {
    expect(messageFor('AUDIO_CONVERSION_FAILED')).toBe(ERROR_MESSAGES.AUDIO_CONVERSION_FAILED);
    expect(messageFor('SOMETHING_NEW')).toBe(GENERIC_ERROR_MESSAGE);
    expect(messageFor('toString')).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('parseRetryAfter accepts seconds and HTTP dates', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30);
    expect(parseRetryAfter(new Date(NOW + 90_500).toUTCString(), NOW)).toBe(90);
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
  });
});

describe('token renewal', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const { api, calls, refreshSession } = setup({
      responses: [json(401, { message: 'Unauthorized' }), json(200, { households: [] })],
    });
    await expect(api.listHouseholds()).resolves.toEqual({ households: [] });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(header(calls[1], 'Authorization')).toBe('id-2');
  });

  it('shares one refresh across concurrent 401s', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, refreshSession } = setup({
      responses: [
        json(401, {}),
        json(401, {}),
        json(200, { plans: [] }),
        json(200, { plans: [] }),
      ],
      refresh: async () => {
        await gate;
        return { idToken: 'id-2', expiresAt: NOW + 3_600_000 };
      },
    });
    const both = Promise.all([api.listPlans(), api.listPlans()]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await expect(both).resolves.toHaveLength(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('refreshes proactively when the token is about to expire', async () => {
    const { api, calls, refreshSession } = setup({
      session: { idToken: 'id-old', expiresAt: NOW + 30_000 },
      responses: [json(200, { plans: [] })],
    });
    await api.listPlans();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(header(calls[0], 'Authorization')).toBe('id-2');
  });

  it('reports auth failure when renewal fails', async () => {
    const { api, onAuthFailure, fetchMock } = setup({
      responses: [json(401, {})],
      refresh: async () => null,
    });
    await expect(api.getFridge()).rejects.toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch without a session', async () => {
    const { api, onAuthFailure, fetchMock } = setup({ responses: [], session: null });
    await expect(api.listHouseholds()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });
});

describe('runtime config', () => {
  const valid = { apiUrl: 'https://api.example.test/', region: 'eu-west-1', userPoolId: 'eu-west-1_abc', userPoolClientId: 'client' };

  it('accepts a complete config and strips the trailing slash', () => {
    expect(parseRuntimeConfig(valid).apiUrl).toBe('https://api.example.test');
  });

  it('rejects missing fields and non-HTTPS URLs', () => {
    expect(() => parseRuntimeConfig({ ...valid, userPoolId: '' })).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig({ ...valid, apiUrl: 'http://api.example.test' })).toThrow(RuntimeConfigError);
    expect(() => parseRuntimeConfig(null)).toThrow(RuntimeConfigError);
  });
});
