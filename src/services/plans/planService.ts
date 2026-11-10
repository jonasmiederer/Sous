/**
 * Plan Service core: weekly/custom Meal_Plan generation and single-day edits
 * (Requirements 3.1-3.8, 7.5, 8.4, 8.6).
 *
 * A PlanService is bound to one Active_Household through its
 * HouseholdRepository; membership has already been verified by the caller.
 *
 * Generation
 * - Validation happens before any read or agent call: range 1-31 (weekly = 7),
 *   Context_Input <= 500 chars, presets recognized and compatible.
 * - A stored Preference_Profile is required (3.3).
 * - The whole plan is built in memory and persisted only when complete, as one
 *   all-or-nothing transaction creating the plan record and its Meal records
 *   (3.4, 3.5). Any failure stores nothing.
 *
 * Agent-output policy (documented choice): the agent's Meals must number
 * exactly one per requested day, each with a name, >= 1 ingredient and >= 1
 * step, and none may violate a hard exclusion (3.2, Property 7). An output
 * that fails any of these checks, or that does not parse, is discarded and
 * the agent is re-requested while time remains within the single 30s
 * deadline, up to `maxGenerationAttempts` (default 2). Timeouts and
 * invocation failures are not retried. If no attempt yields a valid plan the
 * request fails with GENERATION_FAILED / GENERATION_TIMEOUT and nothing is
 * stored. Meals are never silently dropped or substituted, so a stored plan
 * always has exactly one agent Meal per day.
 *
 * Day edits (replace / add / remove) rewrite the plan record with
 * `replaceIfVersion` in a transaction that also creates the new Meal record,
 * so other days are untouched and a concurrent edit is rejected as
 * PLAN_CONFLICT instead of being overwritten (3.6). Superseded Meal records
 * are kept (they may be referenced by Feedback or acceptances). After a
 * committed edit a MealPlanChanged event is published (7.5); a publish
 * failure does not undo the committed edit and is reported as
 * `eventPublished: false`.
 *
 * Range semantics for edits: `startDate`/`endDate`/`rangeDays` describe the
 * plan's date range. Removing a day leaves that date without a Meal and keeps
 * the range. Adding a day fills an unassigned date in the range or extends the
 * range to include the new date, provided the range stays within 31 days.
 */
import { performance } from 'node:perf_hooks';

import { buildPlanPayload, type PlanPayload } from '../../agent/payload.js';
import { parseAgentResponseValue, type AgentMeal } from '../../agent/responses.js';
import { PLAN_DEADLINE_MS, type SuggestionAgentClient } from '../../agent/runtimeClient.js';
import type { HouseholdPreferenceRead, MemoryClient } from '../../agent/memoryClient.js';
import { assertKeyComponent, KeyPrefix, sortKeys } from '../../data/keys.js';
import type { HouseholdRepository, HouseholdTransactOp } from '../../data/repository.js';
import type { WriteResult } from '../../data/errors.js';
import { enforceHardExclusions } from '../../domain/exclusions.js';
import { validatePresets } from '../../domain/presets.js';
import type { Ingredient, IsoDate, Meal, MealPlan, MealPlanDay, PreferenceProfile, Preset } from '../../domain/types.js';
import { dateRange, daysBetween, isIsoDate, toIsoDate } from './dates.js';
import { PLAN_ERROR_MESSAGES, planError, type PlanError, type PlanResult } from './errors.js';
import type { MealPlanChangeKind, MealPlanChangedEvent, PlanEventPublisher } from './events.js';
import {
  mealAttributes,
  planAttributes,
  toFridgeItems,
  toMeal,
  toMealPlan,
  toPreferenceProfile,
  type PlanAttributes,
} from './records.js';

export const MIN_PLAN_DAYS = 1;
export const MAX_PLAN_DAYS = 31;
export const WEEKLY_PLAN_DAYS = 7;
export const MAX_CONTEXT_INPUT_LENGTH = 500;
export const DEFAULT_MAX_GENERATION_ATTEMPTS = 2;
/** GET /plans returns at most this many plans. */
export const MAX_LISTED_PLANS = 20;

