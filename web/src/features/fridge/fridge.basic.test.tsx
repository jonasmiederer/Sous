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
import { FridgeEditor, parseQuickAdd, planSave, type FridgeEditorProps } from './index';

const FRIDGE_URL = `${TEST_CONFIG.apiUrl}/fridge`;

function inventory(items: Array<{ name: string; quantity: number; unit: string }>) {
  return { inventory: { householdId: 'hh-1', items, updatedAt: '2030-01-01T00:00:00Z' }, version: 1 };
}

function renderEditor(routes: Routes, props: FridgeEditorProps = {}) {
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
            <FridgeEditor {...props} />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>,
  );
  const puts = () => net.calls.filter((c) => c.method === 'PUT' && c.url === FRIDGE_URL);
  return { calls: net.calls, puts };
}

describe('parseQuickAdd', () => {
  it('reads a name, an optional amount, and an optional unit', () => {
    expect(parseQuickAdd('eggs')).toEqual({ name: 'eggs', quantity: '1', unit: 'piece' });
    expect(parseQuickAdd('6 eggs')).toEqual({ name: 'eggs', quantity: '6', unit: 'piece' });
    expect(parseQuickAdd('500g flour')).toEqual({ name: 'flour', quantity: '500', unit: 'g' });
    expect(parseQuickAdd('1,5 litres of milk')).toEqual({ name: 'milk', quantity: '1.5', unit: 'l' });
    expect(parseQuickAdd('  ')).toBeNull();
  });
});

describe('planSave', () => {
  it('skips blank rows and sends filled rows so the server can report dropped ones', () => {
    const plan = planSave([
      { key: 'a', name: ' Milk ', quantity: '1,5', unit: 'l' },
      { key: 'b', name: '', quantity: '', unit: 'piece' },
      { key: 'c', name: 'Butter', quantity: 'x', unit: 'g' },
    ]);
    expect(plan.items).toEqual([
      { name: 'Milk', quantity: 1.5, unit: 'l' },
      { name: 'Butter', quantity: 0, unit: 'g' },
    ]);
    expect(plan.submittedRows.map((r) => r.key)).toEqual(['a', 'c']);
  });
});

describe('Fridge editor', () => {
  it('loads rows, quick-adds an item, saves the full list, and reports dropped rows', async () => {
    const user = userEvent.setup();
    const { puts } = renderEditor({
      [`GET ${FRIDGE_URL}`]: { body: inventory([{ name: 'milk', quantity: 1, unit: 'l' }]) },
      [`PUT ${FRIDGE_URL}`]: {
        body: { ...inventory([{ name: 'milk', quantity: 1, unit: 'l' }, { name: 'eggs', quantity: 6, unit: 'piece' }]), version: 2, droppedIndexes: [2] },
      },
    });

    expect(await screen.findByDisplayValue('milk')).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Quick add'), '6 eggs{Enter}');
    expect(screen.getByLabelText('Name of eggs')).toHaveValue('eggs');
    expect(screen.getByLabelText('Unit of eggs')).toHaveValue('piece');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add row' }));
    const items = screen.getAllByRole('listitem');
    await user.type(within(items[2]!).getByLabelText(/Name of/), 'butter');

    await user.click(screen.getByRole('button', { name: 'Save fridge' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({
      items: [
        { name: 'milk', quantity: 1, unit: 'l' },
        { name: 'eggs', quantity: 6, unit: 'piece' },
        { name: 'butter', quantity: 0, unit: 'piece' },
      ],
    });
    expect(await screen.findByText(/One row wasn’t saved because it was incomplete: butter\./)).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('empties the fridge with an explicit clear when every row is removed', async () => {
    const user = userEvent.setup();
    const { puts } = renderEditor({ [`GET ${FRIDGE_URL}`]: { body: inventory([{ name: 'milk', quantity: 1, unit: 'l' }]) } });

    await user.click(await screen.findByRole('button', { name: 'Remove milk' }));
    expect(screen.getByText('Your fridge is empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save fridge' }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ items: [], clear: true });
  });

  it('blocks saving when rows are filled in but none is a valid item', async () => {
    const user = userEvent.setup();
    const { puts } = renderEditor({ [`GET ${FRIDGE_URL}`]: { body: inventory([{ name: 'milk', quantity: 1, unit: 'l' }]) } });

    const quantity = await screen.findByLabelText(/Amount of milk/);
    await user.clear(quantity);
    await user.click(screen.getByRole('button', { name: 'Save fridge' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one item with a name and an amount above 0.');
    expect(puts()).toHaveLength(0);
  });

  it('gives the voice slot the fridge target and reloads rows after a voice update', async () => {
    const user = userEvent.setup();
    let version = 1;
    renderEditor(
      {
        [`GET ${FRIDGE_URL}`]: () =>
          version === 1
            ? { body: { inventory: null } }
            : { body: inventory([{ name: 'spinach', quantity: 1, unit: 'bunch' }]) },
      },
      {
        renderVoiceAction: (slot) => (
          <button
            type="button"
            onClick={() => {
              expect(slot.targetOperation).toEqual({ type: 'fridge' });
              version = 2;
              slot.onApplied();
            }}
          >
            Fake voice
          </button>
        ),
      },
    );

    expect(await screen.findByText('Your fridge is empty')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fake voice' }));
    expect(await screen.findByDisplayValue('spinach')).toBeInTheDocument();
    expect(screen.getByLabelText('Unit of spinach')).toHaveValue('bunch');
  });
});
