/**
 * Grocery Service core: generate and regenerate a Meal_Plan's Grocery_List
 * (Requirements 7.1, 7.5, 7.7).
 *
 * A GroceryService is bound to one Household through its HouseholdRepository.
 * For HTTP requests the authorizer has already verified membership; for
 * MealPlanChanged events the repository is bound to the event's householdId.
 *
 * Both paths share one routine:
 *   1. Read the CURRENT plan at PLAN#{planId}, its Meals at MEAL#{mealId},
 *      the Fridge_Inventory at FRIDGE, and any existing list at
 *      GROCERY#{planId} (all from the bound Household partition).
 *   2. Consolidate with the pure `buildGroceryList` (task 5.4). The list
 *      carries the plan's planId and the Household's id (7.7).
 *   3. Persist the domain GroceryList fields plus `sourcePlanVersion` (the
 *      plan record version the list was built from) at GROCERY#{planId}:
 *      `create` when no list exists, otherwise `replaceIfVersion` against the
 *      stored list version, so a concurrent writer is never clobbered. On a
 *      lost race the routine re-reads everything and tries again, up to
 *      `maxWriteAttempts` (default 3).
 *
 * Regeneration policy (MealPlanChanged consumer, 7.5):
 * - Regenerate only when a Grocery_List already exists for the plan. The
 *   requirement scopes regeneration to plans "after a Grocery_List exists";
 *   creating a list nobody asked for would also make list generation implicit
 *   on every plan edit. Events for plans without a list are skipped.
 * - Events are ordered by `planVersion`. If the stored list was already built
 *   from that plan version or a later one, the event is stale and skipped.
 * - The list is always rebuilt from the plan as currently stored, never from
 *   the event body. If the plan read is older than the event's planVersion
 *   (should not happen with consistent reads) a StalePlanReadError is thrown
 *   so the event is retried.
 * - A regenerated list replaces any chat refinement made to the previous
 *   list, since it must equal fresh generation on the changed plan.
 *
 * Storage read failures throw; write failures are returned as results.
 */
import { sortKeys } from '../../data/keys.js';
import type { HouseholdRepository, StoredRecord } from '../../data/repository.js';
import { buildGroceryList } from '../../domain/grocery.js';
import type { FridgeInventory, GroceryList, Ingredient, Meal, MealId, MealPlan, PlanId } from '../../domain/types.js';
import { toFridgeItems, toMealPlan, type PlanAttributes } from '../plans/records.js';
import {
  GROCERY_ERROR_MESSAGES,
  groceryError,
  type GroceryServiceError,
  type GroceryServiceResult,
} from './errors.js';

export const DEFAULT_MAX_WRITE_ATTEMPTS = 3;

export interface Clock {
  now(): Date;
}

export interface GroceryServiceDeps {
  repository: HouseholdRepository;
  clock: Clock;
  maxWriteAttempts?: number;
}

/** Stored Grocery_List attributes: the domain GroceryList plus its source plan version. */
export interface GroceryListAttributes extends GroceryList {
  [key: string]: unknown;
  sourcePlanVersion: number;
}

export interface StoredGroceryList {
  groceryList: GroceryList;
  /** Version of the GROCERY#{planId} record after the write. */
  version: number;
  /** Version of the plan record the list was built from. */
  sourcePlanVersion: number;
  /** True when this write created the record, false when it replaced one. */
  created: boolean;
}

export type RegenerationSkipReason = 'no_grocery_list' | 'stale_event' | 'plan_not_found';

export type RegenerationOutcome =
  | { status: 'regenerated'; list: StoredGroceryList }
  | { status: 'skipped'; reason: RegenerationSkipReason }
  | { status: 'failed'; error: GroceryServiceError };

/** The plan read lagged behind the event; retry the event later. */
export class StalePlanReadError extends Error {
  override readonly name = 'StalePlanReadError';
  constructor(planId: PlanId, readVersion: number, eventVersion: number) {
    super(`Plan ${planId} read at version ${readVersion}, older than event version ${eventVersion}`);
  }
}

