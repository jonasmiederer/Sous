import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import { ToastProvider } from '../../ui';
import type { Meal, StoredPlan } from '../../api/types';
import { MemoryStorage, NOW, ONE_HOUSEHOLD, HOUSEHOLDS_URL, TEST_CONFIG, fakeFetch, testSession, type Routes as FakeRoutes } from '../../test/harness';
import { NewPlan, PlanView, PlansList, addableDays, findSavedPlan, progressFraction, validateNewPlan } from './index';

const API = TEST_CONFIG.apiUrl;
const PLANS_URL = `${API}/plans`;

function meal(id: string, name: string): Meal {
  return {
    mealId: id,
    name,
    ingredients: [{ name: 'tomato', quantity: 2, unit: 'piece' }],
    steps: ['Chop', 'Cook'],
    attributes: ['vegetarian'],
  };
}

const STORED: StoredPlan = {
  plan: {
    planId: 'plan-1',
    householdId: 'hh-1',
    startDate: '2030-01-07',
    endDate: '2030-01-09',
    rangeDays: 3,
    days: [
      { day: '2030-01-07', mealId: 'm1' },
      { day: '2030-01-09', mealId: 'm3' },
    ],
  },
  meals: [meal('m1', 'Shakshuka'), meal('m3', 'Lentil soup')],
  version: 2,
};

const SUMMARY = { planId: 'plan-1', startDate: '2030-01-07', endDate: '2030-01-09', rangeDays: 3 };

function GroceryStub() {
  return <h1>Grocery for {useParams().planId}</h1>;
}

