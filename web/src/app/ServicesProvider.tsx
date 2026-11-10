import { createContext, useContext, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SousApi } from '../api/endpoints';
import type { AppServices } from './services';

const ServicesContext = createContext<AppServices | null>(null);

/** Makes the app-wide services (and their QueryClient) available to the tree. */
export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return (
    <ServicesContext.Provider value={services}>
      <QueryClientProvider client={services.queryClient}>{children}</QueryClientProvider>
    </ServicesContext.Provider>
  );
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>.');
  return services;
}

/** The single app-wide typed API (Authorization and X-Active-Household are added for you). */
export function useApi(): SousApi {
  return useServices().api;
}
