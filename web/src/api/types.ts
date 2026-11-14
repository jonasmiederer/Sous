/**
 * Wire types for the Sous HTTP API, taken from the backend handlers and
 * service result types:
 *
 *   src/services/auth/{handlers,loginService,membershipService}.ts
 *   src/services/suggestions/{handler,suggestionService,errors}.ts
 *   src/services/plans/{handlers,planService}.ts
 *   src/services/grocery/handlers.ts
 *   src/services/preferences/{handlers,preferenceService}.ts
 *   src/services/fridge/{handlers,fridgeService}.ts
 *   src/services/conversations/{handlers,service,artifacts}.ts
 *   src/services/voice/{handlers,service,targets}.ts
 *
 * Domain shapes are imported type-only from the shared `src/domain/types.ts`,
 * so nothing from the backend is bundled.
 */
import type {
  ConversationArtifactType,
  FeedbackValue,
  FridgeInventory,
  GroceryList,
  Household,
  Ingredient,
  Invitation,
  IsoDate,
  Meal,
  MealPlan,
  MealSuggestion,
  Membership,
  MembershipRole,
  PreferenceProfile,
  Preset,
} from '@sous/domain/types';

export type {
  ConversationArtifactType,
  FeedbackValue,
  FridgeInventory,
  GroceryEntry,
  GroceryList,
  Household,
  Ingredient,
  Invitation,
  Invitee,
  IsoDate,
  IsoTimestamp,
  Meal,
  MealPlan,
  MealPlanDay,
  MealSuggestion,
  Membership,
  MembershipRole,
  PreferenceProfile,
  Preset,
} from '@sous/domain/types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Every error body is `{ error: { code, message, ... } }`. Extra fields depend on the service. */
export interface WireError {
  code: string;
  message?: string;
  /** Suggestions: NoSuggestionReason. Preferences: 'empty' | 'too_long' | 'duplicate'. */
  reason?: string;
  /** Suggestions: echoed request session on generation failures. */
  sessionId?: string;
  /** Voice: true when the User should record again. */
  retry?: boolean;
  /** Voice TARGET_OPERATION_FAILED: the target operation's own error. */
  targetError?: { code: string; message: string; status?: number; details?: unknown };
  details?: unknown;
}

export interface WireErrorBody {
  error: WireError;
}

// ---------------------------------------------------------------------------
// Auth & membership
// ---------------------------------------------------------------------------

export interface LoginRequest {
  identifier: string;
  password: string;
}

export interface CognitoTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn?: number;
  tokenType?: string;
}

export type LoginResponse =
  | { kind: 'session'; user: { userId: string; email?: string }; tokens: CognitoTokens }
  | { kind: 'challenge'; challengeName: string; session?: string };

export interface HouseholdSummary {
  householdId: string;
  name: string;
  role: MembershipRole;
  ownerUserId: string;
}

export interface ListHouseholdsResponse {
  households: HouseholdSummary[];
}

export interface CreateHouseholdRequest {
  name: string;
}

export interface CreateHouseholdResponse {
  household: Household;
  membership: Membership;
}

export type InviteRequest = { email: string } | { userId: string };

export interface AcceptInvitationResponse {
  invitation: Invitation;
  membership: Membership;
}

export interface MemberSummary {
  userId: string;
  email?: string;
  role: MembershipRole;
  joinedAt: string;
}

export interface ListMembersResponse {
  members: MemberSummary[];
}

export interface RemoveMemberResponse {
  removed: Membership;
}

export interface SetActiveHouseholdRequest {
  householdId: string;
}

