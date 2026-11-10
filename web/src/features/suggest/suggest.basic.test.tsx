import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import type { SuggestRequest, SuggestResponse, SuggestionView } from '../../api/types';
import {
  HOUSEHOLDS_URL,
  MemoryStorage,
  NOW,
  ONE_HOUSEHOLD,
  TEST_CONFIG,
  fakeFetch,
  testSession,
  type Routes,
} from '../../test/harness';
import { ToastProvider } from '../../ui';
import { DEGRADED_MESSAGE, SuggestScreen, type SuggestScreenProps } from './index';

const SUGGEST = `POST ${TEST_CONFIG.apiUrl}/suggestions`;
const FEEDBACK = `POST ${TEST_CONFIG.apiUrl}/preferences/feedback`;
const ACCEPT = `POST ${TEST_CONFIG.apiUrl}/preferences/acceptances`;
const SAVED_PROFILE = {
  profile: { householdId: 'hh-1', likes: [], dislikes: [], excludedIngredients: [], dietaryConstraints: [], acceptances: [], updatedAt: '2030-01-01T00:00:00Z' },
  version: 1,
};

function meal(id: string, name: string, extra: Partial<SuggestionView> = {}): SuggestionView {
  return {
    suggestionId: id,
    sessionId: 'sess-1',
    householdId: 'hh-1',
    name,
    ingredients: [
      { name: 'rice', quantity: 200, unit: 'g' },
      { name: 'egg', quantity: 2, unit: 'piece' },
    ],
    steps: ['Cook the rice.', 'Fry the eggs.'],
    presetContext: [],
    preferenceApplied: true,
    attributes: ['under-30-minutes'],
    ...extra,
  };
}

function response(suggestions: SuggestionView[], extra: Partial<SuggestResponse> = {}): SuggestResponse {
  return { sessionId: 'sess-1', suggestions, preferenceApplied: true, softPreferencesDegraded: false, ...extra };
}

function renderScreen(routes: Routes, props: SuggestScreenProps = {}) {
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
            <SuggestScreen {...props} />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>,
  );
  const suggestCalls = () => net.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/suggestions'));
  return { calls: net.calls, suggestCalls };
}

