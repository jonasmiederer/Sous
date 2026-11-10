/** In-memory PlanEventPublisher for tests, with failure injection. */
import type { MealPlanChangedEvent, PlanEventPublisher } from '../events.js';

export class InMemoryPlanEventPublisher implements PlanEventPublisher {
  readonly events: MealPlanChangedEvent[] = [];
  private failures = 0;

  /** Makes the next `count` publishes reject. */
  failNext(count = 1): void {
    this.failures += count;
  }

  async publishMealPlanChanged(event: MealPlanChangedEvent): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('injected publish failure');
    }
    this.events.push(structuredClone(event));
  }
}
