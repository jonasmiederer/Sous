/**
 * MealPlanChanged event (Requirement 7.5). Emitted after a committed day
 * add/remove/replace so the Grocery Service (task 10.1) can regenerate the
 * plan's Grocery_List from the current plan.
 */
import { EventBridgeClient, PutEventsCommand, type PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import type { HouseholdId, IsoDate, IsoTimestamp, MealId, PlanId } from '../../domain/types.js';

export const MEAL_PLAN_CHANGED_SOURCE = 'sous.plans';
export const MEAL_PLAN_CHANGED_DETAIL_TYPE = 'MealPlanChanged';

export type MealPlanChangeKind = 'day_added' | 'day_removed' | 'day_replaced';

export interface MealPlanChangedEvent {
  type: 'MealPlanChanged';
  householdId: HouseholdId;
  planId: PlanId;
  change: MealPlanChangeKind;
  day: IsoDate;
  /** Meal now assigned to `day`; absent for day_removed. */
  mealId?: MealId;
  /** Plan record version after the change, for consumers to drop stale events. */
  planVersion: number;
  occurredAt: IsoTimestamp;
}

/** Narrow publishing interface the Plan Service depends on. */
export interface PlanEventPublisher {
  /** Rejects if the event was not accepted. */
  publishMealPlanChanged(event: MealPlanChangedEvent): Promise<void>;
}

/** Minimal EventBridgeClient surface, injectable for tests. */
export interface EventBridgeSender {
  send(command: PutEventsCommand): Promise<PutEventsCommandOutput>;
}

export interface EventBridgePlanEventPublisherConfig {
  eventBusName: string;
  /** Defaults to a new EventBridgeClient using the ambient AWS config. */
  client?: EventBridgeSender;
}

export class EventPublishError extends Error {
  override readonly name = 'EventPublishError';
}

export class EventBridgePlanEventPublisher implements PlanEventPublisher {
  private readonly client: EventBridgeSender;

  constructor(private readonly config: EventBridgePlanEventPublisherConfig) {
    if (!config.eventBusName) throw new TypeError('eventBusName is required');
    this.client = config.client ?? (new EventBridgeClient({}) as EventBridgeSender);
  }

  async publishMealPlanChanged(event: MealPlanChangedEvent): Promise<void> {
    const out = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.config.eventBusName,
            Source: MEAL_PLAN_CHANGED_SOURCE,
            DetailType: MEAL_PLAN_CHANGED_DETAIL_TYPE,
            Detail: JSON.stringify(event),
            Time: new Date(event.occurredAt),
          },
        ],
      }),
    );
    if ((out.FailedEntryCount ?? 0) > 0) {
      const entry = out.Entries?.[0];
      throw new EventPublishError(
        `MealPlanChanged was not accepted: ${entry?.ErrorCode ?? 'unknown'} ${entry?.ErrorMessage ?? ''}`.trim(),
      );
    }
  }
}
