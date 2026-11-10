/**
 * Accept or decline an Invitation from its Invitation_Link (Requirements
 * 10.3, 10.4, 13.7) and show the System's outcome. A User who is not signed
 * in is sent to sign-in and brought back here afterwards.
 */
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { CircleCheck, CircleX, MailOpen } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useSession } from '../../auth/SessionProvider';
import { SIGN_IN_PATH, type SignInLocationState } from '../../auth/RequireSession';
import { householdsQueryKey, useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { Button, ErrorBanner } from '../../ui';
import { HOUSEHOLDS_PATH, errorText } from './shared';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'accepted'; householdId: string }
  | { kind: 'declined' }
  | { kind: 'error'; message: string };

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border border-border bg-surface p-6 text-center shadow-card sm:p-8">
      <div aria-hidden="true" className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-text [&_svg]:size-7">
        {icon}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function AcceptInvitation() {
  const { invitationId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const api = useApi();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const { households, selectHousehold } = useActiveHousehold();
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [pending, setPending] = useState<'accept' | 'decline' | 'switch'>();
  const [switchError, setSwitchError] = useState<string>();

  if (!session) {
    const state: SignInLocationState = { from: `${location.pathname}${location.search}${location.hash}` };
    return <Navigate to={SIGN_IN_PATH} replace state={state} />;
  }

  async function respond(action: 'accept' | 'decline') {
    setPending(action);
    try {
      if (action === 'accept') {
        const result = await api.acceptInvitation(invitationId);
        await queryClient.invalidateQueries({ queryKey: householdsQueryKey(session?.user.userId) });
        setOutcome({ kind: 'accepted', householdId: result.membership.householdId });
      } else {
        await api.declineInvitation(invitationId);
        setOutcome({ kind: 'declined' });
      }
    } catch (err) {
      setOutcome({ kind: 'error', message: errorText(err) });
    } finally {
      setPending(undefined);
    }
  }

  async function switchTo(householdId: string) {
    setPending('switch');
    setSwitchError(undefined);
    try {
      await selectHousehold(householdId);
      navigate('/', { replace: true });
    } catch (err) {
      setSwitchError(errorText(err));
    } finally {
      setPending(undefined);
    }
  }

  if (outcome.kind === 'accepted') {
    const name = households.data?.find((h) => h.householdId === outcome.householdId)?.name;
    return (
      <Card icon={<CircleCheck />} title="You're in">
        <p className="text-text-muted">{name ? `You joined ${name}.` : 'You joined the household.'} Switch to it to start planning together.</p>
        {switchError && <ErrorBanner message={switchError} className="w-full text-left" />}
        <div className="flex w-full flex-col gap-2">
          <Button size="lg" fullWidth loading={pending === 'switch'} onClick={() => void switchTo(outcome.householdId)}>
            {name ? `Switch to ${name}` : 'Switch to this household'}
          </Button>
          <Button size="lg" fullWidth variant="ghost" onClick={() => navigate(HOUSEHOLDS_PATH)}>
            Not now
          </Button>
        </div>
      </Card>
    );
  }

  if (outcome.kind === 'declined') {
    return (
      <Card icon={<CircleX />} title="Invitation declined">
        <p className="text-text-muted">You won't be added to that household.</p>
        <Link to={HOUSEHOLDS_PATH} className="min-h-11 content-center font-medium text-accent-text underline-offset-4 hover:underline">
          Go to your households
        </Link>
      </Card>
    );
  }

  return (
    <Card icon={<MailOpen />} title="You're invited">
      <p className="text-text-muted">
        Someone invited you to plan meals with their household on Sous. Accepting gives you access to its plans, grocery lists, and preferences.
      </p>
      {outcome.kind === 'error' && <ErrorBanner message={outcome.message} className="w-full text-left" />}
      {outcome.kind === 'error' ? (
        <Link to={HOUSEHOLDS_PATH} className="min-h-11 content-center font-medium text-accent-text underline-offset-4 hover:underline">
          Go to your households
        </Link>
      ) : (
        <div className="flex w-full flex-col gap-2">
          <Button size="lg" fullWidth loading={pending === 'accept'} disabled={pending === 'decline'} onClick={() => void respond('accept')}>
            Accept invitation
          </Button>
          <Button size="lg" fullWidth variant="secondary" loading={pending === 'decline'} disabled={pending === 'accept'} onClick={() => void respond('decline')}>
            Decline
          </Button>
        </div>
      )}
    </Card>
  );
}
