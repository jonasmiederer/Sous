import { describe, expect, it } from 'vitest';
import { InMemoryPlanEventPublisher } from '../plans/testing/inMemoryPlanEventPublisher.js';
import { publishPlanRefinement } from './planEvents.js';

describe('publishPlanRefinement', () => {
  it('publishes a day_replaced MealPlanChanged event carrying the new plan version', async () => {
    const publisher = new InMemoryPlanEventPublisher();
    const at = new Date('2025-01-01T12:00:00.000Z');
    await publishPlanRefinement(publisher, () => at)({
      householdId: 'hh-1',
      planId: 'plan-1',
      day: '2025-01-02',
      mealId: 'meal-9',
      planVersion: 3,
    });
    expect(publisher.events).toEqual([
      {
        type: 'MealPlanChanged',
        householdId: 'hh-1',
        planId: 'plan-1',
        change: 'day_replaced',
        day: '2025-01-02',
        mealId: 'meal-9',
        planVersion: 3,
        occurredAt: at.toISOString(),
      },
    ]);
  });
});
