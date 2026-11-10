/**
 * Preference_Profile query key and hook, keyed by `['hh', householdId, ...]`.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { isApiError } from '../../api/errors';

export function preferencesKey(householdId: string | null) {
  return ['hh', householdId ?? 'none', 'preferences'] as const;
}

export function usePreferences() {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery({
    queryKey: preferencesKey(activeHouseholdId),
    queryFn: ({ signal }) => api.getPreferences({ signal }),
    enabled: activeHouseholdId !== null,
  });
}

export function errorMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : 'Something went wrong. Please try again.';
}
