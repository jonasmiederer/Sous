/**
 * Thin API Gateway handlers for the Plan Service.
 *
 *   POST   /plans                  { rangeDays } | { weekly: true }, optional startDate, contextInput, presets
 *   PUT    /plans/{id}/days/{day}  { meal? , contextInput?, presets? }  replace one day's Meal
 *   POST   /plans/{id}/days        { day, meal?, contextInput?, presets? } add a Meal on a day
 *   DELETE /plans/{id}/days/{day}                                         remove a day's Meal
 *   DELETE /plans/{id}                                                    delete the plan and its grocery list
 *   GET    /plans                                                         newest 20 plan summaries
 *   GET    /plans/{id}                                                    { plan, meals, version }
 *
 * Each handler receives a request whose Active_Household scope was already
 * resolved and membership-verified by the authorizer (task 15.1). The
 * handlers only parse the body, call the household-bound PlanService, and map
 * results to HTTP responses. Error bodies carry a code and message only.
 */
import { randomUUID } from 'node:crypto';

import type { MemoryClient } from '../../agent/memoryClient.js';
import type { SuggestionAgentClient } from '../../agent/runtimeClient.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { TableClient } from '../../data/tableClient.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { PlanError, PlanErrorCode, PlanResult } from './errors.js';
import type { PlanEventPublisher } from './events.js';
import { PlanService, type Clock, type IdGenerator, type PlanEditResult } from './planService.js';

export interface AuthorizedPlanRequest {
  /** Already-authorized Active_Household scope. */
  scope: ActiveHouseholdScope;
  pathParameters?: Record<string, string | undefined> | null;
  body?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export type PlanServiceFor = (scope: ActiveHouseholdScope) => PlanService;

export const PLAN_ERROR_STATUS: Readonly<Record<PlanErrorCode, number>> = {
  INVALID_RANGE: 400,
  INVALID_REQUEST: 400,
  CONTEXT_TOO_LONG: 400,
  UNRECOGNIZED_PRESET: 400,
  PRESET_CONFLICT: 400,
  PROFILE_REQUIRED: 422,
  MEAL_EXCLUDED: 422,
  PLAN_NOT_FOUND: 404,
  DAY_NOT_FOUND: 404,
  DAY_ALREADY_ASSIGNED: 409,
  PLAN_CONFLICT: 409,
  GENERATION_FAILED: 503,
  GENERATION_TIMEOUT: 504,
  SAVE_DID_NOT_COMPLETE: 503,
};

const JSON_HEADERS = { 'content-type': 'application/json' };

function respond(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function errorResponse(error: PlanError): HttpResponse {
  return respond(PLAN_ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
}

function parseBody(body: string | null | undefined): PlanResult<Record<string, unknown>> {
  if (body === undefined || body === null || body.trim() === '') return { ok: true, value: {} };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Request body must be valid JSON.' } };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Request body must be a JSON object.' } };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function editBody(result: PlanEditResult): unknown {
  return {
    plan: result.plan,
    meal: result.meals[0],
    change: result.change,
    day: result.day,
    version: result.version,
    eventPublished: result.eventPublished,
  };
}

async function guarded(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch {
    return respond(500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  }
}

export function createPlanHandlers(serviceFor: PlanServiceFor) {
  return {
    generatePlan: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body.ok) return errorResponse(body.error);
        const result = await serviceFor(req.scope).generatePlan(body.value);
        if (!result.ok) return errorResponse(result.error);
        return respond(201, { plan: result.value.plan, meals: result.value.meals, version: result.value.version });
      }),

    replaceDay: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body.ok) return errorResponse(body.error);
        const result = await serviceFor(req.scope).replaceDay(req.pathParameters?.id, req.pathParameters?.day, body.value);
        return result.ok ? respond(200, editBody(result.value)) : errorResponse(result.error);
      }),

    addDay: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const body = parseBody(req.body);
        if (!body.ok) return errorResponse(body.error);
        const result = await serviceFor(req.scope).addDay(req.pathParameters?.id, body.value);
        return result.ok ? respond(201, editBody(result.value)) : errorResponse(result.error);
      }),

    removeDay: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).removeDay(req.pathParameters?.id, req.pathParameters?.day);
        return result.ok ? respond(200, editBody(result.value)) : errorResponse(result.error);
      }),

    deletePlan: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).deletePlan(req.pathParameters?.id);
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    listPlans: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).listPlans();
        return result.ok ? respond(200, result.value) : errorResponse(result.error);
      }),

    getPlan: (req: AuthorizedPlanRequest): Promise<HttpResponse> =>
      guarded(async () => {
        const result = await serviceFor(req.scope).getPlan(req.pathParameters?.id);
        if (!result.ok) return errorResponse(result.error);
        return respond(200, { plan: result.value.plan, meals: result.value.meals, version: result.value.version });
      }),
  };
}

export interface PlanServiceFactoryConfig {
  tableClient: TableClient;
  agent: SuggestionAgentClient;
  events: PlanEventPublisher;
  memory?: MemoryClient;
  clock?: Clock;
  ids?: IdGenerator;
}

/** Builds a PlanService bound to the request's Active_Household partition. */
export function planServiceFactory(config: PlanServiceFactoryConfig): PlanServiceFor {
  const clock = config.clock ?? { now: () => new Date() };
  const ids = config.ids ?? { next: () => randomUUID() };
  return (scope) =>
    new PlanService({
      repository: new HouseholdRepository(config.tableClient, scope.householdId),
      agent: config.agent,
      events: config.events,
      clock,
      ids,
      ...(config.memory ? { memory: config.memory } : {}),
    });
}
