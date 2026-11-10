/**
 * Suggestion_Agent response types and runtime validation of the agent's JSON.
 *
 * The parser checks structure and types only. Business rules (1-3
 * suggestions, exclusion enforcement, distinctness, plan length) are applied
 * by the orchestration services, not trusted to the model.
 */

import type { GroceryEntry, Ingredient, IsoDate } from '../domain/types.js';
import type { AdHocPayload, AgentMode, AgentPayload, PlanPayload, RefinePayload } from './payload.js';

/** A Meal as returned by the agent, before the service assigns ids. */
export interface AgentMeal {
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  attributes: string[];
}

export interface AdHocAgentResponse {
  mode: 'ad_hoc';
  suggestions: AgentMeal[];
}

export interface PlanAgentResponse {
  mode: 'plan';
  /** One Meal per day, in day order starting at the plan's start date. */
  meals: AgentMeal[];
}

export type RefinedArtifact =
  | { type: 'suggestion'; meal: AgentMeal }
  | { type: 'plan'; day: IsoDate; meal: AgentMeal }
  | { type: 'grocery_list'; entries: GroceryEntry[] };

export type RefineAgentResponse =
  | { mode: 'refine'; outcome: 'updated'; artifact: RefinedArtifact }
  /** The request was ambiguous; the prior artifact must stay unchanged (9.5). */
  | { mode: 'refine'; outcome: 'clarification'; message: string };

export type AgentResponse = AdHocAgentResponse | PlanAgentResponse | RefineAgentResponse;

export type AgentResponseFor<P extends AgentPayload> = P extends AdHocPayload
  ? AdHocAgentResponse
  : P extends PlanPayload
    ? PlanAgentResponse
    : P extends RefinePayload
      ? RefineAgentResponse
      : never;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Validation helpers. Each throws InvalidShape with a path-qualified message.
// ---------------------------------------------------------------------------

class InvalidShape extends Error {}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InvalidShape(`${path} must be an object`);
  return v as Obj;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new InvalidShape(`${path} must be a non-empty string`);
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new InvalidShape(`${path} must be an array`);
  return v;
}

function strArr(v: unknown, path: string): string[] {
  return arr(v, path).map((s, i) => str(s, `${path}[${i}]`));
}

function quantity(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new InvalidShape(`${path} must be a finite, non-negative number`);
  }
  return v;
}

function ingredient(v: unknown, path: string): Ingredient {
  const o = obj(v, path);
  return { name: str(o.name, `${path}.name`), quantity: quantity(o.quantity, `${path}.quantity`), unit: str(o.unit, `${path}.unit`) };
}

function meal(v: unknown, path: string): AgentMeal {
  const o = obj(v, path);
  return {
    name: str(o.name, `${path}.name`),
    ingredients: arr(o.ingredients, `${path}.ingredients`).map((x, i) => ingredient(x, `${path}.ingredients[${i}]`)),
    steps: strArr(o.steps, `${path}.steps`),
    attributes: o.attributes === undefined ? [] : strArr(o.attributes, `${path}.attributes`),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(v: unknown, path: string): IsoDate {
  const s = str(v, path);
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new InvalidShape(`${path} must be an ISO-8601 date (YYYY-MM-DD)`);
  }
  return s;
}

function artifact(v: unknown, path: string): RefinedArtifact {
  const o = obj(v, path);
  switch (o.type) {
    case 'suggestion':
      return { type: 'suggestion', meal: meal(o.meal, `${path}.meal`) };
    case 'plan':
      return { type: 'plan', day: isoDate(o.day, `${path}.day`), meal: meal(o.meal, `${path}.meal`) };
    case 'grocery_list':
      return {
        type: 'grocery_list',
        entries: arr(o.entries, `${path}.entries`).map((x, i) => ingredient(x, `${path}.entries[${i}]`)),
      };
    default:
      throw new InvalidShape(`${path}.type must be one of suggestion, plan, grocery_list`);
  }
}

function validate(mode: AgentMode, v: unknown): AgentResponse {
  const o = obj(v, 'response');
  if (o.mode !== mode) throw new InvalidShape(`response.mode must be "${mode}"`);
  switch (mode) {
    case 'ad_hoc':
      return { mode, suggestions: arr(o.suggestions, 'response.suggestions').map((x, i) => meal(x, `response.suggestions[${i}]`)) };
    case 'plan':
      return { mode, meals: arr(o.meals, 'response.meals').map((x, i) => meal(x, `response.meals[${i}]`)) };
    case 'refine':
      if (o.outcome === 'clarification') return { mode, outcome: 'clarification', message: str(o.message, 'response.message') };
      if (o.outcome === 'updated') return { mode, outcome: 'updated', artifact: artifact(o.artifact, 'response.artifact') };
      throw new InvalidShape('response.outcome must be "updated" or "clarification"');
  }
}

/** Validate an already-decoded JSON value against the response shape for `mode`. */
export function parseAgentResponseValue<M extends AgentMode>(
  mode: M,
  value: unknown,
): ParseResult<Extract<AgentResponse, { mode: M }>> {
  try {
    return { ok: true, value: validate(mode, value) as Extract<AgentResponse, { mode: M }> };
  } catch (err) {
    if (err instanceof InvalidShape) return { ok: false, message: err.message };
    throw err;
  }
}

/** Decode and validate the agent's raw JSON text for `mode`. */
export function parseAgentResponse<M extends AgentMode>(
  mode: M,
  text: string,
): ParseResult<Extract<AgentResponse, { mode: M }>> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: 'response is not valid JSON' };
  }
  return parseAgentResponseValue(mode, value);
}
