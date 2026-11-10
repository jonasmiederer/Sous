import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey, groceryChecksKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import { ToastProvider } from '../../ui';
import type { GroceryList } from '../../api/types';
import { HOUSEHOLDS_URL, MemoryStorage, NOW, ONE_HOUSEHOLD, TEST_CONFIG, fakeFetch, testSession, type Routes as FakeRoutes } from '../../test/harness';
import { GroceryIndex, GroceryScreen, formatAmount, groceryEntryKey, readGroceryChecks, writeGroceryChecks } from './index';

const API = TEST_CONFIG.apiUrl;
const LIST_URL = `${API}/plans/plan-1/grocery-list`;
const CHECKS_KEY = groceryChecksKey('hh-1', 'plan-1');

function groceryList(generatedAt: string, entries: GroceryList['entries']): GroceryList {
  return { householdId: 'hh-1', planId: 'plan-1', generatedAt, entries };
}

const LIST = groceryList('2030-01-01T10:00:00.000Z', [
  { name: 'tomato', quantity: 3, unit: 'piece' },
  { name: 'rice', quantity: 500, unit: 'g' },
  { name: 'milk', quantity: 1.5, unit: 'cup' },
]);

function renderGrocery(path: string, routes: FakeRoutes, storage = new MemoryStorage(), onRefine?: (planId: string) => void) {
  const session = testSession();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  storage.setItem(activeHouseholdKey(session.user.userId), 'hh-1');
  const net = fakeFetch({ [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes });
  const services = createAppServices({
    config: TEST_CONFIG,
    storage,
    fetch: net.fetch,
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
                <Route path="/grocery" element={<GroceryIndex />} />
                <Route path="/grocery/:planId" element={<GroceryScreen onRefine={onRefine} />} />
              </Routes>
            </ToastProvider>
          </ActiveHouseholdProvider>
        </SessionProvider>
      </ServicesProvider>
    </MemoryRouter>,
  );
  return { calls: net.calls, storage };
}

describe('grocery helpers', () => {
  it('formats quantities and pluralizes units', () => {
    expect(formatAmount({ quantity: 1, unit: 'piece' })).toBe('1 piece');
    expect(formatAmount({ quantity: 3, unit: 'piece' })).toBe('3 pieces');
    expect(formatAmount({ quantity: 1.5, unit: 'cup' })).toBe('1½ cups');
    expect(formatAmount({ quantity: 0.25, unit: 'tsp' })).toBe('¼ tsp');
    expect(formatAmount({ quantity: 1.25, unit: 'kg' })).toBe('1.25 kg');
    expect(formatAmount({ quantity: 2, unit: 'bunch' })).toBe('2 bunches');
    expect(formatAmount({ quantity: 2, unit: 'fl_oz' })).toBe('2 fl oz');
    expect(groceryEntryKey({ name: 'rice', unit: 'g' })).toBe('rice|g');
  });

  it('reads checks only for the matching generatedAt and survives broken storage', () => {
    const storage = new MemoryStorage();
    writeGroceryChecks(storage, CHECKS_KEY, { generatedAt: 'a', checked: ['rice|g'] });
    expect([...readGroceryChecks(storage, CHECKS_KEY, 'a')]).toEqual(['rice|g']);
    expect(readGroceryChecks(storage, CHECKS_KEY, 'b').size).toBe(0);
    storage.setItem(CHECKS_KEY, 'not json');
    expect(readGroceryChecks(storage, CHECKS_KEY, 'a').size).toBe(0);

    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readGroceryChecks(broken, CHECKS_KEY, 'a').size).toBe(0);
    expect(() => writeGroceryChecks(broken, CHECKS_KEY, { generatedAt: 'a', checked: ['x|g'] })).not.toThrow();
  });
});

describe('GroceryIndex', () => {
  it('lists plans newest first, linking to their grocery lists', async () => {
    renderGrocery('/grocery', {
      [`GET ${API}/plans`]: {
        body: {
          plans: [
            { planId: 'plan-2', startDate: '2030-01-14', endDate: '2030-01-20', rangeDays: 7 },
            { planId: 'plan-1', startDate: '2030-01-07', endDate: '2030-01-09', rangeDays: 3 },
          ],
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Plans to shop for' });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/grocery/plan-2', '/grocery/plan-1']);
  });
});

describe('GroceryScreen', () => {
  it('offers to make a list when none exists and shows it after generating', async () => {
    const user = userEvent.setup();
    const { calls } = renderGrocery('/grocery/plan-1', {
      [`GET ${LIST_URL}`]: { status: 404, body: { error: { code: 'GROCERY_LIST_NOT_FOUND', message: 'none' } } },
      [`POST ${LIST_URL}`]: { status: 201, body: { groceryList: LIST, version: 1 } },
    });
    await user.click(await screen.findByRole('button', { name: 'Make grocery list' }));
    expect(await screen.findByRole('checkbox', { name: 'tomato, 3 pieces' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'rice, 500 g' })).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.url === LIST_URL);
    expect(post?.headers['x-active-household']).toBe('hh-1');
  });

  it('shows an empty-list message for a plan with nothing to buy', async () => {
    renderGrocery('/grocery/plan-1', { [`GET ${LIST_URL}`]: { body: { groceryList: groceryList('t', []), version: 1 } } });
    expect(await screen.findByText('Nothing to buy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('moves checked items to Done, shows progress, and remembers checks on the device', async () => {
    const user = userEvent.setup();
    const { storage } = renderGrocery('/grocery/plan-1', { [`GET ${LIST_URL}`]: { body: { groceryList: LIST, version: 1 } } });
    await user.click(await screen.findByRole('checkbox', { name: 'rice, 500 g' }));

    const done = screen.getByRole('list', { name: 'Done' });
    expect(within(done).getByRole('checkbox', { name: 'rice, 500 g' })).toBeChecked();
    expect(within(screen.getByRole('list', { name: 'To buy' })).getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('progressbar', { name: 'Items checked' })).toHaveAttribute('aria-valuetext', '1 of 3');
    expect(JSON.parse(storage.getItem(CHECKS_KEY)!)).toEqual({ generatedAt: LIST.generatedAt, checked: ['rice|g'] });
  });

  it('restores stored checks for the same list and resets them after regenerating', async () => {
    const user = userEvent.setup();
    const storage = new MemoryStorage();
    storage.setItem(CHECKS_KEY, JSON.stringify({ generatedAt: LIST.generatedAt, checked: ['tomato|piece'] }));
    const regenerated = groceryList('2030-01-02T09:00:00.000Z', LIST.entries);
    let onRefineCalls: string[] = [];
    renderGrocery(
      '/grocery/plan-1',
      {
        [`GET ${LIST_URL}`]: { body: { groceryList: LIST, version: 1 } },
        [`POST ${LIST_URL}`]: { body: { groceryList: regenerated, version: 2 } },
      },
      storage,
      (planId) => {
        onRefineCalls = [...onRefineCalls, planId];
      },
    );
    expect(await screen.findByRole('checkbox', { name: 'tomato, 3 pieces' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Refine in chat' }));
    expect(onRefineCalls).toEqual(['plan-1']);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByRole('progressbar', { name: 'Items checked' })).toHaveAttribute('aria-valuetext', '0 of 3');
    expect(screen.getByRole('checkbox', { name: 'tomato, 3 pieces' })).not.toBeChecked();
    expect(screen.queryByRole('list', { name: 'Done' })).toBeNull();
  });
});
