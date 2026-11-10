/**
 * "New plan" form (Requirements 13.12, 3.1, 3.7, 3.8): a week or 1–31 days,
 * an optional start date, context, and Presets. Generation runs for up to
 * 32 s; a progress state is shown and the User may leave the screen. If the
 * client times out, `GET /plans` is refetched in case the server saved the
 * plan anyway, before any error is shown.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarDays, Sparkles } from 'lucide-react';
import type { Preset } from '@sous/domain/types';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { GeneratePlanRequest, ListPlansResponse, StoredPlan } from '../../api/types';
import { Button, ErrorBanner, TextArea, TextField, isOverLimit, useToast, cx } from '../../ui';
import { GenerationProgress } from './GenerationProgress';
import { PlanPresetPicker, presetConflict } from './PlanPresetPicker';
import { MAX_PLAN_DAYS, MIN_PLAN_DAYS, PLAN_CONTEXT_MAX, WEEK_DAYS, isIsoDate } from './dates';

export { PLAN_CONTEXT_MAX };
import { errorCode, errorMessage, planIds, planKey, plansListKey, usePlansList } from './planQueries';

/** Shown when generation timed out and a follow-up check found no saved plan. */
export const TIMEOUT_NOT_SAVED_MESSAGE =
  'Sous took too long to build this plan and it wasn’t saved. Please try again, or try fewer days.';

type RangeChoice = 'week' | 'custom';

export interface NewPlanFormValues {
  range: RangeChoice;
  /** Raw text of the day-count input. */
  days: string;
  startDate: string;
  contextInput: string;
  presets: Preset[];
}

/** Either a ready-to-send request, or per-field error messages (`presets: 'conflict'` is a flag, not display text). */
export type NewPlanValidation = { ok: true; request: GeneratePlanRequest; dayCount: number } | { ok: false; errors: Partial<Record<'days' | 'startDate' | 'contextInput' | 'presets', string>> };

export const DAYS_ERROR = `Choose between ${MIN_PLAN_DAYS} and ${MAX_PLAN_DAYS} days.`;

/** Builds the `POST /plans` body, or field errors that block submission. */
export function validateNewPlan(values: NewPlanFormValues): NewPlanValidation {
  const errors: Partial<Record<'days' | 'startDate' | 'contextInput' | 'presets', string>> = {};
  let dayCount = WEEK_DAYS;
  if (values.range === 'custom') {
    const trimmed = values.days.trim();
    const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    if (!Number.isInteger(n) || n < MIN_PLAN_DAYS || n > MAX_PLAN_DAYS) errors.days = DAYS_ERROR;
    else dayCount = n;
  }
  if (values.startDate !== '' && !isIsoDate(values.startDate)) errors.startDate = 'Enter a valid date.';
  if (isOverLimit(values.contextInput, PLAN_CONTEXT_MAX)) errors.contextInput = `Keep it to ${PLAN_CONTEXT_MAX} characters.`;
  const conflict = presetConflict(values.presets);
  if (conflict) errors.presets = 'conflict';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const context = values.contextInput.trim();
  const request: GeneratePlanRequest = {
    ...(values.range === 'week' ? { weekly: true as const } : { rangeDays: dayCount }),
    ...(values.startDate ? { startDate: values.startDate } : {}),
    ...(context ? { contextInput: context } : {}),
    ...(values.presets.length > 0 ? { presets: values.presets } : {}),
  };
  return { ok: true, request, dayCount };
}

/**
 * Finds a plan saved by a request whose response never arrived: a plan id
 * missing from the list taken before submission, or, when no list was
 * cached, the newest plan with the requested length (and start date, when
 * one was given).
 */
export function findSavedPlan(
  list: ListPlansResponse,
  knownIds: string[] | null,
  request: { dayCount: number; startDate?: string },
): string | undefined {
  if (knownIds) {
    const known = new Set(knownIds);
    return list.plans.find((p) => !known.has(p.planId))?.planId;
  }
  return list.plans.find((p) => p.rangeDays === request.dayCount && (request.startDate === undefined || p.startDate === request.startDate))?.planId;
}

interface GenerateVariables {
  request: GeneratePlanRequest;
  dayCount: number;
  /** Plan ids known before submitting, or `null` if the list was never loaded. Used to spot a plan saved after a timeout. */
  knownIds: string[] | null;
}

export interface NewPlanProps {
  /** Where to go once a plan exists. Defaults to `/plans/{planId}`. */
  planHref?: (planId: string) => string;
}

