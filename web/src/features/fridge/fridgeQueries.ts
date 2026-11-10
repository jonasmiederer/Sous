/**
 * Fridge query key and hooks. Keys start with `['hh', householdId, ...]` so a
 * Household switch never shows another Household's fridge.
 *
 * Voice (task 24.5): after a confirmed `{ type: 'fridge' }` voice recording,
 * call `useInvalidateFridge()()` (or the editor's `onApplied` slot callback)
 * so the editor reloads the server inventory.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { isApiError } from '../../api/errors';

export function fridgeKey(householdId: string | null) {
  return ['hh', householdId ?? 'none', 'fridge'] as const;
}

export function useFridge() {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery({
    queryKey: fridgeKey(activeHouseholdId),
    queryFn: ({ signal }) => api.getFridge({ signal }),
    enabled: activeHouseholdId !== null,
  });
}

/** Returns a function that refetches the active Household's fridge. */
export function useInvalidateFridge() {
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: fridgeKey(activeHouseholdId) }),
    [queryClient, activeHouseholdId],
  );
}

export function errorMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : 'Something went wrong. Please try again.';
}
