/**
 * Shared fast-check harness for property-based tests.
 *
 * - `PBT_NUM_RUNS` defaults to 100 (minimum required by the design). It can be
 *   raised via the PBT_NUM_RUNS env var but never lowered below 100.
 * - `propertyTag(n, text)` builds the required tag string
 *   `Feature: meal-planner, Property N: ...`, used as the test name.
 */
import fc from 'fast-check';

export const MIN_NUM_RUNS = 100;

function resolveNumRuns(): number {
  const fromEnv = Number(process.env.PBT_NUM_RUNS);
  return Number.isFinite(fromEnv) && fromEnv > MIN_NUM_RUNS ? Math.floor(fromEnv) : MIN_NUM_RUNS;
}

export const PBT_NUM_RUNS = resolveNumRuns();

// Apply globally so any fc.assert call inherits the default.
fc.configureGlobal({ numRuns: PBT_NUM_RUNS });

export const FEATURE_NAME = 'meal-planner';

export function propertyTag(propertyNumber: number, propertyText: string): string {
  return `Feature: ${FEATURE_NAME}, Property ${propertyNumber}: ${propertyText}`;
}

/**
 * fc.assert wrapper that enforces at least MIN_NUM_RUNS runs even if the
 * caller passes a smaller numRuns.
 */
export function assertProperty<Ts>(
  property: fc.IRawProperty<Ts>,
  params: fc.Parameters<Ts> = {},
): void {
  const numRuns = Math.max(params.numRuns ?? PBT_NUM_RUNS, MIN_NUM_RUNS);
  fc.assert(property, { ...params, numRuns });
}

export async function assertPropertyAsync<Ts>(
  property: fc.IAsyncPropertyWithHooks<Ts> | fc.IRawProperty<Ts>,
  params: fc.Parameters<Ts> = {},
): Promise<void> {
  const numRuns = Math.max(params.numRuns ?? PBT_NUM_RUNS, MIN_NUM_RUNS);
  await fc.assert(property, { ...params, numRuns });
}

export { fc };
