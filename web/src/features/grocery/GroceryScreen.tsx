/**
 * `/grocery/:planId`: the consolidated Grocery_List for one plan
 * (Requirements 13.13, 7.1, 7.6).
 *
 * Built for one-handed use in a shop: each entry is a full-width tap target,
 * checked entries fade and move to a "Done" group, and a progress bar shows
 * how many are checked. Check state lives on the device (useGroceryChecks)
 * and resets whenever the list is regenerated.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Check, ChevronLeft, MessageSquare, Pencil, RefreshCw, RotateCcw, ShoppingBasket } from 'lucide-react';
import { AsyncView, Button, EmptyState, ErrorBanner, cx } from '../../ui';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { GroceryEntry, GroceryList } from '../../api/types';
import { rangeLabel } from '../plans/dates';
import { errorMessage, usePlan } from '../plans/planQueries';
import { GroceryEditor } from './GroceryEditor';
import { formatAmount, groceryEntryKey } from './format';
import { useGenerateGroceryList, useGroceryList } from './groceryQueries';
import { useGroceryChecks, type GroceryChecks } from './useGroceryChecks';

export interface GroceryScreenProps {
  /** Defaults to the `:planId` route parameter. */
  planId?: string;
  /** Opens chat refinement for this plan's list (wired by the app shell). */
  onRefine?: (planId: string) => void;
  /** Target of the back link. Defaults to `/grocery`. */
  indexHref?: string;
  /** Builds the link to the plan this list belongs to. Defaults to `/plans/{planId}`. */
  planHref?: (planId: string) => string;
}

/** Explains what "Regenerate" does, including that it clears local check marks. */
export const REGENERATE_HINT =
  'Regenerating rebuilds the list from the current plan and what is in your fridge. Checked items and your manual edits are cleared.';

/** Route-level screen. A `null` list means none has been generated for this plan yet. */
export function GroceryScreen({ planId: planIdProp, onRefine, indexHref = '/grocery', planHref = (id) => `/plans/${id}` }: GroceryScreenProps) {
  const params = useParams();
  const planId = planIdProp ?? params.planId ?? '';
  const list = useGroceryList(planId);
  const plan = usePlan(planId);
  const generate = useGenerateGroceryList(planId);
  const planInfo = plan.data?.plan;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link to={indexHref} className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-text-muted hover:text-text">
          <ChevronLeft aria-hidden="true" className="size-4" /> All grocery lists
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Grocery list</h1>
            {planInfo && (
              <p className="mt-1.5 text-text-muted">
                For{' '}
                <Link to={planHref(planId)} className="font-medium text-accent-text underline-offset-2 hover:underline">
                  {rangeLabel(planInfo.startDate, planInfo.endDate)}
                </Link>
              </p>
            )}
          </div>
          {onRefine && list.data && (
            <Button variant="secondary" icon={<MessageSquare aria-hidden="true" className="size-4" />} onClick={() => onRefine(planId)}>
              Refine in chat
            </Button>
          )}
        </div>
      </div>

      {generate.isError && <ErrorBanner title="Couldn't make the list" message={errorMessage(generate.error)} />}

      <AsyncView query={list} errorMessage={errorMessage}>
        {(data) =>
          data === null ? (
            <EmptyState
              icon={<ShoppingBasket />}
              title="No grocery list yet"
              description="Sous adds up the ingredients of every meal in this plan and leaves out what's already in your fridge."
              action={
                <Button size="lg" loading={generate.isPending} onClick={() => generate.mutate()}>
                  Make grocery list
                </Button>
              }
            />
          ) : (
            <GroceryListView
              list={data.groceryList}
              planId={planId}
              regenerating={generate.isPending}
              onRegenerate={() => generate.mutate()}
            />
          )
        }
      </AsyncView>
    </div>
  );
}

interface GroceryListViewProps {
  list: GroceryList;
  planId: string;
  regenerating: boolean;
  onRegenerate: () => void;
}

