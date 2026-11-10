import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router';
import { CANONICAL_UNITS } from '@sous/domain/units';
import { createAppServices, type AppServices } from './app/services';
import { ServicesProvider } from './app/ServicesProvider';
import { SessionProvider } from './auth/SessionProvider';
import { loadRuntimeConfig } from './config/runtimeConfig';
import { ActiveHouseholdProvider } from './household/ActiveHouseholdProvider';
import { AppRoutes } from './routes';
import { ErrorBanner, MAIN_CONTENT_ID, Spinner, ToastProvider, UpdateAvailableToast } from './ui';

export { NAV_ITEMS } from './navigation';
export { CONTEXT_INPUT_MAX } from './features/suggest';

/** Number of canonical units shared with the backend; proves the domain alias works. */
export const SHARED_UNIT_COUNT = CANONICAL_UNITS.length;

/** Providers and routes. Needs a router above it (BrowserRouter in the app, MemoryRouter in tests). */
export function AppRoot({ services }: { services: AppServices }) {
  return (
    <ServicesProvider services={services}>
      <SessionProvider>
        <ActiveHouseholdProvider>
          <ToastProvider>
            <AppRoutes />
            <UpdateAvailableToast />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>
  );
}

/** Config-loading lifecycle for the initial boot. */
type BootState = { kind: 'loading' } | { kind: 'ready'; services: AppServices } | { kind: 'error' };

/** Loads `/config.json`, builds the app services once, and mounts the app. */
/**
 * Boot sequence. Shows a spinner while config loads, an error with retry if it
 * fails, and the app once services are built. `attempt` bumps to re-run the
 * effect on retry.
 */
export default function App() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadRuntimeConfig()
      .then((config) => {
        if (!cancelled) setState({ kind: 'ready', services: createAppServices({ config }) });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state.kind === 'ready') {
    return (
      <BrowserRouter>
        <AppRoot services={state.services} />
      </BrowserRouter>
    );
  }
  return (
    <main id={MAIN_CONTENT_ID} className="flex min-h-dvh items-center justify-center p-6">
      <h1 className="sr-only">Sous</h1>
      {state.kind === 'loading' ? (
        <Spinner label="Loading Sous" />
      ) : (
        <ErrorBanner
          className="max-w-sm"
          title="Sous couldn't start"
          message="Couldn't reach Sous. Check your connection and try again."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
    </main>
  );
}
