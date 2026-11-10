/**
 * Suggestion_Agent invocation payload assembly (design.md, "Suggestion_Agent
 * interface"). Pure functions only: no I/O, no clock, no randomness.
 *
 * - The Preference_Profile snapshot is deep-copied so later mutation of the
 *   caller's profile cannot change what was sent (Requirement 6.4, Property 19).
 * - `preferenceMemoryNamespace` is always set from `householdId` and cannot be
 *   supplied by the caller (Property 34).
 */

import type {
  ConversationArtifactType,
  ConversationId,
  HouseholdId,
  Ingredient,
  PreferenceProfile,
  Preset,
} from '../domain/types.js';

export type AgentMode = 'ad_hoc' | 'plan' | 'refine';

/** The subset of the Preference_Profile the agent receives (design payload). */
export interface AgentPreferenceProfile {
  likes: string[];
  dislikes: string[];
  excludedIngredients: string[];
  dietaryConstraints: string[];
}

interface BasePayload {
  householdId: HouseholdId;
  /** `null` when the Household has no Preference_Profile (Requirement 2.3). */
  preferenceProfile: AgentPreferenceProfile | null;
  fridgeInventory: Ingredient[];
  presets: Preset[];
  /** Always equal to householdId (long-term household preference memory). */
  preferenceMemoryNamespace: HouseholdId;
}

export interface AdHocPayload extends BasePayload {
  mode: 'ad_hoc';
  contextInput?: string;
  rejectedSuggestionNames: string[];
}

export interface PlanPayload extends BasePayload {
  mode: 'plan';
  contextInput?: string;
  rangeDays: number;
}

/** One prior Conversation turn as sent to the agent (Requirement 9.3, Property 27). */
export interface AgentConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

/** A Meal as shown to the agent for refinement. */
export interface AgentArtifactMeal {
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  attributes: string[];
}

/** The artifact being refined, as it is currently stored. */
export type RefineCurrentArtifact =
  | { type: 'suggestion'; meal: AgentArtifactMeal }
  | { type: 'plan'; days: Array<{ day: string; meal: AgentArtifactMeal }> }
  | { type: 'grocery_list'; entries: Ingredient[] };

export interface RefinePayload extends BasePayload {
  mode: 'refine';
  conversationId: ConversationId;
  /** The refinement request, e.g. "make it vegetarian". */
  contextInput: string;
  targetArtifactType: ConversationArtifactType;
  /** All prior turns of the Conversation, oldest first. Omitted when not supplied. */
  priorTurns?: AgentConversationTurn[];
  /** The artifact being refined. Omitted when not supplied. */
  currentArtifact?: RefineCurrentArtifact;
}

export type AgentPayload = AdHocPayload | PlanPayload | RefinePayload;

// ---------------------------------------------------------------------------
// Builder inputs
// ---------------------------------------------------------------------------

interface BaseInput {
  householdId: HouseholdId;
  preferenceProfile: PreferenceProfile | null | undefined;
  fridgeInventory?: readonly Ingredient[] | null;
  presets?: readonly Preset[] | null;
}

export interface AdHocPayloadInput extends BaseInput {
  contextInput?: string | null;
  rejectedSuggestionNames?: readonly string[] | null;
}

export interface PlanPayloadInput extends BaseInput {
  contextInput?: string | null;
  rangeDays: number;
}

export interface RefinePayloadInput extends BaseInput {
  conversationId: ConversationId;
  contextInput: string;
  targetArtifactType: ConversationArtifactType;
  priorTurns?: readonly AgentConversationTurn[] | null;
  currentArtifact?: RefineCurrentArtifact | null;
}

/** Deep copy of the agent-facing fields of a stored Preference_Profile. */
export function snapshotPreferenceProfile(
  profile: PreferenceProfile | null | undefined,
): AgentPreferenceProfile | null {
  if (!profile) return null;
  return {
    likes: [...profile.likes],
    dislikes: [...profile.dislikes],
    excludedIngredients: [...profile.excludedIngredients],
    dietaryConstraints: [...profile.dietaryConstraints],
  };
}

function base(input: BaseInput): BasePayload {
  return {
    householdId: input.householdId,
    preferenceProfile: snapshotPreferenceProfile(input.preferenceProfile),
    fridgeInventory: (input.fridgeInventory ?? []).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    presets: [...(input.presets ?? [])],
    preferenceMemoryNamespace: input.householdId,
  };
}

export function buildAdHocPayload(input: AdHocPayloadInput): AdHocPayload {
  const payload: AdHocPayload = {
    ...base(input),
    mode: 'ad_hoc',
    rejectedSuggestionNames: [...(input.rejectedSuggestionNames ?? [])],
  };
  if (input.contextInput != null) payload.contextInput = input.contextInput;
  return payload;
}

export function buildPlanPayload(input: PlanPayloadInput): PlanPayload {
  const payload: PlanPayload = { ...base(input), mode: 'plan', rangeDays: input.rangeDays };
  if (input.contextInput != null) payload.contextInput = input.contextInput;
  return payload;
}

function copyIngredients(items: readonly Ingredient[]): Ingredient[] {
  return items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }));
}

function copyMeal(meal: AgentArtifactMeal): AgentArtifactMeal {
  return {
    name: meal.name,
    ingredients: copyIngredients(meal.ingredients),
    steps: [...meal.steps],
    attributes: [...meal.attributes],
  };
}

function copyArtifact(artifact: RefineCurrentArtifact): RefineCurrentArtifact {
  switch (artifact.type) {
    case 'suggestion':
      return { type: 'suggestion', meal: copyMeal(artifact.meal) };
    case 'plan':
      return { type: 'plan', days: artifact.days.map((d) => ({ day: d.day, meal: copyMeal(d.meal) })) };
    case 'grocery_list':
      return { type: 'grocery_list', entries: copyIngredients(artifact.entries) };
  }
}

export function buildRefinePayload(input: RefinePayloadInput): RefinePayload {
  const payload: RefinePayload = {
    ...base(input),
    mode: 'refine',
    conversationId: input.conversationId,
    contextInput: input.contextInput,
    targetArtifactType: input.targetArtifactType,
  };
  if (input.priorTurns != null) {
    payload.priorTurns = input.priorTurns.map((t) => ({ role: t.role, text: t.text, timestamp: t.timestamp }));
  }
  if (input.currentArtifact != null) payload.currentArtifact = copyArtifact(input.currentArtifact);
  return payload;
}

/** UTF-8 JSON bytes for the InvokeAgentRuntime `payload` field. */
export function encodePayload(payload: AgentPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}
