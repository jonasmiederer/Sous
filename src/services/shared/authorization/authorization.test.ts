import { describe, expect, it, vi } from 'vitest';
import { InMemoryTableClient } from '../../../../test/fakes/inMemoryTableClient.js';
import type { ActiveHouseholdScope } from '../../../domain/household.js';
import { asConversationRoute } from '../../conversations/lambda.js';
import { asPlanRoute } from '../../plans/lambda.js';
import {
  createActiveHouseholdResolver,
  jsonResponse,
  scopedRouter,
  toScopeResolver,
  withActiveHousehold,
  type AuthorizedApiEvent,
} from './index.js';

function seedMember(table: InMemoryTableClient, householdId: string, userId: string, role = 'member') {
  return table.put({
    PK: `HH#${householdId}`,
    SK: `MEMBER#${userId}`,
    householdId,
    userId,
    role,
    joinedAt: '2024-01-01T00:00:00.000Z',
    version: 1,
  });
}

function event(opts: { sub?: string; household?: string; headerName?: string; rest?: boolean } = {}): AuthorizedApiEvent {
  const claims = opts.sub === undefined ? undefined : { sub: opts.sub };
  return {
    routeKey: 'POST /plans',
    body: '{"rangeDays":3}',
    pathParameters: { id: 'p1' },
    headers: opts.household === undefined ? {} : { [opts.headerName ?? 'x-active-household']: opts.household },
    requestContext: claims === undefined ? {} : opts.rest ? { authorizer: { claims } } : { authorizer: { jwt: { claims } } },
  };
}

function setup() {
  const table = new InMemoryTableClient();
  const resolve = createActiveHouseholdResolver(table);
  const inner = vi.fn(async (_e: AuthorizedApiEvent, scope: ActiveHouseholdScope) => jsonResponse(200, { scope }));
  return { table, resolve, inner, handler: withActiveHousehold(resolve, inner) };
}

describe('withActiveHousehold', () => {
  it('returns 401 with no data when authorizer claims are absent', async () => {
    const { table, handler, inner } = setup();
    await seedMember(table, 'h1', 'u1');
    const res = await handler(event({ household: 'h1' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'AUTHENTICATION_REQUIRED', message: expect.any(String) } });
    expect(inner).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['containing the key delimiter', 'h1#MEMBER'],
  ])('returns 403 when the X-Active-Household header is %s', async (_label, household) => {
    const { table, handler, inner } = setup();
    await seedMember(table, 'h1', 'u1');
    const res = await handler(event({ sub: 'u1', ...(household === undefined ? {} : { household }) }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('NOT_A_MEMBER');
    expect(inner).not.toHaveBeenCalled();
  });

  it('returns the same 403 for a non-member whether or not the household exists', async () => {
    const { table, handler, inner } = setup();
    await seedMember(table, 'h1', 'owner', 'owner');
    const existing = await handler(event({ sub: 'u2', household: 'h1' }));
    const missing = await handler(event({ sub: 'u2', household: 'nope' }));
    expect(existing.statusCode).toBe(403);
    expect(existing.body).toBe(missing.body);
    expect(existing.body).not.toContain('h1');
    expect(inner).not.toHaveBeenCalled();
  });

  it('invokes the handler with the verified scope for a member (header name case-insensitive, REST claims)', async () => {
    const { table, handler, inner } = setup();
    await seedMember(table, 'h1', 'u1', 'owner');
    const res = await handler(event({ sub: 'u1', household: 'h1', headerName: 'X-Active-Household', rest: true }));
    expect(res.statusCode).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0]?.[1]).toEqual({ userId: 'u1', householdId: 'h1', role: 'owner' });
  });

  it('re-verifies membership per request so a removed member is denied on the next request', async () => {
    const { table, handler } = setup();
    await seedMember(table, 'h1', 'u1');
    expect((await handler(event({ sub: 'u1', household: 'h1' }))).statusCode).toBe(200);
    await table.delete({ PK: 'HH#h1', SK: 'MEMBER#u1' });
    expect((await handler(event({ sub: 'u1', household: 'h1' }))).statusCode).toBe(403);
  });

  it('verifies membership with a base-table key read, never a GSI query', async () => {
    const { table, handler } = setup();
    await seedMember(table, 'h1', 'u1');
    table.calls.length = 0;
    await handler(event({ sub: 'u1', household: 'h1' }));
    expect(table.calls).toEqual([{ op: 'get', input: { PK: 'HH#h1', SK: 'MEMBER#u1' } }]);
  });

  it('fails closed with a generic 500 when the membership read fails', async () => {
    const { table, handler, inner } = setup();
    await seedMember(table, 'h1', 'u1');
    table.failNext('get');
    const res = await handler(event({ sub: 'u1', household: 'h1' }));
    expect(res.statusCode).toBe(500);
    expect(inner).not.toHaveBeenCalled();
  });
});

describe('toScopeResolver', () => {
  it('maps storage errors to a 403 denial for the ScopeResolver contract', async () => {
    const { table, resolve } = setup();
    table.failNext('get');
    expect(await toScopeResolver(resolve)(event({ sub: 'u1', household: 'h1' }))).toMatchObject({ ok: false, status: 403 });
  });
});

describe('route adapters', () => {
  const scope: ActiveHouseholdScope = { userId: 'u1', householdId: 'h1', role: 'member' };

  it('adapts proxy events to the Plan handler request shape, decoding base64 bodies', async () => {
    const plan = vi.fn(async () => jsonResponse(201, {}));
    const e = { ...event(), body: Buffer.from('{"rangeDays":3}').toString('base64'), isBase64Encoded: true };
    await asPlanRoute(plan)(e, scope);
    expect(plan).toHaveBeenCalledWith({ scope, pathParameters: { id: 'p1' }, body: '{"rangeDays":3}' });
  });

  it('adapts proxy events to the Conversation handler shape', async () => {
    const conv = vi.fn(async () => jsonResponse(200, {}));
    await asConversationRoute(conv)(event(), scope);
    expect(conv).toHaveBeenCalledWith({ body: '{"rangeDays":3}', pathParameters: { id: 'p1' } }, scope);
  });

  it('routes by routeKey and returns 404 for unknown routes', async () => {
    const hit = vi.fn(async () => jsonResponse(200, {}));
    const router = scopedRouter({ 'POST /plans': hit });
    expect((await router(event(), scope)).statusCode).toBe(200);
    expect((await router({ ...event(), routeKey: 'GET /nope' }, scope)).statusCode).toBe(404);
  });
});