/** Shopping view: splits entries into "To buy" and "Done" using the device-local check state. */
function GroceryListView({ list, planId, regenerating, onRegenerate }: GroceryListViewProps) {
  const { activeHouseholdId } = useActiveHousehold();
  const checks = useGroceryChecks(activeHouseholdId, planId, list.generatedAt);
  // Checks are keyed by `generatedAt`, so regenerating the list starts fresh.
  // Rows keep their original index so entries sharing a key still get unique React keys.
  const rows = list.entries.map((entry, index) => ({ entry, key: groceryEntryKey(entry), index }));
  const toBuy = rows.filter((row) => !checks.isChecked(row.key));
  const done = rows.filter((row) => checks.isChecked(row.key));
  const [editing, setEditing] = useState(false);

  const editButton = (
    <Button variant="secondary" onClick={() => setEditing(true)} icon={<Pencil aria-hidden="true" className="size-4" />} className="self-start">
      Edit list
    </Button>
  );

  const regenerate = (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
      <Button variant="secondary" loading={regenerating} onClick={onRegenerate} icon={<RefreshCw aria-hidden="true" className="size-4" />} className="self-start">
        Regenerate
      </Button>
      <p className="text-sm text-text-muted">{REGENERATE_HINT}</p>
      <p className="text-xs text-text-muted">Made {generatedLabel(list.generatedAt)}</p>
    </div>
  );

  if (editing) {
    return <GroceryEditor planId={planId} entries={list.entries} onDone={() => setEditing(false)} />;
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<ShoppingBasket />}
          title="Nothing to buy"
          description="This plan has no meals that need shopping, or your fridge already covers everything."
          action={editButton}
        />
        {regenerate}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Progress done={done.length} total={rows.length} onReset={done.length > 0 ? checks.reset : undefined} />
      {editButton}

      {toBuy.length > 0 ? (
        <section aria-labelledby="grocery-to-buy" className="flex flex-col gap-2">
          <h2 id="grocery-to-buy" className="text-sm font-semibold uppercase tracking-wide text-text-muted">
            To buy
          </h2>
          <ul aria-labelledby="grocery-to-buy" className="flex flex-col gap-2">
            {toBuy.map((row) => (
              <EntryRow key={`${row.key}#${row.index}`} entry={row.entry} entryKey={row.key} checks={checks} />
            ))}
          </ul>
        </section>
      ) : (
        <p role="status" className="rounded-2xl bg-accent-soft p-4 text-center font-medium text-accent-text">
          All done. Happy cooking!
        </p>
      )}

      {done.length > 0 && (
        <section aria-labelledby="grocery-done" className="flex flex-col gap-2">
          <h2 id="grocery-done" className="text-sm font-semibold uppercase tracking-wide text-text-muted">
            Done
          </h2>
          <ul aria-labelledby="grocery-done" className="flex flex-col gap-2">
            {done.map((row) => (
              <EntryRow key={`${row.key}#${row.index}`} entry={row.entry} entryKey={row.key} checks={checks} />
            ))}
          </ul>
        </section>
      )}

      {regenerate}
    </div>
  );
}

/** "N of M in the basket" with an accessible progress bar; `onReset` is omitted when nothing is checked. */
function Progress({ done, total, onReset }: { done: number; total: number; onReset?: () => void }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-lg font-semibold tabular-nums text-text">
          {done} of {total}
          <span className="ml-1.5 text-sm font-normal text-text-muted">in the basket</span>
        </p>
        {onReset && (
          <Button variant="ghost" onClick={onReset} icon={<RotateCcw aria-hidden="true" className="size-4" />}>
            Uncheck all
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Items checked"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total}`}
        className="h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** One checkable entry. The whole row is the label, so the tap target is the full width. */
function EntryRow({ entry, entryKey, checks }: { entry: GroceryEntry; entryKey: string; checks: GroceryChecks }) {
  const checked = checks.isChecked(entryKey);
  const amount = formatAmount(entry);
  return (
    <li>
      <label
        className={cx(
          'flex min-h-14 cursor-pointer select-none items-center gap-4 rounded-2xl border px-4 py-3 transition-[opacity,background-color] duration-200 motion-reduce:transition-none',
          'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
          checked ? 'border-transparent bg-surface-2 opacity-60' : 'border-border bg-surface shadow-card active:bg-surface-2',
        )}
      >
        <input type="checkbox" className="sr-only" checked={checked} onChange={() => checks.toggle(entryKey)} aria-label={`${entry.name}, ${amount}`} />
        <span
          aria-hidden="true"
          className={cx(
            'flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            checked ? 'border-accent bg-accent text-accent-contrast' : 'border-border-strong',
          )}
        >
          {checked && <Check className="size-4" strokeWidth={3} />}
        </span>
        <span className={cx('min-w-0 flex-1 text-base font-medium text-text first-letter:uppercase', checked && 'line-through')}>{entry.name}</span>
        <span className="shrink-0 text-base tabular-nums text-text-muted">{amount}</span>
      </label>
    </li>
  );
}

/** Localized short date and time for an ISO timestamp, or "recently" if it can't be parsed. */
function generatedLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
