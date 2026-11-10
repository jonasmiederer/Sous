/**
 * Members of the Active_Household (Requirements 10.7, 10.8, 13.7, 13.8).
 * Only the Household_Owner sees Invite and Remove, and Remove appears only on
 * non-owner rows.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, UserMinus, UserPlus, Users } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useSession } from '../../auth/SessionProvider';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { MemberSummary } from '../../api/types';
import { AsyncView, Button, Dialog, EmptyState, ErrorBanner, useToast } from '../../ui';
import { InviteDialog } from './InviteDialog';
import { HOUSEHOLDS_PATH, RoleBadge, ScreenHeader, errorText, membersQueryKey } from './shared';

function displayName(member: MemberSummary): string {
  return member.email ?? member.userId;
}

function joinedLabel(joinedAt: string): string | undefined {
  const date = new Date(joinedAt);
  return Number.isNaN(date.getTime()) ? undefined : `Joined ${date.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
}

/** Whether `currentUserId` may remove `member` from a Household owned by `ownerUserId` (13.8). */
export function canRemoveMember(currentUserId: string | undefined, ownerUserId: string | undefined, member: MemberSummary): boolean {
  return Boolean(currentUserId) && currentUserId === ownerUserId && member.role !== 'owner';
}

export function Members() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { session } = useSession();
  const { activeHouseholdId, activeHousehold } = useActiveHousehold();
  const householdId = activeHouseholdId ?? '';
  const currentUserId = session?.user.userId;
  const isOwner = Boolean(currentUserId) && activeHousehold?.ownerUserId === currentUserId;

  const members = useQuery({
    queryKey: membersQueryKey(householdId),
    queryFn: async ({ signal }) => (await api.listMembers(householdId, { signal })).members,
    enabled: householdId !== '',
  });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [toRemove, setToRemove] = useState<MemberSummary>();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();

  async function confirmRemove() {
    if (!toRemove) return;
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await api.removeMember(householdId, toRemove.userId);
      await queryClient.invalidateQueries({ queryKey: membersQueryKey(householdId) });
      toast.show({ message: `${displayName(toRemove)} was removed.`, tone: 'success' });
      setToRemove(undefined);
    } catch (err) {
      setRemoveError(errorText(err));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        to={HOUSEHOLDS_PATH}
        className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        All households
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <ScreenHeader
          title="Members"
          description={activeHousehold ? `Everyone who plans meals in ${activeHousehold.name}.` : 'Everyone who plans meals in this household.'}
        />
        {isOwner && (
          <Button onClick={() => setInviteOpen(true)} icon={<UserPlus aria-hidden="true" className="size-4" />} className="self-start sm:self-auto">
            Invite
          </Button>
        )}
      </div>

      <AsyncView
        query={members}
        errorMessage={errorText}
        isEmpty={(list: MemberSummary[]) => list.length === 0}
        empty={<EmptyState icon={<Users />} title="No members to show" />}
      >
        {(list) => (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card" aria-label="Members">
            {list.map((member) => {
              const you = member.userId === currentUserId;
              const joined = joinedLabel(member.joinedAt);
              return (
                <li key={member.userId} className="flex items-center gap-3 p-4">
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold uppercase text-text-muted"
                  >
                    {displayName(member).slice(0, 1)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-text">
                      {displayName(member)}
                      {you && <span className="ml-1.5 text-sm font-normal text-text-muted">(you)</span>}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <RoleBadge role={member.role} />
                      {joined && <span className="text-xs text-text-muted">{joined}</span>}
                    </div>
                  </div>
                  {canRemoveMember(currentUserId, activeHousehold?.ownerUserId, member) && (
                    <Button
                      variant="ghost"
                      aria-label={`Remove ${displayName(member)}`}
                      icon={<UserMinus aria-hidden="true" className="size-4" />}
                      onClick={() => {
                        setRemoveError(undefined);
                        setToRemove(member);
                      }}
                    >
                      <span className="hidden sm:inline">Remove</span>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </AsyncView>

      {isOwner && (
        <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} householdId={householdId} householdName={activeHousehold?.name} />
      )}

      <Dialog
        open={toRemove !== undefined}
        onClose={() => setToRemove(undefined)}
        title="Remove member?"
        description={toRemove ? `${displayName(toRemove)} will lose access to this household's plans, lists, and preferences.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setToRemove(undefined)}>
              Cancel
            </Button>
            <Button variant="danger" loading={removing} onClick={() => void confirmRemove()}>
              Remove
            </Button>
          </>
        }
      >
        {removeError && <ErrorBanner message={removeError} />}
      </Dialog>
    </div>
  );
}
