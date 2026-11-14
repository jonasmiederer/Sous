/**
 * `/grocery/lists/:listId`: a standalone grocery list. It is built from meals
 * you added (for example from a suggestion) and from items you typed in.
 * Shopping view, editing and device-local check marks are shared with plan
 * lists (ChecklistView).
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ChevronLeft, Trash2 } from 'lucide-react';
import { AsyncView, Button, useToast } from '../../ui';
import { errorMessage } from '../plans/planQueries';
import { ConfirmDeleteListDialog } from './ConfirmDeleteListDialog';
import { GroceryEditor } from './GroceryEditor';
import { ChecklistView } from './GroceryScreen';
import { useDeleteShoppingList, useShoppingList } from './shoppingListQueries';

export interface ShoppingListScreenProps {
  /** Defaults to the `:listId` route parameter. */
  listId?: string;
  indexHref?: string;
}

export function ShoppingListScreen({ listId: listIdProp, indexHref = '/grocery' }: ShoppingListScreenProps) {
  const params = useParams();
  const listId = listIdProp ?? params.listId ?? '';
  const query = useShoppingList(listId);
  const remove = useDeleteShoppingList();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link to={indexHref} className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-text-muted hover:text-text">
          <ChevronLeft aria-hidden="true" className="size-4" /> All grocery lists
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{query.data?.shoppingList.name ?? 'Grocery list'}</h1>
      </div>

      <AsyncView query={query} errorMessage={errorMessage}>
        {(data) => (
          <ChecklistView
            entries={data.shoppingList.entries}
            checksId={`list:${data.shoppingList.listId}`}
            version={data.shoppingList.createdAt}
            emptyDescription="This list is empty. Add a meal from Suggestions, or edit the list to type in items."
            renderEditor={(onDone) => (
              <GroceryEditor shoppingListId={data.shoppingList.listId} entries={data.shoppingList.entries} onDone={onDone} />
            )}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirmingDelete(true)} icon={<Trash2 aria-hidden="true" className="size-4" />} className="self-start">
                  Delete list
                </Button>
                <ConfirmDeleteListDialog
                  open={confirmingDelete}
                  title={`Delete “${data.shoppingList.name}”?`}
                  description="The list and its items are deleted. This can’t be undone."
                  pending={remove.isPending}
                  error={remove.isError ? errorMessage(remove.error) : undefined}
                  onClose={() => setConfirmingDelete(false)}
                  onConfirm={() =>
                    remove.mutate(listId, {
                      onSuccess: () => {
                        setConfirmingDelete(false);
                        toast.show({ message: 'List deleted.', tone: 'success' });
                        navigate(indexHref);
                      },
                    })
                  }
                />
              </>
            }
          />
        )}
      </AsyncView>
    </div>
  );
}
