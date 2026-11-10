/**
 * Fridge editor (route `/fridge`, Requirements 4.3, 4.4, 13.14).
 *
 * Editable rows of name, quantity, and unit, a quick-add field, and Save,
 * which replaces the whole Fridge_Inventory with `PUT /fridge`. Save is
 * blocked while no row is a valid item. Rows the server drops as invalid are
 * reported after the save.
 *
 * Voice: `renderVoiceAction` receives a `FridgeVoiceSlot`. After a confirmed
 * voice recording the slot's `onApplied()` refetches the fridge and replaces
 * the rows with the server inventory (voice recordings are full replacements
 * too, so unsaved edits are discarded).
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Info, Plus, Refrigerator, Trash2 } from 'lucide-react';
import { CANONICAL_UNITS } from '@sous/domain/units';
import { useApi } from '../../app/ServicesProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { GetFridgeResponse, Ingredient, PutFridgeResponse, VoiceTargetOperation } from '../../api/types';
import { AsyncView, Button, EmptyState, ErrorBanner, IconButton, TextField, cx, useToast } from '../../ui';
import { CONTROL_CLASS } from '../../ui/Field';
import { errorMessage, fridgeKey, useFridge, useInvalidateFridge } from './fridgeQueries';
import {
  MAX_FRIDGE_ROWS,
  emptyRow,
  hasValidRow,
  isBlankRow,
  isCanonicalUnit,
  newRowKey,
  parseQuickAdd,
  planSave,
  rowProblem,
  rowsFromItems,
  rowsSignature,
  unitLabel,
  type FridgeRow,
} from './fridgeRows';

/** What the editor hands to the voice button rendered next to the quick-add field. */
export interface FridgeVoiceSlot {
  targetOperation: Extract<VoiceTargetOperation, { type: 'fridge' }>;
  disabled: boolean;
  /** Call after the voice recording was confirmed and applied on the server. */
  onApplied: () => void;
}

export interface FridgeEditorProps {
  renderVoiceAction?: (slot: FridgeVoiceSlot) => ReactNode;
}

const FRIDGE_TARGET = { type: 'fridge' } as const;

/** Page shell: loads the fridge and renders `FridgeForm` once data is available. */
export function FridgeEditor({ renderVoiceAction }: FridgeEditorProps) {
  const fridge = useFridge();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Fridge</h1>
        <p className="mt-1.5 text-text-muted">What you have at home. Suggestions use these first, and grocery lists skip them.</p>
      </div>
      <AsyncView query={fridge} errorMessage={errorMessage}>
        {(data) => <FridgeForm data={data} renderVoiceAction={renderVoiceAction} />}
      </AsyncView>
    </div>
  );
}

/** Items of the stored inventory; a household that never saved one has none. */
function itemsOf(data: GetFridgeResponse): Ingredient[] {
  return data.inventory ? data.inventory.items : [];
}

/**
 * Editable copy of the server inventory. `baseline` is the signature of the
 * last server state we adopted; `dirty` means the rows differ from it.
 */
