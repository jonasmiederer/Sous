/**
 * Query keys, hooks, and cache helpers for plans. Keys start with
 * `['hh', householdId, ...]` so a Household switch never shows another
 * Household's cache.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { isApiError } from '../../api/errors';
import type { ListPlansResponse, Meal, PlanEditResult, StoredPlan } from '../../api/types';

export function plansListKey(householdId: string | null) {
  return ['hh', householdId ?? 'none', 'plans', 'list'] as const;
}

export function planKey(householdId: string | null, planId: string) {
  return ['hh', householdId ?? 'none', 'plans', 'detail', planId] as const;
}

export function usePlansList() {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery({
    queryKey: plansListKey(activeHouseholdId),
    queryFn: ({ signal }) => api.listPlans({ signal }),
    enabled: activeHouseholdId !== null,
  });
}

export function usePlan(planId: string) {
  const api = useApi();
  const { activeHouseholdId } = useActiveHousehold();
  return useQuery({
    queryKey: planKey(activeHouseholdId, planId),
    queryFn: ({ signal }) => api.getPlan(planId, { signal }),
    enabled: activeHouseholdId !== null && planId !== '',
  });
}

/** Applies a day edit to a cached plan: new plan and version, and the day's new Meal. */
export function applyPlanEdit(stored: StoredPlan, result: PlanEditResult): StoredPlan {
  const referenced = new Set(result.plan.days.map((d) => d.mealId));
  const meals: Meal[] = stored.meals.filter((m) => referenced.has(m.mealId) && m.mealId !== result.meal?.mealId);
  if (result.meal) meals.push(result.meal);
  return { plan: result.plan, meals, version: result.version };
}

/** Plan ids in a list response, used to spot a plan saved after a client timeout. */
export function planIds(list: ListPlansResponse | undefined): string[] | null {
  return list ? list.plans.map((p) => p.planId) : null;
}

/** The user-facing message for any error thrown by the API client. */
export function errorMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : 'Something went wrong. Please try again.';
}

export function errorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.code : undefined;
}
