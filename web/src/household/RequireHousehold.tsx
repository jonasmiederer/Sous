import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useActiveHousehold } from './ActiveHouseholdProvider';

export const HOUSEHOLDS_PATH = '/households';

export interface HouseholdsLocationState {
  /** Where to go after a Household is selected. */
  from?: string;
}

/**
 * Renders its children only while an Active_Household is selected. Redirects
 * to the picker when none is selected, or when the stored one is no longer in
 * `GET /households`. While the list is loading or unavailable (offline), the
 * stored selection is trusted; the API still enforces membership.
 */
export function RequireHousehold({ children }: { children?: ReactNode }) {
  const { activeHouseholdId, households, clearActiveHousehold } = useActiveHousehold();
  const location = useLocation();
  const stale = Boolean(activeHouseholdId && households.data && !households.data.some((h) => h.householdId === activeHouseholdId));

  useEffect(() => {
    if (stale) clearActiveHousehold();
  }, [stale, clearActiveHousehold]);

  if (!activeHouseholdId || stale) {
    const state: HouseholdsLocationState = { from: `${location.pathname}${location.search}${location.hash}` };
    return <Navigate to={HOUSEHOLDS_PATH} replace state={state} />;
  }
  return children ?? <Outlet />;
}
