/**
 * The Household's plans, newest first (`GET /plans`), with a "New plan" action.
 */
import { Link } from 'react-router';
import { CalendarDays, ChevronRight, Plus } from 'lucide-react';
import { AsyncView, EmptyState, cx } from '../../ui';
import { BUTTON_BASE, BUTTON_VARIANTS } from '../../ui/Button';
import type { PlanSummary } from '../../api/types';
import { dayCountLabel, rangeLabel, weekdayLabel } from './dates';
import { errorMessage, usePlansList } from './planQueries';

const LINK_BUTTON = cx(BUTTON_BASE, BUTTON_VARIANTS.primary, 'min-h-11 px-4 text-sm');

export interface PlansListProps {
  newPlanHref?: string;
  planHref?: (planId: string) => string;
}

export function PlansList({ newPlanHref = '/plans/new', planHref = (id) => `/plans/${id}` }: PlansListProps) {
  const plans = usePlansList();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Plans</h1>
          <p className="mt-1.5 text-text-muted">A meal for every day, ready to shop for.</p>
        </div>
        <Link to={newPlanHref} className={LINK_BUTTON}>
          <Plus aria-hidden="true" className="size-4" /> New plan
        </Link>
      </div>
      <AsyncView
        query={{ ...plans, data: plans.data?.plans }}
        errorMessage={errorMessage}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={<CalendarDays />}
            title="No plans yet"
            description="Plan a week of meals in about half a minute."
            action={
              <Link to={newPlanHref} className={LINK_BUTTON}>
                Plan my week
              </Link>
            }
          />
        }
      >
        {(list) => (
          <ul className="flex flex-col gap-3" aria-label="Plans">
            {list.map((plan) => (
              <li key={plan.planId}>
                <PlanCardLink plan={plan} href={planHref(plan.planId)} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </div>
  );
}

function PlanCardLink({ plan, href }: { plan: PlanSummary; href: string }) {
  return (
    <Link
      to={href}
      className="group flex min-h-16 items-center gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
    >
      <div aria-hidden="true" className="flex size-11 shrink-0 flex-col items-center justify-center rounded-xl bg-accent-soft text-accent-text">
        <span className="text-[0.65rem] font-semibold uppercase leading-none">{weekdayLabel(plan.startDate).slice(0, 3)}</span>
        <span className="text-base font-semibold leading-tight">{Number(plan.startDate.slice(8, 10))}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-text">{rangeLabel(plan.startDate, plan.endDate)}</p>
        <p className="text-sm text-text-muted">{dayCountLabel(plan.rangeDays)}</p>
      </div>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