const compareDesc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

export interface Clock {
  now(): Date;
}

/** Produces unique ids that are safe as key components (no '#'). */
export interface IdGenerator {
  next(): string;
}

export interface PlanServiceDeps {
  repository: HouseholdRepository;
  agent: SuggestionAgentClient;
  events: PlanEventPublisher;
  clock: Clock;
  ids: IdGenerator;
  /**
   * Optional best-effort soft-memory read. Its result is handed to hard
   * exclusion enforcement, which by design ignores it (Property 7); the agent
   * itself reads the household namespace. A failed read never blocks a plan.
   */
  memory?: MemoryClient;
  /** Overall generation deadline; default and ceiling 30s (3.4, 8.4). */
  deadlineMs?: number;
  maxGenerationAttempts?: number;
  /** Monotonic milliseconds for deadline arithmetic. Default performance.now. */
  monotonicNow?: () => number;
}

/** Raw request fields, validated by the service (they come from untrusted JSON). */
export interface GeneratePlanRequest {
  rangeDays?: unknown;
  weekly?: unknown;
  /** YYYY-MM-DD; defaults to today (UTC). */
  startDate?: unknown;
  contextInput?: unknown;
  presets?: unknown;
}

/** Shared generation options for day edits. */
export interface DayMealRequest {
  /** A Meal to use as-is. When absent, the agent generates one. */
  meal?: unknown;
  contextInput?: unknown;
  presets?: unknown;
}

export interface AddDayRequest extends DayMealRequest {
  day?: unknown;
}

export interface StoredPlan {
  plan: MealPlan;
  /** Meals of this change, in day order (all Meals for a new plan). */
  meals: Meal[];
  version: number;
}

/** One entry of GET /plans. */
export interface PlanSummary {
  planId: string;
  startDate: IsoDate;
  endDate: IsoDate;
  rangeDays: number;
}

export interface PlanEditResult extends StoredPlan {
  change: MealPlanChangeKind;
  day: IsoDate;
  eventPublished: boolean;
}

interface GenerationOptions {
  contextInput?: string;
  presets: Preset[];
}

const TIMED_OUT = Symbol('timed-out');

export class PlanService {
  private readonly deadlineMs: number;
  private readonly maxAttempts: number;
  private readonly monotonicNow: () => number;

  constructor(private readonly deps: PlanServiceDeps) {
    this.deadlineMs = Math.min(deps.deadlineMs ?? PLAN_DEADLINE_MS, PLAN_DEADLINE_MS);
    if (!(this.deadlineMs > 0)) throw new RangeError('deadlineMs must be positive');
    this.maxAttempts = Math.max(1, deps.maxGenerationAttempts ?? DEFAULT_MAX_GENERATION_ATTEMPTS);
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
  }

  private get householdId(): string {
    return this.deps.repository.householdId;
  }

  // -------------------------------------------------------------------------
  // POST /plans
  // -------------------------------------------------------------------------

  async generatePlan(request: GeneratePlanRequest): Promise<PlanResult<StoredPlan>> {
    const deadlineAt = this.monotonicNow() + this.deadlineMs;

    const range = resolveRange(request);
    if (!range.ok) return range;
    const options = validateGenerationOptions(request);
    if (!options.ok) return options;
    const now = this.deps.clock.now();
    let startDate: IsoDate;
    if (request.startDate === undefined) startDate = toIsoDate(now);
    else if (isIsoDate(request.startDate)) startDate = request.startDate;
    else return planError('INVALID_REQUEST', 'startDate must be a calendar date in YYYY-MM-DD form.');

    const context = await this.loadContext();
    if (!context.profile) return planError('PROFILE_REQUIRED', PLAN_ERROR_MESSAGES.profileRequired);

    const generated = await this.generateMeals(range.value, context, options.value, deadlineAt);
    if (!generated.ok) return generated;

    const planId = this.newId();
    const days = dateRange(startDate, range.value);
    const meals: Meal[] = generated.value.map((m) => ({ ...m, mealId: this.newId() }));
    const plan: MealPlan = {
      planId,
      householdId: this.householdId,
      startDate,
      endDate: days[days.length - 1] ?? startDate,
      rangeDays: range.value,
      days: days.map((day, i) => ({ day, mealId: (meals[i] as Meal).mealId })),
    };

    // Do not persist a plan that finished after its deadline (3.4).
    if (this.monotonicNow() > deadlineAt) {
      return planError('GENERATION_TIMEOUT', PLAN_ERROR_MESSAGES.generationTimeout);
    }

    const stamp = now.toISOString();
    const ops: HouseholdTransactOp[] = [
      { kind: 'create', sk: sortKeys.plan(planId), attributes: planAttributes(plan, stamp, stamp) },
      ...meals.map(
        (meal): HouseholdTransactOp => ({
          kind: 'create',
          sk: sortKeys.meal(meal.mealId),
          attributes: mealAttributes(meal, planId, stamp),
        }),
      ),
    ];
    const written = await this.deps.repository.transact(ops);
    if (!written.ok) return saveFailure(written, false);
    return { ok: true, value: { plan, meals, version: 1 } };
  }