function renderPlans(path: string, routes: FakeRoutes, fetchOverride?: (base: typeof fetch) => typeof fetch) {
  const storage = new MemoryStorage();
  const session = testSession();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  storage.setItem(activeHouseholdKey(session.user.userId), 'hh-1');
  const net = fakeFetch({ [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes });
  const services = createAppServices({
    config: TEST_CONFIG,
    storage,
    fetch: fetchOverride ? fetchOverride(net.fetch) : net.fetch,
    now: () => NOW,
    queryDefaults: { queries: { retry: false } },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ServicesProvider services={services}>
        <SessionProvider>
          <ActiveHouseholdProvider>
            <ToastProvider>
              <Routes>
                <Route path="/plans" element={<PlansList />} />
                <Route path="/plans/new" element={<NewPlan />} />
                <Route path="/plans/:planId" element={<PlanView />} />
                <Route path="/grocery/:planId" element={<GroceryStub />} />
              </Routes>
            </ToastProvider>
          </ActiveHouseholdProvider>
        </SessionProvider>
      </ServicesProvider>
    </MemoryRouter>,
  );
  return { calls: net.calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('plan helpers', () => {
  it('validates the plan length and builds the request body', () => {
    const base = { range: 'custom' as const, startDate: '', contextInput: '', presets: [] };
    expect(validateNewPlan({ ...base, days: '0' }).ok).toBe(false);
    expect(validateNewPlan({ ...base, days: '32' }).ok).toBe(false);
    expect(validateNewPlan({ ...base, days: '2.5' }).ok).toBe(false);
    expect(validateNewPlan({ ...base, days: '31' })).toMatchObject({ ok: true, request: { rangeDays: 31 } });
    expect(validateNewPlan({ ...base, range: 'week', days: '', contextInput: ' pasta ', presets: ['quick'] })).toEqual({
      ok: true,
      dayCount: 7,
      request: { weekly: true, contextInput: 'pasta', presets: ['quick'] },
    });
    expect(validateNewPlan({ ...base, days: '3', presets: ['quick', 'fine dining'] }).ok).toBe(false);
  });

  it('lists unassigned and adjacent days that can be added', () => {
    expect(addableDays(STORED.plan)).toEqual(['2030-01-06', '2030-01-08', '2030-01-10']);
    const full = { startDate: '2030-01-01', endDate: '2030-01-31', days: [] };
    expect(addableDays(full)).toHaveLength(31);
  });

  it('finds a plan saved after a timeout and keeps progress below completion', () => {
    const list = { plans: [{ ...SUMMARY, planId: 'new' }, SUMMARY] };
    expect(findSavedPlan(list, ['plan-1'], { dayCount: 7 })).toBe('new');
    expect(findSavedPlan(list, ['plan-1', 'new'], { dayCount: 7 })).toBeUndefined();
    expect(findSavedPlan(list, null, { dayCount: 3 })).toBe('new');
    expect(progressFraction(10 * 60_000)).toBeLessThan(1);
  });
});

describe('PlansList', () => {
  it('shows the Household plans and links to each', async () => {
    renderPlans('/plans', { [`GET ${PLANS_URL}`]: { body: { plans: [SUMMARY] } } });
    const list = await screen.findByRole('list', { name: 'Plans' });
    expect(within(list).getByText('3 days')).toBeInTheDocument();
    expect(within(list).getByRole('link')).toHaveAttribute('href', '/plans/plan-1');
  });

  it('shows an empty state without plans', async () => {
    renderPlans('/plans', { [`GET ${PLANS_URL}`]: { body: { plans: [] } } });
    expect(await screen.findByText('No plans yet')).toBeInTheDocument();
  });
});

describe('NewPlan', () => {
  it('blocks out-of-range day counts without calling the API', async () => {
    const user = userEvent.setup();
    const { calls } = renderPlans('/plans/new', { [`GET ${PLANS_URL}`]: { body: { plans: [] } } });
    await user.click(await screen.findByLabelText('Custom'));
    const days = screen.getByLabelText('Number of days');
    await user.clear(days);
    await user.type(days, '40');
    await user.click(screen.getByRole('button', { name: 'Generate plan' }));
    expect(screen.getByText('Choose between 1 and 31 days.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === PLANS_URL)).toBe(false);
  });

  it('generates a week with the Active_Household and opens the plan', async () => {
    const user = userEvent.setup();
    const { calls } = renderPlans('/plans/new', {
      [`GET ${PLANS_URL}`]: { body: { plans: [] } },
      [`POST ${PLANS_URL}`]: { status: 201, body: STORED },
    });
    await user.click(await screen.findByRole('button', { name: 'Healthy' }));
    await user.click(screen.getByRole('button', { name: 'Plan my week' }));
    expect(await screen.findByRole('heading', { name: 'Shakshuka' })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.url === PLANS_URL);
    expect(post?.body).toEqual({ weekly: true, presets: ['healthy'] });
    expect(post?.headers['x-active-household']).toBe('hh-1');
  });

  it('after a client timeout, refetches the plans list and opens a plan that was saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let listCalls = 0;
    renderPlans(
      '/plans/new',
      {
        [`GET ${PLANS_URL}`]: () => ({ body: { plans: listCalls++ === 0 ? [] : [SUMMARY] } }),
        [`GET ${PLANS_URL}/plan-1`]: { body: STORED },
      },
      (base) => (input, init) => {
        if (init?.method === 'POST' && String(input) === PLANS_URL) {
          // Never answers; the client's 32 s timeout aborts it.
          return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        return base(input, init);
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Plan my week' }));
    expect(await screen.findByRole('progressbar', { name: 'Generating plan' })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await screen.findByRole('heading', { name: 'Shakshuka' })).toBeInTheDocument();
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('PlanView', () => {
  const planUrl = `${PLANS_URL}/plan-1`;

  it('shows each day, expands details, and links to the grocery list', async () => {
    renderPlans('/plans/plan-1', { [`GET ${planUrl}`]: { body: STORED } });
    const days = await screen.findByRole('list', { name: 'Days' });
    expect(within(days).getAllByRole('article')).toHaveLength(3);
    expect(within(days).getByText('No meal planned.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grocery list/ })).toHaveAttribute('href', '/grocery/plan-1');
  });

  it('swaps one day with a note and leaves the other days unchanged', async () => {
    const user = userEvent.setup();
    const { calls } = renderPlans('/plans/plan-1', {
      [`GET ${planUrl}`]: { body: STORED },
      [`PUT ${planUrl}/days/2030-01-07`]: {
        body: {
          plan: { ...STORED.plan, days: [{ day: '2030-01-07', mealId: 'm9' }, STORED.plan.days[1]] },
          meal: meal('m9', 'Fish tacos'),
          change: 'day_replaced',
          day: '2030-01-07',
          version: 3,
          eventPublished: true,
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Swap Shakshuka' }));
    await user.type(screen.getByLabelText(/Note for Sous/), 'fish please');
    await user.click(screen.getByRole('button', { name: 'Swap meal' }));
    expect(await screen.findByRole('heading', { name: 'Fish tacos' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lentil soup' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Shakshuka' })).not.toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ contextInput: 'fish please' });
  });

  it('removes a day after confirmation and adds a meal to an empty day', async () => {
    const user = userEvent.setup();
    const { calls } = renderPlans('/plans/plan-1', {
      [`GET ${planUrl}`]: { body: STORED },
      [`DELETE ${planUrl}/days/2030-01-09`]: {
        body: { plan: { ...STORED.plan, days: [STORED.plan.days[0]] }, change: 'day_removed', day: '2030-01-09', version: 3, eventPublished: true },
      },
      [`POST ${planUrl}/days`]: {
        status: 201,
        body: {
          plan: { ...STORED.plan, days: [STORED.plan.days[0], { day: '2030-01-08', mealId: 'm2' }] },
          meal: meal('m2', 'Risotto'),
          change: 'day_added',
          day: '2030-01-08',
          version: 4,
          eventPublished: true,
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove Lentil soup' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Lentil soup' })).not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: /^Add a meal on/ })[0]!);
    await user.click(screen.getByRole('button', { name: 'Add meal' }));
    expect(await screen.findByRole('heading', { name: 'Risotto' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.url === `${planUrl}/days`)?.body).toEqual({ day: '2030-01-08' });
  });

  it('shows PLAN_CONFLICT with a reload action', async () => {
    const user = userEvent.setup();
    let gets = 0;
    renderPlans('/plans/plan-1', {
      [`GET ${planUrl}`]: () => {
        gets++;
        return { body: STORED };
      },
      [`PUT ${planUrl}/days/2030-01-07`]: { status: 409, body: { error: { code: 'PLAN_CONFLICT', message: 'conflict' } } },
    });
    await user.click(await screen.findByRole('button', { name: 'Swap Shakshuka' }));
    await user.click(screen.getByRole('button', { name: 'Swap meal' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Someone else changed this plan');
    await user.click(within(alert).getByRole('button', { name: 'Reload plan' }));
    await waitFor(() => expect(gets).toBe(2));
  });
});
