/**
 * Per-request deadline helper (Requirement 12.13). Uses a monotonic clock
 * (`performance.now()` by default) so wall-clock changes cannot extend or
 * shorten a request's budget.
 */

export type MonotonicClock = () => number;

export interface Budget {
  /** Monotonic timestamp (ms) at which the budget runs out. */
  readonly deadline: number;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  expired(): boolean;
  /** Aborts with `BudgetExpiredError` when the deadline passes. */
  readonly signal: AbortSignal;
  /** Clears the timer; call when the request finishes. */
  dispose(): void;
}

export class BudgetExpiredError extends Error {
  override readonly name = 'BudgetExpiredError';
  constructor() {
    super('Request budget expired.');
  }
}

export function createBudget(totalMs: number, now: MonotonicClock = () => performance.now()): Budget {
  if (!Number.isFinite(totalMs) || totalMs < 0) throw new RangeError('totalMs must be a non-negative finite number.');
  const deadline = now() + totalMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new BudgetExpiredError()), totalMs);
  timer.unref?.();
  return {
    deadline,
    remainingMs: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
