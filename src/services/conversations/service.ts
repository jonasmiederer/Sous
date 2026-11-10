/**
 * Conversation Service core (Requirements 9.1-9.7).
 *
 * A ConversationService is bound to one Active_Household through its
 * HouseholdRepository. Conversation metadata lives at CONVERSATION#{id} in
 * that Household's partition, so a Conversation (or its target artifact) of
 * another Household cannot be loaded (9.7).
 *
 * sendMessage flow:
 * 1. Validate the message, load the Conversation, the target artifact, the
 *    Preference_Profile and Fridge_Inventory, and list all prior turns from
 *    short-term memory at `{householdId}:{conversationId}` (9.3).
 * 2. Invoke the Suggestion_Agent in refine mode with the prior turns and the
 *    current artifact, within the 15s chat bound measured from the start of
 *    the request (9.6).
 * 3. Apply the update:
 *    - suggestion: replace only the content fields the agent changed (9.1);
 *    - plan: replace only the named day's Meal, after checking the day exists
 *      and the new Meal passes hard exclusions (9.2);
 *    - grocery_list: replace the entries as returned; consolidation is not
 *      re-run, so the requested edit is kept as-is (9.4).
 *    Each write is a single conditional write or transaction against the
 *    version that was read, so a concurrent change or failed write leaves the
 *    stored artifact unchanged.
 * 4. Clarification, timeout, agent failure, invalid or excluded results, and
 *    a non-existent plan day perform no artifact write (9.5, 9.6).
 *
 * Turn recording: the user turn and the assistant turn are appended to
 * short-term memory only after a successful update or a clarification, so
 * failed requests never become context for later turns. Appending happens
 * after the artifact write; if it fails the artifact change stands and the
 * result reports `memoryRecorded: false`.
 */
import { randomUUID } from 'node:crypto';

import type { MemoryClient, ConversationTurn } from '../../agent/memoryClient.js';
import { buildRefinePayload } from '../../agent/payload.js';
import type { RefinedArtifact } from '../../agent/responses.js';
import { CHAT_DEADLINE_MS, type SuggestionAgentClient } from '../../agent/runtimeClient.js';
import { InvalidMemoryIdError, validateConversationId } from '../../agent/memoryNamespaces.js';
import { InvalidKeyError, sortKeys } from '../../data/keys.js';
import type { HouseholdRepository } from '../../data/repository.js';
import { enforceHardExclusions } from '../../domain/exclusions.js';
import type {
  Conversation,
  FridgeInventory,
  GroceryList,
  Meal,
  MealPlan,
  MealSuggestion,
  PreferenceProfile,
} from '../../domain/types.js';
import {
  isWellFormedMeal,
  loadArtifact,
  mergeRefinedSuggestion,
  replacePlanDay,
  targetSortKey,
  toCurrentArtifact,
  type ConversationTarget,
  type LoadedArtifact,
  type SuggestionContentField,
} from './artifacts.js';

/** Maximum length of a refinement message (matches the Context_Input limit). */
export const MAX_MESSAGE_LENGTH = 500;

export type ConversationErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'TARGET_NOT_FOUND'
  | 'MEMORY_UNAVAILABLE'
  | 'TIMEOUT'
  | 'AGENT_UNAVAILABLE'
  | 'CANNOT_APPLY'
  | 'SAVE_FAILED';

export interface ConversationError {
  code: ConversationErrorCode;
  message: string;
}

export type Failure = { ok: false; error: ConversationError };

/** Stored Conversation record. `targetSessionId` is set for suggestion targets. */
export interface ConversationRecord extends Conversation {
  targetSessionId?: string;
}

export type UpdatedArtifact =
  | { type: 'suggestion'; suggestion: MealSuggestion; changedFields: SuggestionContentField[] }
  | { type: 'plan'; plan: MealPlan; day: string; meal: Meal }
  | { type: 'grocery_list'; groceryList: GroceryList };

export type SendMessageResult =
  | { ok: true; outcome: 'updated'; artifact: UpdatedArtifact; memoryRecorded: boolean }
  | { ok: true; outcome: 'clarification'; message: string; memoryRecorded: boolean }
  | Failure;

export type CreateConversationResult = { ok: true; conversation: ConversationRecord } | Failure;

export interface PlanChangedEvent {
  householdId: string;
  planId: string;
  day: string;
  /** Meal now assigned to `day`. */
  mealId: string;
  /** Plan record version after the refinement was committed. */
  planVersion: number;
}

export interface ConversationServiceDeps {
  /** Bound to the authorized Active_Household. */
  repository: HouseholdRepository;
  agent: SuggestionAgentClient;
  memory: MemoryClient;
  now?: () => Date;
  newId?: () => string;
  /** Defaults to CHAT_DEADLINE_MS (15s). */
  deadlineMs?: number;
  /** Optional MealPlanChanged publisher; failures do not undo the refinement. */
  onPlanChanged?: (event: PlanChangedEvent) => Promise<void>;
}

const fail = (code: ConversationErrorCode, message: string): Failure => ({ ok: false, error: { code, message } });

