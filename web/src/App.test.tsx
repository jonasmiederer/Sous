import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import fc from 'fast-check';
import { PRESETS } from '@sous/domain/types';
import { validatePresets } from '@sous/domain/presets';
import { NAV_ITEMS, SHARED_UNIT_COUNT } from './App';
import { HOUSEHOLDS_URL, ONE_HOUSEHOLD, renderApp, testSession } from './test/harness';

function renderSignedIn(path = '/') {
  return renderApp({ path, session: testSession(), activeHouseholdId: 'hh-1', routes: { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD } } });
}

describe('App shell', () => {
  it('renders one h1, the navigation, and every preset from the shared domain', async () => {
    renderSignedIn();
    expect(await screen.findByText('Home')).toBeInTheDocument(); // Active_Household name in the top bar
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const item of NAV_ITEMS) {
      expect(nav).toContainElement(screen.getByRole('link', { name: item.label }));
    }
    for (const name of ['Healthy', 'Quick', 'Craving', 'Fine dining']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(SHARED_UNIT_COUNT).toBeGreaterThan(0);
  });

  it('flags conflicting presets and disables submission', async () => {
    const user = userEvent.setup();
    renderSignedIn();
    await user.click(screen.getByRole('button', { name: 'Quick' }));
    await user.click(screen.getByRole('button', { name: 'Fine dining' }));
    expect(screen.getByText(/Quick and Fine dining can.t be combined/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest meals' })).toBeDisabled();
  });

  it('switches the active tab through the router', async () => {
    const user = userEvent.setup();
    renderSignedIn();
    await user.click(screen.getByRole('link', { name: 'Plans' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Plans' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Plans' })).toHaveAttribute('aria-current', 'page');
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderSignedIn();
    await screen.findByText('Home');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('resolves the shared domain modules through the @sous/domain alias', () => {
    fc.assert(
      fc.property(fc.subarray([...PRESETS]), (presets) => {
        const result = validatePresets(presets);
        const conflict = presets.includes('quick') && presets.includes('fine dining');
        expect(result.ok).toBe(!conflict);
      }),
      { numRuns: 100 },
    );
  });
});
