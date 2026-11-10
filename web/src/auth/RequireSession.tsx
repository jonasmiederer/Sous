import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useSession } from './SessionProvider';
import type { SessionEndReason } from './session';

export const SIGN_IN_PATH = '/sign-in';

/** Navigation state passed to the sign-in screen. */
export interface SignInLocationState {
  /** Where to go after signing in. */
  from?: string;
  reason?: SessionEndReason;
  /** Set after a confirmed sign-up. */
  confirmedEmail?: string;
}

/** Renders its children (or the nested route) only with a session; otherwise redirects to sign-in, keeping the target path. */
export function RequireSession({ children }: { children?: ReactNode }) {
  const { session, endReason } = useSession();
  const location = useLocation();
  if (!session) {
    const state: SignInLocationState = {
      from: `${location.pathname}${location.search}${location.hash}`,
      ...(endReason ? { reason: endReason } : {}),
    };
    return <Navigate to={SIGN_IN_PATH} replace state={state} />;
  }
  return children ?? <Outlet />;
}

/** For the auth screens: sends a signed-in User to the app. */
export function RedirectIfSignedIn({ children }: { children?: ReactNode }) {
  const { session } = useSession();
  const location = useLocation();
  if (session) {
    const from = (location.state as SignInLocationState | null)?.from;
    return <Navigate to={safeReturnPath(from)} replace />;
  }
  return children ?? <Outlet />;
}

/** Only in-app absolute paths are followed after sign-in; anything else goes home. */
export function safeReturnPath(from: string | undefined): string {
  if (!from || !from.startsWith('/') || from.startsWith('//') || from.startsWith('/sign-')) return '/';
  return from;
}
