/**
 * Suggestion Service core: ad hoc meal suggestions (Requirements 2.1-2.7,
 * 4.1, 4.2, 5.2-5.4).
 *
 * Flow
 * ----
 * 1. Validate the request (Context_Input <= 500 chars, Presets recognized and
 *    non-conflicting). Invalid requests return before any read or agent call.
 * 2. Start the 10-second budget. In parallel, load the Household-scoped
 *    Preference_Profile, Fridge_Inventory and this session's stored
 *    suggestions, and read the household long-term preference memory
 *    (best-effort, capped at `memoryReadBudgetMs` and the remaining budget).
 * 3. Invoke the Suggestion_Agent with the remaining budget as its deadline.
 * 4. Post-process deterministically (see postProcess.ts).
 * 5. Persist the new suggestions and mark the newly rejected ones in a single
 *    all-or-nothing transaction, but only if the budget has not run out.
 *
 * Every failure branch returns before step 5, so no partial state is written.
 *
 * Rejected suggestions (Requirement 2.5)
 * --------------------------------------
 * The request session is server-side. Each successful response stores its
 * suggestions under `SUGGESTION#{sessionId}#{suggestionId}` (TTL-expired).
 * The client rejects suggestions by sending their ids in
 * `rejectedSuggestionIds`; the service resolves the names from the stored
 * items, so a client cannot forge or omit names. Rejections are recorded
 * (`rejected: true`) in the same transaction as the next successful
 * response, and the rejected set for a request is the union of previously
 * recorded rejections and the ids in the request. When a request fails, no
 * rejection is recorded, so the client resends the same ids on retry.
 *
 * Soft long-term memory
 * ---------------------
 * Read here so the whole 10s bound covers it and a failure degrades
 * gracefully. The statements are passed to the agent in the additive payload
 * field `householdPreferenceMemory` as a soft bias. They never influence hard
 * exclusion enforcement (Property 7).
 */
import type { MemoryClient, HouseholdPreferenceRead } from '../../agent/memoryClient.js';
import { buildAdHocPayload, type AdHocPayload } from '../../agent/payload.js';
import type { AgentMeal } from '../../agent/responses.js';
import { AD_HOC_DEADLINE_MS, type SuggestionAgentClient } from '../../agent/runtimeClient.js';
import { sortKeys } from '../../data/keys.js';
import type { Attributes, HouseholdRepository, HouseholdTransactOp, StoredRecord } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type {
  FridgeInventory,
  HouseholdId,
  Ingredient,
  MealSuggestion,
  PreferenceMemoryPolarity,
  PreferenceProfile,
  Preset,
  SessionId,
  SuggestionId,
} from '../../domain/types.js';
import { NO_SUGGESTION_MESSAGES, type NoSuggestionReason, type SuggestionError } from './errors.js';
import { selectSuggestions } from './postProcess.js';
import { validateAdHocRequest, type ValidatedAdHocRequest } from './validation.js';

/** Default cap for the best-effort long-term memory read within the 10s budget. */
export const DEFAULT_MEMORY_READ_BUDGET_MS = 2_000;
/** Stored session suggestions expire after this long (DynamoDB TTL). */
export const SUGGESTION_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** DynamoDB TTL attribute name on SUGGESTION# items (epoch seconds). */
export const SUGGESTION_TTL_ATTRIBUTE = 'ttl';

/** A returned suggestion: the domain MealSuggestion plus its descriptive attributes. */
export interface SuggestionView extends MealSuggestion {
  attributes: string[];
}

export interface AdHocSuggestionSuccess {
  sessionId: SessionId;
  suggestions: SuggestionView[];
  /** False when the Household has no Preference_Profile (Requirement 2.3). */
  preferenceApplied: boolean;
  /** Present when no Preference_Profile was applied (Requirement 2.3). */
  notice?: string;
  /** True when household long-term memory could not be read; the soft bias was omitted. */
  softPreferencesDegraded: boolean;
}

export type AdHocSuggestionResult = { ok: true; value: AdHocSuggestionSuccess } | { ok: false; error: SuggestionError };

/** Payload sent to the agent: the design payload plus the prefetched soft bias. */
export interface AdHocPayloadWithMemory extends AdHocPayload {
  householdPreferenceMemory: Array<{ statement: string; polarity?: PreferenceMemoryPolarity }>;
}

export interface SuggestionServiceDeps {
  /** Returns a repository bound to the given (already authorized) Household. */
  repositoryFor: (householdId: HouseholdId) => HouseholdRepository;
  agent: SuggestionAgentClient;
  memory: MemoryClient;
  /** Milliseconds since the epoch. */
  now: () => number;
  newId: () => string;
  /** Overall bound; defaults to and may not exceed AD_HOC_DEADLINE_MS (10s). */
  deadlineMs?: number;
  memoryReadBudgetMs?: number;
}

