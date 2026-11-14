/**
 * Route table (design.md, "Routing"). Auth screens are public and bounce a
 * signed-in User to the app; every other route needs a session, and the
 * Household screens also need an Active_Household.
 */
import { forwardRef } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { LogOut, SlidersHorizontal } from 'lucide-react';
import { RedirectIfSignedIn, RequireSession } from './auth/RequireSession';
import { useSession } from './auth/SessionProvider';
import { ConfirmSignUp } from './features/auth/ConfirmSignUp';
import { SignIn } from './features/auth/SignIn';
import { SignUp } from './features/auth/SignUp';
import { GroceryIndex, ShoppingListScreen } from './features/grocery';
import { AcceptInvitation, HouseholdPicker, Members } from './features/households';
import { NewPlan, PlansList } from './features/plans';
import { PreferencesScreen } from './features/preferences';
import { useActiveHousehold } from './household/ActiveHouseholdProvider';
import { RequireHousehold } from './household/RequireHousehold';
import { NAV_ITEMS, activeNavId } from './navigation';
import { FridgeRoute, GroceryRoute, PlanGroceryRedirect, PlanRoute, SuggestRoute } from './screens';
import { AppShell, IconButton, ThemeToggle, cx, type NavLinkProps } from './ui';

/** Adapts the shell's anchor-style links to client-side navigation. */
const RouterNavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function RouterNavLink({ href, ...rest }, ref) {
  return <Link ref={ref} to={href} {...rest} />;
});

export const PREFERENCES_PATH = '/preferences';

/** Top-bar link to Preferences, styled like an IconButton. */
function PreferencesLink({ active }: { active: boolean }) {
  return (
    <Link
      to={PREFERENCES_PATH}
      aria-label="Preferences"
      title="Preferences"
      aria-current={active ? 'page' : undefined}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors duration-150 [&_svg]:size-5',
        active ? 'bg-accent-soft text-accent-text' : 'text-text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      <SlidersHorizontal aria-hidden="true" />
    </Link>
  );
}

/** App chrome (nav, header actions) wrapping the authenticated routes via `<Outlet>`. */
function ShellLayout() {
  const { pathname } = useLocation();
  const { signOut } = useSession();
  const { activeHousehold } = useActiveHousehold();
  return (
    <AppShell
      navItems={NAV_ITEMS}
      activeNavId={activeNavId(pathname)}
      linkComponent={RouterNavLink}
      subtitle={activeHousehold?.name}
      actions={
        <>
          {activeHousehold && <PreferencesLink active={pathname === PREFERENCES_PATH} />}
          <ThemeToggle />
          <IconButton label="Sign out" icon={<LogOut />} onClick={signOut} />
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

/**
 * The route tree. Nesting encodes access: `RedirectIfSignedIn` wraps the
 * public auth routes, `RequireSession` the rest, and `RequireHousehold` the
 * routes that also need an active household. Unknown paths redirect to `/`.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<RedirectIfSignedIn />}>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/sign-up" element={<SignUp />} />
        <Route path="/sign-up/confirm" element={<ConfirmSignUp />} />
        <Route path="/confirm" element={<ConfirmRedirect />} />
      </Route>
      <Route element={<RequireSession />}>
        <Route element={<ShellLayout />}>
          <Route path="/invitations/:invitationId" element={<AcceptInvitation />} />
          <Route path="/households" element={<HouseholdPicker />} />
          <Route element={<RequireHousehold />}>
            <Route index element={<SuggestRoute />} />
            <Route path="/households/members" element={<Members />} />
            <Route path="/plans" element={<PlansList />} />
            <Route path="/plans/new" element={<NewPlan />} />
            <Route path="/plans/:planId" element={<PlanRoute />} />
            <Route path="/plans/:planId/grocery" element={<PlanGroceryRedirect />} />
            <Route path="/grocery" element={<GroceryIndex />} />
            <Route path="/grocery/lists/:listId" element={<ShoppingListScreen />} />
            <Route path="/grocery/:planId" element={<GroceryRoute />} />
            <Route path="/fridge" element={<FridgeRoute />} />
            <Route path={PREFERENCES_PATH} element={<PreferencesScreen />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** `/confirm` is a short alias for the confirmation screen. */
function ConfirmRedirect() {
  const location = useLocation();
  return <Navigate to="/sign-up/confirm" replace state={location.state} />;
}