describe('Suggest now screen', () => {
  it('sends presets and the note, then shows cards with tags, key ingredients, a collapsible recipe, and notices', async () => {
    const user = userEvent.setup();
    const { suggestCalls } = renderScreen({
      [SUGGEST]: { body: response([meal('s1', 'Egg fried rice')], { notice: 'No household preference profile yet.', softPreferencesDegraded: true }) },
    });

    await user.click(screen.getByRole('button', { name: 'Quick' }));
    await user.type(screen.getByLabelText(/Anything else/), 'something warm');
    await user.click(screen.getByRole('button', { name: 'Suggest meals' }));

    const card = await screen.findByRole('article', { name: 'Egg fried rice' });
    const [call] = suggestCalls();
    expect(call?.body).toEqual({ contextInput: 'something warm', presets: ['quick'] });
    expect(call?.headers['x-active-household']).toBe('hh-1');

    expect(within(card).getByText('Under 30 minutes')).toBeInTheDocument();
    expect(within(card).getByText(/rice, egg/)).toBeInTheDocument();
    const toggle = within(card).getByRole('button', { name: 'Show recipe' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).queryByText('Fry the eggs.')).not.toBeVisible();
    await user.click(toggle);
    expect(within(card).getByText('Fry the eggs.')).toBeVisible();

    expect(screen.getByText('No household preference profile yet.')).toBeInTheDocument();
    expect(screen.getByText(DEGRADED_MESSAGE)).toBeInTheDocument();
  });

  it('names a preset conflict and blocks over-long notes before any request', async () => {
    const user = userEvent.setup();
    const { suggestCalls } = renderScreen({});
    const submit = screen.getByRole('button', { name: 'Suggest meals' });

    await user.click(screen.getByRole('button', { name: 'Quick' }));
    await user.click(screen.getByRole('button', { name: 'Fine dining' }));
    expect(screen.getByText(/Quick and Fine dining can.t be combined/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Fine dining' }));
    expect(submit).toBeEnabled();

    // 501 code points (each emoji is two UTF-16 units but one code point).
    const field = screen.getByLabelText(/Anything else/);
    await user.click(field);
    await user.paste('🍝'.repeat(500));
    expect(submit).toBeEnabled();
    await user.paste('x');
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Keep your note to 500 characters/)).toBeInTheDocument();
    expect(suggestCalls()).toHaveLength(0);
  });

  it('keeps the sessionId and sends every rejected id when asking for another', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { suggestCalls } = renderScreen({
      [SUGGEST]: () => {
        n += 1;
        if (n === 1) return { body: response([meal('s1', 'Egg fried rice'), meal('s2', 'Shakshuka')]) };
        if (n === 2) return { body: response([meal('s2', 'Shakshuka'), meal('s3', 'Pad thai')]) };
        return { body: response([meal('s4', 'Risotto')]) };
      },
    });

    await user.click(screen.getByRole('button', { name: 'Suggest meals' }));
    await user.click(await screen.findByRole('button', { name: 'Not for me: Egg fried rice' }));
    expect(await screen.findByRole('article', { name: 'Pad thai' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Egg fried rice' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Shakshuka' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Not for me: Pad thai' }));
    expect(await screen.findByRole('article', { name: 'Risotto' })).toBeInTheDocument();

    const bodies = suggestCalls().map((c) => c.body as SuggestRequest);
    expect(bodies[0]).toEqual({});
    expect(bodies[1]).toEqual({ sessionId: 'sess-1', rejectedSuggestionIds: ['s1'] });
    expect(bodies[2]).toEqual({ sessionId: 'sess-1', rejectedSuggestionIds: ['s1', 's3'] });
  });

  it('records like feedback by name and acceptance by suggestion id', async () => {
    const user = userEvent.setup();
    const { calls } = renderScreen({
      [SUGGEST]: { body: response([meal('s1', 'Egg fried rice')]) },
      [FEEDBACK]: { body: SAVED_PROFILE },
      [ACCEPT]: { body: SAVED_PROFILE },
    });
    await user.click(screen.getByRole('button', { name: 'Suggest meals' }));
    const like = await screen.findByRole('button', { name: 'Like Egg fried rice' });
    await user.click(like);
    await waitFor(() => expect(like).toHaveAttribute('aria-pressed', 'true'));
    expect(calls.find((c) => c.url.endsWith('/preferences/feedback'))?.body).toEqual({ item: 'Egg fried rice', value: 'like' });

    await user.click(screen.getByRole('button', { name: 'Accept Egg fried rice' }));
    expect(await screen.findByRole('button', { name: 'Egg fried rice accepted' })).toBeDisabled();
    expect(calls.find((c) => c.url.endsWith('/preferences/acceptances'))?.body).toEqual({ mealId: 's1' });
    expect(screen.getByText(/Egg fried rice accepted\. Sous will suggest/)).toBeInTheDocument();
  });

  it('shows the Refine action only when onRefine is given and passes the session', async () => {
    const user = userEvent.setup();
    const refined: Array<[string, string]> = [];
    renderScreen({ [SUGGEST]: { body: response([meal('s1', 'Egg fried rice')]) } }, { onRefine: (s, sessionId) => refined.push([s.suggestionId, sessionId]) });
    await user.click(screen.getByRole('button', { name: 'Suggest meals' }));
    await user.click(await screen.findByRole('button', { name: 'Refine' }));
    expect(refined).toEqual([['s1', 'sess-1']]);
  });

  it('maps a generation error to a message with a retry', async () => {
    const user = userEvent.setup();
    let n = 0;
    renderScreen({
      [SUGGEST]: () => {
        n += 1;
        return n === 1 ? { status: 504, body: { error: { code: 'GENERATION_TIMEOUT' } } } : { body: response([meal('s1', 'Egg fried rice')]) };
      },
    });
    await user.click(screen.getByRole('button', { name: 'Suggest meals' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/That took too long/);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('article', { name: 'Egg fried rice' })).toBeInTheDocument();
  });
});
