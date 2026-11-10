import type { InitiateAuthCommand, InitiateAuthCommandOutput } from '@aws-sdk/client-cognito-identity-provider';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { GlobalLookups } from '../../data/repository.js';
import { CognitoAuthenticator, secretHash, type CognitoSender } from './cognito.js';
import { INVALID_CREDENTIALS_MESSAGE } from './errors.js';
import { LOCKOUT_DURATION_MS, TableLockoutStore } from './lockout.js';
import { LoginService } from './loginService.js';

const USERNAME = 'sam@example.com';
const PASSWORD = 'correct-horse-battery';
const USER_SUB = 'user-sub-1';

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

function cognitoError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/** Fake Cognito user pool with one user. */
class FakeCognito implements CognitoSender {
  readonly commands: InitiateAuthCommand[] = [];
  outage: Error | undefined;

  async send(command: InitiateAuthCommand): Promise<InitiateAuthCommandOutput> {
    this.commands.push(command);
    if (this.outage) throw this.outage;
    const params = command.input.AuthParameters ?? {};
    if (params.USERNAME !== USERNAME) throw cognitoError('UserNotFoundException');
    if (params.PASSWORD !== PASSWORD) throw cognitoError('NotAuthorizedException');
    return {
      $metadata: {},
      AuthenticationResult: {
        AccessToken: 'access',
        IdToken: idToken({ sub: USER_SUB, email: USERNAME }),
        RefreshToken: 'refresh',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    };
  }
}

describe('LoginService', () => {
  let cognito: FakeCognito;
  let table: InMemoryTableClient;
  let clock: number;
  let logs: string[];
  let service: LoginService;

  beforeEach(() => {
    cognito = new FakeCognito();
    table = new InMemoryTableClient();
    clock = Date.parse('2025-03-01T10:00:00Z');
    logs = [];
    service = new LoginService({
      authenticator: new CognitoAuthenticator(cognito, { clientId: 'client-1' }),
      lockout: new TableLockoutStore(table),
      lookups: new GlobalLookups(table),
      now: () => new Date(clock),
      logger: { warn: (m, f) => logs.push(m + JSON.stringify(f ?? {})) },
    });
  });

  it('returns a session and establishes the user identity on valid credentials (1.1)', async () => {
    const result = await service.login({ identifier: USERNAME, password: PASSWORD });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'session',
        user: { userId: USER_SUB, email: USERNAME },
        tokens: { accessToken: 'access', idToken: expect.any(String), refreshToken: 'refresh', expiresIn: 3600, tokenType: 'Bearer' },
      },
    });
    expect(cognito.commands[0]!.input).toMatchObject({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client-1' });
    expect((await new GlobalLookups(table).getUser(USER_SUB))?.attributes).toMatchObject({ identifier: USERNAME });
  });

  it('returns one identical error for wrong password, unknown user, and out-of-range lengths (1.2)', async () => {
    const attempts = [
      { identifier: USERNAME, password: 'wrong-password' },
      { identifier: 'nobody@example.com', password: PASSWORD },
      { identifier: '', password: PASSWORD },
      { identifier: 'x'.repeat(255), password: PASSWORD },
      { identifier: USERNAME, password: 'short' },
      { identifier: USERNAME, password: 'p'.repeat(129) },
      { identifier: 42, password: undefined },
    ];
    for (const input of attempts) {
      const result = await service.login(input);
      expect(result).toEqual({ ok: false, error: { code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE } });
    }
    // Out-of-range inputs never reach Cognito.
    expect(cognito.commands).toHaveLength(2);
  });

  it('locks the identifier after 5 failures in 15 minutes and skips Cognito while locked (1.3)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await service.login({ identifier: USERNAME, password: 'wrong-password' });
      expect(r.ok || r.error.code).toBe('INVALID_CREDENTIALS');
      clock += 60_000;
    }
    const fifth = await service.login({ identifier: USERNAME, password: 'wrong-password' });
    expect(fifth.ok || fifth.error.code).toBe('ACCOUNT_TEMPORARILY_LOCKED');

    const callsBefore = cognito.commands.length;
    const whileLocked = await service.login({ identifier: USERNAME, password: PASSWORD });
    expect(whileLocked.ok || whileLocked.error).toMatchObject({
      code: 'ACCOUNT_TEMPORARILY_LOCKED',
      retryAfterSeconds: LOCKOUT_DURATION_MS / 1000,
    });
    expect(cognito.commands).toHaveLength(callsBefore);

    clock += LOCKOUT_DURATION_MS;
    expect((await service.login({ identifier: USERNAME, password: PASSWORD })).ok).toBe(true);
  });

  it('resets the failure counter on successful sign-in', async () => {
    for (let i = 0; i < 4; i++) await service.login({ identifier: USERNAME, password: 'wrong-password' });
    expect((await service.login({ identifier: USERNAME, password: PASSWORD })).ok).toBe(true);
    const next = await service.login({ identifier: USERNAME, password: 'wrong-password' });
    expect(next.ok || next.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('reports Cognito outages as unavailable without counting a failure, and never logs the password', async () => {
    cognito.outage = cognitoError('InternalErrorException');
    for (let i = 0; i < 6; i++) {
      const r = await service.login({ identifier: USERNAME, password: PASSWORD });
      expect(r.ok || r.error.code).toBe('AUTH_UNAVAILABLE');
    }
    cognito.outage = undefined;
    expect((await service.login({ identifier: USERNAME, password: PASSWORD })).ok).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(PASSWORD);
  });

  it('fails closed when the lockout store cannot be read', async () => {
    table.failNext('get');
    const r = await service.login({ identifier: USERNAME, password: PASSWORD });
    expect(r.ok || r.error.code).toBe('AUTH_UNAVAILABLE');
    expect(cognito.commands).toHaveLength(0);
  });
});

describe('CognitoAuthenticator', () => {
  it('adds SECRET_HASH when the app client has a secret', async () => {
    const cognito = new FakeCognito();
    await new CognitoAuthenticator(cognito, { clientId: 'cid', clientSecret: 's3cret' }).authenticate(USERNAME, PASSWORD);
    expect(cognito.commands[0]!.input.AuthParameters?.SECRET_HASH).toBe(secretHash(USERNAME, 'cid', 's3cret'));
  });

  it('treats a slow Cognito call as unavailable', async () => {
    const slow: CognitoSender = { send: () => new Promise(() => undefined) };
    const outcome = await new CognitoAuthenticator(slow, { clientId: 'cid', timeoutMs: 10 }).authenticate(USERNAME, PASSWORD);
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'CognitoTimeoutError' });
  });
});