interface StoredSuggestion extends Record<string, unknown> {
  suggestionId: SuggestionId;
  sessionId: SessionId;
  name: string;
  rejected?: boolean;
}

const TIMED_OUT = Symbol('timed-out');

/** Resolves to the promise's value, or TIMED_OUT after `ms` (<= 0 times out immediately). */
async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    promise.catch(() => undefined);
    return TIMED_OUT;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const out = await Promise.race([promise, deadline]);
    if (out === TIMED_OUT) promise.catch(() => undefined);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function noSuggestion(reason: NoSuggestionReason, sessionId: SessionId): AdHocSuggestionResult {
  return {
    ok: false,
    error: { code: 'NO_SUGGESTION_AVAILABLE', message: NO_SUGGESTION_MESSAGES[reason], reason, sessionId },
  };
}

function timeout(deadlineMs: number, sessionId: SessionId): AdHocSuggestionResult {
  return {
    ok: false,
    error: {
      code: 'GENERATION_TIMEOUT',
      message: `No suggestion was produced within ${deadlineMs / 1000} seconds. Please try again.`,
      sessionId,
    },
  };
}

const NO_PROFILE_NOTICE =
  'No household preference profile exists yet, so these suggestions were not filtered by your preferences.';

export class SuggestionService {
  private readonly deadlineMs: number;
  private readonly memoryReadBudgetMs: number;

  constructor(private readonly deps: SuggestionServiceDeps) {
    const deadline = deps.deadlineMs ?? AD_HOC_DEADLINE_MS;
    if (!Number.isFinite(deadline) || deadline <= 0 || deadline > AD_HOC_DEADLINE_MS) {
      throw new RangeError(`deadlineMs must be in (0, ${AD_HOC_DEADLINE_MS}]`);
    }
    this.deadlineMs = deadline;
    this.memoryReadBudgetMs = deps.memoryReadBudgetMs ?? DEFAULT_MEMORY_READ_BUDGET_MS;
  }

  /** Validates the raw body, then generates. Entry point for the Lambda handler. */
  async suggest(scope: ActiveHouseholdScope, body: unknown): Promise<AdHocSuggestionResult> {
    const validated = validateAdHocRequest(body);
    if (!validated.ok) return validated;
    return this.generate(scope, validated.value);
  }

