/**
 * Core domain types for Sous. Shapes follow the Data Models
 * section of design.md. Storage keys (PK/SK/GSI) are handled by the data
 * layer in src/data and are intentionally not part of these types.
 *
 * Timestamps and dates are ISO-8601 strings, matching how they are persisted
 * in DynamoDB.
 */

export type HouseholdId = string;
export type UserId = string;
export type InvitationId = string;
export type MealId = string;
export type PlanId = string;
export type SuggestionId = string;
export type SessionId = string;
export type ConversationId = string;
export type PreferenceId = string;

/** ISO-8601 timestamp, e.g. 2025-01-31T12:00:00.000Z */
export type IsoTimestamp = string;
/** ISO-8601 calendar date, e.g. 2025-01-31 */
export type IsoDate = string;

// ---------------------------------------------------------------------------
// Ingredients and grocery entries
// ---------------------------------------------------------------------------

/** An ingredient with a quantity and unit. See src/domain/units.ts. */
export interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

/** A consolidated grocery-list line. Same shape as an Ingredient. */
export interface GroceryEntry {
  name: string;
  quantity: number;
  unit: string;
}

// ---------------------------------------------------------------------------
// Users, Households, membership, invitations
// ---------------------------------------------------------------------------

/** Cognito-backed User mirror record. */
export interface User {
  userId: UserId;
  /** Login identifier (email), 1-254 chars. */
  identifier: string;
  createdAt: IsoTimestamp;
}

export interface Household {
  householdId: HouseholdId;
  name: string;
  ownerUserId: UserId;
  createdAt: IsoTimestamp;
  /** Long-term preference memory namespace. Always equal to householdId. */
  preferenceMemoryNamespace: HouseholdId;
}

export type MembershipRole = 'owner' | 'member';

export interface Membership {
  householdId: HouseholdId;
  userId: UserId;
  role: MembershipRole;
  joinedAt: IsoTimestamp;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

/** Invitee is identified by email address or user identifier. */
export type Invitee =
  | { kind: 'email'; email: string }
  | { kind: 'userId'; userId: UserId };

export interface Invitation {
  invitationId: InvitationId;
  householdId: HouseholdId;
  invitee: Invitee;
  status: InvitationStatus;
  createdAt: IsoTimestamp;
  /** createdAt + 7 days. */
  expiresAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Meals, plans, suggestions
// ---------------------------------------------------------------------------

export interface Meal {
  mealId: MealId;
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  /** Descriptive attributes (e.g. "vegetarian", "under-30-min"). */
  attributes: string[];
}

export interface MealPlanDay {
  day: IsoDate;
  mealId: MealId;
}

export interface MealPlan {
  planId: PlanId;
  householdId: HouseholdId;
  startDate: IsoDate;
  endDate: IsoDate;
  /** 1-31 inclusive. */
  rangeDays: number;
  days: MealPlanDay[];
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** The four named Presets (Requirement 5.1). */
export const PRESETS = ['healthy', 'quick', 'craving', 'fine dining'] as const;
export type Preset = (typeof PRESETS)[number];

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'string' && (PRESETS as readonly string[]).includes(value);
}

export interface MealSuggestion {
  suggestionId: SuggestionId;
  sessionId: SessionId;
  householdId: HouseholdId;
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  presetContext: Preset[];
  /** False when no Preference_Profile existed (Requirement 2.3). */
  preferenceApplied: boolean;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** Authoritative hard-constraint and explicit-feedback store (one per Household). */
export interface PreferenceProfile {
  householdId: HouseholdId;
  likes: string[];
  dislikes: string[];
  excludedIngredients: string[];
  /** Each non-empty and at most 200 chars, no duplicates. */
  dietaryConstraints: string[];
  acceptances: MealId[];
  updatedAt: IsoTimestamp;
}

export type FeedbackValue = 'like' | 'dislike';

export type PreferenceMemoryPolarity = 'like' | 'dislike' | 'favorite' | 'avoid-soft';

/**
 * Soft, free-form household preference extracted into AgentCore long-term
 * memory (optional DynamoDB mirror). Household-scoped: deliberately has no
 * userId attribute.
 */
export interface HouseholdPreferenceMemoryEntry {
  householdId: HouseholdId;
  preferenceId: PreferenceId;
  statement: string;
  polarity: PreferenceMemoryPolarity;
  sourceConversationId: ConversationId;
  extractedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Fridge, grocery list, conversation
// ---------------------------------------------------------------------------

export interface FridgeInventory {
  householdId: HouseholdId;
  items: Ingredient[];
  updatedAt: IsoTimestamp;
}

export interface GroceryList {
  householdId: HouseholdId;
  planId: PlanId;
  entries: GroceryEntry[];
  generatedAt: IsoTimestamp;
}

export type ConversationArtifactType = 'suggestion' | 'plan' | 'grocery_list';

export interface Conversation {
  conversationId: ConversationId;
  householdId: HouseholdId;
  /** Short-term memory session, `{householdId}:{conversationId}`. */
  memorySessionId: string;
  targetArtifactType: ConversationArtifactType;
  targetArtifactId: string;
  createdAt: IsoTimestamp;
}
