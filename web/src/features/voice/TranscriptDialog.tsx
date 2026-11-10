/**
 * Shows the Transcript returned by `POST /voice` for the User to confirm or
 * correct (Requirements 11.3, 13.15). Confirm sends the edited text; Cancel
 * closes the dialog and applies nothing (the pending recording expires on
 * the server).
 *
 * The dialog has no `<form>`: it renders inside the fridge, suggestion, and
 * chat forms, and forms can't nest.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button, Dialog, ErrorBanner, TextArea, isOverLimit } from '../../ui';
import { MAX_TRANSCRIPT_CODE_POINTS } from './voiceUpload';

export interface TranscriptDialogProps {
  open: boolean;
  /** The Transcript as heard. The field starts with this text. */
  transcript: string;
  title?: string;
  /** What Confirm does, for example "Sous replaces your fridge list with these items." */
  description?: string;
  maxCodePoints?: number;
  confirmLabel?: string;
  /** True while `POST /voice/{id}/confirm` is in flight. */
  confirming?: boolean;
  /** Message for a failed confirmation; the User can edit and confirm again. */
  error?: string;
  onConfirm: (transcript: string) => void;
  onCancel: () => void;
}

export function TranscriptDialog({
  open,
  transcript,
  title = 'Check what Sous heard',
  description = 'Fix anything that’s wrong. Nothing is applied until you confirm.',
  maxCodePoints = MAX_TRANSCRIPT_CODE_POINTS,
  confirmLabel = 'Confirm',
  confirming = false,
  error,
  onConfirm,
  onCancel,
}: TranscriptDialogProps) {
  const [text, setText] = useState(transcript);
  const empty = text.trim() === '';
  const tooLong = isOverLimit(text, maxCodePoints);
  const canConfirm = !empty && !tooLong && !confirming;

  function confirm() {
    if (canConfirm) onConfirm(text.trim());
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!confirming) onCancel();
      }}
      title={title}
      description={description}
      closeLabel="Cancel"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={confirming}>
            Cancel
          </Button>
          <Button onClick={confirm} loading={confirming} disabled={!canConfirm} icon={<Check aria-hidden="true" className="size-4" />}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextArea
          label="Transcript"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxCodePoints={maxCodePoints}
          error={
            empty
              ? 'The transcript is empty. Type what you meant, or cancel and record again.'
              : tooLong
                ? `Keep it to ${maxCodePoints} characters or fewer.`
                : undefined
          }
          disabled={confirming}
          rows={4}
          onKeyDown={(event) => {
            // Ctrl/Cmd+Enter confirms; plain Enter adds a line break.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              confirm();
            }
          }}
        />
        {error && <ErrorBanner message={error} />}
      </div>
    </Dialog>
  );
}