/** The plan-creation screen: form while idle, progress while generating. */
export function NewPlan({ planHref = (id) => `/plans/${id}` }: NewPlanProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { activeHouseholdId } = useActiveHousehold();
  const plansList = usePlansList();

  // Generation can outlive this screen. Track mount state so a finished plan
  // navigates directly if the user is still here, or shows a toast with a link if not.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [values, setValues] = useState<NewPlanFormValues>({ range: 'week', days: '7', startDate: '', contextInput: '', presets: [] });
  const [submitted, setSubmitted] = useState(false);
  const [checkingSaved, setCheckingSaved] = useState(false);
  const validation = validateNewPlan(values);
  const fieldErrors = !validation.ok && submitted ? validation.errors : {};

  /** Announces a finished plan: navigate if still on this screen, otherwise a persistent toast with a "View plan" action. */
  function planReady(planId: string, message: string) {
    if (mounted.current) {
      navigate(planHref(planId));
      toast.show({ message, tone: 'success' });
    } else {
      toast.show({ message, tone: 'success', durationMs: null, action: { label: 'View plan', onAction: () => navigate(planHref(planId)) } });
    }
  }

  const generate = useMutation<StoredPlan, unknown, GenerateVariables>({
    mutationFn: async ({ request }) => api.generatePlan(request),
    onSuccess: (stored) => {
      queryClient.setQueryData(planKey(activeHouseholdId, stored.plan.planId), stored);
      void queryClient.invalidateQueries({ queryKey: plansListKey(activeHouseholdId) });
      planReady(stored.plan.planId, 'Your plan is ready.');
    },
    onError: async (error, variables) => {
      if (errorCode(error) !== 'REQUEST_TIMEOUT') {
        if (!mounted.current) toast.show({ message: errorMessage(error), tone: 'error' });
        return;
      }
      // The server may have stored the plan after the client gave up.
      if (mounted.current) setCheckingSaved(true);
      try {
        const list = await queryClient.fetchQuery({
          queryKey: plansListKey(activeHouseholdId),
          queryFn: ({ signal }) => api.listPlans({ signal }),
          staleTime: 0,
        });
        const startDate = variables.request.startDate;
        const found = findSavedPlan(list, variables.knownIds, { dayCount: variables.dayCount, ...(startDate ? { startDate } : {}) });
        if (found) {
          planReady(found, 'Your plan was saved.');
          return;
        }
      } catch {
        // Fall through to the timeout message.
      } finally {
        if (mounted.current) setCheckingSaved(false);
      }
      if (!mounted.current) toast.show({ message: TIMEOUT_NOT_SAVED_MESSAGE, tone: 'error' });
    },
  });

  const busy = generate.isPending || checkingSaved;
  const timedOut = generate.isError && errorCode(generate.error) === 'REQUEST_TIMEOUT';

  function update<K extends keyof NewPlanFormValues>(key: K, value: NewPlanFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!validation.ok || busy) return;
    generate.reset();
    generate.mutate({ request: validation.request, dayCount: validation.dayCount, knownIds: planIds(plansList.data) });
  }

  const dayCount = validation.ok ? validation.dayCount : values.range === 'week' ? WEEK_DAYS : Number(values.days) || 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link to="/plans" className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text">
          <ArrowLeft aria-hidden="true" className="size-4" /> Plans
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">New plan</h1>
        <p className="text-text-muted">Sous plans one meal for every day, using your household&rsquo;s preferences.</p>
      </div>

      {busy ? (
        <GenerationProgress dayCount={dayCount} {...(checkingSaved ? { detail: 'That took a while. Checking whether your plan was saved…' } : {})} />
      ) : (
        <form
          noValidate
          onSubmit={onSubmit}
          aria-label="New plan"
          className="flex flex-col gap-6 rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6"
        >
          {generate.isError && (
            <ErrorBanner
              title="No plan this time"
              message={timedOut ? TIMEOUT_NOT_SAVED_MESSAGE : errorMessage(generate.error)}
            />
          )}

          <fieldset className="flex flex-col">
            <legend className="mb-3 text-sm font-medium">How long?</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['week', 'custom'] as const).map((choice) => (
                <label
                  key={choice}
                  className={cx(
                    'flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-focus/40',
                    values.range === choice ? 'border-accent bg-accent-soft text-accent-text' : 'border-border-strong bg-surface hover:bg-surface-2',
                  )}
                >
                  <input
                    type="radio"
                    name="plan-range"
                    value={choice}
                    checked={values.range === choice}
                    onChange={() => update('range', choice)}
                    className="sr-only"
                  />
                  {choice === 'week' ? 'A week' : 'Custom'}
                </label>
              ))}
            </div>
          </fieldset>

          {values.range === 'custom' && (
            <TextField
              label="Number of days"
              type="number"
              inputMode="numeric"
              min={MIN_PLAN_DAYS}
              max={MAX_PLAN_DAYS}
              step={1}
              value={values.days}
              onChange={(e) => update('days', e.target.value)}
              hint={`From ${MIN_PLAN_DAYS} to ${MAX_PLAN_DAYS} days.`}
              error={fieldErrors.days}
            />
          )}

          <TextField
            label="Start date"
            optional
            type="date"
            value={values.startDate}
            onChange={(e) => update('startDate', e.target.value)}
            hint="Leave empty to start today."
            error={fieldErrors.startDate}
          />

          <PlanPresetPicker value={values.presets} onChange={(next) => update('presets', next)} />

          <TextArea
            label="Anything to keep in mind?"
            optional
            placeholder="Light lunches, a pasta night, use up the squash…"
            value={values.contextInput}
            onChange={(e) => update('contextInput', e.target.value)}
            maxCodePoints={PLAN_CONTEXT_MAX}
            error={fieldErrors.contextInput}
          />

          <Button
            type="submit"
            size="lg"
            fullWidth
            icon={<Sparkles aria-hidden="true" className="size-5" />}
            disabled={Boolean(presetConflict(values.presets)) || isOverLimit(values.contextInput, PLAN_CONTEXT_MAX)}
          >
            {values.range === 'week' ? 'Plan my week' : 'Generate plan'}
          </Button>
          <p className="-mt-3 flex items-center justify-center gap-1.5 text-xs text-text-muted">
            <CalendarDays aria-hidden="true" className="size-3.5" /> Takes up to half a minute.
          </p>
        </form>
      )}
    </div>
  );
}
