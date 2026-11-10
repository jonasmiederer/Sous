import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { RequireSession } from '../../auth/RequireSession';
import { SESSION_STORAGE_KEY, activeHouseholdKey, type StoredSession } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import { RequireHousehold } from '../../household/RequireHousehold';
import { ToastProvider } from '../../ui';
import { HOUSEHOLDS_URL, MemoryStorage, NOW, TEST_CONFIG, USER, fakeFetch, testSession, type Routes as FakeRoutes } from '../../test/harness';
import { AcceptInvitation, HouseholdPicker, Members, invitationLink } from './index';

const API = TEST_CONFIG.apiUrl;
const ACTIVE_URL = `${API}/session/active-household`;

function SignInProbe() {
  const state = useLocation().state as { from?: string } | null;
  return <p>sign-in from {state?.from}</p>;
}

/** Mounts the household screens on their design.md routes with the real providers. */
function renderScreens(path: string, routes: FakeRoutes, opts: { session?: StoredSession | null; activeHouseholdId?: string } = {}) {
  const storage = new MemoryStorage();
  const session = opts.session === undefined ? testSession() : opts.session;
  if (session) storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  if (session && opts.activeHouseholdId) storage.setItem(activeHouseholdKey(session.user.userId), opts.activeHouseholdId);
  const net = fakeFetch(routes);
  const services = createAppServices({ config: TEST_CONFIG, storage, fetch: net.fetch, now: () => NOW, queryDefaults: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ServicesProvider services={services}>
        <SessionProvider>
          <ActiveHouseholdProvider>
            <ToastProvider>
              <Routes>
                <Route path="/sign-in" element={<SignInProbe />} />
                <Route path="/invitations/:invitationId" element={<AcceptInvitation />} />
                <Route element={<RequireSession />}>
                  <Route path="/households" element={<HouseholdPicker />} />
                  <Route element={<RequireHousehold />}>
                    <Route path="/households/members" element={<Members />} />
                    <Route path="/" element={<p>suggest home</p>} />
                  </Route>
                </Route>
              </Routes>
            </ToastProvider>
          </ActiveHouseholdProvider>
        </SessionProvider>
      </ServicesProvider>
    </MemoryRouter>,
  );
  return { calls: net.calls, storage };
}

const OWNED = { householdId: 'hh-1', name: 'Home', role: 'owner', ownerUserId: USER.userId };
const JOINED = { householdId: 'hh-2', name: 'Beach house', role: 'member', ownerUserId: 'user-9' };

describe('HouseholdPicker', () => {
  it('shows role badges and selects a household after the System confirms membership', async () => {
    const { calls, storage } = renderScreens('/households', {
      [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [OWNED, JOINED] } },
      [`PUT ${ACTIVE_URL}`]: { body: { userId: USER.userId, householdId: 'hh-2', role: 'member' } },
    });
    const list = await screen.findByRole('list', { name: 'Households' });
    const [home, beach] = within(list).getAllByRole('button');
    expect(within(home!).getByText('Owner')).toBeInTheDocument();
    expect(within(beach!).getByText('Member')).toBeInTheDocument();

    await userEvent.click(beach!);
    expect(await screen.findByText('suggest home')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ householdId: 'hh-2' });
    expect(storage.getItem(activeHouseholdKey(USER.userId))).toBe('hh-2');
  });

  it('prompts creation when the User has no households, and selects the new one', async () => {
    let created = false;
    const { calls } = renderScreens('/households', {
      [`GET ${HOUSEHOLDS_URL}`]: () => ({ body: { households: created ? [OWNED] : [] } }),
      [`POST ${HOUSEHOLDS_URL}`]: () => {
        created = true;
        return { body: { household: { householdId: 'hh-1', name: 'Home', ownerUserId: USER.userId }, membership: { householdId: 'hh-1', userId: USER.userId, role: 'owner' } } };
      },
      [`PUT ${ACTIVE_URL}`]: { body: { userId: USER.userId, householdId: 'hh-1', role: 'owner' } },
    });
    expect(await screen.findByText('No households yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Give your household a name.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Household name'), '  Home ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('suggest home')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Home' });
  });
});

const MEMBERS = {
  members: [
    { userId: USER.userId, email: USER.email, role: 'owner', joinedAt: '2029-12-01T00:00:00.000Z' },
    { userId: 'user-2', email: 'ben@example.com', role: 'member', joinedAt: '2029-12-02T00:00:00.000Z' },
  ],
};