  // -------------------------------------------------------------------------
  // PUT /plans/{id}/days/{day}
  // -------------------------------------------------------------------------

  async replaceDay(planId: unknown, day: unknown, request: DayMealRequest): Promise<PlanResult<PlanEditResult>> {
    const deadlineAt = this.monotonicNow() + this.deadlineMs;
    const loaded = await this.loadPlanForEdit(planId, day);
    if (!loaded.ok) return loaded;
    const { plan, version, record, targetDay } = loaded.value;

    const index = plan.days.findIndex((d) => d.day === targetDay);
    if (index === -1) return planError('DAY_NOT_FOUND', `The plan has no Meal on ${targetDay}.`);

    const meal = await this.resolveDayMeal(request, deadlineAt);
    if (!meal.ok) return meal;

    const days = plan.days.map((d, i) => (i === index ? { day: d.day, mealId: meal.value.mealId } : d));
    return this.commitEdit(record, version, { ...plan, days }, 'day_replaced', targetDay, meal.value);
  }

  // -------------------------------------------------------------------------
  // POST /plans/{id}/days
  // -------------------------------------------------------------------------

  async addDay(planId: unknown, request: AddDayRequest): Promise<PlanResult<PlanEditResult>> {
    const deadlineAt = this.monotonicNow() + this.deadlineMs;
    const loaded = await this.loadPlanForEdit(planId, request.day);
    if (!loaded.ok) return loaded;
    const { plan, version, record, targetDay } = loaded.value;

    if (plan.days.some((d) => d.day === targetDay)) {
      return planError('DAY_ALREADY_ASSIGNED', `The plan already has a Meal on ${targetDay}.`);
    }
    const startDate = targetDay < plan.startDate ? targetDay : plan.startDate;
    const endDate = targetDay > plan.endDate ? targetDay : plan.endDate;
    const rangeDays = daysBetween(startDate, endDate) + 1;
    if (rangeDays > MAX_PLAN_DAYS) return planError('INVALID_RANGE', PLAN_ERROR_MESSAGES.invalidRange);

    const meal = await this.resolveDayMeal(request, deadlineAt);
    if (!meal.ok) return meal;

    const days: MealPlanDay[] = [...plan.days, { day: targetDay, mealId: meal.value.mealId }].sort((a, b) =>
      a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
    );
    return this.commitEdit(record, version, { ...plan, startDate, endDate, rangeDays, days }, 'day_added', targetDay, meal.value);
  }

  // -------------------------------------------------------------------------
  // DELETE /plans/{id}/days/{day}
  // -------------------------------------------------------------------------

  async removeDay(planId: unknown, day: unknown): Promise<PlanResult<PlanEditResult>> {
    const loaded = await this.loadPlanForEdit(planId, day);
    if (!loaded.ok) return loaded;
    const { plan, version, record, targetDay } = loaded.value;
    if (!plan.days.some((d) => d.day === targetDay)) {
      return planError('DAY_NOT_FOUND', `The plan has no Meal on ${targetDay}.`);
    }
    const days = plan.days.filter((d) => d.day !== targetDay);
    return this.commitEdit(record, version, { ...plan, days }, 'day_removed', targetDay, undefined);
  }

