import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { GroceryList, Meal, StoredPlan, SuggestionView } from './api/types';
import { HOUSEHOLDS_URL, ONE_HOUSEHOLD, TEST_CONFIG, renderApp, testSession, type Routes } from './test/harness';

const API = TEST_CONFIG.apiUrl;
const START = `POST ${API}/conversations`;
const SEND = `POST ${API}/conversations/conv-1/messages`;

function meal(id: string, name: string): Meal {
  return { mealId: id, name, ingredients: [{ name: 'beans', quantity: 400, unit: 'g' }], steps: ['Simmer'], attributes: [] };
}

const STORED: StoredPlan = {
  plan: {
    planId: 'plan-1',
    householdId: 'hh-1',
    startDate: '2030-01-07',
    endDate: '2030-01-08',
    rangeDays: 2,
    days: [
      { day: '2030-01-07', mealId: 'm1' },
      { day: '2030-01-08', mealId: 'm2' },
    ],
  },
  meals: [meal('m1', 'Shakshuka'), meal('m2', 'Beef stew')],
  version: 3,
};

const LIST: GroceryList = { householdId: 'hh-1', planId: 'plan-1', generatedAt: '2030-01-01T10:00:00.000Z', entries: [{ name: 'milk', quantity: 1, unit: 'cup' }] };

function conversation(type: string, id: string) {
  return {
    conversation: {
      conversationId: 'conv-1',
      householdId: 'hh-1',
      memorySessionId: 'hh-1:conv-1',
      targetArtifactType: type,
      targetArtifactId: id,
      createdAt: '2030-01-01T00:00:00Z',
    },
  };
}

function renderAt(path: string, routes: Routes = {}) {
  return renderApp({ path, session: testSession(), activeHouseholdId: 'hh-1', routes: { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes } });
}

async function sendInChat(text: string) {
  const user = userEvent.setup();
  const dialog = await screen.findByRole('dialog', { name: 'Refine with Sous' });
  await user.type(within(dialog).getByRole('textbox'), text);
  await user.click(within(dialog).getByRole('button', { name: 'Send' }));
  return dialog;
}

describe('route table', () => {
  it.each([
    ['/plans', 'Plans', { [`GET ${API}/plans`]: { body: { plans: [] } } }],
    ['/grocery', 'Grocery', { [`GET ${API}/plans`]: { body: { plans: [] } } }],
    ['/fridge', 'Fridge', { [`GET ${API}/fridge`]: { body: { inventory: null } } }],
    ['/households', 'Your households', {}],
  ] as const)('renders %s', async (path, heading, routes) => {
    renderAt(path, routes as Routes);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it('sends a signed-out visitor to sign-in', async () => {
    renderApp({ path: '/plans' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('sends a User without an Active_Household to the picker', async () => {
    renderApp({ path: '/fridge', session: testSession(), routes: { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD } } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your households' })).toBeInTheDocument();
  });

  it('opens Preferences from the top bar', async () => {
    const user = userEvent.setup();
    renderAt('/', {});
    await user.click(await screen.findByRole('link', { name: 'Preferences' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Preferences' })).toBeInTheDocument();
  });

  it('redirects /plans/:planId/grocery to the grocery screen', async () => {
    renderAt('/plans/plan-1/grocery', {
      [`GET ${API}/plans/plan-1`]: { body: STORED },
      [`GET ${API}/plans/plan-1/grocery-list`]: { body: { groceryList: LIST, version: 1 } },
    });
    expect(await screen.findByText('milk')).toBeInTheDocument();
  });
});

describe('chat launch points', () => {
  it('refines a plan day and shows the updated meal', async () => {
    const user = userEvent.setup();
    const refined: StoredPlan = {
      ...STORED,
      plan: { ...STORED.plan, days: [STORED.plan.days[0]!, { day: '2030-01-08', mealId: 'm9' }] },
      meals: [STORED.meals[0]!, meal('m9', 'Veggie chili')],
      version: 4,
    };
    let current = STORED;
    const { calls } = renderAt('/plans/plan-1', {
      [`GET ${API}/plans/plan-1`]: () => ({ body: current }),
      [`GET ${API}/plans`]: { body: { plans: [] } },
      [START]: { status: 201, body: conversation('plan', 'plan-1') },
      [SEND]: () => {
        current = refined;
        return { body: { outcome: 'updated', artifact: { type: 'plan', plan: refined.plan, day: '2030-01-08', meal: meal('m9', 'Veggie chili') } } };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Refine Beef stew in chat' }));
    const dialog = await sendInChat('make it vegetarian');
    expect(await within(dialog).findByText(/Veggie chili/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === `${API}/conversations`)?.body).toEqual({ targetArtifactType: 'plan', targetArtifactId: 'plan-1' });
    await user.click(within(dialog).getByRole('button', { name: 'Close chat' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Veggie chili' })).toBeInTheDocument());
  });

  it('refines the grocery list', async () => {
    const user = userEvent.setup();
    const { calls } = renderAt('/grocery/plan-1', {
      [`GET ${API}/plans/plan-1`]: { body: STORED },
      [`GET ${API}/plans/plan-1/grocery-list`]: { body: { groceryList: LIST, version: 1 } },
      [START]: { status: 201, body: conversation('grocery_list', 'plan-1') },
      [SEND]: { body: { outcome: 'updated', artifact: { type: 'grocery_list', groceryList: { ...LIST, entries: [] } } } },
    });
    await user.click(await screen.findByRole('button', { name: 'Refine in chat' }));
    const dialog = await sendInChat('remove the milk');
    expect(await within(dialog).findByText(/It now has 0 items/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === `${API}/conversations`)?.body).toEqual({ targetArtifactType: 'grocery_list', targetArtifactId: 'plan-1' });
  });

  it('refines a suggestion and updates its card', async () => {
    const user = userEvent.setup();
    const suggestion: SuggestionView = {
      suggestionId: 's1',
      sessionId: 'sess-1',
      householdId: 'hh-1',
      name: 'Egg fried rice',
      ingredients: [{ name: 'rice', quantity: 200, unit: 'g' }],
      steps: ['Cook.'],
      presetContext: [],
      preferenceApplied: true,
      attributes: [],
    };
    const { calls } = renderAt('/', {
      [`POST ${API}/suggestions`]: { body: { sessionId: 'sess-1', suggestions: [suggestion], preferenceApplied: true, softPreferencesDegraded: false } },
      [START]: { status: 201, body: conversation('suggestion', 's1') },
      [SEND]: {
        body: { outcome: 'updated', artifact: { type: 'suggestion', suggestion: { ...suggestion, name: 'Tofu fried rice' }, changedFields: ['name'] } },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Suggest meals' }));
    await user.click(await screen.findByRole('button', { name: 'Refine' }));
    const dialog = await sendInChat('no eggs');
    expect(await within(dialog).findByText(/Updated 'Tofu fried rice'/)).toBeInTheDocument();
    expect(calls.find((c) => c.url === `${API}/conversations`)?.body).toEqual({
      targetArtifactType: 'suggestion',
      targetArtifactId: 's1',
      sessionId: 'sess-1',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Close chat' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Tofu fried rice' })).toBeInTheDocument());
  });
});
