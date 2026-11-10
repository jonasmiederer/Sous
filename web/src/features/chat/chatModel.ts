/**
 * Pure helpers for the chat refinement panel (Requirements 9.1, 9.5, 13.14):
 * what a target maps to on the wire, the composer limit, the assistant's
 * summary of an applied change, and the query cache keys the panel updates.
 */
import type {
  GetGroceryListResponse,
  IsoDate,
  Meal,
  StartConversationRequest,
  StoredPlan,
  SuggestionContentField,
  UpdatedArtifact,
} from '../../api/types';
import { codePointLength } from '../../ui';

/** What the panel refines. `title` is shown under the panel heading. */
export type ChatTarget =
  | { type: 'suggestion'; sessionId: string; suggestionId: string; title: string }
  | { type: 'plan'; planId: string; day?: IsoDate; title: string }
  | { type: 'grocery_list'; planId: string; title: string };

/** Refinement message limit in code points, the same as Context_Input (500). */
export const CHAT_MESSAGE_MAX = 500;

export function isMessageTooLong(value: string): boolean {
  return codePointLength(value) > CHAT_MESSAGE_MAX;
}

/** True when the composer has something sendable. */
export function canSend(value: string): boolean {
  return value.trim().length > 0 && !isMessageTooLong(value);
}

/** The `POST /conversations` body for a target. */
export function conversationRequest(target: ChatTarget): StartConversationRequest {
  switch (target.type) {
    case 'suggestion':
      return { targetArtifactType: 'suggestion', targetArtifactId: target.suggestionId, sessionId: target.sessionId };
    case 'plan':
      return { targetArtifactType: 'plan', targetArtifactId: target.planId };
    case 'grocery_list':
      return { targetArtifactType: 'grocery_list', targetArtifactId: target.planId };
  }
}

/**
 * Identity of a target. The panel reuses one Conversation while it stays open
 * for the same key and starts a fresh one when the key changes. `day` is not
 * part of the key: the Conversation targets the whole plan.
 */
export function targetKey(target: ChatTarget): string {
  switch (target.type) {
    case 'suggestion':
      return `suggestion:${target.sessionId}:${target.suggestionId}`;
    case 'plan':
      return `plan:${target.planId}`;
    case 'grocery_list':
      return `grocery_list:${target.planId}`;
  }
}

function formatDay(day: IsoDate, options: Intl.DateTimeFormatOptions): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) return day;
  return new Date(ms).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

/** "Tuesday" */
export function weekdayOf(day: IsoDate): string {
  return formatDay(day, { weekday: 'long' });
}

export function composerPlaceholder(target: ChatTarget): string {
  switch (target.type) {
    case 'suggestion':
      return 'e.g. make it dairy-free, or swap the rice for quinoa';
    case 'plan':
      return target.day ? `e.g. make ${weekdayOf(target.day)} vegetarian` : 'e.g. make Friday something lighter';
    case 'grocery_list':
      return 'e.g. remove the milk, we already have some';
  }
}

const FIELD_LABELS: Record<SuggestionContentField, string> = { name: 'name', ingredients: 'ingredients', steps: 'steps' };

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The assistant's short description of an applied change. */
export function summarizeUpdate(artifact: UpdatedArtifact): string {
  switch (artifact.type) {
    case 'suggestion': {
      const fields = artifact.changedFields.map((f) => FIELD_LABELS[f]);
      return fields.length === 0
        ? `Updated '${artifact.suggestion.name}'.`
        : `Updated '${artifact.suggestion.name}': changed the ${joinList(fields)}.`;
    }
    case 'plan': {
      const when = artifact.plan.rangeDays > 7 ? formatDay(artifact.day, { weekday: 'long', month: 'short', day: 'numeric' }) : weekdayOf(artifact.day);
      return `Updated ${when} to '${artifact.meal.name}'.`;
    }
    case 'grocery_list': {
      const n = artifact.groceryList.entries.length;
      return `Updated the grocery list. It now has ${n} ${n === 1 ? 'item' : 'items'}.`;
    }
  }
}

/**
 * Grocery list query key, shared with the grocery feature (tasks 23.7, 23.11):
 * `['hh', householdId, 'grocery', planId]`, holding a `GetGroceryListResponse`.
 */
export function groceryListKey(householdId: string | null, planId: string) {
  return ['hh', householdId ?? 'none', 'grocery', planId] as const;
}

/** A cached plan with the refined day's new plan and Meal applied. The version is refreshed by refetch. */
export function applyPlanRefinement(stored: StoredPlan, artifact: Extract<UpdatedArtifact, { type: 'plan' }>): StoredPlan {
  const referenced = new Set(artifact.plan.days.map((d) => d.mealId));
  const meals: Meal[] = stored.meals.filter((m) => referenced.has(m.mealId) && m.mealId !== artifact.meal.mealId);
  meals.push(artifact.meal);
  return { plan: artifact.plan, meals, version: stored.version };
}

/** A cached grocery response with the refined list applied, or undefined when the cache holds another shape. */
export function applyGroceryRefinement(
  cached: unknown,
  artifact: Extract<UpdatedArtifact, { type: 'grocery_list' }>,
): GetGroceryListResponse | undefined {
  if (typeof cached !== 'object' || cached === null || !('groceryList' in cached)) return undefined;
  return { ...(cached as GetGroceryListResponse), groceryList: artifact.groceryList };
}
