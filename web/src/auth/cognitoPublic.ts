/**
 * Cognito public client APIs called with `fetch` (Requirements 13.4, 13.17, 13.18).
 *
 * The app client is public (no secret), so sign-up, confirmation, token
 * refresh, and token revocation go straight to the Cognito Identity Provider
 * JSON API. Sign-in does NOT use this module: it goes through
 * `POST /auth/login` to keep the server-side lockout (Requirement 1.3).
 * No AWS SDK is bundled.
 */

/** The operation is selected with the `x-amz-target` header: prefix + operation name. */
export const COGNITO_TARGET_PREFIX = 'AWSCognitoIdentityProviderService.';
export const COGNITO_CONTENT_TYPE = 'application/x-amz-json-1.1';
/** Per-request timeout before the call fails with `REQUEST_TIMEOUT`. */
export const COGNITO_TIMEOUT_MS = 10_000;

/** The subset of Cognito operations this client uses. */
export type CognitoOperation = 'SignUp' | 'ConfirmSignUp' | 'ResendConfirmationCode' | 'InitiateAuth' | 'RevokeToken';

/** Regional Cognito Identity Provider endpoint. */
export function cognitoEndpoint(region: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

/**
 * User-facing text per exception name. `NETWORK_ERROR` and `REQUEST_TIMEOUT`
 * are client-side codes, not Cognito exceptions.
 */
const COGNITO_MESSAGES: Record<string, string> = {
  UsernameExistsException: 'An account with this email already exists. Sign in, or confirm it with the code we emailed you.',
  InvalidPasswordException: 'Choose a password of 8 to 128 characters.',
  CodeMismatchException: "That code isn't right. Check the email and try again.",
  ExpiredCodeException: 'That code has expired. Send a new code and try again.',
  LimitExceededException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyRequestsException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyFailedAttemptsException: 'Too many attempts. Wait a few minutes and try again.',
  CodeDeliveryFailureException: "We couldn't send the code. Check the email address and try again.",
  UserNotFoundException: "We couldn't find an account with that email.",
  NotAuthorizedException: "That account can't be confirmed right now. It may already be confirmed; try signing in.",
  InvalidParameterException: 'Check the email address and try again.',
  NETWORK_ERROR: "Couldn't reach Sous. Check your connection and try again.",
  REQUEST_TIMEOUT: "Couldn't reach Sous. Check your connection and try again.",
};

export const COGNITO_GENERIC_MESSAGE = 'Something went wrong. Please try again in a moment.';

/** A failed Cognito call. `code` is the Cognito exception name, or a client code for network failures. */
export class CognitoError extends Error {
  override readonly name = 'CognitoError';
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }

  /** Safe to show to the user; falls back to a generic message for unknown codes. */
  get userMessage(): string {
    return COGNITO_MESSAGES[this.code] ?? COGNITO_GENERIC_MESSAGE;
  }
}

export interface RefreshedTokens {
  idToken: string;
  accessToken: string;
  /** Present only when Cognito rotates the refresh token. */
  refreshToken?: string;
  expiresIn?: number;
}

export interface SignUpResult {
  userConfirmed: boolean;
  /** Where the confirmation code was sent, e.g. `j***@e***.com`. */
  destination?: string;
}

/** Methods reject with `CognitoError`. */
export interface CognitoPublicClient {
  signUp(email: string, password: string): Promise<SignUpResult>;
  confirmSignUp(email: string, code: string): Promise<void>;
  resendConfirmationCode(email: string): Promise<{ destination?: string }>;
  refreshTokens(refreshToken: string): Promise<RefreshedTokens>;
  revokeToken(refreshToken: string): Promise<void>;
}

export interface CognitoPublicClientOptions {
  region: string;
  /** Public app client id (no secret). */
  clientId: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `COGNITO_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Extracts the exception name from an error response, preferring the body's
 * `__type` over the `x-amzn-errortype` header. Either may be `Name`,
 * `prefix#Name`, or `Name:details`; only `Name` is returned.
 */
function exceptionName(value: unknown, header: string | null): string | undefined {
  const raw = (typeof value === 'object' && value !== null ? (value as { __type?: unknown }).__type : undefined) ?? header;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const afterHash = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1) : raw;
  return afterHash.split(':')[0]?.trim() || undefined;
}

/** Creates a client that talks to Cognito over plain `fetch`, with a timeout on every call. */
export function createCognitoPublicClient(options: CognitoPublicClientOptions): CognitoPublicClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = cognitoEndpoint(options.region);
  const timeoutMs = options.timeoutMs ?? COGNITO_TIMEOUT_MS;
  const clientId = options.clientId;

  /**
   * POSTs one Cognito operation and returns its parsed JSON body. Throws
   * `CognitoError` for network failures/timeouts (status 0), non-2xx
   * responses, and bodies that are not a JSON object.
   */
  async function call<T>(operation: CognitoOperation, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': COGNITO_CONTENT_TYPE, 'x-amz-target': `${COGNITO_TARGET_PREFIX}${operation}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      throw new CognitoError(timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', 0);
    } finally {
      clearTimeout(timer);
    }
    let value: unknown;
    try {
      value = text === '' ? {} : JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const code = exceptionName(value, response.headers.get('x-amzn-errortype')) ?? 'UNKNOWN';
      const message = typeof value === 'object' && value !== null ? (value as { message?: unknown }).message : undefined;
      throw new CognitoError(code, response.status, typeof message === 'string' ? message : undefined);
    }
    if (typeof value !== 'object' || value === null) throw new CognitoError('INVALID_RESPONSE', response.status);
    return value as T;
  }

  return {
    async signUp(email, password) {
      const result = await call<{ UserConfirmed?: boolean; CodeDeliveryDetails?: { Destination?: string } }>('SignUp', {
        ClientId: clientId,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'email', Value: email }],
      });
      const destination = result.CodeDeliveryDetails?.Destination;
      return { userConfirmed: result.UserConfirmed === true, ...(destination ? { destination } : {}) };
    },

    async confirmSignUp(email, code) {
      await call('ConfirmSignUp', { ClientId: clientId, Username: email, ConfirmationCode: code });
    },

    async resendConfirmationCode(email) {
      const result = await call<{ CodeDeliveryDetails?: { Destination?: string } }>('ResendConfirmationCode', {
        ClientId: clientId,
        Username: email,
      });
      const destination = result.CodeDeliveryDetails?.Destination;
      return destination ? { destination } : {};
    },

    async refreshTokens(refreshToken) {
      const result = await call<{
        AuthenticationResult?: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number };
      }>('InitiateAuth', {
        ClientId: clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      const auth = result.AuthenticationResult;
      if (!auth?.IdToken || !auth.AccessToken) throw new CognitoError('INVALID_RESPONSE', 200);
      return {
        idToken: auth.IdToken,
        accessToken: auth.AccessToken,
        ...(auth.RefreshToken ? { refreshToken: auth.RefreshToken } : {}),
        ...(typeof auth.ExpiresIn === 'number' ? { expiresIn: auth.ExpiresIn } : {}),
      };
    },

    async revokeToken(refreshToken) {
      await call('RevokeToken', { ClientId: clientId, Token: refreshToken });
    },
  };
}
