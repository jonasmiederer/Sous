import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useServices } from '../app/ServicesProvider';
import { useSession } from '../auth/SessionProvider';
import type { HouseholdSummary } from '../api/types';

/** Query key of the signed-in User's Households (user-scoped, not Household-scoped). */
export function householdsQueryKey(userId: string | undefined) {
  return ['user', userId ?? 'anonymous', 'households'] as const;
}

export interface ActiveHouseholdContextValue {
  activeHouseholdId: string | null;
  /** The selected Household from `GET /households`, once loaded. */
  activeHousehold: HouseholdSummary | undefined;
  households: UseQueryResult<HouseholdSummary[]>;
  /**
   * Confirms membership with `PUT /session/active-household`, then stores the
   * choice under `sous.activeHousehold.v1.{userId}`. Rejects (and stores
   * nothing) when the System refuses.
   */
  selectHousehold(householdId: string): Promise<void>;
  clearActiveHousehold(): void;
}

const ActiveHouseholdContext = createContext<ActiveHouseholdContextValue | null>(null);

export function ActiveHouseholdProvider({ children }: { children: ReactNode }) {
  const { api, householdStore } = useServices();
  const { session } = useSession();
  const userId = session?.user.userId;
  const activeHouseholdId = useSyncExternalStore(householdStore.subscribe, householdStore.get, householdStore.get);

  const households = useQuery({
    queryKey: householdsQueryKey(userId),
    queryFn: async ({ signal }) => (await api.listHouseholds({ signal })).households,
    enabled: Boolean(userId),
  });

  const selectHousehold = useCallback(
    async (householdId: string) => {
      const scope = await api.setActiveHousehold(householdId);
      householdStore.set(scope.householdId);
    },
    [api, householdStore],
  );
  const clearActiveHousehold = useCallback(() => householdStore.clear(), [householdStore]);

  const value = useMemo<ActiveHouseholdContextValue>(
    () => ({
      activeHouseholdId: userId ? activeHouseholdId : null,
      activeHousehold: households.data?.find((h) => h.householdId === activeHouseholdId),
      households,
      selectHousehold,
      clearActiveHousehold,
    }),
    [userId, activeHouseholdId, households, selectHousehold, clearActiveHousehold],
  );
  return <ActiveHouseholdContext.Provider value={value}>{children}</ActiveHouseholdContext.Provider>;
}

export function useActiveHousehold(): ActiveHouseholdContextValue {
  const value = useContext(ActiveHouseholdContext);
  if (!value) throw new Error('useActiveHousehold must be used inside <ActiveHouseholdProvider>.');
  return value;
}
