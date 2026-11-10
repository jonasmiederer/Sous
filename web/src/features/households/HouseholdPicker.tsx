/**
 * Household picker (Requirement 13.6): the User's Households with role
 * badges, selection of the Active_Household, and creation of a new one.
 */
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Check, ChevronRight, Home, Users } from 'lucide-react';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import type { HouseholdsLocationState } from '../../household/RequireHousehold';
import type { HouseholdSummary } from '../../api/types';
import { AsyncView, EmptyState, ErrorBanner, cx } from '../../ui';
import { CreateHousehold } from './CreateHousehold';
import { HOUSEHOLDS_PATH, MEMBERS_PATH, RoleBadge, ScreenHeader, errorText } from './shared';

function returnPath(state: HouseholdsLocationState | null): string {
  const from = state?.from;
  return from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith(HOUSEHOLDS_PATH) ? from : '/';
}

export function HouseholdPicker() {
  const navigate = useNavigate();
  const location = useLocation();
  const { households, activeHouseholdId, selectHousehold } = useActiveHousehold();
  const [selecting, setSelecting] = useState<string>();
  const [error, setError] = useState<string>();

  async function choose(householdId: string, then?: string) {
    setSelecting(householdId);
    setError(undefined);
    try {
      await selectHousehold(householdId);
      navigate(then ?? returnPath(location.state as HouseholdsLocationState | null), { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSelecting(undefined);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <ScreenHeader title="Your households" description="Choose which household you're planning for." />
      {error && <ErrorBanner message={error} />}
      <AsyncView
        query={households}
        errorMessage={errorText}
        isEmpty={(list: HouseholdSummary[]) => list.length === 0}
        empty={
          <div className="flex flex-col gap-6">
            <EmptyState
              icon={<Home />}
              title="No households yet"
              description="Create a household to start planning meals. You can invite others once it exists."
            />
            <CreateHousehold label="Household name" onCreated={(h) => choose(h.householdId, '/')} />
          </div>
        }
      >
        {(list) => (
          <div className="flex flex-col gap-8">
            <ul className="flex flex-col gap-3" aria-label="Households">
              {list.map((household) => {
                const active = household.householdId === activeHouseholdId;
                return (
                  <li key={household.householdId}>
                    <button
                      type="button"
                      onClick={() => void choose(household.householdId)}
                      disabled={selecting !== undefined}
                      aria-current={active ? 'true' : undefined}
                      aria-busy={selecting === household.householdId || undefined}
                      className={cx(
                        'flex min-h-16 w-full items-center gap-3 rounded-2xl border bg-surface p-4 text-left shadow-card transition-colors duration-150 hover:bg-surface-2 disabled:opacity-60',
                        active ? 'border-accent' : 'border-border',
                      )}
                    >
                      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                        <Home className="size-5" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                        <span className="block max-w-full truncate font-medium text-text">{household.name}</span>
                        <RoleBadge role={household.role} />
                      </span>
                      {active ? (
                        <>
                          <Check aria-hidden="true" className="size-5 text-accent-text" />
                          <span className="sr-only">(selected)</span>
                        </>
                      ) : (
                        <ChevronRight aria-hidden="true" className="size-5 text-text-muted" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {activeHouseholdId && list.some((h) => h.householdId === activeHouseholdId) && (
              <Link
                to={MEMBERS_PATH}
                className="inline-flex min-h-11 items-center gap-2 self-start rounded-xl px-1 text-sm font-medium text-accent-text underline-offset-4 hover:underline"
              >
                <Users aria-hidden="true" className="size-4" />
                Members of the selected household
              </Link>
            )}
            <section aria-labelledby="new-household-heading" className="flex flex-col gap-3">
              <h2 id="new-household-heading" className="text-sm font-medium">
                Start another household
              </h2>
              <CreateHousehold onCreated={(h) => choose(h.householdId, '/')} />
            </section>
          </div>
        )}
      </AsyncView>
    </div>
  );
}
