/**
 * One plan, day by day (Requirements 13.12, 3.6). Each assigned day can be
 * swapped (agent-generated, optional note) or removed; unassigned dates in
 * the range, and the days just before and after it, can get a Meal.
 *
 * Optional integration points, wired by the routing task:
 * - `onRefineDay` adds a "Refine in chat" action per day.
 * - `onOpenGrocery` replaces the grocery link with a button; otherwise the
 *   link goes to `groceryHref(planId)` (default `/grocery/{planId}`).
 * - `planId` defaults to the `:planId` route param.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, MessageCircle, Plus, Repeat2, ShoppingBasket, Trash2 } from 'lucide-react';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { messageFor } from '../../api/errors';
import type { IsoDate, Meal, PlanEditResult, StoredPlan } from '../../api/types';
import { AsyncView, Button, ErrorBanner, SkeletonList, cx, useToast } from '../../ui';
import { BUTTON_BASE, BUTTON_VARIANTS } from '../../ui/Button';
import { DayEditor, type DayEditorMode } from './DayEditor';
import { DeletePlanDialog } from './DeletePlanDialog';
import { addableDays, dateRange, dayCountLabel, rangeLabel, shortDateLabel, weekdayLabel } from './dates';
import { applyPlanEdit, errorMessage, planKey, plansListKey, usePlan } from './planQueries';

/** Identifies the day a user wants to refine in chat. */
export interface RefineDayTarget {
  planId: string;
  day: IsoDate;
  meal: Meal;
}

export interface PlanViewProps {
  /** Overrides the `:planId` route param. */
  planId?: string;
  /** When set, each day card shows a "Refine" action. */
  onRefineDay?: (target: RefineDayTarget) => void;
  /** When set, the grocery link renders as a button that calls this instead. */
  onOpenGrocery?: (planId: string) => void;
  /** Builds the grocery link target. Defaults to `/grocery/{planId}`. */
  groceryHref?: (planId: string) => string;
  /** Where the back link and the post-delete redirect go. Defaults to `/plans`. */
  plansHref?: string;
}

/** State of the open DayEditor dialog; `null` means the dialog is closed. */
interface EditorState {
  mode: DayEditorMode;
  day: IsoDate;
  /** Name of the meal being swapped or removed (unused when adding). */
  mealName?: string;
  /** Dates the user may pick from when adding a day outside the range. */
  choices?: IsoDate[];
}

/** Toast text shown after each kind of successful plan edit. */
const CHANGE_MESSAGES: Record<PlanEditResult['change'], string> = {
  day_replaced: 'Meal swapped.',
  day_added: 'Meal added.',
  day_removed: 'Meal removed.',
};

/** Route-level wrapper: loads the plan and renders `PlanDetail` once it is available. */
export function PlanView({ planId: planIdProp, onRefineDay, onOpenGrocery, groceryHref = (id) => `/grocery/${id}`, plansHref = '/plans' }: PlanViewProps) {
  const params = useParams();
  const planId = planIdProp ?? params.planId ?? '';
  const plan = usePlan(planId);
  return (
    <div className="flex flex-col gap-6">
      <Link to={plansHref} className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text">
        <ArrowLeft aria-hidden="true" className="size-4" /> Plans
      </Link>
      <AsyncView
        query={plan}
        errorMessage={errorMessage}
        loading={
          <>
            <h1 className="sr-only">Plan</h1>
            <SkeletonList rows={4} label="Loading plan" />
          </>
        }
      >
        {(stored) => (
          <PlanDetail
            stored={stored}
            refetch={() => void plan.refetch()}
            refetching={plan.isFetching}
            onRefineDay={onRefineDay}
            onOpenGrocery={onOpenGrocery}
            groceryHref={groceryHref}
            plansHref={plansHref}
          />
        )}
      </AsyncView>
    </div>
  );
}

interface PlanDetailProps {
  stored: StoredPlan;
  refetch: () => void;
  refetching: boolean;
  onRefineDay: PlanViewProps['onRefineDay'];
  onOpenGrocery: PlanViewProps['onOpenGrocery'];
  groceryHref: (planId: string) => string;
  plansHref: string;
}

