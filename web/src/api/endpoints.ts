/**
 * One typed function per API route (design.md, "API client" table).
 *
 * `ROUTES` is the single source of each route's method, access class, and
 * client timeout, so tests can enumerate every Household-scoped endpoint.
 */
import type { ApiClient, EndpointAccess, HttpMethod } from './client';
import type {
  AcceptanceRequest,
  AcceptInvitationResponse,
  ActiveHouseholdScope,
  AddDayRequest,
  ConfirmVoiceRequest,
  ConfirmVoiceResponse,
  ConstraintRequest,
  CreateHouseholdRequest,
  CreateHouseholdResponse,
  FeedbackRequest,
  AddShoppingListItemsRequest,
  CreateShoppingListRequest,
  ListShoppingListsResponse,
  ShoppingListResponse,
  UpdateShoppingListRequest,
  GenerateGroceryListResponse,
  GeneratePlanRequest,
  GetFridgeResponse,
  GetGroceryListResponse,
  GetPreferencesResponse,
  Invitation,
  InviteRequest,
  ListHouseholdsResponse,
  ListMembersResponse,
  ListPlansResponse,
  LoginRequest,
  LoginResponse,
  PendingTranscript,
  PlanEditResult,
  PutFridgeRequest,
  PutFridgeResponse,
  RemoveMemberResponse,
  ReplaceDayRequest,
  SavedProfile,
  SendMessageRequest,
  SendMessageResponse,
  StartConversationRequest,
  StartConversationResponse,
  StoredPlan,
  SubmitVoiceRequest,
  SuggestRequest,
  SuggestResponse,
  UpdateGroceryListRequest,
} from './types';

/** Static description of one API route. */
export interface RouteDef {
  method: HttpMethod;
  /** Route template as configured in API Gateway. */
  route: string;
  /** `public` needs no session, `user` needs sign-in, `household` also needs an active household. */
  access: EndpointAccess;
  /** Client-side timeout; generous for routes that call the agent (suggestions, plans, edits, voice, messages). */
  timeoutMs: number;
}

/** Default timeout for ordinary reads and writes. */
const S10 = 10_000;

export const ROUTES = {
  login: { method: 'POST', route: '/auth/login', access: 'public', timeoutMs: S10 },

  listHouseholds: { method: 'GET', route: '/households', access: 'user', timeoutMs: S10 },
  createHousehold: { method: 'POST', route: '/households', access: 'user', timeoutMs: S10 },
  invite: { method: 'POST', route: '/households/{id}/invitations', access: 'user', timeoutMs: S10 },
  acceptInvitation: { method: 'POST', route: '/invitations/{id}/accept', access: 'user', timeoutMs: S10 },
  declineInvitation: { method: 'POST', route: '/invitations/{id}/decline', access: 'user', timeoutMs: S10 },
  listMembers: { method: 'GET', route: '/households/{id}/members', access: 'user', timeoutMs: S10 },
  removeMember: { method: 'DELETE', route: '/households/{id}/members/{userId}', access: 'user', timeoutMs: S10 },
  setActiveHousehold: { method: 'PUT', route: '/session/active-household', access: 'user', timeoutMs: S10 },

  suggest: { method: 'POST', route: '/suggestions', access: 'household', timeoutMs: 12_000 },

  generatePlan: { method: 'POST', route: '/plans', access: 'household', timeoutMs: 32_000 },
  listPlans: { method: 'GET', route: '/plans', access: 'household', timeoutMs: S10 },
  getPlan: { method: 'GET', route: '/plans/{id}', access: 'household', timeoutMs: S10 },
  replaceDay: { method: 'PUT', route: '/plans/{id}/days/{day}', access: 'household', timeoutMs: 17_000 },
  addDay: { method: 'POST', route: '/plans/{id}/days', access: 'household', timeoutMs: 17_000 },
  removeDay: { method: 'DELETE', route: '/plans/{id}/days/{day}', access: 'household', timeoutMs: 17_000 },
  deletePlan: { method: 'DELETE', route: '/plans/{id}', access: 'household', timeoutMs: S10 },

  generateGroceryList: { method: 'POST', route: '/plans/{id}/grocery-list', access: 'household', timeoutMs: S10 },
  getGroceryList: { method: 'GET', route: '/plans/{id}/grocery-list', access: 'household', timeoutMs: S10 },
  updateGroceryList: { method: 'PUT', route: '/plans/{id}/grocery-list', access: 'household', timeoutMs: S10 },
  deleteGroceryList: { method: 'DELETE', route: '/plans/{id}/grocery-list', access: 'household', timeoutMs: S10 },

  listShoppingLists: { method: 'GET', route: '/shopping-lists', access: 'household', timeoutMs: S10 },
  createShoppingList: { method: 'POST', route: '/shopping-lists', access: 'household', timeoutMs: S10 },
  getShoppingList: { method: 'GET', route: '/shopping-lists/{id}', access: 'household', timeoutMs: S10 },
  updateShoppingList: { method: 'PUT', route: '/shopping-lists/{id}', access: 'household', timeoutMs: S10 },
  addShoppingListItems: { method: 'POST', route: '/shopping-lists/{id}/items', access: 'household', timeoutMs: S10 },
  deleteShoppingList: { method: 'DELETE', route: '/shopping-lists/{id}', access: 'household', timeoutMs: S10 },

  getPreferences: { method: 'GET', route: '/preferences', access: 'household', timeoutMs: S10 },
  sendFeedback: { method: 'POST', route: '/preferences/feedback', access: 'household', timeoutMs: S10 },
  recordAcceptance: { method: 'POST', route: '/preferences/acceptances', access: 'household', timeoutMs: S10 },
  addConstraint: { method: 'POST', route: '/preferences/constraints', access: 'household', timeoutMs: S10 },

  getFridge: { method: 'GET', route: '/fridge', access: 'household', timeoutMs: S10 },
  putFridge: { method: 'PUT', route: '/fridge', access: 'household', timeoutMs: S10 },

  startConversation: { method: 'POST', route: '/conversations', access: 'household', timeoutMs: S10 },
  sendMessage: { method: 'POST', route: '/conversations/{id}/messages', access: 'household', timeoutMs: 17_000 },

  submitVoice: { method: 'POST', route: '/voice', access: 'household', timeoutMs: 17_000 },
  confirmVoice: { method: 'POST', route: '/voice/{id}/confirm', access: 'household', timeoutMs: S10 },
} as const satisfies Record<string, RouteDef>;

