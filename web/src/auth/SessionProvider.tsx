import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useServices } from '../app/ServicesProvider';
import type { LoginResponse } from '../api/types';
import { sessionFromLogin, type SessionEndReason, type StoredSession } from './session';

export interface SessionContextValue {
  session: StoredSession | null;
  /** Why the last session ended; shown on the sign-in screen. */
  endReason: SessionEndReason | undefined;
  /** Stores the session of a successful `POST /auth/login`. Returns false for a challenge. */
  completeSignIn(response: LoginResponse): boolean;
  signOut(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const services = useServices();
  const { sessionStore } = services;
  const session = useSyncExternalStore(sessionStore.subscribe, sessionStore.get, sessionStore.get);

  const completeSignIn = useCallback(
    (response: LoginResponse) => {
      const next = sessionFromLogin(response, services.now());
      if (!next) return false;
      services.completeSignIn(next);
      return true;
    },
    [services],
  );
  const signOut = useCallback(() => services.signOut(), [services]);

  const value = useMemo<SessionContextValue>(
    () => ({ session, endReason: session ? undefined : sessionStore.lastEndReason(), completeSignIn, signOut }),
    [session, sessionStore, completeSignIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}
