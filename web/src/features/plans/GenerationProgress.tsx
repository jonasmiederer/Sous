/**
 * Progress state for plan generation, which can take around 25 s. The bar
 * eases toward 90 % and never reaches the end, so it never claims the plan
 * is done before the server answers.
 */
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

export const PROGRESS_STEPS = [
  'Reading your household’s tastes',
  'Balancing cuisines across the days',
  'Choosing a main ingredient for each meal',
  'Checking every dish against your exclusions',
  'Writing up ingredients and steps',
  'Almost there, plating the plan',
] as const;

const STEP_MS = 4_500;
const TICK_MS = 250;
/** Time constant of the easing curve; about 63 % after this long. */
const EASE_MS = 11_000;
const CEILING = 0.9;

/** Fraction of the bar to fill after `elapsedMs`. Always below `CEILING`. */
export function progressFraction(elapsedMs: number): number {
  return CEILING * (1 - Math.exp(-Math.max(0, elapsedMs) / EASE_MS));
}

export interface GenerationProgressProps {
  dayCount: number;
  /** Shown under the step text, for example "Checking whether your plan was saved…". */
  detail?: string;
}

export function GenerationProgress({ dayCount, detail }: GenerationProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const step = PROGRESS_STEPS[Math.min(PROGRESS_STEPS.length - 1, Math.floor(elapsed / STEP_MS))];
  const percent = Math.round(progressFraction(elapsed) * 100);
  return (
    <section
      aria-labelledby="plan-progress-title"
      className="flex flex-col gap-5 rounded-3xl border border-border bg-surface p-6 shadow-card"
    >
      <div className="flex items-start gap-4">
        <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
          <Sparkles className="size-6 motion-safe:animate-pulse" />
        </div>
        <div className="min-w-0">
          <h2 id="plan-progress-title" className="text-lg font-semibold tracking-tight">
            Cooking up your {dayCount === 7 ? 'week' : `${dayCount}-day plan`}
          </h2>
          <p role="status" aria-live="polite" className="mt-1 text-sm text-text-muted">
            {detail ?? `${step}…`}
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Generating plan"
        aria-valuetext="In progress"
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
      <p className="text-sm text-text-muted">
        This usually takes under half a minute. You can leave this screen; we&rsquo;ll let you know when your plan is ready.
      </p>
    </section>
  );
}
