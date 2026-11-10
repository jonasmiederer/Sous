/**
 * Validates incoming `POST /invocations` payloads (Requirement 12.3,
 * Property 37). Accepts exactly the shapes built by `src/agent/payload.ts`
 * (`AdHocPayload`, `PlanPayload`, `RefinePayload`) plus the optional
 * `householdPreferenceMemory` field on any mode. Unknown extra fields are
 * ignored and dropped from the returned request.
 *
 * Pure: no I/O. A failure must be answered with `400` before the model or
 * memory is touched.
 */

import type {
  AdHocPayload,
  AgentArtifactMeal,
  AgentConversationTurn,
  AgentPreferenceProfile,
  PlanPayload,
  RefineCurrentArtifact,
  RefinePayload,
} from '../../src/agent/payload.js';
import { InvalidMemoryIdError, validateConversationId, validateHouseholdId } from '../../src/agent/memoryNamespaces.js';
import { validatePresets } from '../../src/domain/presets.js';
import type { ConversationArtifactType, Ingredient } from '../../src/domain/types.js';

/** Maximum Context_Input length in code points (same as the calling services). */
export const MAX_CONTEXT_INPUT_LENGTH = 500;
export const MIN_RANGE_DAYS = 1;
export const MAX_RANGE_DAYS = 31;

/** A Soft_Preference supplied by the caller (Suggestion Service prefetch). */
export interface SoftPreferenceEntry {
  statement: string;
  polarity?: string;
}

interface WithSoftPreferences {
  householdPreferenceMemory?: SoftPreferenceEntry[];
}

export type AdHocRequest = AdHocPayload & WithSoftPreferences;
export type PlanRequest = PlanPayload & WithSoftPreferences;
export type RefineRequest = RefinePayload & WithSoftPreferences;
export type AgentRequest = AdHocRequest | PlanRequest | RefineRequest;

export type ParseResult = { ok: true; request: AgentRequest } | { ok: false; message: string };

const ARTIFACT_TYPES: readonly ConversationArtifactType[] = ['suggestion', 'plan', 'grocery_list'];

class RequestError extends Error {}

