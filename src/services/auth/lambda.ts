/**
 * Lambda entry point for the Auth & Membership Service.
 *
 * Environment:
 *   TABLE_NAME             DynamoDB single table
 *   COGNITO_CLIENT_ID      User Pool app client id (USER_PASSWORD_AUTH enabled)
 *   COGNITO_CLIENT_SECRET  optional; only when the app client has a secret
 *
 * Dependencies are built once per container, on first invocation.
 */
import { randomUUID } from 'node:crypto';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GlobalLookups } from '../../data/repository.js';
import { DocumentTableClient } from '../../data/tableClient.js';
import { CognitoAuthenticator } from './cognito.js';
import { createAuthHandler, type ApiEvent, type ApiResponse } from './handlers.js';
import { TableLockoutStore } from './lockout.js';
import { LoginService } from './loginService.js';
import { MembershipService } from './membershipService.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function build(): (event: ApiEvent) => Promise<ApiResponse> {
  const table = new DocumentTableClient(DynamoDBDocumentClient.from(new DynamoDBClient({})), requireEnv('TABLE_NAME'));
  const clientSecret = process.env.COGNITO_CLIENT_SECRET;
  const authenticator = new CognitoAuthenticator(new CognitoIdentityProviderClient({}), {
    clientId: requireEnv('COGNITO_CLIENT_ID'),
    ...(clientSecret ? { clientSecret } : {}),
  });
  const now = () => new Date();
  const logger = { warn: (message: string, fields?: Record<string, unknown>) => console.warn(message, fields ?? {}) };
  return createAuthHandler({
    login: new LoginService({
      authenticator,
      lockout: new TableLockoutStore(table),
      lookups: new GlobalLookups(table),
      now,
      logger,
    }),
    membership: new MembershipService({ client: table, now, newId: randomUUID }),
  });
}

let cached: ((event: ApiEvent) => Promise<ApiResponse>) | undefined;

export async function handler(event: ApiEvent): Promise<ApiResponse> {
  cached ??= build();
  return cached(event);
}