function FridgeForm({ data, renderVoiceAction }: { data: GetFridgeResponse; renderVoiceAction?: FridgeEditorProps['renderVoiceAction'] }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  const invalidateFridge = useInvalidateFridge();

  const [baseline, setBaseline] = useState(() => rowsSignature(rowsFromItems(itemsOf(data))));
  const [rows, setRows] = useState<FridgeRow[]>(() => rowsFromItems(itemsOf(data)));
  const [quickAdd, setQuickAdd] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [dropped, setDropped] = useState<string[]>([]);
  const dirty = rowsSignature(rows) !== baseline;

  /** Replaces the editable rows with server data and resets the dirty baseline. */
  function adopt(next: GetFridgeResponse) {
    const nextRows = rowsFromItems(itemsOf(next));
    setRows(nextRows);
    setBaseline(rowsSignature(nextRows));
  }

  // Adopt newer server data (another member's save, a refetch) while nothing is being edited.
  const serverSignature = useMemo(() => rowsSignature(rowsFromItems(itemsOf(data))), [data]);
  useEffect(() => {
    if (!dirty && serverSignature !== baseline) adopt(data);
    // Only react to new server data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSignature]);

  const save = useMutation({
    mutationFn: (items: Ingredient[]) => api.putFridge(items.length === 0 ? { items, clear: true } : { items }),
  });

  // Emptying the fridge on purpose (every row removed or blank) is allowed.
  const clearing = rows.every(isBlankRow);
  const canSave = hasValidRow(rows) || clearing;
  const atLimit = rows.length >= MAX_FRIDGE_ROWS;

  /** Patches one row, identified by its stable client-side key. */
  function update(key: string, patch: Partial<FridgeRow>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  /** Parses text like "6 eggs" into a new row; unparseable input is ignored. */
  function addQuick(event: FormEvent) {
    event.preventDefault();
    const parsed = parseQuickAdd(quickAdd);
    if (!parsed || atLimit) return;
    setRows((current) => [...current, { key: newRowKey(), ...parsed }]);
    setQuickAdd('');
  }

  /**
   * Saves the whole inventory. The server reports invalid rows by index into
   * the submitted list (`droppedIndexes`); we map them back to names so the
   * user can see what was left out.
   */
  function onSave(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!canSave || save.isPending) return;
    const plan = planSave(rows);
    setDropped([]);
    save.mutate(plan.items, {
      onSuccess: (result: PutFridgeResponse) => {
        const droppedNames = result.droppedIndexes.map((i) => plan.submittedRows[i]?.name.trim() || 'Unnamed item');
        const next: GetFridgeResponse = { inventory: result.inventory, version: result.version };
        queryClient.setQueryData(fridgeKey(activeHouseholdId), next);
        adopt(next);
        setAttempted(false);
        setDropped(droppedNames);
        toast.show({ tone: 'success', message: 'Fridge saved.' });
      },
    });
  }

  const voiceSlot: FridgeVoiceSlot = {
    targetOperation: FRIDGE_TARGET,
    disabled: save.isPending,
    onApplied: () => {
      setDropped([]);
      setAttempted(false);
      void invalidateFridge().then(() => {
        const latest = queryClient.getQueryData<GetFridgeResponse>(fridgeKey(activeHouseholdId));
        if (latest) adopt(latest);
      });
    },
  };

  const blockedMessage = attempted && !canSave ? 'Add at least one item with a name and an amount above 0.' : undefined;

  return (
    <form onSubmit={onSave} noValidate className="flex flex-col gap-5" aria-label="Fridge inventory">
      <div className="flex items-start gap-2">
        <QuickAddField value={quickAdd} onChange={setQuickAdd} onAdd={addQuick} disabled={atLimit} />
        {renderVoiceAction && <div className="mt-7 shrink-0">{renderVoiceAction(voiceSlot)}</div>}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Refrigerator />}
          title="Your fridge is empty"
          description="Add what you have, like “6 eggs” or “500 g flour”."
          action={
            <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setRows([emptyRow()])}>
              Add an item
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2.5" aria-label="Fridge items">
          {rows.map((row, index) => (
            <li key={row.key}>
              <RowEditor
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

      {rows.length > 0 && (
        <div>
          <Button
            variant="ghost"
            icon={<Plus className="size-4" />}
            onClick={() => setRows((current) => [...current, emptyRow()])}
            disabled={atLimit}
          >
            Add row
          </Button>
        </div>
      )}

      {dropped.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-warning-soft px-4 py-3 text-sm text-text">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {dropped.length === 1 ? 'One row wasn’t saved' : `${dropped.length} rows weren’t saved`} because{' '}
            {dropped.length === 1 ? 'it was' : 'they were'} incomplete: {dropped.join(', ')}.
          </span>
        </p>
      )}

      {save.isError && <ErrorBanner message={errorMessage(save.error)} />}

      <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        <p className="text-sm text-text-muted" aria-live="polite">
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-text">
              <span aria-hidden="true" className="size-2 rounded-full bg-warning" /> Unsaved changes
            </span>
          ) : (
            'All changes saved'
          )}
        </p>
        <Button type="submit" loading={save.isPending} disabled={!dirty && !save.isError}>
          Save fridge
        </Button>
      </div>
      {blockedMessage && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {blockedMessage}
        </p>
      )}
    </form>
  );
}

/** Single-line "6 eggs" input; Enter or the plus button adds a row. */
function QuickAddField({
  value,
  onChange,
  onAdd,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: (event: FormEvent) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <TextField
        label="Quick add"
        hint="Try “eggs”, “6 eggs”, or “500 g flour”."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onAdd(e);
        }}
        enterKeyHint="done"
        autoComplete="off"
        containerClassName="min-w-0 flex-1"
        disabled={disabled}
      />
      <IconButton
        label="Add to list"
        icon={<Plus />}
        variant="secondary"
        onClick={onAdd}
        disabled={disabled || value.trim() === ''}
        className="mt-7 self-start"
      />
    </div>
  );
}

/**
 * One editable item (name, amount, unit). Labels are screen-reader only and
 * include the item name. Problems show only after the first save attempt, and
 * fully blank rows never count as a problem (they are dropped on save).
 */
function RowEditor({
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
  const problem = isBlankRow(row) ? null : rowProblem(row);
  const visibleProblem = showProblem ? problem : null;
  const label = row.name.trim() || `item ${index + 1}`;
  const errorId = `${id}-error`;
  // Keep a non-canonical unit (e.g. from older data) selectable so it isn't silently changed.
  const unitOptions = isCanonicalUnit(row.unit) ? CANONICAL_UNITS : [...CANONICAL_UNITS, row.unit];
  return (
    <div className="rounded-2xl border border-border bg-surface p-3 shadow-card">
      <div className="grid grid-cols-[1fr_auto] items-start gap-2 sm:grid-cols-[1fr_6rem_10rem_auto]">
        <div className="col-span-1">
          <label htmlFor={`${id}-name`} className="sr-only">
            Name of {label}
          </label>
          <input
            id={`${id}-name`}
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Item, e.g. spinach"
            autoComplete="off"
            aria-invalid={visibleProblem === 'name' || undefined}
            aria-describedby={visibleProblem === 'name' ? errorId : undefined}
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
              aria-invalid={visibleProblem === 'quantity' || undefined}
              aria-describedby={visibleProblem === 'quantity' ? errorId : undefined}
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
      {visibleProblem && (
        <p id={errorId} className="mt-2 flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {visibleProblem === 'name' ? 'Add a name or remove this row.' : 'Enter an amount above 0.'}
        </p>
      )}
    </div>
  );
}
