/**
 * Confirmation dialog for deleting a whole plan: `DELETE /plans/{id}`.
 * The plan and its grocery list are removed; the fridge and preferences stay.
 */
import { useMutation } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { Button, Dialog, ErrorBanner } from '../../ui';
import { errorMessage } from './planQueries';

export interface DeletePlanDialogProps {
  open: boolean;
  planId: string;
  /** Human label for the plan, e.g. its date range. */
  label: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeletePlanDialog({ open, planId, label, onClose, onDeleted }: DeletePlanDialogProps) {
  const api = useApi();
  const remove = useMutation({
    mutationFn: () => api.deletePlan(planId),
    onSuccess: () => onDeleted(),
  });

  if (!open) return null;
  return (
    <Dialog
      open
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
      title="Delete this plan?"
      description={`The plan for ${label} and its grocery list will be deleted. This can’t be undone.`}
      placement="sheet"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Delete plan
          </Button>
        </>
      }
    >
      {remove.isError && <ErrorBanner message={errorMessage(remove.error)} />}
    </Dialog>
  );
}
