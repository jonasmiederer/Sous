/**
 * `/grocery`: pick the plan to shop for. Plans are listed as `GET /plans`
 * returns them, newest first (Requirement 13.13).
 */
import { Link } from 'react-router';
import { ChevronRight, ShoppingBasket } from 'lucide-react';
import { AsyncView, EmptyState, cx } from '../../ui';
import { BUTTON_BASE, BUTTON_VARIANTS } from '../../ui/Button';
import type { PlanSummary } from '../../api/types';
import { dayCountLabel, rangeLabel } from '../plans/dates';
import { errorMessage, usePlansList } from '../plans/planQueries';

const LINK_BUTTON = cx(BUTTON_BASE, BUTTON_VARIANTS.primary, 'min-h-11 px-4 text-sm');

export interface GroceryIndexProps {
  listHref?: (planId: string) => string;
  newPlanHref?: string;
}

export function GroceryIndex({ listHref = (id) => `/grocery/${id}`, newPlanHref = '/plans/new' }: GroceryIndexProps) {
  const plans = usePlansList();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Grocery</h1>
        <p className="mt-1.5 text-text-muted">Pick a plan and get one list for the shop.</p>
      </div>
      <AsyncView
        query={{ ...plans, data: plans.data?.plans }}
        errorMessage={errorMessage}
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            icon={<ShoppingBasket />}
            title="No plans yet"
            description="Plan some meals first. Sous turns the plan into a single shopping list."
            action={
              <Link to={newPlanHref} className={LINK_BUTTON}>
                Plan my week
              </Link>
            }
          />
        }
      >
        {(list) => (
          <ul className="flex flex-col gap-3" aria-label="Plans to shop for">
            {list.map((plan) => (
              <li key={plan.planId}>
                <PlanLink plan={plan} href={listHref(plan.planId)} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </div>
  );
}

function PlanLink({ plan, href }: { plan: PlanSummary; href: string }) {
  return (
    <Link
      to={href}
      className="group flex min-h-16 items-center gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
    >
      <div aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
        <ShoppingBasket className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-text">{rangeLabel(plan.startDate, plan.endDate)}</p>
        <p className="text-sm text-text-muted">{dayCountLabel(plan.rangeDays)}</p>
      </div>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