  // -------------------------------------------------------------------------
  // GET /plans
  // -------------------------------------------------------------------------

  /**
   * Lists the Active_Household's plans, newest first, at most
   * MAX_LISTED_PLANS (13.12, 1.4).
   *
   * Trade-off: this is one partition query on the `PLAN#` sort-key prefix
   * (never a scan), and sorting by `createdAt` happens in code because plan
   * sort keys are ids, not timestamps. Every plan record in the partition is
   * read before the cap is applied. That is cheap for the expected tens of
   * plans per Household; if Households accumulate many plans, add a
   * timestamp-ordered sort key (or a GSI) and query it with a limit instead.
   */
  async listPlans(): Promise<PlanResult<{ plans: PlanSummary[] }>> {
    const records = await this.deps.repository.query<PlanAttributes>(KeyPrefix.plan);
    const plans = records
      .map((r) => r.attributes)
      .sort((a, b) => compareDesc(String(a.createdAt ?? ''), String(b.createdAt ?? '')) || compareDesc(a.planId, b.planId))
      .slice(0, MAX_LISTED_PLANS)
      .map((a) => ({ planId: a.planId, startDate: a.startDate, endDate: a.endDate, rangeDays: a.rangeDays }));
    return { ok: true, value: { plans } };
  }

  // -------------------------------------------------------------------------
  // GET /plans/{id}
  // -------------------------------------------------------------------------

