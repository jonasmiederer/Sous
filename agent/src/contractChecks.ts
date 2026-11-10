/**
 * Mode-specific checks applied after `parseAgentResponseValue`
 * (design.md, "Generation pipeline"; Requirements 12.4–12.6, 12.12).
 *
 * Pure functions. A failed check returns a validator message that the
 * generation pipeline sends back to the model in its single repair call.
 *
 * - Ad hoc: Meals are filtered, not rejected. Rejected names (trimmed,
 *   case-insensitive), Meals violating a hard exclusion (the same matcher as
 *   `src/domain/exclusions.ts`), and duplicate names are dropped, and the
 *   result is truncated to 3. An empty result is nonconforming.
 * - Plan chunk: exactly the chunk's day count and no excluded Meal.
 * - Refine: `updated` must target the request's artifact type, a plan day
 *   must exist in `currentArtifact`, and an updated Meal must not violate a
 *   hard exclusion.
 */

import type {
  AdHocAgentResponse,
  AgentMeal,
  PlanAgentResponse,
  RefineAgentResponse,
} from '../../src/agent/responses.js';
import { buildExclusionRules, findViolations, type ExclusionRule } from '../../src/domain/exclusions.js';
import type { AdHocRequest, AgentRequest, RefineRequest } from './requestParser.js';

export const MAX_AD_HOC_SUGGESTIONS = 3;

export type CheckResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Trimmed, lower-cased name used for rejected-name and duplicate matching. */
export function normalizeMealName(name: string): string {
  return name.trim().toLowerCase();
}

function exclusionRules(request: AgentRequest): ExclusionRule[] {
  return buildExclusionRules(request.preferenceProfile);
}

/** A validator message for the first excluded Meal, or undefined. */
function exclusionMessage(
  meals: readonly AgentMeal[],
  rules: readonly ExclusionRule[],
  pathFor: (index: number) => string,
): string | undefined {
  for (const [i, meal] of meals.entries()) {
    const violation = findViolations(meal, rules)[0];
    if (violation !== undefined) {
      return `${pathFor(i)} ("${meal.name}") uses "${violation.matchedValue}", which is excluded by "${violation.origin}" in avoid`;
    }
  }
  return undefined;
}

/** Ad hoc filtering (12.5, 12.6). Order of the remaining Meals is preserved. */
export function filterAdHocSuggestions(suggestions: readonly AgentMeal[], request: AdHocRequest): AgentMeal[] {
  const rejected = new Set(request.rejectedSuggestionNames.map(normalizeMealName));
  const rules = exclusionRules(request);
  const seen = new Set<string>();
  const kept: AgentMeal[] = [];
  for (const meal of suggestions) {
    const name = normalizeMealName(meal.name);
    if (rejected.has(name) || seen.has(name)) continue;
    if (findViolations(meal, rules).length > 0) continue;
    seen.add(name);
    kept.push(meal);
    if (kept.length === MAX_AD_HOC_SUGGESTIONS) break;
  }
  return kept;
}

export function checkAdHocResponse(response: AdHocAgentResponse, request: AdHocRequest): CheckResult<AdHocAgentResponse> {
  const suggestions = filterAdHocSuggestions(response.suggestions, request);
  if (suggestions.length === 0) {
    return {
      ok: false,
      message:
        'response.suggestions has no usable Meal: every suggestion was empty, a duplicate, matched a name in rejectedNames, or used an item in avoid',
    };
  }
  return { ok: true, value: { mode: 'ad_hoc', suggestions } };
}

export function checkPlanChunk(
  response: PlanAgentResponse,
  dayCount: number,
  request: AgentRequest,
): CheckResult<PlanAgentResponse> {
  if (response.meals.length !== dayCount) {
    return { ok: false, message: `response.meals must contain exactly ${dayCount} items, got ${response.meals.length}` };
  }
  const excluded = exclusionMessage(response.meals, exclusionRules(request), (i) => `response.meals[${i}]`);
  if (excluded !== undefined) return { ok: false, message: excluded };
  const seen = new Set<string>();
  for (const [i, meal] of response.meals.entries()) {
    const name = normalizeMealName(meal.name);
    if (seen.has(name)) return { ok: false, message: `response.meals[${i}] ("${meal.name}") repeats a dish; every day needs a different Meal` };
    seen.add(name);
  }
  return { ok: true, value: response };
}

export function checkRefineResponse(response: RefineAgentResponse, request: RefineRequest): CheckResult<RefineAgentResponse> {
  if (response.outcome === 'clarification') return { ok: true, value: response };
  const { artifact } = response;
  if (artifact.type !== request.targetArtifactType) {
    return { ok: false, message: `response.artifact.type must be "${request.targetArtifactType}", got "${artifact.type}"` };
  }
  if (artifact.type === 'plan' && request.currentArtifact?.type === 'plan') {
    const days = request.currentArtifact.days.map((d) => d.day);
    if (!days.includes(artifact.day)) {
      return { ok: false, message: `response.artifact.day must be one of ${days.join(', ')}, got ${artifact.day}` };
    }
  }
  if (artifact.type === 'suggestion' || artifact.type === 'plan') {
    const excluded = exclusionMessage([artifact.meal], exclusionRules(request), () => 'response.artifact.meal');
    if (excluded !== undefined) return { ok: false, message: excluded };
  }
  return { ok: true, value: response };
}
