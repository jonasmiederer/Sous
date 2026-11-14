/**
 * `/grocery`: your grocery lists (standalone lists you can create, fill from
 * meals and delete) and the plans you can shop for. Plans are listed as
 * `GET /plans` returns them, newest first (Requirement 13.13).
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, Plus, ShoppingBasket, Trash2 } from 'lucide-react';
import { AsyncView, Button, EmptyState, ErrorBanner, IconButton, TextField, cx } from '../../ui';
import { BUTTON_BASE, BUTTON_VARIANTS } from '../../ui/Button';
import type { PlanSummary, ShoppingListSummary } from '../../api/types';
import { dayCountLabel, rangeLabel } from '../plans/dates';
import { errorMessage, usePlansList } from '../plans/planQueries';
import { ConfirmDeleteListDialog } from './ConfirmDeleteListDialog';
import { useCreateShoppingList, useDeleteShoppingList, useShoppingLists } from './shoppingListQueries';

const LINK_BUTTON = cx(BUTTON_BASE, BUTTON_VARIANTS.primary, 'min-h-11 px-4 text-sm');

export interface GroceryIndexProps {
  listHref?: (planId: string) => string;
  /** Link to a standalone list. */
  shoppingListHref?: (listId: string) => string;
  newPlanHref?: string;
}

export function GroceryIndex({ listHref = (id) => `/grocery/${id}`, shoppingListHref = (id) => `/grocery/lists/${id}`, newPlanHref = '/plans/new' }: GroceryIndexProps) {
  const plans = usePlansList();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Grocery</h1>
        <p className="mt-1.5 text-text-muted">Keep lists for the shop, or build one from a plan.</p>
      </div>
      <ShoppingLists listHref={shoppingListHref} />
      <h2 className="-mb-3 text-lg font-semibold tracking-tight">From a plan</h2>
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

/** Standalone lists: create an empty one, open one, or delete one. */
function ShoppingLists({ listHref }: { listHref: (listId: string) => string }) {
  const lists = useShoppingLists();
  const create = useCreateShoppingList();
  const remove = useDeleteShoppingList();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<ShoppingListSummary | null>(null);

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (create.isPending) return;
    create.mutate(
      { ...(name.trim() ? { name: name.trim() } : {}) },
      {
        onSuccess: (result) => {
          setName('');
          navigate(listHref(result.shoppingList.listId));
        },
      },
    );
  }

  return (
    <section aria-labelledby="shopping-lists-heading" className="flex flex-col gap-3">
      <h2 id="shopping-lists-heading" className="text-lg font-semibold tracking-tight">
        Your lists
      </h2>

      <form onSubmit={onCreate} aria-label="New grocery list" className="flex items-end gap-2">
        <TextField
          label="New empty list"
          placeholder="Name, e.g. Weekend BBQ"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          containerClassName="min-w-0 flex-1"
        />
        <Button type="submit" variant="secondary" loading={create.isPending} icon={<Plus aria-hidden="true" className="size-4" />}>
          Create
        </Button>
      </form>
      {create.isError && <ErrorBanner message={errorMessage(create.error)} />}

      <AsyncView
        query={{ ...lists, data: lists.data?.shoppingLists }}
        errorMessage={errorMessage}
        isEmpty={(list) => list.length === 0}
        empty={<p className="rounded-2xl border border-dashed border-border-strong p-4 text-center text-text-muted">No lists yet. Create one above, or add a meal from Suggestions.</p>}
      >
        {(list) => (
          <ul className="flex flex-col gap-3" aria-label="Grocery lists">
            {list.map((item) => (
              <li key={item.listId} className="flex items-center gap-2">
                <Link
                  to={listHref(item.listId)}
                  className="group flex min-h-16 min-w-0 flex-1 items-center gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
                >
                  <div aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                    <ShoppingBasket className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-text">{item.name}</p>
                    <p className="text-sm text-text-muted">{item.itemCount} {item.itemCount === 1 ? 'item' : 'items'}</p>
                  </div>
                  <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" />
                </Link>
                <IconButton label={`Delete ${item.name}`} icon={<Trash2 />} onClick={() => setDeleting(item)} />
              </li>
            ))}
          </ul>
        )}
      </AsyncView>

      <ConfirmDeleteListDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="The list and its items are deleted. This can’t be undone."
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.listId, { onSuccess: () => setDeleting(null) });
        }}
      />
    </section>
  );
}