function fail(message: string): never {
  throw new RequestError(message);
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Obj {
  if (!isObject(value)) fail(`${path} must be an object.`);
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string.`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((v, i) => string(v, `${path}[${i}]`));
}

function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

function contextInput(value: unknown, path: string): string {
  const s = string(value, path);
  if (codePointLength(s) > MAX_CONTEXT_INPUT_LENGTH) {
    fail(`${path} must be at most ${MAX_CONTEXT_INPUT_LENGTH} characters.`);
  }
  return s;
}

function ingredient(value: unknown, path: string): Ingredient {
  const o = object(value, path);
  const quantity = o.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    fail(`${path}.quantity must be a non-negative number.`);
  }
  return { name: string(o.name, `${path}.name`), quantity, unit: string(o.unit, `${path}.unit`) };
}

function ingredients(value: unknown, path: string): Ingredient[] {
  return array(value, path).map((v, i) => ingredient(v, `${path}[${i}]`));
}

function preferenceProfile(value: unknown): AgentPreferenceProfile | null {
  if (value === null) return null;
  const o = object(value, 'preferenceProfile');
  return {
    likes: stringArray(o.likes, 'preferenceProfile.likes'),
    dislikes: stringArray(o.dislikes, 'preferenceProfile.dislikes'),
    excludedIngredients: stringArray(o.excludedIngredients, 'preferenceProfile.excludedIngredients'),
    dietaryConstraints: stringArray(o.dietaryConstraints, 'preferenceProfile.dietaryConstraints'),
  };
}

function softPreferences(value: unknown): SoftPreferenceEntry[] {
  return array(value, 'householdPreferenceMemory').map((v, i) => {
    const path = `householdPreferenceMemory[${i}]`;
    const o = object(v, path);
    const entry: SoftPreferenceEntry = { statement: string(o.statement, `${path}.statement`) };
    if (o.polarity !== undefined) entry.polarity = string(o.polarity, `${path}.polarity`);
    return entry;
  });
}

function meal(value: unknown, path: string): AgentArtifactMeal {
  const o = object(value, path);
  return {
    name: string(o.name, `${path}.name`),
    ingredients: ingredients(o.ingredients, `${path}.ingredients`),
    steps: stringArray(o.steps, `${path}.steps`),
    attributes: stringArray(o.attributes, `${path}.attributes`),
  };
}

function currentArtifact(value: unknown): RefineCurrentArtifact {
  const o = object(value, 'currentArtifact');
  switch (o.type) {
    case 'suggestion':
      return { type: 'suggestion', meal: meal(o.meal, 'currentArtifact.meal') };
    case 'plan':
      return {
        type: 'plan',
        days: array(o.days, 'currentArtifact.days').map((d, i) => {
          const path = `currentArtifact.days[${i}]`;
          const day = object(d, path);
          return { day: string(day.day, `${path}.day`), meal: meal(day.meal, `${path}.meal`) };
        }),
      };
    case 'grocery_list':
      return { type: 'grocery_list', entries: ingredients(o.entries, 'currentArtifact.entries') };
    default:
      return fail(`currentArtifact.type must be one of ${ARTIFACT_TYPES.join(', ')}.`);
  }
}

function priorTurns(value: unknown): AgentConversationTurn[] {
  return array(value, 'priorTurns').map((v, i) => {
    const path = `priorTurns[${i}]`;
    const o = object(v, path);
    if (o.role !== 'user' && o.role !== 'assistant') fail(`${path}.role must be 'user' or 'assistant'.`);
    return { role: o.role, text: string(o.text, `${path}.text`), timestamp: string(o.timestamp, `${path}.timestamp`) };
  });
}

function parse(value: unknown): AgentRequest {
  const o = object(value, 'request');
  const mode = o.mode;
  if (mode !== 'ad_hoc' && mode !== 'plan' && mode !== 'refine') {
    fail("mode must be one of 'ad_hoc', 'plan', 'refine'.");
  }

  const householdId = validateHouseholdId(o.householdId);
  if (o.preferenceMemoryNamespace !== householdId) fail('preferenceMemoryNamespace must equal householdId.');

  const presetsResult = validatePresets(array(o.presets, 'presets'));
  if (!presetsResult.ok) fail(presetsResult.error.message);

  const base = {
    householdId,
    preferenceProfile: preferenceProfile(o.preferenceProfile),
    fridgeInventory: ingredients(o.fridgeInventory, 'fridgeInventory'),
    presets: presetsResult.presets,
    preferenceMemoryNamespace: householdId,
  };
  const soft: WithSoftPreferences =
    o.householdPreferenceMemory === undefined ? {} : { householdPreferenceMemory: softPreferences(o.householdPreferenceMemory) };

  switch (mode) {
    case 'ad_hoc': {
      const request: AdHocRequest = {
        ...base,
        mode,
        rejectedSuggestionNames: stringArray(o.rejectedSuggestionNames, 'rejectedSuggestionNames'),
        ...soft,
      };
      if (o.contextInput !== undefined) request.contextInput = contextInput(o.contextInput, 'contextInput');
      return request;
    }
    case 'plan': {
      const rangeDays = o.rangeDays;
      if (typeof rangeDays !== 'number' || !Number.isInteger(rangeDays) || rangeDays < MIN_RANGE_DAYS || rangeDays > MAX_RANGE_DAYS) {
        fail(`rangeDays must be an integer from ${MIN_RANGE_DAYS} to ${MAX_RANGE_DAYS}.`);
      }
      const request: PlanRequest = { ...base, mode, rangeDays, ...soft };
      if (o.contextInput !== undefined) request.contextInput = contextInput(o.contextInput, 'contextInput');
      return request;
    }
    case 'refine': {
      const target = o.targetArtifactType;
      if (!ARTIFACT_TYPES.includes(target as ConversationArtifactType)) {
        fail(`targetArtifactType must be one of ${ARTIFACT_TYPES.join(', ')}.`);
      }
      const targetArtifactType = target as ConversationArtifactType;
      const request: RefineRequest = {
        ...base,
        mode,
        conversationId: validateConversationId(o.conversationId),
        contextInput: contextInput(o.contextInput, 'contextInput'),
        targetArtifactType,
        ...soft,
      };
      if (o.priorTurns !== undefined) request.priorTurns = priorTurns(o.priorTurns);
      if (o.currentArtifact !== undefined) {
        const artifact = currentArtifact(o.currentArtifact);
        if (artifact.type !== targetArtifactType) fail('currentArtifact.type must equal targetArtifactType.');
        request.currentArtifact = artifact;
      }
      return request;
    }
  }
}

/** Validate an already JSON-decoded request body. */
export function parseAgentRequest(value: unknown): ParseResult {
  try {
    return { ok: true, request: parse(value) };
  } catch (err) {
    if (err instanceof RequestError || err instanceof InvalidMemoryIdError) return { ok: false, message: err.message };
    throw err;
  }
}