/** Loaded-plan view: day list, grocery link, delete, and the swap/add/remove editor. */
function PlanDetail({ stored, refetch, refetching, onRefineDay, onOpenGrocery, groceryHref, plansHref }: PlanDetailProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const { activeHouseholdId } = useActiveHousehold();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [conflict, setConflict] = useState(false);

  const { plan } = stored;
  // Plan days only reference meals by id; resolve them against the stored meal list.
  const mealsById = useMemo(() => new Map(stored.meals.map((m) => [m.mealId, m])), [stored.meals]);
  // day -> Meal. A day absent from this map has no meal (rendered as an empty card).
  const assigned = useMemo(() => new Map(plan.days.map((d) => [d.day, mealsById.get(d.mealId)])), [plan.days, mealsById]);
  const days = dateRange(plan.startDate, plan.endDate);
  const addable = addableDays(plan);
  // Addable dates outside the plan's range (the days just before and after it).
  // ISO dates compare correctly as plain strings.
  const outside = addable.filter((d) => d < plan.startDate || d > plan.endDate);

  /** Applies an edit result to the cached plan without refetching, then refreshes the list. */
  function onDone(result: PlanEditResult) {
    queryClient.setQueryData<StoredPlan>(planKey(activeHouseholdId, plan.planId), (current) => applyPlanEdit(current ?? stored, result));
    void queryClient.invalidateQueries({ queryKey: plansListKey(activeHouseholdId) });
    setEditor(null);
    setConflict(false);
    toast.show({ message: CHANGE_MESSAGES[result.change], tone: 'success' });
  }

  /** Drops the deleted plan from the cache and returns to the plans list. */
  function onDeleted() {
    queryClient.removeQueries({ queryKey: planKey(activeHouseholdId, plan.planId) });
    void queryClient.invalidateQueries({ queryKey: plansListKey(activeHouseholdId) });
    toast.show({ message: 'Plan deleted.', tone: 'success' });
    navigate(plansHref);
  }

  const groceryClass = cx(BUTTON_BASE, BUTTON_VARIANTS.secondary, 'min-h-11 px-4 text-sm');
  const groceryContent = (
    <>
      <ShoppingBasket aria-hidden="true" className="size-4" /> Grocery list
    </>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{rangeLabel(plan.startDate, plan.endDate)}</h1>
          <p className="mt-1.5 text-text-muted">
            {dayCountLabel(plan.rangeDays)} · {plan.days.length} {plan.days.length === 1 ? 'meal' : 'meals'}
          </p>
        </div>
        {onOpenGrocery ? (
          <button type="button" className={groceryClass} onClick={() => onOpenGrocery(plan.planId)}>
            {groceryContent}
          </button>
        ) : (
          <Link to={groceryHref(plan.planId)} className={groceryClass}>
            {groceryContent}
          </Link>
        )}
      </div>

      {/* Shown when the server rejects an edit because the plan changed elsewhere. */}
      {conflict && (
        <ErrorBanner
          title="This plan changed"
          message={messageFor('PLAN_CONFLICT')}
          onRetry={() => {
            setConflict(false);
            refetch();
          }}
          retryLabel="Reload plan"
          retrying={refetching}
        />
      )}

      <ol aria-label="Days" className="grid gap-3 lg:grid-cols-2">
        {days.map((day) => {
          const meal = assigned.get(day);
          const hasDay = assigned.has(day);
          return (
            <li key={day}>
              {hasDay && meal ? (
                <DayCard
                  day={day}
                  meal={meal}
                  onReplace={() => setEditor({ mode: 'replace', day, mealName: meal.name })}
                  onRemove={() => setEditor({ mode: 'remove', day, mealName: meal.name })}
                  {...(onRefineDay ? { onRefine: () => onRefineDay({ planId: plan.planId, day, meal }) } : {})}
                />
              ) : (
                <EmptyDayCard day={day} onAdd={() => setEditor({ mode: 'add', day, choices: [day] })} />
              )}
            </li>
          );
        })}
      </ol>

      {outside.length > 0 && (
        <Button
          variant="ghost"
          icon={<CalendarPlus aria-hidden="true" className="size-4" />}
          className="self-start"
          onClick={() => setEditor({ mode: 'add', day: outside[outside.length - 1]!, choices: outside })}
        >
          Add a day
        </Button>
      )}

      <Button
        variant="ghost"
        icon={<Trash2 aria-hidden="true" className="size-4" />}
        className="self-start"
        onClick={() => setDeleting(true)}
      >
        Delete plan
      </Button>

      <DeletePlanDialog
        open={deleting}
        planId={plan.planId}
        label={rangeLabel(plan.startDate, plan.endDate)}
        onClose={() => setDeleting(false)}
        onDeleted={onDeleted}
      />

      <DayEditor
        open={editor !== null}
        mode={editor?.mode ?? 'replace'}
        planId={plan.planId}
        day={editor?.day ?? plan.startDate}
        {...(editor?.mealName ? { mealName: editor.mealName } : {})}
        {...(editor?.choices ? { addableDays: editor.choices } : {})}
        onClose={() => setEditor(null)}
        onDone={onDone}
        onConflict={() => {
          setEditor(null);
          setConflict(true);
        }}
      />
    </>
  );
}

