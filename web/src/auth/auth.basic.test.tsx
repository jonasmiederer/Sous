import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CognitoError, createCognitoPublicClient } from './cognitoPublic';
import {
  GROCERY_CHECKS_KEY_PREFIX,
  SESSION_STORAGE_KEY,
  activeHouseholdKey,
  sessionFromLogin,
  tokenExpiresAt,
} from './session';
import { lockoutMessage } from '../features/auth/SignIn';
import {
  COGNITO_URL,
  HOUSEHOLDS_URL,
  MemoryStorage,
  NOW,
  ONE_HOUSEHOLD,
  TEST_CONFIG,
  USER,
  fakeFetch,
  makeJwt,
  renderApp,
  testSession,
} from '../test/harness';

const LOGIN_URL = `${TEST_CONFIG.apiUrl}/auth/login`;
const ACTIVE_URL = `${TEST_CONFIG.apiUrl}/session/active-household`;

describe('session helpers', () => {
  it('takes expiry from the ID token exp claim, then expiresIn, then a default', () => {
    expect(tokenExpiresAt(makeJwt({ exp: 2_000_000_000 }), 60, NOW)).toBe(2_000_000_000_000);
    expect(tokenExpiresAt('not-a-jwt', 60, NOW)).toBe(NOW + 60_000);
    expect(tokenExpiresAt('not-a-jwt', undefined, NOW)).toBe(NOW + 3_600_000);
  });

  it('builds a session only for kind "session"', () => {
    expect(sessionFromLogin({ kind: 'challenge', challengeName: 'NEW_PASSWORD_REQUIRED' }, NOW)).toBeUndefined();
    const session = sessionFromLogin(
      { kind: 'session', user: USER, tokens: { idToken: makeJwt({ exp: 1 }), accessToken: 'a', refreshToken: 'r' } },
      NOW,
    );
    expect(session).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresAt: 1000, user: USER });
  });

  it('formats the lockout wait from retry-after', () => {
    expect(lockoutMessage(600)).toMatch(/10 minutes/);
    expect(lockoutMessage(30)).toMatch(/30 seconds/);
    expect(lockoutMessage(undefined)).toMatch(/15 minutes/);
  });
});

