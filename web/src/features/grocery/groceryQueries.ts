/**
 * Query key and hooks for a plan's Grocery_List. Keys start with
 * `['hh', householdId, ...]` like every Household-scoped query.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { isApiError } from '../../api/errors';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { GetGroceryListResponse, GroceryEntry } from '../../api/types';

export function groceryListKey(householdId: string | null, planId: string) {
  return ['hh', householdId ?? 'none', 'grocery', planId] as const;
}

/** True for the 404 the API returns before a list has been generated. */
export function isNoGroceryList(error: unknown): boolean {
  return isApiError(error) && error.code === 'GROCERY_LIST_NOT_FOUND';
}

/** The stored list, or `null` when none has been generated for the plan yet. */
export function useGroceryList(planId: string) {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery<GetGroceryListResponse | null>({
    queryKey: groceryListKey(activeHouseholdId, planId),
    queryFn: async ({ signal }) => {
      try {
        return await api.getGroceryList(planId, { signal });
      } catch (error) {
        if (isNoGroceryList(error)) return null;
        throw error;
      }
    },
    enabled: activeHouseholdId !== null && planId !== '',
  });
}

/** Saves a manual edit (add, remove, change entries) and puts the stored list in the cache. */
export function useUpdateGroceryList(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: (entries: GroceryEntry[]) => api.updateGroceryList(planId, { entries }),
    onSuccess: (result) => {
      queryClient.setQueryData<GetGroceryListResponse>(groceryListKey(activeHouseholdId, planId), result);
    },
  });
}

/** Generates or regenerates the list and puts the result in the cache. */
export function useGenerateGroceryList(planId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: () => api.generateGroceryList(planId),
    onSuccess: (result) => {
      const value: GetGroceryListResponse = { groceryList: result.groceryList, version: result.version };
      queryClient.setQueryData(groceryListKey(activeHouseholdId, planId), value);
    },
  });
}
