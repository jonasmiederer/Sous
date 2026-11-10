import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import type { GetGroceryListResponse, Meal, SendMessageResponse, StoredPlan, UpdatedArtifact } from '../../api/types';
import { HOUSEHOLDS_URL, MemoryStorage, NOW, ONE_HOUSEHOLD, TEST_CONFIG, fakeFetch, testSession, type Routes } from '../../test/harness';
import { ToastProvider } from '../../ui';
import { planKey } from '../plans/planQueries';
import { ChatPanel, applyGroceryRefinement, conversationRequest, groceryListKey, summarizeUpdate, type ChatPanelProps, type ChatTarget } from './index';

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

const PLAN_UPDATED: UpdatedArtifact = {
  type: 'plan',
  plan: { ...STORED.plan, days: [STORED.plan.days[0]!, { day: '2030-01-08', mealId: 'm9' }] },
  day: '2030-01-08',
  meal: meal('m9', 'Veggie chili'),
};

const CONVERSATION = {
  conversation: {
    conversationId: 'conv-1',
    householdId: 'hh-1',
    memorySessionId: 'hh-1:conv-1',
    targetArtifactType: 'plan',
    targetArtifactId: 'plan-1',
    createdAt: '2030-01-01T00:00:00Z',
  },
};

const PLAN_TARGET: ChatTarget = { type: 'plan', planId: 'plan-1', day: '2030-01-08', title: 'Tuesday: Beef stew' };

