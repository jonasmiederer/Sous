import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import { HOUSEHOLDS_URL, MemoryStorage, NOW, ONE_HOUSEHOLD, TEST_CONFIG, fakeFetch, testSession, type Routes } from '../../test/harness';
import { ToastProvider } from '../../ui';
import { PreferencesScreen, constraintProblem } from './index';

const PREFS_URL = `${TEST_CONFIG.apiUrl}/preferences`;
const CONSTRAINTS = `POST ${TEST_CONFIG.apiUrl}/preferences/constraints`;

function saved(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      householdId: 'hh-1',
      likes: ['Lasagna'],
      dislikes: ['Liver'],
      excludedIngredients: ['coconut'],
      dietaryConstraints: ['Vegetarian'],
      acceptances: [],
      updatedAt: '2030-01-01T00:00:00Z',
      ...overrides,
    },
    version: 1,
  };
}

function renderScreen(routes: Routes) {
  const storage = new MemoryStorage();
  const session = testSession();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  storage.setItem(activeHouseholdKey(session.user.userId), 'hh-1');
  const net = fakeFetch({ [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes });
  const services = createAppServices({ config: TEST_CONFIG, storage, fetch: net.fetch, now: () => NOW, queryDefaults: { queries: { retry: false } } });
  render(
    <ServicesProvider services={services}>
      <SessionProvider>
        <ActiveHouseholdProvider>
          <ToastProvider>
            <PreferencesScreen />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>,
  );
  return { posts: () => net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/preferences/constraints')) };
}

describe('constraintProblem', () => {
  it('trims, limits to 200 code points, and rejects case-insensitive duplicates', () => {
    expect(constraintProblem('   ', [])).toBe('empty');
    expect(constraintProblem('😀'.repeat(200), [])).toBeNull();
    expect(constraintProblem('a'.repeat(201), [])).toBe('too_long');
    expect(constraintProblem('  vegetarian ', ['Vegetarian'])).toBe('duplicate');
    expect(constraintProblem('no coconut', ['Vegetarian'])).toBeNull();
  });
});

describe('Preferences screen', () => {
  it('shows likes, dislikes, exclusions, and needs, and adds a new need', async () => {
    const user = userEvent.setup();
    const { posts } = renderScreen({
      [`GET ${PREFS_URL}`]: { body: saved() },
      [CONSTRAINTS]: { body: saved({ dietaryConstraints: ['Vegetarian', 'no coconut'] }) },
    });

    expect(within(await screen.findByRole('list', { name: 'Likes' })).getByText('Lasagna')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Dislikes' })).getByText('Liver')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Never included' })).getByText('coconut')).toBeInTheDocument();
    expect(screen.getByText(/always respects needs like “no coconut”/)).toBeInTheDocument();

    const field = screen.getByLabelText('Add a dietary need');
    await user.type(field, '  no coconut ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ constraint: 'no coconut' });
    expect(await within(screen.getByRole('list', { name: 'Dietary needs' })).findByText('no coconut')).toBeInTheDocument();
    expect(field).toHaveValue('');
  });

  it('blocks duplicates and over-long needs locally with a live counter', async () => {
    const user = userEvent.setup();
    const { posts } = renderScreen({ [`GET ${PREFS_URL}`]: { body: saved() } });

    const field = await screen.findByLabelText('Add a dietary need');
    await user.type(field, 'VEGETARIAN');
    expect(screen.getByText('That one is already on your list.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await user.clear(field);
    await user.click(field);
    await user.paste('x'.repeat(201));
    expect(screen.getByText('201 / 200')).toBeInTheDocument();
    expect(screen.getByText('Keep it to 200 characters or fewer.')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('maps the server reason and shows an empty profile', async () => {
    const user = userEvent.setup();
    renderScreen({
      [`GET ${PREFS_URL}`]: { body: { profile: null } },
      [CONSTRAINTS]: { status: 400, body: { error: { code: 'INVALID_DIETARY_CONSTRAINT', message: 'dup', reason: 'duplicate' } } },
    });

    expect(await screen.findByText('No dietary needs yet.')).toBeInTheDocument();
    expect(screen.getByText('Like a suggestion to see it here.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Add a dietary need'), 'halal{Enter}');
    expect(await screen.findByText('That one is already on your list.')).toBeInTheDocument();
  });
});
