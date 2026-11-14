/**
 * Query keys and hooks for standalone grocery lists (`/shopping-lists`) and
 * for deleting a plan's grocery list. Keys start with `['hh', householdId, ...]`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { Ingredient, ListShoppingListsResponse, ShoppingListResponse } from '../../api/types';
import { groceryListKey } from './groceryQueries';

export function shoppingListsKey(householdId: string | null) {
  return ['hh', householdId ?? 'none', 'shopping-lists'] as const;
}

export function shoppingListKey(householdId: string | null, listId: string) {
  return ['hh', householdId ?? 'none', 'shopping-list', listId] as const;
}

export function useShoppingLists() {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery<ListShoppingListsResponse>({
    queryKey: shoppingListsKey(activeHouseholdId),
    queryFn: ({ signal }) => api.listShoppingLists({ signal }),
    enabled: activeHouseholdId !== null,
  });
}

export function useShoppingList(listId: string) {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery<ShoppingListResponse>({
    queryKey: shoppingListKey(activeHouseholdId, listId),
    queryFn: ({ signal }) => api.getShoppingList(listId, { signal }),
    enabled: activeHouseholdId !== null && listId !== '',
  });
}

/** Creates a list: empty when `entries` is omitted. */
export function useCreateShoppingList() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: (input: { name?: string; entries?: Ingredient[] }) => api.createShoppingList(input),
    onSuccess: (result) => {
      queryClient.setQueryData(shoppingListKey(activeHouseholdId, result.shoppingList.listId), result);
      void queryClient.invalidateQueries({ queryKey: shoppingListsKey(activeHouseholdId) });
    },
  });
}

/** Adds ingredients to an existing list. */
export function useAddToShoppingList() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: ({ listId, items }: { listId: string; items: Ingredient[] }) =>
      api.addShoppingListItems(listId, { items }),
    onSuccess: (result) => {
      queryClient.setQueryData(shoppingListKey(activeHouseholdId, result.shoppingList.listId), result);
      void queryClient.invalidateQueries({ queryKey: shoppingListsKey(activeHouseholdId) });
    },
  });
}

/** Replaces a list's entries (manual edit) and/or renames it. */
export function useUpdateShoppingList(listId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: (input: { name?: string; entries?: Ingredient[] }) => api.updateShoppingList(listId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(shoppingListKey(activeHouseholdId, listId), result);
      void queryClient.invalidateQueries({ queryKey: shoppingListsKey(activeHouseholdId) });
    },
  });
}

export function useDeleteShoppingList() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: (listId: string) => api.deleteShoppingList(listId),
    onSuccess: (_result, listId) => {
      queryClient.removeQueries({ queryKey: shoppingListKey(activeHouseholdId, listId) });
      void queryClient.invalidateQueries({ queryKey: shoppingListsKey(activeHouseholdId) });
    },
  });
}

/** Deletes a plan's grocery list; the plan itself stays. */
export function useDeletePlanGroceryList() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  return useMutation({
    mutationFn: (planId: string) => api.deleteGroceryList(planId),
    onSuccess: (_result, planId) => {
      queryClient.setQueryData(groceryListKey(activeHouseholdId, planId), null);
      void queryClient.invalidateQueries({ queryKey: groceryListKey(activeHouseholdId, planId) });
    },
  });
}
