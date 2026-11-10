import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetExpiredError, createBudget } from './budget.js';

describe('createBudget', () => {
  afterEach(() => vi.useRealTimers());

  it('tracks remaining time on the injected monotonic clock', () => {
    let t = 1_000;
    const budget = createBudget(8_000, () => t);
    expect(budget.deadline).toBe(9_000);
    expect(budget.remainingMs()).toBe(8_000);
    t = 6_000;
    expect(budget.remainingMs()).toBe(3_000);
    expect(budget.expired()).toBe(false);
    t = 10_000;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.expired()).toBe(true);
    budget.dispose();
  });

  it('aborts its signal at the deadline', () => {
    vi.useFakeTimers();
    const budget = createBudget(500);
    vi.advanceTimersByTime(499);
    expect(budget.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(BudgetExpiredError);
  });

  it('does not abort after dispose', () => {
    vi.useFakeTimers();
    const budget = createBudget(500);
    budget.dispose();
    vi.advanceTimersByTime(1_000);
    expect(budget.signal.aborted).toBe(false);
  });

  it('rejects invalid totals', () => {
    expect(() => createBudget(-1)).toThrow(RangeError);
    expect(() => createBudget(Number.NaN)).toThrow(RangeError);
  });
});