/** "Weekday · date" label shared by assigned and empty day cards. */
function DayHeading({ day }: { day: IsoDate }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
      {weekdayLabel(day)} · <span className="normal-case">{shortDateLabel(day)}</span>
    </p>
  );
}

interface DayCardProps {
  day: IsoDate;
  meal: Meal;
  onReplace: () => void;
  onRemove: () => void;
  onRefine?: () => void;
}

/** A day with an assigned meal: attributes, collapsible recipe, and swap/refine/remove actions. */
function DayCard({ day, meal, onReplace, onRemove, onRefine }: DayCardProps) {
  return (
    <article aria-label={`${weekdayLabel(day)}, ${shortDateLabel(day)}: ${meal.name}`} className="flex h-full flex-col gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex flex-col gap-1">
        <DayHeading day={day} />
        <h2 className="text-lg font-semibold leading-snug tracking-tight">{meal.name}</h2>
        {meal.attributes.length > 0 && (
          <ul aria-label="Attributes" className="mt-1 flex flex-wrap gap-1.5">
            {meal.attributes.map((attribute) => (
              <li key={attribute} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-text">
                {attribute}
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="group rounded-xl bg-surface-2 px-3 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium">
          Ingredients and steps
          <span aria-hidden="true" className="text-text-muted transition-transform group-open:rotate-45">
            <Plus className="size-4" />
          </span>
        </summary>
        <div className="flex flex-col gap-4 pb-3 text-sm">
          <div>
            <h3 className="mb-1.5 font-semibold">Ingredients</h3>
            <ul className="flex flex-col gap-1">
              {meal.ingredients.map((ingredient, index) => (
                <li key={`${ingredient.name}-${index}`} className="flex justify-between gap-3">
                  <span>{ingredient.name}</span>
                  <span className="shrink-0 tabular-nums text-text-muted">
                    {ingredient.quantity} {ingredient.unit}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1.5 font-semibold">Steps</h3>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5">
              {meal.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </details>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Repeat2 aria-hidden="true" className="size-4" />} onClick={onReplace} aria-label={`Swap ${meal.name}`}>
          Swap
        </Button>
        {onRefine && (
          <Button variant="ghost" icon={<MessageCircle aria-hidden="true" className="size-4" />} onClick={onRefine} aria-label={`Refine ${meal.name} in chat`}>
            Refine
          </Button>
        )}
        <Button variant="ghost" icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={onRemove} aria-label={`Remove ${meal.name}`} className="ml-auto">
          Remove
        </Button>
      </div>
    </article>
  );
}

/** Placeholder for a date inside the plan's range that has no meal yet. */
function EmptyDayCard({ day, onAdd }: { day: IsoDate; onAdd: () => void }) {
  return (
    <article
      aria-label={`${weekdayLabel(day)}, ${shortDateLabel(day)}: no meal`}
      className="flex h-full flex-col gap-3 rounded-2xl border border-dashed border-border-strong p-4"
    >
      <DayHeading day={day} />
      <p className="text-sm text-text-muted">No meal planned.</p>
      <Button variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} className="self-start" onClick={onAdd} aria-label={`Add a meal on ${weekdayLabel(day)}, ${shortDateLabel(day)}`}>
        Add meal
      </Button>
    </article>
  );
}