export class ConversationService {
  private readonly repo: HouseholdRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly deadlineMs: number;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.repo = deps.repository;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
    this.deadlineMs = deps.deadlineMs ?? CHAT_DEADLINE_MS;
  }

  get householdId(): string {
    return this.repo.householdId;
  }

  /** POST /conversations: start a Conversation on an artifact of the Active_Household. */
  async createConversation(target: ConversationTarget): Promise<CreateConversationResult> {
    let sk: string;
    try {
      sk = targetSortKey(target);
    } catch (err) {
      if (err instanceof InvalidKeyError) return fail('INVALID_REQUEST', 'The target artifact id is invalid.');
      throw err;
    }
    if (!(await this.repo.get(sk))) return fail('TARGET_NOT_FOUND', 'The artifact to refine was not found.');

    const conversationId = validateConversationId(this.newId());
    const record: ConversationRecord = {
      conversationId,
      householdId: this.householdId,
      memorySessionId: `${this.householdId}:${conversationId}`,
      targetArtifactType: target.type,
      targetArtifactId: target.type === 'suggestion' ? target.suggestionId : target.planId,
      createdAt: this.now().toISOString(),
    };
    if (target.type === 'suggestion') record.targetSessionId = target.sessionId;

    const write = await this.repo.create(sortKeys.conversation(conversationId), { ...record });
    if (!write.ok) return fail('SAVE_FAILED', write.error.message);
    return { ok: true, conversation: record };
  }

  /** Loads a Conversation of the Active_Household, or undefined. */
  async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    try {
      validateConversationId(conversationId);
    } catch (err) {
      if (err instanceof InvalidMemoryIdError) return undefined;
      throw err;
    }
    const record = await this.repo.get<ConversationRecord & Record<string, unknown>>(sortKeys.conversation(conversationId));
    if (!record || record.attributes.householdId !== this.householdId) return undefined;
    return record.attributes;
  }

  /** POST /conversations/{id}/messages: refine the Conversation's artifact. */
  async sendMessage(conversationId: string, message: unknown): Promise<SendMessageResult> {
    const startedAt = this.now().getTime();
    const elapsed = () => this.now().getTime() - startedAt;

    if (typeof message !== 'string' || message.trim().length === 0) {
      return fail('INVALID_REQUEST', 'The message must not be empty.');
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return fail('INVALID_REQUEST', `The message must be at most ${MAX_MESSAGE_LENGTH} characters.`);
    }

    const conversation = await this.getConversation(conversationId);
    if (!conversation) return fail('NOT_FOUND', 'The conversation was not found.');
    const target = toTarget(conversation);
    if (!target) return fail('NOT_FOUND', 'The conversation was not found.');
    const scope = { householdId: this.householdId, conversationId: conversation.conversationId };

    let priorTurns: ConversationTurn[];
    try {
      priorTurns = await this.deps.memory.listConversationTurns(scope);
    } catch {
      return fail('MEMORY_UNAVAILABLE', 'The conversation history is unavailable; nothing was changed.');
    }

    const [artifact, profile, fridge] = await Promise.all([
      loadArtifact(this.repo, target),
      this.repo.get<PreferenceProfile & Record<string, unknown>>(sortKeys.preferenceProfile()),
      this.repo.get<FridgeInventory & Record<string, unknown>>(sortKeys.fridge()),
    ]);
    if (!artifact) return fail('TARGET_NOT_FOUND', 'The artifact to refine was not found.');

    const remaining = this.deadlineMs - elapsed();
    if (remaining <= 0) return timeout();

    const payload = buildRefinePayload({
      householdId: this.householdId,
      preferenceProfile: profile?.attributes ?? null,
      fridgeInventory: fridge?.attributes.items ?? [],
      conversationId: conversation.conversationId,
      contextInput: message,
      targetArtifactType: conversation.targetArtifactType,
      priorTurns,
      currentArtifact: toCurrentArtifact(artifact),
    });
    const result = await this.deps.agent.invoke(payload, { timeoutMs: remaining });
    if (!result.ok) {
      return result.error.kind === 'timeout'
        ? timeout()
        : fail('AGENT_UNAVAILABLE', 'Refinement is unavailable right now; nothing was changed.');
    }
    if (elapsed() > this.deadlineMs) return timeout();

    const response = result.response;
    if (response.outcome === 'clarification') {
      const memoryRecorded = await this.recordTurns(scope, message, response.message);
      return { ok: true, outcome: 'clarification', message: response.message, memoryRecorded };
    }

    const applied = await this.apply(artifact, response.artifact, profile?.attributes ?? null);
    if (!applied.ok) return applied;
    const memoryRecorded = await this.recordTurns(scope, message, describe(applied.artifact));
    return { ok: true, outcome: 'updated', artifact: applied.artifact, memoryRecorded };
  }

  private async apply(
    current: LoadedArtifact,
    refined: RefinedArtifact,
    profile: PreferenceProfile | null,
  ): Promise<{ ok: true; artifact: UpdatedArtifact } | Failure> {
    if (refined.type !== current.type) {
      return fail('AGENT_UNAVAILABLE', 'Refinement returned an unexpected result; nothing was changed.');
    }
    const { record } = current;

    if (current.type === 'suggestion' && refined.type === 'suggestion') {
      if (!isWellFormedMeal(refined.meal)) {
        return fail('AGENT_UNAVAILABLE', 'Refinement returned an incomplete meal; nothing was changed.');
      }
      if (enforceHardExclusions([refined.meal], profile).excluded.length > 0) {
        return fail('CANNOT_APPLY', 'That change would break a dietary constraint or excluded ingredient; nothing was changed.');
      }
      const { suggestion, changedFields } = mergeRefinedSuggestion(current.record.attributes, refined.meal);
      if (changedFields.length > 0) {
        const write = await this.repo.replaceIfVersion(record.sk, record.version, { ...suggestion });
        if (!write.ok) return fail('SAVE_FAILED', write.error.message);
      }
      return { ok: true, artifact: { type: 'suggestion', suggestion, changedFields } };
    }

    if (current.type === 'plan' && refined.type === 'plan') {
      if (!isWellFormedMeal(refined.meal)) {
        return fail('AGENT_UNAVAILABLE', 'Refinement returned an incomplete meal; nothing was changed.');
      }
      if (enforceHardExclusions([refined.meal], profile).excluded.length > 0) {
        return fail('CANNOT_APPLY', 'That change would break a dietary constraint or excluded ingredient; nothing was changed.');
      }
      const meal: Meal = {
        mealId: this.newId(),
        name: refined.meal.name,
        ingredients: refined.meal.ingredients.map((i) => ({ ...i })),
        steps: [...refined.meal.steps],
        attributes: [...refined.meal.attributes],
      };
      const plan = replacePlanDay(current.record.attributes, refined.day, meal.mealId);
      if (!plan) return fail('CANNOT_APPLY', `The plan has no meal on ${refined.day}; nothing was changed.`);
      const write = await this.repo.transact([
        { kind: 'create', sk: sortKeys.meal(meal.mealId), attributes: { ...meal } },
        { kind: 'replaceIfVersion', sk: record.sk, expectedVersion: record.version, attributes: { ...plan } },
      ]);
      if (!write.ok) return fail('SAVE_FAILED', write.error.message);
      if (this.deps.onPlanChanged) {
        await this.deps
          .onPlanChanged({
            householdId: this.householdId,
            planId: plan.planId,
            day: refined.day,
            mealId: meal.mealId,
            planVersion: record.version + 1,
          })
          .catch(() => undefined);
      }
      return { ok: true, artifact: { type: 'plan', plan, day: refined.day, meal } };
    }

    if (current.type === 'grocery_list' && refined.type === 'grocery_list') {
      const groceryList = {
        ...structuredClone(current.record.attributes),
        entries: refined.entries.map((e) => ({ ...e })),
        generatedAt: this.now().toISOString(),
      };
      const write = await this.repo.replaceIfVersion(record.sk, record.version, groceryList);
      if (!write.ok) return fail('SAVE_FAILED', write.error.message);
      return { ok: true, artifact: { type: 'grocery_list', groceryList } };
    }

    return fail('AGENT_UNAVAILABLE', 'Refinement returned an unexpected result; nothing was changed.');
  }

  private async recordTurns(
    scope: { householdId: string; conversationId: string },
    userText: string,
    assistantText: string,
  ): Promise<boolean> {
    try {
      await this.deps.memory.appendConversationTurn(scope, {
        role: 'user',
        text: userText,
        timestamp: this.now().toISOString(),
      });
      await this.deps.memory.appendConversationTurn(scope, {
        role: 'assistant',
        text: assistantText,
        timestamp: this.now().toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }
}

function timeout(): Failure {
  return fail('TIMEOUT', 'The refinement did not complete in time; nothing was changed.');
}

function toTarget(c: ConversationRecord): ConversationTarget | undefined {
  switch (c.targetArtifactType) {
    case 'suggestion':
      return c.targetSessionId
        ? { type: 'suggestion', sessionId: c.targetSessionId, suggestionId: c.targetArtifactId }
        : undefined;
    case 'plan':
      return { type: 'plan', planId: c.targetArtifactId };
    case 'grocery_list':
      return { type: 'grocery_list', planId: c.targetArtifactId };
  }
}

/** Assistant turn text recorded in short-term memory. */
function describe(artifact: UpdatedArtifact): string {
  switch (artifact.type) {
    case 'suggestion':
      return artifact.changedFields.length === 0
        ? `No change to suggestion "${artifact.suggestion.name}".`
        : `Updated suggestion "${artifact.suggestion.name}" (changed: ${artifact.changedFields.join(', ')}).`;
    case 'plan':
      return `Updated ${artifact.day} to "${artifact.meal.name}".`;
    case 'grocery_list':
      return `Updated grocery list (${artifact.groceryList.entries.length} entries).`;
  }
}
