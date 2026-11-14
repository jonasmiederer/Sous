/**
 * Manual editing of a Grocery_List: change name, amount and unit, remove
 * entries, and add new ones (quick add like "6 eggs" or an empty row).
 *
 * Save replaces the whole list with `PUT /plans/{id}/grocery-list` (or
 * `PUT /shopping-lists/{id}` for a standalone list). Rows left
 * completely blank are ignored; a filled row without a name or with an amount
 * of 0 or less blocks the save and shows what to fix. Removing every row is
 * allowed and saves an empty list.
 */
import { useId, useState, type FormEvent } from 'react';
import { CircleAlert, Plus, Trash2 } from 'lucide-react';
import { CANONICAL_UNITS } from '@sous/domain/units';
import type { GroceryEntry } from '../../api/types';
import { Button, ErrorBanner, IconButton, TextField, cx } from '../../ui';
import { CONTROL_CLASS } from '../../ui/Field';
import { errorMessage } from '../plans/planQueries';
import {
  MAX_FRIDGE_ROWS,
  emptyRow,
  isBlankRow,
  isCanonicalUnit,
  newRowKey,
  parseQuickAdd,
  planSave,
  rowProblem,
  rowsFromItems,
  unitLabel,
  type FridgeRow,
} from '../fridge/fridgeRows';
import { useUpdateGroceryList } from './groceryQueries';
import { useUpdateShoppingList } from './shoppingListQueries';

export interface GroceryEditorProps {
  /** Edits the grocery list of this plan (`PUT /plans/{id}/grocery-list`). */
  planId?: string;
  /** Edits this standalone list (`PUT /shopping-lists/{id}`) instead of a plan's list. */
  shoppingListId?: string;
  entries: readonly GroceryEntry[];
  /** Called after a successful save or when the user cancels. */
  onDone: () => void;
}

export function GroceryEditor({ planId = '', shoppingListId, entries, onDone }: GroceryEditorProps) {
  const planUpdate = useUpdateGroceryList(planId);
  const listUpdate = useUpdateShoppingList(shoppingListId ?? '');
  const save = shoppingListId ? listUpdate : planUpdate;
  const [rows, setRows] = useState<FridgeRow[]>(() => rowsFromItems(entries));
  const [quickAdd, setQuickAdd] = useState('');
  const [attempted, setAttempted] = useState(false);
  const atLimit = rows.length >= MAX_FRIDGE_ROWS;
  const hasProblem = rows.some((r) => !isBlankRow(r) && rowProblem(r) !== null);

  function update(key: string, patch: Partial<FridgeRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addQuick(event: FormEvent) {
    event.preventDefault();
    const parsed = parseQuickAdd(quickAdd);
    if (!parsed || atLimit) return;
    setRows((current) => [...current, { key: newRowKey(), ...parsed }]);
    setQuickAdd('');
  }

  function onSave(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (hasProblem || save.isPending) return;
    const items = planSave(rows).items;
    if (shoppingListId) listUpdate.mutate({ entries: items }, { onSuccess: onDone });
    else planUpdate.mutate(items, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSave} noValidate aria-label="Edit grocery list" className="flex flex-col gap-5">
      <div className="flex items-start gap-2">
        <TextField
          label="Add an item"
          hint="Try “eggs”, “6 eggs”, or “500 g flour”."
          value={quickAdd}
          onChange={(e) => setQuickAdd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addQuick(e);
          }}
          enterKeyHint="done"
          autoComplete="off"
          containerClassName="min-w-0 flex-1"
          disabled={atLimit}
        />
        <IconButton
          label="Add to list"
          icon={<Plus />}
          variant="secondary"
          onClick={addQuick}
          disabled={atLimit || quickAdd.trim() === ''}
          className="mt-7 self-start"
        />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border-strong p-4 text-center text-text-muted">
          The list is empty. Add an item above, or save to keep it empty.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5" aria-label="Grocery items">
          {rows.map((row, index) => (
            <li key={row.key}>
              <EditRow
                row={row}
                index={index}
                showProblem={attempted}
                onChange={(patch) => update(row.key, patch)}
                onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              />
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setRows((c) => [...c, emptyRow()])} disabled={atLimit}>
          Add row
        </Button>
      </div>

      {save.isError && <ErrorBanner message={errorMessage(save.error)} />}
      {attempted && hasProblem && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Give every item a name and an amount above 0, or remove it.
        </p>
      )}

      <div className="flex items-center justify-end gap-3">
        <Button variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          Save list
        </Button>
      </div>
    </form>
  );
}

function EditRow({
  row,
  index,
  showProblem,
  onChange,
  onRemove,
}: {
  row: FridgeRow;
  index: number;
  showProblem: boolean;
  onChange: (patch: Partial<FridgeRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const problem = showProblem && !isBlankRow(row) ? rowProblem(row) : null;
  const label = row.name.trim() || `item ${index + 1}`;
  const errorId = `${id}-error`;
  const unitOptions = isCanonicalUnit(row.unit) ? CANONICAL_UNITS : [...CANONICAL_UNITS, row.unit];
  return (
    <div className="rounded-2xl border border-border bg-surface p-3 shadow-card">
      <div className="grid grid-cols-[1fr_auto] items-start gap-2 sm:grid-cols-[1fr_6rem_10rem_auto]">
        <div>
          <label htmlFor={`${id}-name`} className="sr-only">
            Name of {label}
          </label>
          <input
            id={`${id}-name`}
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Item, e.g. spinach"
            autoComplete="off"
            aria-invalid={problem === 'name' || undefined}
            aria-describedby={problem === 'name' ? errorId : undefined}
            className={cx(CONTROL_CLASS, 'min-h-11 py-2')}
          />
        </div>
        <IconButton label={`Remove ${label}`} icon={<Trash2 />} onClick={onRemove} className="sm:order-last" />
        <div className="col-span-2 grid grid-cols-[6rem_1fr] gap-2 sm:col-span-2 sm:grid-cols-subgrid">
          <div>
            <label htmlFor={`${id}-qty`} className="sr-only">
              Amount of {label}
            </label>
            <input
              id={`${id}-qty`}
              value={row.quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              inputMode="decimal"
              placeholder="Amount"
              autoComplete="off"
              aria-invalid={problem === 'quantity' || undefined}
              aria-describedby={problem === 'quantity' ? errorId : undefined}
              className={cx(CONTROL_CLASS, 'min-h-11 py-2 tabular-nums')}
            />
          </div>
          <div>
            <label htmlFor={`${id}-unit`} className="sr-only">
              Unit of {label}
            </label>
            <select
              id={`${id}-unit`}
              value={row.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              className={cx(CONTROL_CLASS, 'min-h-11 py-2')}
            >
              {unitOptions.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabel(unit)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {problem && (
        <p id={errorId} className="mt-2 flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {problem === 'name' ? 'Add a name or remove this row.' : 'Enter an amount above 0.'}
        </p>
      )}
    </div>
  );
}