describe('Members', () => {
  it('shows Remove only to the owner and only on non-owner rows, and removes after confirmation', async () => {
    let members = MEMBERS.members;
    const { calls } = renderScreens(
      '/households/members',
      {
        [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [OWNED] } },
        [`GET ${HOUSEHOLDS_URL}/hh-1/members`]: () => ({ body: { members } }),
        [`DELETE ${HOUSEHOLDS_URL}/hh-1/members/user-2`]: () => {
          members = members.filter((m) => m.userId !== 'user-2');
          return { body: { removed: { householdId: 'hh-1', userId: 'user-2', role: 'member' } } };
        },
      },
      { activeHouseholdId: 'hh-1' },
    );
    await screen.findByText('ben@example.com');
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: `Remove ${USER.email}` })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove ben@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove member?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('ben@example.com')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(await screen.findByText('ben@example.com was removed.')).toBeInTheDocument();
  });

  it('hides Invite and Remove from a non-owner member', async () => {
    renderScreens(
      '/households/members',
      {
        [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [JOINED] } },
        [`GET ${HOUSEHOLDS_URL}/hh-2/members`]: {
          body: { members: [{ userId: 'user-9', email: 'cy@example.com', role: 'owner', joinedAt: '2029-01-01T00:00:00Z' }, { userId: USER.userId, role: 'member', joinedAt: '2029-02-01T00:00:00Z' }] },
        },
      },
      { activeHouseholdId: 'hh-2' },
    );
    await screen.findByText('cy@example.com');
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });
});

describe('InviteDialog', () => {
  it('creates an invitation by email and shows the Invitation_Link with Copy', async () => {
    const { calls } = renderScreens(
      '/households/members',
      {
        [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [OWNED] } },
        [`GET ${HOUSEHOLDS_URL}/hh-1/members`]: { body: MEMBERS },
        [`POST ${HOUSEHOLDS_URL}/hh-1/invitations`]: {
          body: { invitationId: 'inv-7', householdId: 'hh-1', invitee: { kind: 'email', email: 'dee@example.com' }, status: 'pending', createdAt: '', expiresAt: '' },
        },
      },
      { activeHouseholdId: 'hh-1' },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite someone' });
    await userEvent.type(within(dialog).getByLabelText('Email'), 'not-an-email');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    expect(within(dialog).getByText(/Enter an email address/)).toBeInTheDocument();

    await userEvent.clear(within(dialog).getByLabelText('Email'));
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dee@example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));

    const ready = await screen.findByRole('dialog', { name: 'Invitation ready' });
    expect(calls.find((c) => c.url.endsWith('/invitations'))?.body).toEqual({ email: 'dee@example.com' });
    expect(within(ready).getByLabelText('Invitation link')).toHaveValue(invitationLink('inv-7'));
    await userEvent.click(within(ready).getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/Invitation link copied|Couldn't copy the link/)).toBeInTheDocument();
  });

  it('formats the Invitation_Link as {origin}/invitations/{id}', () => {
    expect(invitationLink('inv 1', 'https://sous.example/')).toBe('https://sous.example/invitations/inv%201');
  });
});

describe('AcceptInvitation', () => {
  it('sends a signed-out User to sign-in and keeps the invitation path', async () => {
    renderScreens('/invitations/inv-7', {}, { session: null });
    expect(await screen.findByText('sign-in from /invitations/inv-7')).toBeInTheDocument();
  });

  it('accepts, refreshes the households list, and offers to switch to the joined household', async () => {
    let joined = false;
    const { storage } = renderScreens('/invitations/inv-7', {
      [`GET ${HOUSEHOLDS_URL}`]: () => ({ body: { households: joined ? [OWNED, JOINED] : [OWNED] } }),
      [`POST ${API}/invitations/inv-7/accept`]: () => {
        joined = true;
        return { body: { invitation: { invitationId: 'inv-7', status: 'accepted' }, membership: { householdId: 'hh-2', userId: USER.userId, role: 'member' } } };
      },
      [`PUT ${ACTIVE_URL}`]: { body: { userId: USER.userId, householdId: 'hh-2', role: 'member' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Beach house' }));
    expect(await screen.findByText('suggest home')).toBeInTheDocument();
    expect(storage.getItem(activeHouseholdKey(USER.userId))).toBe('hh-2');
  });

  it("shows the System's invalid-invitation outcome", async () => {
    renderScreens('/invitations/inv-old', {
      [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [OWNED] } },
      [`POST ${API}/invitations/inv-old/accept`]: { status: 409, body: { error: { code: 'INVALID_INVITATION' } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer valid/);
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });

  it('declines', async () => {
    renderScreens('/invitations/inv-7', {
      [`GET ${HOUSEHOLDS_URL}`]: { body: { households: [OWNED] } },
      [`POST ${API}/invitations/inv-7/decline`]: { body: { invitationId: 'inv-7', status: 'declined' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(await screen.findByRole('heading', { name: 'Invitation declined' })).toBeInTheDocument();
  });
});