describe('cognitoPublic', () => {
  it('sends SignUp to the regional endpoint with the public client id and the amz-json headers', async () => {
    const net = fakeFetch({ 'POST cognito:SignUp': { body: { UserConfirmed: false, CodeDeliveryDetails: { Destination: 'a***@e***' } } } });
    const client = createCognitoPublicClient({ region: 'eu-west-1', clientId: 'client-123', fetch: net.fetch });
    await expect(client.signUp('ana@example.com', 'password1')).resolves.toEqual({ userConfirmed: false, destination: 'a***@e***' });
    const [call] = net.calls;
    expect(call?.url).toBe(COGNITO_URL);
    expect(call?.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(call?.headers['x-amz-target']).toBe('AWSCognitoIdentityProviderService.SignUp');
    expect(call?.body).toEqual({
      ClientId: 'client-123',
      Username: 'ana@example.com',
      Password: 'password1',
      UserAttributes: [{ Name: 'email', Value: 'ana@example.com' }],
    });
  });

  it('maps Cognito exception names, including prefixed __type values', async () => {
    const net = fakeFetch({
      'POST cognito:ConfirmSignUp': { status: 400, body: { __type: 'com.amazonaws#CodeMismatchException', message: 'bad' } },
    });
    const client = createCognitoPublicClient({ region: 'eu-west-1', clientId: 'c', fetch: net.fetch });
    const error = await client.confirmSignUp('a@b.co', '1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CognitoError);
    expect((error as CognitoError).code).toBe('CodeMismatchException');
  });
});

describe('sign-in', () => {
  it('signs in through POST /auth/login, then requires a household selection confirmed by the System', async () => {
    const user = userEvent.setup();
    const idToken = makeJwt({ sub: USER.userId, exp: NOW / 1000 + 3600 });
    const { calls, storage } = renderApp({
      path: '/plans',
      routes: {
        [`POST ${LOGIN_URL}`]: { body: { kind: 'session', user: USER, tokens: { idToken, accessToken: 'acc', refreshToken: 'ref' } } },
        [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD },
        [`PUT ${ACTIVE_URL}`]: { body: { userId: USER.userId, householdId: 'hh-1', role: 'owner' } },
      },
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret-pass');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await user.click(await screen.findByRole('button', { name: /Home/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();

    const login = calls.find((c) => c.url === LOGIN_URL)!;
    expect(login.body).toEqual({ identifier: 'ana@example.com', password: 'secret-pass' });
    expect(login.headers.authorization).toBeUndefined();
    const select = calls.find((c) => c.url === ACTIVE_URL)!;
    expect(select.body).toEqual({ householdId: 'hh-1' });
    expect(select.headers.authorization).toBe(idToken);
    expect(storage.getItem(activeHouseholdKey(USER.userId))).toBe('hh-1');
    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY)!)).toMatchObject({ idToken, refreshToken: 'ref' });
  });

  it('shows the lockout wait from retry-after', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/sign-in',
      routes: {
        [`POST ${LOGIN_URL}`]: { status: 429, headers: { 'retry-after': '600' }, body: { error: { code: 'ACCOUNT_TEMPORARILY_LOCKED' } } },
      },
    });
    await user.type(screen.getByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 10 minutes.');
  });

  it('explains an unsupported challenge and stores no session', async () => {
    const user = userEvent.setup();
    const { storage } = renderApp({
      path: '/sign-in',
      routes: { [`POST ${LOGIN_URL}`]: { body: { kind: 'challenge', challengeName: 'NEW_PASSWORD_REQUIRED' } } },
    });
    await user.type(screen.getByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'temp-pass');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/extra sign-in step/);
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe('sign-up', () => {
  it('rejects a short password locally, then registers, confirms, and returns to sign-in', async () => {
    const user = userEvent.setup();
    const { calls } = renderApp({
      path: '/sign-up',
      routes: {
        'POST cognito:SignUp': { body: { UserConfirmed: false } },
        'POST cognito:ConfirmSignUp': { body: {} },
      },
    });
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    await user.type(screen.getByLabelText('Password'), '-enough');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Confirm your email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com');

    await user.type(screen.getByLabelText('Confirmation code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm account' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText(/Your email is confirmed/)).toBeInTheDocument();
    expect(calls.map((c) => c.headers['x-amz-target'])).toEqual([
      'AWSCognitoIdentityProviderService.SignUp',
      'AWSCognitoIdentityProviderService.ConfirmSignUp',
    ]);
    expect(calls[1]?.body).toEqual({ ClientId: 'client-123', Username: 'new@example.com', ConfirmationCode: '123456' });
  });
});

describe('guards and sign-out', () => {
  it('redirects to sign-in without a session', async () => {
    renderApp({ path: '/fridge' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('sends a User whose stored household is no longer listed to the picker', async () => {
    const { storage } = renderApp({
      path: '/',
      session: testSession(),
      activeHouseholdId: 'hh-gone',
      routes: { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD } },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your households' })).toBeInTheDocument();
    await waitFor(() => expect(storage.getItem(activeHouseholdKey(USER.userId))).toBeNull());
  });

  it('sign-out removes the session, Active_Household, and grocery checks, and revokes the refresh token', async () => {
    const user = userEvent.setup();
    const storage = new MemoryStorage();
    storage.setItem(`${GROCERY_CHECKS_KEY_PREFIX}hh-1.plan-1`, '{"generatedAt":"x","checked":[]}');
    storage.setItem('sous.theme.v1', 'dark');
    const { calls, services } = renderApp({
      storage,
      session: testSession(),
      activeHouseholdId: 'hh-1',
      routes: { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, 'POST cognito:RevokeToken': { body: {} } },
    });
    await screen.findByText('Home');
    expect(services.queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
    expect(storage.keys()).toEqual(['sous.theme.v1']);
    // Only the disabled, empty placeholder query of the signed-out tree may remain.
    expect(services.queryClient.getQueryCache().getAll().filter((q) => q.state.data !== undefined)).toHaveLength(0);
    await waitFor(() => expect(calls.some((c) => c.headers['x-amz-target']?.endsWith('RevokeToken'))).toBe(true));
    expect(calls.find((c) => c.headers['x-amz-target']?.endsWith('RevokeToken'))?.body).toEqual({ ClientId: 'client-123', Token: 'refresh-1' });
  });

  it('renews once on 401 and signs out when renewal fails', async () => {
    const { storage, calls } = renderApp({
      session: testSession(),
      activeHouseholdId: 'hh-1',
      routes: {
        [`GET ${HOUSEHOLDS_URL}`]: { status: 401, body: { error: { code: 'AUTHENTICATION_REQUIRED' } } },
        'POST cognito:InitiateAuth': { status: 400, body: { __type: 'NotAuthorizedException' } },
      },
    });
    expect(await screen.findByText('Your session has ended. Please sign in again.')).toBeInTheDocument();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(activeHouseholdKey(USER.userId))).toBeNull();
    const refresh = calls.filter((c) => c.headers['x-amz-target']?.endsWith('InitiateAuth'));
    expect(refresh).toHaveLength(1);
    expect(refresh[0]?.body).toEqual({ ClientId: 'client-123', AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: 'refresh-1' } });
  });
});
