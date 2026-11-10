/**
 * App-wide singletons: runtime config, session and Active_Household stores,
 * the Cognito public client, one API client with its typed endpoints, and the
 * TanStack Query client. Built once per app launch (or per test).
 */
import { MutationCache, QueryCache, QueryClient, type DefaultOptions } from '@tanstack/react-query';
import { createApiClient } from '../api/client';
import { createEndpoints, type SousApi } from '../api/endpoints';
import { isApiError } from '../api/errors';
import type { RuntimeConfig } from '../config/runtimeConfig';
import { createCognitoPublicClient, type CognitoPublicClient } from '../auth/cognitoPublic';
import {
  clearUserDeviceData,
  createSessionStore,
  tokenExpiresAt,
  type SessionEndReason,
  type SessionStore,
  type StoredSession,
} from '../auth/session';
import { createActiveHouseholdStore, type ActiveHouseholdStore } from '../household/activeHouseholdStore';

export interface AppServices {
  config: RuntimeConfig;
  storage: Storage;
  sessionStore: SessionStore;
  householdStore: ActiveHouseholdStore;
  cognito: CognitoPublicClient;
  api: SousApi;
  queryClient: QueryClient;
  now: () => number;
  /** Stores a new session (after sign-in) and drops any cached data of a previous session. */
  completeSignIn(session: StoredSession): void;
  /**
   * Discards the session, the Active_Household selection, grocery check
   * state, and the query cache on this device (Requirements 13.17, 13.18).
   */
  signOutLocal(reason: SessionEndReason): void;
  /** Local sign-out plus a best-effort `RevokeToken` for the refresh token. */
  signOut(): void;
}

export interface AppServicesOptions {
  config: RuntimeConfig;
  storage?: Storage;
  fetch?: typeof fetch;
  now?: () => number;
  /** Overrides for TanStack Query defaults (tests turn retries off). */
  queryDefaults?: DefaultOptions;
}

/** Client errors (4xx) other than timeouts are not worth retrying. */
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createAppServices(options: AppServicesOptions): AppServices {
  const storage = options.storage ?? window.localStorage;
  const now = options.now ?? (() => Date.now());
  const sessionStore = createSessionStore(storage);
  const householdStore = createActiveHouseholdStore(storage, () => sessionStore.get()?.user.userId);
  const cognito = createCognitoPublicClient({
    region: options.config.region,
    clientId: options.config.userPoolClientId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  // A 403 NOT_A_MEMBER means the stored Active_Household is stale; dropping it
  // makes RequireHousehold route to the picker.
  const onError = (error: unknown) => {
    if (isApiError(error) && error.code === 'NOT_A_MEMBER') householdStore.clear();
  };
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      ...options.queryDefaults,
      queries: { retry: shouldRetryQuery, refetchOnWindowFocus: false, ...options.queryDefaults?.queries },
      mutations: { retry: false, ...options.queryDefaults?.mutations },
    },
  });

  function signOutLocal(reason: SessionEndReason) {
    const userId = sessionStore.get()?.user.userId;
    clearUserDeviceData(storage, userId);
    queryClient.clear();
    sessionStore.clear(reason);
    householdStore.refresh();
  }

  async function refreshSession(): Promise<StoredSession | null> {
    const current = sessionStore.get();
    if (!current?.refreshToken) return null;
    const tokens = await cognito.refreshTokens(current.refreshToken);
    // The User may have signed out while the refresh was in flight.
    const latest = sessionStore.get();
    if (!latest || latest.user.userId !== current.user.userId) return null;
    const next: StoredSession = {
      ...latest,
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      expiresAt: tokenExpiresAt(tokens.idToken, tokens.expiresIn, now()),
    };
    sessionStore.set(next);
    return next;
  }

  const client = createApiClient({
    config: { apiUrl: options.config.apiUrl },
    getSession: () => sessionStore.get(),
    refreshSession,
    getActiveHouseholdId: () => householdStore.get(),
    onAuthFailure: () => {
      if (sessionStore.get() !== null) signOutLocal('expired');
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
  });

  return {
    config: options.config,
    storage,
    sessionStore,
    householdStore,
    cognito,
    api: createEndpoints(client),
    queryClient,
    now,
    completeSignIn(session) {
      queryClient.clear();
      sessionStore.set(session);
      householdStore.refresh();
    },
    signOutLocal,
    signOut() {
      const refreshToken = sessionStore.get()?.refreshToken;
      signOutLocal('signed_out');
      if (refreshToken) void cognito.revokeToken(refreshToken).catch(() => undefined);
    },
  };
}