/** Key into `ROUTES`, e.g. `'getPlan'`. */
export type EndpointName = keyof typeof ROUTES;

/** Fills `{param}` placeholders with URL-encoded values. Throws on a missing or empty value. */
export function buildPath(route: string, params: Record<string, string> = {}): string {
  return route.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`Missing path parameter "${name}".`);
    return encodeURIComponent(value);
  });
}

export interface CallOptions {
  /** Cancels the request, e.g. when a component unmounts or a newer request supersedes it. */
  signal?: AbortSignal;
}

/** Builds the typed API surface on top of a low-level `ApiClient`. */
export function createEndpoints(client: ApiClient) {
  /** Looks up the route, fills its path params, and sends the request with the route's access class and timeout. */
  function call<T>(name: EndpointName, params: Record<string, string>, body: unknown, opts?: CallOptions): Promise<T> {
    const def: RouteDef = ROUTES[name];
    return client.request<T>({
      method: def.method,
      path: buildPath(def.route, params),
      access: def.access,
      timeoutMs: def.timeoutMs,
      ...(body !== undefined ? { body } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  return {
    // Auth & membership
    login: (body: LoginRequest, o?: CallOptions) => call<LoginResponse>('login', {}, body, o),
    listHouseholds: (o?: CallOptions) => call<ListHouseholdsResponse>('listHouseholds', {}, undefined, o),
    createHousehold: (body: CreateHouseholdRequest, o?: CallOptions) =>
      call<CreateHouseholdResponse>('createHousehold', {}, body, o),
    invite: (householdId: string, body: InviteRequest, o?: CallOptions) =>
      call<Invitation>('invite', { id: householdId }, body, o),
    acceptInvitation: (invitationId: string, o?: CallOptions) =>
      call<AcceptInvitationResponse>('acceptInvitation', { id: invitationId }, undefined, o),
    declineInvitation: (invitationId: string, o?: CallOptions) =>
      call<Invitation>('declineInvitation', { id: invitationId }, undefined, o),
    listMembers: (householdId: string, o?: CallOptions) =>
      call<ListMembersResponse>('listMembers', { id: householdId }, undefined, o),
    removeMember: (householdId: string, userId: string, o?: CallOptions) =>
      call<RemoveMemberResponse>('removeMember', { id: householdId, userId }, undefined, o),
    setActiveHousehold: (householdId: string, o?: CallOptions) =>
      call<ActiveHouseholdScope>('setActiveHousehold', {}, { householdId }, o),

    // Suggestions
    suggest: (body: SuggestRequest, o?: CallOptions) => call<SuggestResponse>('suggest', {}, body, o),

    // Plans
    generatePlan: (body: GeneratePlanRequest, o?: CallOptions) => call<StoredPlan>('generatePlan', {}, body, o),
    listPlans: (o?: CallOptions) => call<ListPlansResponse>('listPlans', {}, undefined, o),
    getPlan: (planId: string, o?: CallOptions) => call<StoredPlan>('getPlan', { id: planId }, undefined, o),
    replaceDay: (planId: string, day: string, body: ReplaceDayRequest = {}, o?: CallOptions) =>
      call<PlanEditResult>('replaceDay', { id: planId, day }, body, o),
    addDay: (planId: string, body: AddDayRequest, o?: CallOptions) =>
      call<PlanEditResult>('addDay', { id: planId }, body, o),
    removeDay: (planId: string, day: string, o?: CallOptions) =>
      call<PlanEditResult>('removeDay', { id: planId, day }, undefined, o),
    deletePlan: (planId: string, o?: CallOptions) =>
      call<{ planId: string }>('deletePlan', { id: planId }, undefined, o),

    // Grocery
    generateGroceryList: (planId: string, o?: CallOptions) =>
      call<GenerateGroceryListResponse>('generateGroceryList', { id: planId }, undefined, o),
    getGroceryList: (planId: string, o?: CallOptions) =>
      call<GetGroceryListResponse>('getGroceryList', { id: planId }, undefined, o),
    updateGroceryList: (planId: string, body: UpdateGroceryListRequest, o?: CallOptions) =>
      call<GetGroceryListResponse>('updateGroceryList', { id: planId }, body, o),
    deleteGroceryList: (planId: string, o?: CallOptions) =>
      call<{ deleted: true }>('deleteGroceryList', { id: planId }, undefined, o),
    listShoppingLists: (o?: CallOptions) => call<ListShoppingListsResponse>('listShoppingLists', {}, undefined, o),
    createShoppingList: (body: CreateShoppingListRequest = {}, o?: CallOptions) =>
      call<ShoppingListResponse>('createShoppingList', {}, body, o),
    getShoppingList: (listId: string, o?: CallOptions) =>
      call<ShoppingListResponse>('getShoppingList', { id: listId }, undefined, o),
    updateShoppingList: (listId: string, body: UpdateShoppingListRequest, o?: CallOptions) =>
      call<ShoppingListResponse>('updateShoppingList', { id: listId }, body, o),
    addShoppingListItems: (listId: string, body: AddShoppingListItemsRequest, o?: CallOptions) =>
      call<ShoppingListResponse>('addShoppingListItems', { id: listId }, body, o),
    deleteShoppingList: (listId: string, o?: CallOptions) =>
      call<{ deleted: true }>('deleteShoppingList', { id: listId }, undefined, o),

    // Preferences
    getPreferences: (o?: CallOptions) => call<GetPreferencesResponse>('getPreferences', {}, undefined, o),
    sendFeedback: (body: FeedbackRequest, o?: CallOptions) => call<SavedProfile>('sendFeedback', {}, body, o),
    recordAcceptance: (body: AcceptanceRequest, o?: CallOptions) =>
      call<SavedProfile>('recordAcceptance', {}, body, o),
    addConstraint: (body: ConstraintRequest, o?: CallOptions) => call<SavedProfile>('addConstraint', {}, body, o),

    // Fridge
    getFridge: (o?: CallOptions) => call<GetFridgeResponse>('getFridge', {}, undefined, o),
    putFridge: (body: PutFridgeRequest, o?: CallOptions) => call<PutFridgeResponse>('putFridge', {}, body, o),

    // Conversations
    startConversation: (body: StartConversationRequest, o?: CallOptions) =>
      call<StartConversationResponse>('startConversation', {}, body, o),
    sendMessage: (conversationId: string, body: SendMessageRequest, o?: CallOptions) =>
      call<SendMessageResponse>('sendMessage', { id: conversationId }, body, o),

    // Voice
    submitVoice: (body: SubmitVoiceRequest, o?: CallOptions) => call<PendingTranscript>('submitVoice', {}, body, o),
    confirmVoice: (voiceId: string, body: ConfirmVoiceRequest = {}, o?: CallOptions) =>
      call<ConfirmVoiceResponse>('confirmVoice', { id: voiceId }, body, o),
  };
}

/** The typed API object injected through `ServicesProvider`. */
export type SousApi = ReturnType<typeof createEndpoints>;