function renderPanel(routes: Routes, props: Partial<ChatPanelProps> = {}) {
  const storage = new MemoryStorage();
  const session = testSession();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  storage.setItem(activeHouseholdKey(session.user.userId), 'hh-1');
  const net = fakeFetch({ [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes });
  const services = createAppServices({ config: TEST_CONFIG, storage, fetch: net.fetch, now: () => NOW, queryDefaults: { queries: { retry: false } } });
  const onUpdated = vi.fn();
  const onClose = vi.fn();
  render(
    <ServicesProvider services={services}>
      <SessionProvider>
        <ActiveHouseholdProvider>
          <ToastProvider>
            <ChatPanel open onClose={onClose} target={PLAN_TARGET} onUpdated={onUpdated} {...props} />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>,
  );
  const callsTo = (key: string) => net.calls.filter((c) => `${c.method} ${c.url}` === key);
  return { services, onUpdated, onClose, callsTo };
}

describe('ChatPanel', () => {
  it('starts the Conversation on the first message, shows a clarification without changing the artifact, and reuses the Conversation', async () => {
    const user = userEvent.setup();
    const replies: SendMessageResponse[] = [
      { outcome: 'clarification', message: 'Which day do you mean?' },
      { outcome: 'clarification', message: 'Vegetarian or vegan?' },
    ];
    const { callsTo, onUpdated } = renderPanel({
      [START]: { status: 201, body: CONVERSATION },
      [SEND]: () => ({ body: replies.shift() }),
    });

    const composer = screen.getByRole('textbox', { name: 'Message' });
    expect(composer).toHaveAttribute('placeholder', 'e.g. make Tuesday vegetarian');
    expect(callsTo(START)).toHaveLength(0);

    await user.type(composer, 'make it vegetarian{Enter}');
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(await within(log).findByText('Which day do you mean?')).toBeInTheDocument();
    expect(within(log).getByText('make it vegetarian')).toBeInTheDocument();
    expect(callsTo(START)[0]?.body).toEqual({ targetArtifactType: 'plan', targetArtifactId: 'plan-1' });
    expect(callsTo(START)[0]?.headers['x-active-household']).toBe('hh-1');
    expect(callsTo(SEND)[0]?.body).toEqual({ message: 'make it vegetarian' });
    expect(onUpdated).not.toHaveBeenCalled();

    await waitFor(() => expect(composer).not.toBeDisabled());
    await user.type(composer, 'Tuesday{Enter}');
    expect(await within(log).findByText('Vegetarian or vegan?')).toBeInTheDocument();
    expect(callsTo(START)).toHaveLength(1);
    expect(callsTo(SEND)).toHaveLength(2);
  });

  it('applies an updated plan: shows a summary, updates the plan cache, and calls onUpdated', async () => {
    const user = userEvent.setup();
    const { services, onUpdated } = renderPanel({
      [START]: { status: 201, body: CONVERSATION },
      [SEND]: { body: { outcome: 'updated', artifact: PLAN_UPDATED } },
      [`GET ${API}/plans/plan-1`]: { status: 503, body: { error: { code: 'INTERNAL' } } },
    });
    services.queryClient.setQueryData(planKey('hh-1', 'plan-1'), STORED);

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'make Tuesday vegetarian');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText("Updated Tuesday to 'Veggie chili'.")).toBeInTheDocument();
    expect(onUpdated).toHaveBeenCalledWith(PLAN_UPDATED);
    const cached = services.queryClient.getQueryData<StoredPlan>(planKey('hh-1', 'plan-1'));
    expect(cached?.plan.days[1]?.mealId).toBe('m9');
    expect(cached?.meals.map((m) => m.name).sort()).toEqual(['Shakshuka', 'Veggie chili']);
  });

  it('shows an inline error with Retry that resends the same message', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const { callsTo } = renderPanel({
      [START]: { status: 201, body: CONVERSATION },
      [SEND]: () =>
        ++attempts === 1
          ? { status: 503, body: { error: { code: 'AGENT_UNAVAILABLE', message: 'down' } } }
          : { body: { outcome: 'clarification', message: 'Sure, which ingredient?' } },
    });

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'swap the beans{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The meal assistant isn't available right now.");

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Sure, which ingredient?')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByText('swap the beans')).toHaveLength(1);
    expect(callsTo(SEND).map((c) => c.body)).toEqual([{ message: 'swap the beans' }, { message: 'swap the beans' }]);
  });

  it('blocks messages over 500 code points and keeps Shift+Enter as a newline', async () => {
    const user = userEvent.setup();
    const { callsTo } = renderPanel({ [START]: { status: 201, body: CONVERSATION } });
    const composer = screen.getByRole('textbox', { name: 'Message' });

    await user.type(composer, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(composer).toHaveValue('line one\nline two');
    expect(callsTo(START)).toHaveLength(0);

    await user.clear(composer);
    await user.click(composer);
    await user.paste('🍅'.repeat(501));
    expect(screen.getByText('Keep your message to 500 characters or fewer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(callsTo(START)).toHaveLength(0);
  });

  it('gives the voice slot ensureConversation and shows voice results like typed messages', async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    const { callsTo, onUpdated } = renderPanel(
      { [START]: { status: 201, body: CONVERSATION } },
      {
        target: { type: 'grocery_list', planId: 'plan-1', title: 'Grocery list' },
        voiceSlot: ({ ensureConversation, receiveVoiceResult }) => (
          <button
            type="button"
            onClick={async () => {
              ids.push(await ensureConversation());
              ids.push(await ensureConversation());
              receiveVoiceResult('drop the milk', {
                outcome: 'updated',
                artifact: { type: 'grocery_list', groceryList: { householdId: 'hh-1', planId: 'plan-1', entries: [], generatedAt: '2030-01-01T00:00:00Z' } },
              });
            }}
          >
            Voice
          </button>
        ),
      },
    );

    await user.click(screen.getByRole('button', { name: 'Voice' }));
    expect(await screen.findByText('Updated the grocery list. It now has 0 items.')).toBeInTheDocument();
    expect(screen.getByText('drop the milk')).toBeInTheDocument();
    expect(ids).toEqual(['conv-1', 'conv-1']);
    expect(callsTo(START)).toHaveLength(1);
    expect(callsTo(START)[0]?.body).toEqual({ targetArtifactType: 'grocery_list', targetArtifactId: 'plan-1' });
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('chat helpers', () => {
  it('maps targets to conversation requests', () => {
    expect(conversationRequest({ type: 'suggestion', sessionId: 's1', suggestionId: 'g1', title: 'x' })).toEqual({
      targetArtifactType: 'suggestion',
      targetArtifactId: 'g1',
      sessionId: 's1',
    });
  });

  it('summarizes suggestion changes and uses the shared grocery key', () => {
    const suggestion = {
      suggestionId: 'g1',
      sessionId: 's1',
      householdId: 'hh-1',
      name: 'Veggie chili',
      ingredients: [],
      steps: [],
      presetContext: [],
      preferenceApplied: true,
    };
    expect(summarizeUpdate({ type: 'suggestion', suggestion, changedFields: ['ingredients', 'steps'] })).toBe(
      "Updated 'Veggie chili': changed the ingredients and steps.",
    );
    expect(groceryListKey('hh-1', 'plan-1')).toEqual(['hh', 'hh-1', 'grocery', 'plan-1']);
    const cached: GetGroceryListResponse = { groceryList: { householdId: 'hh-1', planId: 'plan-1', entries: [], generatedAt: 'a' }, version: 1 };
    const groceryList = { ...cached.groceryList, generatedAt: 'b' };
    expect(applyGroceryRefinement(cached, { type: 'grocery_list', groceryList })).toEqual({ groceryList, version: 1 });
    expect(applyGroceryRefinement(undefined, { type: 'grocery_list', groceryList })).toBeUndefined();
  });
});
