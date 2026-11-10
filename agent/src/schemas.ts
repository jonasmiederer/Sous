/**
 * JSON Schemas of the Agent_Response_Contract, one per mode (design.md,
 * "Structured output, validation, and repair"; Requirement 12.1).
 *
 * The schemas mirror `src/agent/responses.ts` and are deliberately stricter
 * than it (units are limited to CANONICAL_UNITS, arrays are bounded, Meals
 * need at least one ingredient and step), so every schema-valid document
 * also parses with `parseAgentResponseValue`. The schema only guides the
 * model: the parser and the contract checks decide what is valid.
 *
 * Pure data, no I/O.
 */

import type { AgentMode } from '../../src/agent/payload.js';
import { CANONICAL_UNITS } from '../../src/domain/units.js';

/** Name of the single tool the model must call to answer. */
export const SUBMIT_TOOL_NAME = 'submit_response';

/** Upper bounds that keep model output short (prompts state the same limits). */
export const SCHEMA_LIMITS = {
  maxSuggestions: 3,
  maxPlanDays: 31,
  maxIngredientsPerMeal: 12,
  maxStepsPerMeal: 8,
  maxAttributesPerMeal: 8,
  maxGroceryEntries: 200,
  maxNameLength: 120,
  maxStepLength: 400,
  maxAttributeLength: 60,
  maxMessageLength: 1000,
} as const;

/** A JSON Schema document (draft 2020-12 subset accepted by Bedrock tool specs). */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Non-empty after trimming, matching the parser's `str` check. */
function text(maxLength: number): JsonSchema {
  return { type: 'string', minLength: 1, maxLength, pattern: '\\S' };
}

const INGREDIENT: JsonSchema = {
  type: 'object',
  properties: {
    name: text(SCHEMA_LIMITS.maxNameLength),
    quantity: { type: 'number', minimum: 0 },
    unit: { type: 'string', enum: [...CANONICAL_UNITS] },
  },
  required: ['name', 'quantity', 'unit'],
  additionalProperties: false,
};

const MEAL: JsonSchema = {
  type: 'object',
  properties: {
    name: text(SCHEMA_LIMITS.maxNameLength),
    ingredients: { type: 'array', items: INGREDIENT, minItems: 1, maxItems: SCHEMA_LIMITS.maxIngredientsPerMeal },
    steps: { type: 'array', items: text(SCHEMA_LIMITS.maxStepLength), minItems: 1, maxItems: SCHEMA_LIMITS.maxStepsPerMeal },
    attributes: { type: 'array', items: text(SCHEMA_LIMITS.maxAttributeLength), maxItems: SCHEMA_LIMITS.maxAttributesPerMeal },
  },
  required: ['name', 'ingredients', 'steps', 'attributes'],
  additionalProperties: false,
};

const ISO_DATE: JsonSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

export interface AdHocSchemaOptions {
  /** Maximum number of suggestions, 1–3 (default 3). */
  maxSuggestions?: number;
}

export interface PlanSchemaOptions {
  /** Exact number of Meals this call must return, 1–31 (a plan chunk's day count). */
  dayCount?: number;
}

export function adHocResponseSchema(options: AdHocSchemaOptions = {}): JsonSchema {
  const max = clamp(options.maxSuggestions ?? SCHEMA_LIMITS.maxSuggestions, 1, SCHEMA_LIMITS.maxSuggestions);
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', const: 'ad_hoc' },
      suggestions: { type: 'array', items: MEAL, minItems: 1, maxItems: max },
    },
    required: ['mode', 'suggestions'],
    additionalProperties: false,
  };
}

export function planResponseSchema(options: PlanSchemaOptions = {}): JsonSchema {
  const meals: Record<string, unknown> = { type: 'array', items: MEAL, minItems: 1, maxItems: SCHEMA_LIMITS.maxPlanDays };
  if (options.dayCount !== undefined) {
    const n = clamp(options.dayCount, 1, SCHEMA_LIMITS.maxPlanDays);
    meals.minItems = n;
    meals.maxItems = n;
  }
  return {
    type: 'object',
    properties: { mode: { type: 'string', const: 'plan' }, meals },
    required: ['mode', 'meals'],
    additionalProperties: false,
  };
}

const REFINED_ARTIFACT: JsonSchema = {
  anyOf: [
    {
      type: 'object',
      properties: { type: { type: 'string', const: 'suggestion' }, meal: MEAL },
      required: ['type', 'meal'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { type: { type: 'string', const: 'plan' }, day: ISO_DATE, meal: MEAL },
      required: ['type', 'day', 'meal'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'grocery_list' },
        entries: { type: 'array', items: INGREDIENT, maxItems: SCHEMA_LIMITS.maxGroceryEntries },
      },
      required: ['type', 'entries'],
      additionalProperties: false,
    },
  ],
};

/**
 * Refine output is `updated` (with `artifact`) or `clarification` (with
 * `message`). Tool input schemas must have an object at the top level, so the
 * two outcomes are expressed with `if`/`then` rather than a top-level union;
 * the parser enforces the same rule regardless.
 */
export function refineResponseSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      mode: { type: 'string', const: 'refine' },
      outcome: { type: 'string', enum: ['updated', 'clarification'] },
      artifact: REFINED_ARTIFACT,
      message: text(SCHEMA_LIMITS.maxMessageLength),
    },
    required: ['mode', 'outcome'],
    additionalProperties: false,
    allOf: [
      { if: { properties: { outcome: { const: 'updated' } } }, then: { required: ['artifact'] } },
      { if: { properties: { outcome: { const: 'clarification' } } }, then: { required: ['message'] } },
    ],
  };
}

export interface ResponseSchemaOptions extends AdHocSchemaOptions, PlanSchemaOptions {}

/** The response schema for `mode`, used as the `submit_response` tool input schema. */
export function responseSchema(mode: AgentMode, options: ResponseSchemaOptions = {}): JsonSchema {
  switch (mode) {
    case 'ad_hoc':
      return adHocResponseSchema(options);
    case 'plan':
      return planResponseSchema(options);
    case 'refine':
      return refineResponseSchema();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new RangeError(`expected an integer, got ${value}`);
  return Math.min(Math.max(value, min), max);
}