/** `ActiveHouseholdScope` from src/domain/household.ts. */
export interface ActiveHouseholdScope {
  userId: string;
  householdId: string;
  role: MembershipRole;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface SuggestRequest {
  /** Omit to start a new request session. */
  sessionId?: string;
  /** At most 500 code points. */
  contextInput?: string;
  presets?: Preset[];
  /** Ids of this session's suggestions the User rejected. */
  rejectedSuggestionIds?: string[];
}

export interface SuggestionView extends MealSuggestion {
  attributes: string[];
}

export interface SuggestResponse {
  sessionId: string;
  suggestions: SuggestionView[];
  preferenceApplied: boolean;
  notice?: string;
  softPreferencesDegraded: boolean;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

interface GenerationOptions {
  contextInput?: string;
  presets?: Preset[];
}

export type GeneratePlanRequest = ({ rangeDays: number } | { weekly: true }) &
  GenerationOptions & {
    /** YYYY-MM-DD; the server defaults to today (UTC). */
    startDate?: IsoDate;
  };

/** `StoredPlan`: returned by POST /plans (201) and GET /plans/{id}. */
export interface StoredPlan {
  plan: MealPlan;
  meals: Meal[];
  version: number;
}

export interface PlanSummary {
  planId: string;
  startDate: IsoDate;
  endDate: IsoDate;
  rangeDays: number;
}

export interface ListPlansResponse {
  plans: PlanSummary[];
}

/** A Meal supplied as-is for a day; the agent generates one when omitted. */
export interface SuppliedMeal {
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  attributes?: string[];
}

export interface ReplaceDayRequest extends GenerationOptions {
  meal?: SuppliedMeal;
}

export interface AddDayRequest extends ReplaceDayRequest {
  day: IsoDate;
}

export type MealPlanChangeKind = 'day_added' | 'day_removed' | 'day_replaced';

export interface PlanEditResult {
  plan: MealPlan;
  /** The day's new Meal; absent after a removal. */
  meal?: Meal;
  change: MealPlanChangeKind;
  day: IsoDate;
  version: number;
  eventPublished: boolean;
}

// ---------------------------------------------------------------------------
// Grocery
// ---------------------------------------------------------------------------

/** POST /plans/{id}/grocery-list (201 created, 200 replaced). */
export interface GenerateGroceryListResponse {
  groceryList: GroceryList;
  version: number;
}

/** PUT /plans/{id}/grocery-list: replaces all entries with a manual edit. */
export interface UpdateGroceryListRequest {
  entries: Ingredient[];
}

export interface GetGroceryListResponse {
  groceryList: GroceryList;
  version: number;
  sourcePlanVersion?: number;
}

/** A standalone, named grocery list that is not tied to a plan. */
export interface ShoppingList {
  listId: string;
  name: string;
  entries: Ingredient[];
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListSummary {
  listId: string;
  name: string;
  itemCount: number;
  updatedAt: string;
}

/** GET /shopping-lists */
export interface ListShoppingListsResponse {
  shoppingLists: ShoppingListSummary[];
}

/** POST /shopping-lists: an empty list when `entries` is omitted. */
export interface CreateShoppingListRequest {
  name?: string;
  entries?: Ingredient[];
}

/** PUT /shopping-lists/{id}: rename and/or replace all entries. */
export interface UpdateShoppingListRequest {
  name?: string;
  entries?: Ingredient[];
}

/** POST /shopping-lists/{id}/items: ingredients are added to matching entries. */
export interface AddShoppingListItemsRequest {
  items: Ingredient[];
}

/** Response of create, get, update and add-items. */
export interface ShoppingListResponse {
  shoppingList: ShoppingList;
  version: number;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface SavedProfile {
  profile: PreferenceProfile;
  version: number;
}

/** GET /preferences: `{ profile: null }` when the Household has no profile yet. */
export type GetPreferencesResponse = SavedProfile | { profile: null };

export interface FeedbackRequest {
  /** Meal_Suggestion or Meal name (or id). */
  item: string;
  value: FeedbackValue;
}

export interface AcceptanceRequest {
  mealId: string;
}

export interface ConstraintRequest {
  constraint: string;
}

// ---------------------------------------------------------------------------
// Fridge
// ---------------------------------------------------------------------------

export interface SavedFridge {
  inventory: FridgeInventory;
  version: number;
}

/** GET /fridge: `{ inventory: null }` when nothing has been recorded. */
export type GetFridgeResponse = SavedFridge | { inventory: null };

export interface PutFridgeRequest {
  /** Set with an empty `items` to deliberately empty the fridge. */
  clear?: boolean;
  items: Ingredient[];
}

export interface PutFridgeResponse extends SavedFridge {
  /** Indexes (into the submitted items) of entries dropped as invalid. */
  droppedIndexes: number[];
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface StartConversationRequest {
  targetArtifactType: ConversationArtifactType;
  targetArtifactId: string;
  /** Required for suggestion targets. */
  sessionId?: string;
}

export interface ConversationRecord {
  conversationId: string;
  householdId: string;
  memorySessionId: string;
  targetArtifactType: ConversationArtifactType;
  targetArtifactId: string;
  createdAt: string;
  targetSessionId?: string;
}

export interface StartConversationResponse {
  conversation: ConversationRecord;
}

export interface SendMessageRequest {
  message: string;
}

export type SuggestionContentField = 'name' | 'ingredients' | 'steps';

export type UpdatedArtifact =
  | { type: 'suggestion'; suggestion: MealSuggestion; changedFields: SuggestionContentField[] }
  | { type: 'plan'; plan: MealPlan; day: string; meal: Meal }
  | { type: 'grocery_list'; groceryList: GroceryList };

export type SendMessageResponse =
  | { outcome: 'clarification'; message: string }
  | { outcome: 'updated'; artifact: UpdatedArtifact };

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export type VoiceTargetOperation =
  | { type: 'fridge' }
  | { type: 'context'; sessionId?: string; presets?: string[]; rejectedSuggestionIds?: string[] }
  | { type: 'conversation'; conversationId: string };

export interface SubmitVoiceRequest {
  /** Base64-encoded audio bytes. */
  audio: string;
  /** e.g. `audio/pcm`, `audio/ogg`, `audio/webm`, `audio/mp4`. */
  contentType: string;
  /** Required for `audio/pcm` (16000). */
  sampleRateHertz?: number;
  languageCode?: string;
  targetOperation: VoiceTargetOperation;
}

export interface PendingTranscript {
  voiceId: string;
  transcript: string;
  targetOperation: VoiceTargetOperation;
  status: 'pending';
  expiresAt: string;
}

export interface ConfirmVoiceRequest {
  /** The edited Transcript; the original is used when omitted. */
  transcript?: string;
}

export interface ConfirmVoiceResponse {
  voiceId: string;
  transcript: string;
  targetOperation: VoiceTargetOperation;
  /** The target operation's own success body. */
  result: unknown;
}
