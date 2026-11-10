/**
 * Invite someone by email (Requirements 10.2, 13.7). After the System creates
 * the pending Invitation, the dialog shows the Invitation_Link with Copy and
 * Share (`navigator.share` when available).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Mail, Share2 } from 'lucide-react';
import { useApi } from '../../app/ServicesProvider';
import type { Invitation } from '../../api/types';
import { Button, Dialog, ErrorBanner, TextField, useToast } from '../../ui';
import { copyText, errorText, invitationLink, isPlausibleEmail } from './shared';

export interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
  householdId: string;
  householdName?: string;
}

export function InviteDialog({ open, onClose, householdId, householdName }: InviteDialogProps) {
  const api = useApi();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState<Invitation>();

  useEffect(() => {
    if (!open) {
      setEmail('');
      setEmailError(undefined);
      setError(undefined);
      setInvitation(undefined);
    }
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!isPlausibleEmail(trimmed)) return setEmailError('Enter an email address, like name@example.com.');
    setEmailError(undefined);
    setError(undefined);
    setPending(true);
    try {
      setInvitation(await api.invite(householdId, { email: trimmed }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  const link = invitation ? invitationLink(invitation.invitationId) : '';
  const invitee = invitation?.invitee.kind === 'email' ? invitation.invitee.email : email.trim();
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function onCopy() {
    const ok = await copyText(link);
    toast.show(
      ok
        ? { message: 'Invitation link copied.', tone: 'success' }
        : { message: "Couldn't copy the link. Select it and copy it yourself.", tone: 'error' },
    );
  }

  async function onShare() {
    try {
      await navigator.share({
        title: 'Join my household on Sous',
        text: householdName ? `Join "${householdName}" on Sous to plan meals together.` : 'Join my household on Sous.',
        url: link,
      });
      toast.show({ message: 'Invitation shared.', tone: 'success' });
    } catch (err) {
      // The User closing the share sheet is not an error.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.show({ message: "Couldn't open sharing. Copy the link instead.", tone: 'error' });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={invitation ? 'Invitation ready' : 'Invite someone'}
      description={
        invitation
          ? `Send this link to ${invitee}. It works for 7 days and only for that email address.`
          : `They'll get access to ${householdName ? `"${householdName}"` : 'this household'} once they accept.`
      }
      footer={
        invitation ? (
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="invite-form" loading={pending} icon={<Mail aria-hidden="true" className="size-4" />}>
              Create invitation
            </Button>
          </>
        )
      }
    >
      {invitation ? (
        <div className="flex flex-col gap-4">
          <TextField label="Invitation link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => void onCopy()} icon={<Copy aria-hidden="true" className="size-4" />}>
              Copy link
            </Button>
            {canShare && (
              <Button variant="secondary" onClick={() => void onShare()} icon={<Share2 aria-hidden="true" className="size-4" />}>
                Share
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form id="invite-form" noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
          {error && <ErrorBanner message={error} />}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
          />
        </form>
      )}
    </Dialog>
  );
}
