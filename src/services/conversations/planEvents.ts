/**
 * Bridges ConversationService plan refinements to the Plan Service's
 * MealPlanChanged event (Requirement 7.5), so a chat refinement of a plan day
 * regenerates the Grocery_List exactly like `PUT /plans/{id}/days/{day}`.
 */
import type { PlanEventPublisher } from '../plans/events.js';
import type { PlanChangedEvent } from './service.js';

export function publishPlanRefinement(
  publisher: PlanEventPublisher,
  now: () => Date = () => new Date(),
): (event: PlanChangedEvent) => Promise<void> {
  return (event) =>
    publisher.publishMealPlanChanged({
      type: 'MealPlanChanged',
      householdId: event.householdId,
      planId: event.planId,
      change: 'day_replaced',
      day: event.day,
      mealId: event.mealId,
      planVersion: event.planVersion,
      occurredAt: now().toISOString(),
    });
}