  async generate(scope: ActiveHouseholdScope, request: ValidatedAdHocRequest): Promise<AdHocSuggestionResult> {
    const { deps } = this;
    const startedAt = deps.now();
    const remaining = () => this.deadlineMs - (deps.now() - startedAt);
    const householdId = scope.householdId;
    const sessionId = request.sessionId ?? deps.newId();
    const repo = deps.repositoryFor(householdId);
    if (repo.householdId !== householdId) {
      throw new Error('repositoryFor returned a repository bound to a different Household');
    }

    // --- Load context (parallel, all within the budget) -------------------
    const memoryRead = deps.memory
      .readHouseholdPreferences({ householdId })
      .catch((): HouseholdPreferenceRead => ({ entries: [], degraded: true }));
    const boundedMemory = withinBudget(memoryRead, Math.min(this.memoryReadBudgetMs, remaining())).then(
      (r): HouseholdPreferenceRead => (r === TIMED_OUT ? { entries: [], degraded: true } : r),
    );
    const storage = Promise.all([
      repo.get<PreferenceProfile & Attributes>(sortKeys.preferenceProfile()),
      repo.get<FridgeInventory & Attributes>(sortKeys.fridge()),
      request.sessionId !== undefined
        ? repo.query<StoredSuggestion>(sortKeys.suggestionSession(request.sessionId))
        : Promise.resolve([] as StoredRecord<StoredSuggestion>[]),
    ]);

    let loaded: Awaited<typeof storage> | typeof TIMED_OUT;
    try {
      loaded = await withinBudget(storage, remaining());
    } catch {
      boundedMemory.catch(() => undefined);
      return noSuggestion('storage_unavailable', sessionId);
    }
    if (loaded === TIMED_OUT) return timeout(this.deadlineMs, sessionId);
    const [profileRecord, fridgeRecord, sessionRecords] = loaded;
    const softMemory = await boundedMemory;

    // --- Resolve rejected names from the session ---------------------------
    const byId = new Map(sessionRecords.map((r) => [r.attributes.suggestionId, r]));
    const unknown = request.rejectedSuggestionIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_SUGGESTION',
          message: 'One or more rejected suggestions are not part of this session.',
          sessionId,
          details: { unknownSuggestionIds: unknown },
        },
      };
    }
    const newlyRejected = request.rejectedSuggestionIds
      .map((id) => byId.get(id))
      .filter((r): r is StoredRecord<StoredSuggestion> => r !== undefined && r.attributes.rejected !== true);
    const rejectedNames = [
      ...new Set(
        sessionRecords
          .filter((r) => r.attributes.rejected === true || request.rejectedSuggestionIds.includes(r.attributes.suggestionId))
          .map((r) => r.attributes.name),
      ),
    ];

    const profile = profileRecord?.attributes ?? null;
    const fridgeItems: Ingredient[] = fridgeRecord?.attributes.items ?? [];

    // --- Invoke the agent with the remaining budget ------------------------
    const payload: AdHocPayloadWithMemory = {
      ...buildAdHocPayload({
        householdId,
        preferenceProfile: profile,
        fridgeInventory: fridgeItems,
        presets: request.presets,
        contextInput: request.contextInput ?? null,
        rejectedSuggestionNames: rejectedNames,
      }),
      householdPreferenceMemory: softMemory.entries.map((e) =>
        e.polarity !== undefined ? { statement: e.statement, polarity: e.polarity } : { statement: e.statement },
      ),
    };
    const agentBudget = remaining();
    if (agentBudget <= 0) return timeout(this.deadlineMs, sessionId);
    const invocation = await withinBudget(deps.agent.invoke(payload, { timeoutMs: agentBudget }), agentBudget);
    if (invocation === TIMED_OUT) return timeout(this.deadlineMs, sessionId);
    if (!invocation.ok) {
      if (invocation.error.kind === 'timeout') return timeout(this.deadlineMs, sessionId);
      return noSuggestion(
        invocation.error.kind === 'invalid_response' ? 'agent_invalid_response' : 'agent_unavailable',
        sessionId,
      );
    }

    // --- Deterministic post-processing --------------------------------------
    const selection = selectSuggestions({
      meals: invocation.response.suggestions,
      profile,
      rejectedNames,
      fridgeItems,
      softMemory: softMemory.entries,
    });
    switch (selection.kind) {
      case 'none_well_formed':
        return noSuggestion('no_well_formed_suggestions', sessionId);
      case 'all_excluded':
        return noSuggestion('all_suggestions_excluded', sessionId);
      case 'exhausted_distinct':
        return {
          ok: false,
          error: {
            code: 'NO_DISTINCT_SUGGESTIONS',
            message: 'No further distinct suggestions are available for this session.',
            sessionId,
          },
        };
      case 'selected':
        break;
    }

    if (remaining() <= 0) return timeout(this.deadlineMs, sessionId);

    // --- Persist atomically --------------------------------------------------
    const preferenceApplied = profile !== null;
    const suggestions = selection.meals.map((meal) =>
      toView(meal, { householdId, sessionId, suggestionId: deps.newId(), presets: request.presets, preferenceApplied }),
    );
    const createdAt = new Date(startedAt).toISOString();
    const ttl = Math.floor(startedAt / 1000) + SUGGESTION_SESSION_TTL_SECONDS;
    const ops: HouseholdTransactOp[] = [
      ...newlyRejected.map(
        (r): HouseholdTransactOp => ({
          kind: 'replaceIfVersion',
          sk: r.sk,
          expectedVersion: r.version,
          attributes: { ...r.attributes, rejected: true },
        }),
      ),
      ...suggestions.map(
        (s): HouseholdTransactOp => ({
          kind: 'create',
          sk: sortKeys.suggestion(sessionId, s.suggestionId),
          attributes: { ...s, rejected: false, createdAt, [SUGGESTION_TTL_ATTRIBUTE]: ttl },
        }),
      ),
    ];
    const write = await repo.transact(ops);
    if (!write.ok) {
      return {
        ok: false,
        error: { code: 'SAVE_DID_NOT_COMPLETE', message: write.error.message, reason: write.error.reason, sessionId },
      };
    }

    const value: AdHocSuggestionSuccess = {
      sessionId,
      suggestions,
      preferenceApplied,
      softPreferencesDegraded: softMemory.degraded,
    };
    if (!preferenceApplied) value.notice = NO_PROFILE_NOTICE;
    return { ok: true, value };
  }
}

function toView(
  meal: AgentMeal,
  ctx: { householdId: HouseholdId; sessionId: SessionId; suggestionId: SuggestionId; presets: Preset[]; preferenceApplied: boolean },
): SuggestionView {
  return {
    suggestionId: ctx.suggestionId,
    sessionId: ctx.sessionId,
    householdId: ctx.householdId,
    name: meal.name.trim(),
    ingredients: meal.ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit })),
    steps: [...meal.steps],
    attributes: [...meal.attributes],
    presetContext: [...ctx.presets],
    preferenceApplied: ctx.preferenceApplied,
  };
}
