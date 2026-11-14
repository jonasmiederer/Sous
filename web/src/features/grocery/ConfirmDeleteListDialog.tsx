/** Confirmation before deleting a grocery list. The caller owns the request and its state. */
import { Button, Dialog, ErrorBanner } from '../../ui';

export interface ConfirmDeleteListDialogProps {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteListDialog({ open, title, description, pending, error, onClose, onConfirm }: ConfirmDeleteListDialogProps) {
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title={title}
      description={description}
      placement="sheet"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            Delete list
          </Button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
    </Dialog>
  );
}
