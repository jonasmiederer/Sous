import { describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import type { CognitoAuthOutcome } from './cognito.js';
import { createAuthHandler, type ApiEvent } from './handlers.js';
import { TableLockoutStore } from './lockout.js';
import { LoginService } from './loginService.js';
import { MembershipService } from './membershipService.js';

function setup() {
  const table = new InMemoryTableClient();
  let seq = 0;
  const now = () => new Date('2025-03-01T10:00:00Z');
  const rejectAll = { authenticate: async (): Promise<CognitoAuthOutcome> => ({ kind: 'rejected' }) };
  return createAuthHandler({
    login: new LoginService({ authenticator: rejectAll, lockout: new TableLockoutStore(table), now }),
    membership: new MembershipService({ client: table, now, newId: () => `id-${++seq}` }),
  });
}

const authed = (sub: string): ApiEvent['requestContext'] => ({ authorizer: { jwt: { claims: { sub } } } });

describe('auth handler', () => {
  it('maps login failures to 401 and the 5th failure to 423 with retry-after', async () => {
    const handle = setup();
    const event: ApiEvent = {
      routeKey: 'POST /auth/login',
      body: JSON.stringify({ identifier: 'sam@example.com', password: 'wrong-password' }),
    };
    for (let i = 0; i < 4; i++) expect((await handle(event)).statusCode).toBe(401);
    const locked = await handle(event);
    expect(locked.statusCode).toBe(423);
    expect(locked.headers['retry-after']).toBe('900');
    expect(JSON.parse(locked.body).error.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');
  });

  it('requires authenticated claims for membership routes', async () => {
    const res = await setup()({ routeKey: 'POST /households', body: '{"name":"Home"}' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('creates a Household and sets it active via REST-style routing', async () => {
    const handle = setup();
    const created = await handle({ routeKey: 'POST /households', body: '{"name":"Home"}', requestContext: authed('u1') });
    expect(created.statusCode).toBe(201);
    const { household } = JSON.parse(created.body);
    const active = await handle({
      httpMethod: 'PUT',
      resource: '/session/active-household',
      body: JSON.stringify({ householdId: household.householdId }),
      requestContext: { authorizer: { claims: { sub: 'u1' } } },
    });
    expect(active.statusCode).toBe(200);
    const denied = await handle({
      routeKey: 'DELETE /households/{id}/members/{userId}',
      pathParameters: { id: household.householdId, userId: 'u1' },
      requestContext: authed('u2'),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('serves GET /households and GET /households/{id}/members, denying non-members with 403', async () => {
    const handle = setup();
    const created = await handle({ routeKey: 'POST /households', body: '{"name":"Home"}', requestContext: authed('u1') });
    const { household } = JSON.parse(created.body);

    const list = await handle({ routeKey: 'GET /households', requestContext: authed('u1') });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toEqual({
      households: [{ householdId: household.householdId, name: 'Home', role: 'owner', ownerUserId: 'u1' }],
    });

    const members = await handle({
      routeKey: 'GET /households/{id}/members',
      pathParameters: { id: household.householdId },
      requestContext: authed('u1'),
    });
    expect(members.statusCode).toBe(200);
    expect(JSON.parse(members.body).members).toEqual([
      { userId: 'u1', role: 'owner', joinedAt: '2025-03-01T10:00:00.000Z' },
    ]);

    const denied = await handle({
      routeKey: 'GET /households/{id}/members',
      pathParameters: { id: household.householdId },
      requestContext: authed('u2'),
    });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: { code: 'NOT_A_MEMBER', message: expect.any(String) } });
    expect((await handle({ routeKey: 'GET /households' })).statusCode).toBe(401);
  });

  it('rejects malformed JSON and unknown routes', async () => {
    const handle = setup();
    expect((await handle({ routeKey: 'POST /households', body: '{', requestContext: authed('u1') })).statusCode).toBe(400);
    expect((await handle({ routeKey: 'GET /nope', requestContext: authed('u1') })).statusCode).toBe(404);
  });
});
