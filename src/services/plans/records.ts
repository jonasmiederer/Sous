/**
 * Mapping between stored single-table records and domain types for the Plan
 * Service. Plan and Meal records are written by this service. The
 * Preference_Profile and Fridge_Inventory records are read with the domain
 * type's fields as attributes (the shape the Preference and Fridge services
 * persist); unexpected attribute types are treated as empty.
 */
import type {
  FridgeInventory,
  HouseholdId,
  Ingredient,
  IsoTimestamp,
  Meal,
  MealId,
  MealPlan,
  MealPlanDay,
  PreferenceProfile,
} from '../../domain/types.js';
import type { Attributes } from '../../data/repository.js';

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const isIngredient = (v: unknown): v is Ingredient =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Ingredient).name === 'string' &&
  typeof (v as Ingredient).quantity === 'number' &&
  typeof (v as Ingredient).unit === 'string';

export function toPreferenceProfile(householdId: HouseholdId, a: Attributes): PreferenceProfile {
  return {
    householdId,
    likes: strings(a.likes),
    dislikes: strings(a.dislikes),
    excludedIngredients: strings(a.excludedIngredients),
    dietaryConstraints: strings(a.dietaryConstraints),
    acceptances: strings(a.acceptances),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : '',
  };
}

export function toFridgeItems(a: Attributes | undefined): Ingredient[] {
  return Array.isArray(a?.items) ? a.items.filter(isIngredient) : [];
}

export type FridgeItems = FridgeInventory['items'];

/** Stored Meal_Plan attributes: the MealPlan plus audit timestamps. */
export interface PlanAttributes extends Attributes {
  planId: string;
  householdId: HouseholdId;
  startDate: string;
  endDate: string;
  rangeDays: number;
  days: MealPlanDay[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export function planAttributes(plan: MealPlan, createdAt: IsoTimestamp, updatedAt: IsoTimestamp): PlanAttributes {
  return {
    planId: plan.planId,
    householdId: plan.householdId,
    startDate: plan.startDate,
    endDate: plan.endDate,
    rangeDays: plan.rangeDays,
    days: plan.days.map((d) => ({ day: d.day, mealId: d.mealId })),
    createdAt,
    updatedAt,
  };
}

export function toMealPlan(a: PlanAttributes): MealPlan {
  return {
    planId: a.planId,
    householdId: a.householdId,
    startDate: a.startDate,
    endDate: a.endDate,
    rangeDays: a.rangeDays,
    days: (a.days ?? []).map((d) => ({ day: d.day, mealId: d.mealId })),
  };
}

/** Reads a stored Meal record; malformed ingredients and steps are dropped. */
export function toMeal(mealId: MealId, a: Attributes): Meal {
  return {
    mealId,
    name: typeof a.name === 'string' ? a.name : '',
    ingredients: Array.isArray(a.ingredients)
      ? a.ingredients.filter(isIngredient).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }))
      : [],
    steps: strings(a.steps),
    attributes: strings(a.attributes),
  };
}

export function mealAttributes(meal: Meal, planId: string, createdAt: IsoTimestamp): Attributes {
  return {
    mealId: meal.mealId,
    name: meal.name,
    ingredients: meal.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    steps: [...meal.steps],
    attributes: [...meal.attributes],
    planId,
    createdAt,
  };
}