const isIngredient = (v: unknown): v is Ingredient =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Ingredient).name === 'string' &&
  typeof (v as Ingredient).quantity === 'number' &&
  typeof (v as Ingredient).unit === 'string';

/** Strict Meal parse: a malformed ingredient list makes the Meal unusable. */
function toMeal(mealId: MealId, a: Record<string, unknown>): Meal | undefined {
  if (!Array.isArray(a.ingredients) || !a.ingredients.every(isIngredient)) return undefined;
  return {
    mealId,
    name: typeof a.name === 'string' ? a.name : '',
    ingredients: a.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    steps: Array.isArray(a.steps) ? a.steps.filter((s): s is string => typeof s === 'string') : [],
    attributes: Array.isArray(a.attributes) ? a.attributes.filter((s): s is string => typeof s === 'string') : [],
  };
}

function sourceVersionOf(record: StoredRecord): number {
  const v = record.attributes.sourcePlanVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

type Mode =
  | { kind: 'generate' }
  | { kind: 'regenerate'; eventPlanVersion: number };

type RunResult =
  | { ok: true; value: StoredGroceryList }
  | { ok: false; error: GroceryServiceError }
  | { ok: 'skipped'; reason: RegenerationSkipReason };

export class GroceryService {
  private readonly repo: HouseholdRepository;
  private readonly maxWriteAttempts: number;

  constructor(private readonly deps: GroceryServiceDeps) {
    this.repo = deps.repository;
    this.maxWriteAttempts = Math.max(1, deps.maxWriteAttempts ?? DEFAULT_MAX_WRITE_ATTEMPTS);
  }

  /** POST /plans/{id}/grocery-list: build and persist the plan's Grocery_List (7.1, 7.7). */
  async generate(planId: unknown): Promise<GroceryServiceResult<StoredGroceryList>> {
    const sk = this.planSortKey(planId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.invalidPlanId);
    const result = await this.run(planId as PlanId, { kind: 'generate' });
    if (result.ok === 'skipped') return groceryError('PLAN_NOT_FOUND', GROCERY_ERROR_MESSAGES.planNotFound);
    return result;
  }

  /**
   * GET /plans/{id}/grocery-list: the stored list for a plan in the bound
   * Household partition (13.13, 1.4). Read-only; never generates a list.
   */
  async get(planId: unknown): Promise<GroceryServiceResult<Omit<StoredGroceryList, 'created'>>> {
    const sk = this.groceryListSortKey(planId);
    if (sk === undefined) return groceryError('INVALID_REQUEST', GROCERY_ERROR_MESSAGES.invalidPlanId);
    const record = await this.repo.get(sk);
    if (record === undefined) {
      return groceryError('GROCERY_LIST_NOT_FOUND', GROCERY_ERROR_MESSAGES.groceryListNotFound);
    }
    const a = record.attributes;
    const groceryList: GroceryList = {
      householdId: this.repo.householdId,
      planId: planId as PlanId,
      entries: Array.isArray(a.entries) ? a.entries.filter(isIngredient).map((e) => ({ ...e })) : [],
      generatedAt: typeof a.generatedAt === 'string' ? a.generatedAt : '',
    };
    return { ok: true, value: { groceryList, version: record.version, sourcePlanVersion: sourceVersionOf(record) } };
  }

  /** MealPlanChanged: rebuild an existing list from the current plan (7.5). */
  async regenerate(planId: PlanId, eventPlanVersion: number): Promise<RegenerationOutcome> {
    const result = await this.run(planId, { kind: 'regenerate', eventPlanVersion });
    if (result.ok === 'skipped') return { status: 'skipped', reason: result.reason };
    if (result.ok) return { status: 'regenerated', list: result.value };
    return { status: 'failed', error: result.error };
  }

  private planSortKey(planId: unknown): string | undefined {
    try {
      return sortKeys.plan(planId as PlanId);
    } catch {
      return undefined;
    }
  }

  private async run(planId: PlanId, mode: Mode): Promise<RunResult> {
    for (let attempt = 0; attempt < this.maxWriteAttempts; attempt++) {
      const [planRecord, listRecord] = await Promise.all([
        this.repo.get<PlanAttributes>(sortKeys.plan(planId)),
        this.repo.get(sortKeys.grocery(planId)),
      ]);
      if (planRecord === undefined) return { ok: 'skipped', reason: 'plan_not_found' };

      if (mode.kind === 'regenerate') {
        if (listRecord === undefined) return { ok: 'skipped', reason: 'no_grocery_list' };
        if (sourceVersionOf(listRecord) >= mode.eventPlanVersion) return { ok: 'skipped', reason: 'stale_event' };
        if (planRecord.version < mode.eventPlanVersion) {
          throw new StalePlanReadError(planId, planRecord.version, mode.eventPlanVersion);
        }
      }

      const plan: MealPlan = { ...toMealPlan(planRecord.attributes), planId, householdId: this.repo.householdId };
      const built = await this.build(plan);
      if (!built.ok) return built;

      const attributes: GroceryListAttributes = { ...built.value, sourcePlanVersion: planRecord.version };
      const write =
        listRecord === undefined
          ? await this.repo.create(sortKeys.grocery(planId), attributes)
          : await this.repo.replaceIfVersion(sortKeys.grocery(planId), listRecord.version, attributes);

      if (write.ok) {
        return {
          ok: true,
          value: {
            groceryList: built.value,
            version: listRecord === undefined ? 1 : listRecord.version + 1,
            sourcePlanVersion: planRecord.version,
            created: listRecord === undefined,
          },
        };
      }
      if (write.error.reason !== 'condition_failed') {
        return groceryError('SAVE_DID_NOT_COMPLETE', GROCERY_ERROR_MESSAGES.saveDidNotComplete);
      }
      // Lost an optimistic-concurrency race: re-read and try again.
    }
    return groceryError('GROCERY_CONFLICT', GROCERY_ERROR_MESSAGES.conflict);
  }

  private async build(plan: MealPlan): Promise<GroceryServiceResult<GroceryList>> {
    const mealIds = [...new Set(plan.days.map((d) => d.mealId))];
    const [mealRecords, fridgeRecord] = await Promise.all([
      Promise.all(
        mealIds.map(async (id) => {
          const sk = this.mealSortKey(id);
          return sk === undefined ? undefined : this.repo.get(sk);
        }),
      ),
      this.repo.get(sortKeys.fridge()),
    ]);

    const meals: Meal[] = [];
    mealRecords.forEach((record, i) => {
      const meal = record && toMeal(mealIds[i]!, record.attributes);
      if (meal) meals.push(meal);
    });

    const fridge: FridgeInventory | undefined =
      fridgeRecord === undefined
        ? undefined
        : {
            householdId: this.repo.householdId,
            items: toFridgeItems(fridgeRecord.attributes),
            updatedAt: typeof fridgeRecord.attributes.updatedAt === 'string' ? fridgeRecord.attributes.updatedAt : '',
          };

    const result = buildGroceryList({
      plan,
      meals,
      ...(fridge ? { fridge } : {}),
      generatedAt: this.deps.clock.now().toISOString(),
    });
    if (!result.ok) return groceryError('PLAN_INCONSISTENT', result.error.message);
    return result;
  }

  private groceryListSortKey(planId: unknown): string | undefined {
    try {
      return sortKeys.grocery(planId as PlanId);
    } catch {
      return undefined;
    }
  }

  private mealSortKey(mealId: unknown): string | undefined {
    try {
      return sortKeys.meal(mealId as MealId);
    } catch {
      return undefined;
    }
  }
}