  /**
   * Reads one plan with its Meals in day order (13.12). Meals are read from
   * the same Household partition; a referenced Meal whose record is missing
   * is left out of `meals` (the day itself stays in `plan.days`).
   */
  async getPlan(planId: unknown): Promise<PlanResult<StoredPlan>> {
    if (typeof planId !== 'string' || planId.length === 0 || planId.includes('#')) {
      return planError('INVALID_REQUEST', 'planId is invalid.');
    }
    const stored = await this.deps.repository.get<PlanAttributes>(sortKeys.plan(planId));
    if (!stored) return planError('PLAN_NOT_FOUND', 'Meal plan not found.');
    const plan: MealPlan = { ...toMealPlan(stored.attributes), planId, householdId: this.householdId };

    const mealIds = [...new Set(plan.days.map((d) => d.mealId))];
    const records = await Promise.all(
      mealIds.map((id) =>
        typeof id === 'string' && id.length > 0 && !id.includes('#')
          ? this.deps.repository.get(sortKeys.meal(id))
          : Promise.resolve(undefined),
      ),
    );
    const meals: Meal[] = [];
    records.forEach((record, i) => {
      if (record) meals.push(toMeal(mealIds[i] as string, record.attributes));
    });
    return { ok: true, value: { plan, meals, version: stored.version } };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private newId(): string {
    return assertKeyComponent('id', this.deps.ids.next());
  }

  private async loadContext(): Promise<{
    profile: PreferenceProfile | null;
    fridge: Ingredient[];
    softMemory: HouseholdPreferenceRead | undefined;
  }> {
    const [profileRecord, fridgeRecord, softMemory] = await Promise.all([
      this.deps.repository.get(sortKeys.preferenceProfile()),
      this.deps.repository.get(sortKeys.fridge()),
      this.deps.memory
        ? this.deps.memory.readHouseholdPreferences({ householdId: this.householdId }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    return {
      profile: profileRecord ? toPreferenceProfile(this.householdId, profileRecord.attributes) : null,
      fridge: toFridgeItems(fridgeRecord?.attributes),
      softMemory,
    };
  }

  /** Requests `count` Meals from the agent under the deadline; see the module doc for the policy. */
  private async generateMeals(
    count: number,
    context: Awaited<ReturnType<PlanService['loadContext']>>,
    options: GenerationOptions,
    deadlineAt: number,
  ): Promise<PlanResult<AgentMeal[]>> {
    const payload: PlanPayload = buildPlanPayload({
      householdId: this.householdId,
      preferenceProfile: context.profile,
      fridgeInventory: context.fridge,
      presets: options.presets,
      contextInput: options.contextInput ?? null,
      rangeDays: count,
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const remaining = Math.floor(deadlineAt - this.monotonicNow());
      if (remaining <= 0) return planError('GENERATION_TIMEOUT', PLAN_ERROR_MESSAGES.generationTimeout);

      const result = await raceDeadline(this.deps.agent.invoke(payload, { timeoutMs: remaining }), remaining);
      if (result === TIMED_OUT || (!result.ok && result.error.kind === 'timeout')) {
        return planError('GENERATION_TIMEOUT', PLAN_ERROR_MESSAGES.generationTimeout);
      }
      if (!result.ok) {
        if (result.error.kind === 'invalid_response') continue;
        return planError('GENERATION_FAILED', PLAN_ERROR_MESSAGES.generationFailed);
      }

      const meals = result.response.meals;
      if (meals.length !== count || !meals.every(isWellFormedMeal)) continue;
      const exclusions = enforceHardExclusions(meals, context.profile, context.softMemory);
      if (exclusions.excluded.length > 0) continue;
      return { ok: true, value: meals };
    }
    return planError('GENERATION_FAILED', PLAN_ERROR_MESSAGES.generationFailed);
  }

  /** A Meal for a day edit: the supplied one (validated) or one generated by the agent. */
  private async resolveDayMeal(request: DayMealRequest, deadlineAt: number): Promise<PlanResult<Meal>> {
    if (request.meal !== undefined) {
      const parsed = parseAgentResponseValue('plan', { mode: 'plan', meals: [request.meal] });
      const supplied = parsed.ok ? parsed.value.meals[0] : undefined;
      if (!supplied || !isWellFormedMeal(supplied)) {
        return planError(
          'INVALID_REQUEST',
          'meal must have a name, at least one ingredient {name, quantity, unit}, and at least one step.',
        );
      }
      const profileRecord = await this.deps.repository.get(sortKeys.preferenceProfile());
      const profile = profileRecord ? toPreferenceProfile(this.householdId, profileRecord.attributes) : null;
      const exclusions = enforceHardExclusions([supplied], profile);
      const violation = exclusions.excluded[0]?.violations[0];
      if (violation) {
        return planError('MEAL_EXCLUDED', `The meal conflicts with the household exclusion "${violation.origin}".`);
      }
      return { ok: true, value: { ...supplied, mealId: this.newId() } };
    }

    const options = validateGenerationOptions(request);
    if (!options.ok) return options;
    const context = await this.loadContext();
    const generated = await this.generateMeals(1, context, options.value, deadlineAt);
    if (!generated.ok) return generated;
    const [meal] = generated.value as [AgentMeal];
    return { ok: true, value: { ...meal, mealId: this.newId() } };
  }

  private async loadPlanForEdit(
    planId: unknown,
    day: unknown,
  ): Promise<PlanResult<{ plan: MealPlan; version: number; record: PlanAttributes; targetDay: IsoDate }>> {
    if (typeof planId !== 'string' || planId.length === 0 || planId.includes('#')) {
      return planError('INVALID_REQUEST', 'planId is invalid.');
    }
    if (!isIsoDate(day)) return planError('INVALID_REQUEST', 'day must be a calendar date in YYYY-MM-DD form.');
    const stored = await this.deps.repository.get<PlanAttributes>(sortKeys.plan(planId));
    if (!stored) return planError('PLAN_NOT_FOUND', 'Meal plan not found.');
    return {
      ok: true,
      value: { plan: toMealPlan(stored.attributes), version: stored.version, record: stored.attributes, targetDay: day },
    };
  }

  private async commitEdit(
    record: PlanAttributes,
    version: number,
    updated: MealPlan,
    change: MealPlanChangeKind,
    day: IsoDate,
    meal: Meal | undefined,
  ): Promise<PlanResult<PlanEditResult>> {
    const stamp = this.deps.clock.now().toISOString();
    const ops: HouseholdTransactOp[] = [
      {
        kind: 'replaceIfVersion',
        sk: sortKeys.plan(updated.planId),
        expectedVersion: version,
        attributes: planAttributes(updated, record.createdAt, stamp),
      },
    ];
    if (meal) {
      ops.push({ kind: 'create', sk: sortKeys.meal(meal.mealId), attributes: mealAttributes(meal, updated.planId, stamp) });
    }
    const written = await this.deps.repository.transact(ops);
    if (!written.ok) return saveFailure(written, true);

    const newVersion = version + 1;
    const event: MealPlanChangedEvent = {
      type: 'MealPlanChanged',
      householdId: this.householdId,
      planId: updated.planId,
      change,
      day,
      planVersion: newVersion,
      occurredAt: stamp,
      ...(meal ? { mealId: meal.mealId } : {}),
    };
    let eventPublished = true;
    try {
      await this.deps.events.publishMealPlanChanged(event);
    } catch {
      eventPublished = false;
    }
    return {
      ok: true,
      value: { plan: updated, meals: meal ? [meal] : [], version: newVersion, change, day, eventPublished },
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Resolves the requested plan length; weekly means 7 (3.1, 3.7, 3.8). */
export function resolveRange(request: Pick<GeneratePlanRequest, 'rangeDays' | 'weekly'>): PlanResult<number> {
  if (request.weekly !== undefined && typeof request.weekly !== 'boolean') {
    return planError('INVALID_REQUEST', 'weekly must be a boolean.');
  }
  if (request.weekly === true) {
    if (request.rangeDays !== undefined && request.rangeDays !== WEEKLY_PLAN_DAYS) {
      return planError('INVALID_REQUEST', 'A weekly plan covers exactly 7 days; omit rangeDays or set it to 7.');
    }
    return { ok: true, value: WEEKLY_PLAN_DAYS };
  }
  const n = request.rangeDays;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_PLAN_DAYS || n > MAX_PLAN_DAYS) {
    return planError('INVALID_RANGE', PLAN_ERROR_MESSAGES.invalidRange);
  }
  return { ok: true, value: n };
}

function validateGenerationOptions(request: { contextInput?: unknown; presets?: unknown }): PlanResult<GenerationOptions> {
  const { contextInput, presets } = request;
  if (contextInput !== undefined && contextInput !== null) {
    if (typeof contextInput !== 'string') return planError('INVALID_REQUEST', 'contextInput must be a string.');
    if (contextInput.length > MAX_CONTEXT_INPUT_LENGTH) {
      return planError('CONTEXT_TOO_LONG', `Context input must be at most ${MAX_CONTEXT_INPUT_LENGTH} characters.`);
    }
  }
  if (presets !== undefined && presets !== null && !Array.isArray(presets)) {
    return planError('INVALID_REQUEST', 'presets must be an array.');
  }
  const validated = validatePresets(presets as unknown[] | null | undefined);
  if (!validated.ok) return planError(validated.error.code, validated.error.message);
  return {
    ok: true,
    value: {
      presets: validated.presets,
      ...(typeof contextInput === 'string' && contextInput.length > 0 ? { contextInput } : {}),
    },
  };
}

function isWellFormedMeal(meal: AgentMeal): boolean {
  return meal.name.trim().length > 0 && meal.ingredients.length > 0 && meal.steps.length > 0;
}

/** Edits that lose an optimistic-concurrency check report PLAN_CONFLICT; all else is a save failure. */
function saveFailure(written: Extract<WriteResult, { ok: false }>, isEdit: boolean): { ok: false; error: PlanError } {
  if (isEdit && written.error.reason === 'condition_failed') {
    return planError('PLAN_CONFLICT', PLAN_ERROR_MESSAGES.planConflict);
  }
  return planError('SAVE_DID_NOT_COMPLETE', PLAN_ERROR_MESSAGES.saveDidNotComplete);
}

async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const winner = await Promise.race([promise, deadline]);
    if (winner === TIMED_OUT) promise.catch(() => undefined);
    return winner;
  } finally {
    clearTimeout(timer);
  }
}
