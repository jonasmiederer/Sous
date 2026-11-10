/**
 * Cognito authentication via InitiateAuth (USER_PASSWORD_AUTH).
 *
 * The authenticator classifies every Cognito response into one of four
 * outcomes. All credential-related failures become `rejected`, so the caller
 * can return one generic error without revealing which field was wrong
 * (Requirement 1.2). Passwords are only placed in the InitiateAuth request and
 * are never logged.
 */
import { createHmac } from 'node:crypto';
import {
  InitiateAuthCommand,
  type InitiateAuthCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider';

/** The subset of CognitoIdentityProviderClient used here; fakeable in tests. */
export interface CognitoSender {
  send(command: InitiateAuthCommand): Promise<InitiateAuthCommandOutput>;
}

export interface CognitoAuthConfig {
  /** App client id of the User Pool. */
  clientId: string;
  /** App client secret, when the app client has one (adds SECRET_HASH). */
  clientSecret?: string;
  /** Upper bound on the Cognito call, so login answers within 3 s (1.1). */
  timeoutMs?: number;
}

export interface CognitoTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
}

export type CognitoAuthOutcome =
  | { kind: 'authenticated'; tokens: CognitoTokens }
  | { kind: 'challenge'; challengeName: string; session?: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable'; reason: string };

/**
 * Cognito exceptions that mean "these credentials do not sign this user in".
 * NotAuthorizedException covers wrong passwords and Cognito-side throttling of
 * wrong passwords; UserNotFoundException is masked the same way.
 */
const REJECTED_ERRORS = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
]);

export const DEFAULT_COGNITO_TIMEOUT_MS = 2500;

export function secretHash(username: string, clientId: string, clientSecret: string): string {
  return createHmac('sha256', clientSecret).update(username + clientId, 'utf8').digest('base64');
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : 'UnknownError';
}

class CognitoTimeoutError extends Error {
  override readonly name = 'CognitoTimeoutError';
}

export class CognitoAuthenticator {
  private readonly timeoutMs: number;

  constructor(
    private readonly sender: CognitoSender,
    private readonly config: CognitoAuthConfig,
  ) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_COGNITO_TIMEOUT_MS;
  }

  async authenticate(username: string, password: string): Promise<CognitoAuthOutcome> {
    const authParameters: Record<string, string> = { USERNAME: username, PASSWORD: password };
    if (this.config.clientSecret !== undefined) {
      authParameters.SECRET_HASH = secretHash(username, this.config.clientId, this.config.clientSecret);
    }
    const command = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: this.config.clientId,
      AuthParameters: authParameters,
    });

    let output: InitiateAuthCommandOutput;
    let timer: NodeJS.Timeout | undefined;
    try {
      output = await Promise.race([
        this.sender.send(command),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CognitoTimeoutError()), this.timeoutMs);
        }),
      ]);
    } catch (err) {
      const name = errorName(err);
      if (REJECTED_ERRORS.has(name)) return { kind: 'rejected' };
      return { kind: 'unavailable', reason: name };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const result = output.AuthenticationResult;
    if (result?.AccessToken !== undefined && result.IdToken !== undefined) {
      return {
        kind: 'authenticated',
        tokens: {
          accessToken: result.AccessToken,
          idToken: result.IdToken,
          ...(result.RefreshToken !== undefined ? { refreshToken: result.RefreshToken } : {}),
          ...(result.ExpiresIn !== undefined ? { expiresIn: result.ExpiresIn } : {}),
          ...(result.TokenType !== undefined ? { tokenType: result.TokenType } : {}),
        },
      };
    }
    if (output.ChallengeName !== undefined) {
      return {
        kind: 'challenge',
        challengeName: output.ChallengeName,
        ...(output.Session !== undefined ? { session: output.Session } : {}),
      };
    }
    return { kind: 'unavailable', reason: 'EmptyAuthenticationResult' };
  }
}

export interface IdTokenClaims {
  sub: string;
  email?: string;
}

/**
 * Reads `sub` and `email` from a Cognito ID token returned directly by
 * InitiateAuth over TLS. This does not verify the signature, so it must only
 * be used on tokens just received from Cognito, never on client-supplied ones
 * (the API authorizer verifies those).
 */
export function readIdTokenClaims(idToken: string): IdTokenClaims | undefined {
  const payload = idToken.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) return undefined;
    return typeof claims.email === 'string' ? { sub: claims.sub, email: claims.email } : { sub: claims.sub };
  } catch {
    return undefined;
  }
}
