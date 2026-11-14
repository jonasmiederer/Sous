/**
 * "Add to grocery list": adds a meal's ingredients to a new list or to one of
 * the household's existing lists. The choice is made in this dialog; nothing
 * is written until the user confirms.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import type { Ingredient } from '../../api/types';
import { AsyncView, Button, Dialog, ErrorBanner, TextField, cx, useToast } from '../../ui';
import { errorMessage } from '../plans/planQueries';
import { useAddToShoppingList, useCreateShoppingList, useShoppingLists } from './shoppingListQueries';

export interface AddToGroceryListDialogProps {
  open: boolean;
  onClose: () => void;
  /** Name of the meal being added, shown in the title and used as the default name of a new list. */
  mealName: string;
  ingredients: Ingredient[];
}

const NEW_LIST = 'new';
const MAX_NAME = 80;

export function AddToGroceryListDialog({ open, onClose, mealName, ingredients }: AddToGroceryListDialogProps) {
  if (!open) return null;
  return <AddToGroceryListDialogInner onClose={onClose} mealName={mealName} ingredients={ingredients} />;
}

function AddToGroceryListDialogInner({ onClose, mealName, ingredients }: Omit<AddToGroceryListDialogProps, 'open'>) {
  const lists = useShoppingLists();
  const create = useCreateShoppingList();
  const add = useAddToShoppingList();
  const toast = useToast();
  const [choice, setChoice] = useState<string | null>(null);
  const [newName, setNewName] = useState(mealName.slice(0, MAX_NAME));

  const existing = lists.data?.shoppingLists ?? [];
  // Default: the most recently changed list, or a new one when there is none yet.
  const selected = choice ?? (existing[0]?.listId ?? NEW_LIST);
  const pending = create.isPending || add.isPending;
  const error = create.isError ? create.error : add.isError ? add.error : null;
  const items = ingredients.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit }));

  function done(listName: string) {
    toast.show({ message: `Added ${mealName} to ${listName}.`, tone: 'success' });
    onClose();
  }

  function confirm() {
    if (pending) return;
    if (selected === NEW_LIST) {
      create.mutate(
        { name: newName.trim() || mealName.slice(0, MAX_NAME), entries: items },
        { onSuccess: (r) => done(r.shoppingList.name) },
      );
    } else {
      add.mutate(
        { listId: selected, items },
        { onSuccess: (r) => done(r.shoppingList.name) },
      );
    }
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title="Add to grocery list"
      description={`Add the ingredients of ${mealName}. Matching items are added together.`}
      placement="sheet"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button loading={pending} onClick={confirm} disabled={lists.isPending || ingredients.length === 0}>
            Add {ingredients.length} {ingredients.length === 1 ? 'item' : 'items'}
          </Button>
        </>
      }
    >
      <AsyncView query={lists} errorMessage={errorMessage}>
        {() => (
          <fieldset className="flex flex-col gap-2" disabled={pending}>
            <legend className="sr-only">Choose a grocery list</legend>
            {existing.map((list) => (
              <ChoiceRow
                key={list.listId}
                value={list.listId}
                checked={selected === list.listId}
                onSelect={setChoice}
                label={list.name}
                detail={`${list.itemCount} ${list.itemCount === 1 ? 'item' : 'items'}`}
              />
            ))}
            <ChoiceRow value={NEW_LIST} checked={selected === NEW_LIST} onSelect={setChoice} label="New list" />
            {selected === NEW_LIST && (
              <TextField
                label="List name"
                value={newName}
                maxLength={MAX_NAME}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirm();
                  }
                }}
                autoComplete="off"
              />
            )}
          </fieldset>
        )}
      </AsyncView>
      {error !== null && <ErrorBanner message={errorMessage(error)} />}
      <p className="mt-4 text-sm text-text-muted">
        <Link to="/grocery" onClick={onClose} className="font-medium text-accent-text underline-offset-2 hover:underline">
          Manage grocery lists
        </Link>
      </p>
    </Dialog>
  );
}

function ChoiceRow({
  value,
  checked,
  onSelect,
  label,
  detail,
}: {
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  label: string;
  detail?: string;
}) {
  return (
    <label
      className={cx(
        'flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3',
        'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface',
      )}
    >
      <input type="radio" name="grocery-list-choice" value={value} checked={checked} onChange={() => onSelect(value)} className="size-4 accent-[var(--color-accent)]" />
      <span className="min-w-0 flex-1 truncate font-medium text-text">{label}</span>
      {detail && <span className="shrink-0 text-sm text-text-muted">{detail}</span>}
    </label>
  );
}
