/**
 * Suggest now (Requirements 13.9–13.11, 2.5, 4.2, 5.5, 6.1, 6.3): the home
 * screen. The User picks Presets, adds an optional note, and gets 1–3
 * Meal_Suggestions.
 *
 * Request session: the first "Suggest meals" starts a new session (no
 * `sessionId`). Rejecting a card ("Not for me") adds its id to the session's
 * rejected set and asks for another with the same `sessionId`, the same note
 * and Presets that produced the session, and every rejected id so far. The
 * rejected card is replaced in place by the first returned suggestion that is
 * not already on screen, so cards the User is still looking at stay put.
 *
 * Accept: records an acceptance (`POST /preferences/acceptances` with the
 * suggestion id as `mealId`, which the Preference Service stores as given)
 * and confirms with a toast. Placing the Meal on a specific plan day is left
 * to the plan screens (`addDay` / `replaceDay` with a supplied Meal).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChefHat, Info, RotateCw, Sparkles } from 'lucide-react';
import type { Preset } from '@sous/domain/types';
import { useApi } from '../../app/ServicesProvider';
import { isApiError, messageFor } from '../../api/errors';
import type { FeedbackValue, MealSuggestion, SuggestRequest, SuggestResponse, SuggestionView, VoiceTargetOperation } from '../../api/types';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { Button, EmptyState, ErrorBanner, cx, useToast } from '../../ui';
import { ContextInput } from './ContextInput';
import { PresetChips } from './PresetChips';
import { SuggestionCard, SuggestionCardSkeleton } from './SuggestionCard';
import { isContextInputTooLong, presetConflict } from './validation';

/** Placeholder cards while the first suggestions load (the agent returns 2 by default). */
const LOADING_CARDS = 2;

/** Shown when the learned (soft) preferences could not be loaded for this response. */
export const DEGRADED_MESSAGE =
  "Your household's learned tastes couldn't be loaded this time, so these ideas use your saved preferences only.";

/** What a voice button next to the note needs (task 24.5 renders VoiceButton here). */
export interface SuggestVoiceSlot {
  /** The `context` target for `POST /voice`, carrying this request session. */
  targetOperation: Extract<VoiceTargetOperation, { type: 'context' }>;
  disabled: boolean;
  /** Puts a transcript into the note field without submitting. */
  setContextInput: (text: string) => void;
  /** Shows the result of a confirmed voice request (`confirmVoice` returns a SuggestResponse for `context`). */
  showResult: (response: SuggestResponse, contextInput: string) => void;
}

export interface SuggestScreenProps {
  /** Opens chat refinement for a suggestion (tasks 23.9/23.11). The Refine action is hidden when absent. */
  onRefine?: (suggestion: SuggestionView, sessionId: string) => void;
  renderVoiceAction?: (slot: SuggestVoiceSlot) => ReactNode;
  /**
   * The latest suggestion returned by chat refinement. When it changes, the
   * card with the same id shows the refined name, ingredients, and steps.
   */
  refinedSuggestion?: MealSuggestion;
}

/** The note and Presets that produced the current session, resent on every "another". */
interface SessionState {
  sessionId: string;
  contextInput?: string;
  presets?: Preset[];
  rejectedIds: string[];
}

/** Extra information returned with the latest suggestions. */
interface ResultMeta {
  /** Server message about the result, shown above the cards. */
  notice?: string;
  softPreferencesDegraded: boolean;
}

/** A user-facing error plus the action that retries the failed request. */
type ScreenError = { message: string; retry: () => void };

/** User-safe error text; non-API errors map to the generic internal error. */
function errorMessage(error: unknown): string {
  return isApiError(error) ? error.userMessage : messageFor('INTERNAL_ERROR');
}

/** Case- and whitespace-insensitive form used to detect duplicate meal names. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Resets all screen state when the Active_Household changes. */
export function SuggestScreen(props: SuggestScreenProps) {
  const { activeHouseholdId } = useActiveHousehold();
  return <SuggestScreenInner key={activeHouseholdId ?? 'none'} {...props} />;
}

function SuggestScreenInner({ onRefine, renderVoiceAction, refinedSuggestion }: SuggestScreenProps) {
  const api = useApi();
  const toast = useToast();

  const [presets, setPresets] = useState<Preset[]>([]);
  const [context, setContext] = useState('');
  const [session, setSession] = useState<SessionState | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionView[]>([]);
  const [meta, setMeta] = useState<ResultMeta>({ softPreferencesDegraded: false });
  const [loading, setLoading] = useState(false);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [error, setError] = useState<ScreenError | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackValue>>({});
  const [pendingFeedback, setPendingFeedback] = useState<Record<string, FeedbackValue>>({});
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const [accepting, setAccepting] = useState<ReadonlySet<string>>(new Set());

  // Only the latest suggest call may update the screen; unmount drops all.
  const requestToken = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!refinedSuggestion) return;
    setSuggestions((list) =>
      list.map((s) => (s.suggestionId === refinedSuggestion.suggestionId ? { ...s, ...refinedSuggestion } : s)),
    );
  }, [refinedSuggestion]);

  const resultsHeading = useRef<HTMLHeadingElement>(null);

  const busy = loading || replacingId !== null;
  const conflict = presetConflict(presets);
  const tooLong = isContextInputTooLong(context);
  const canSubmit = !conflict && !tooLong && !busy;

  /**
   * Sends a suggest request, aborting any one still in flight. Resolves to
   * `null` when the call was superseded or aborted, so callers must return
   * without touching state in that case.
   */
  const callSuggest = useCallback(
    async (body: SuggestRequest): Promise<{ ok: true; value: SuggestResponse } | { ok: false; error: unknown } | null> => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const token = ++requestToken.current;
      try {
        const value = await api.suggest(body, { signal: controller.signal });
        return token === requestToken.current ? { ok: true, value } : null;
      } catch (err) {
        return token === requestToken.current && !controller.signal.aborted ? { ok: false, error: err } : null;
      }
    },
    [api],
  );

  /** Adopts a brand-new session: stores it, clears per-card state, and moves focus to the results heading. */
  function applyFresh(response: SuggestResponse, snapshot: Omit<SessionState, 'sessionId' | 'rejectedIds'>) {
    setSession({ ...snapshot, sessionId: response.sessionId, rejectedIds: [] });
    setSuggestions(response.suggestions);
    setMeta({ notice: response.notice, softPreferencesDegraded: response.softPreferencesDegraded });
    setFeedback({});
    setPendingFeedback({});
    setAccepted(new Set());
    setAccepting(new Set());
    requestAnimationFrame(() => resultsHeading.current?.focus());
  }

  /** First request of a session (no `sessionId`); discards any previous results. */
  async function startSession(snapshot: Omit<SessionState, 'sessionId' | 'rejectedIds'>) {
    setLoading(true);
    setError(null);
    setSuggestions([]);
    setSession(null);
    const result = await callSuggest({ ...snapshot });
    if (!result) return;
    setLoading(false);
    if (result.ok) applyFresh(result.value, snapshot);
    else setError({ message: errorMessage(result.error), retry: () => void startSession(snapshot) });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const note = context.trim();
    void startSession({
      ...(note ? { contextInput: note } : {}),
      ...(presets.length > 0 ? { presets } : {}),
    });
  }

  /** Re-requests the whole set for the session, keeping every rejected id (retry after a failed "another"). */
  async function refillSession(current: SessionState) {
    setLoading(true);
    setError(null);
    const result = await callSuggest(sessionRequest(current));
    if (!result) return;
    setLoading(false);
    if (result.ok) {
      setSession({ ...current, sessionId: result.value.sessionId });
      setSuggestions(result.value.suggestions);
      setMeta({ notice: result.value.notice, softPreferencesDegraded: result.value.softPreferencesDegraded });
    } else {
      setError({ message: errorMessage(result.error), retry: () => void refillSession(current) });
    }
  }

  /**
   * "Not for me": records the rejection, asks for new ideas in the same
   * session, and swaps in the first result that is not already shown,
   * rejected, or a name duplicate. With no such result the card is removed.
   */
  async function reject(suggestion: SuggestionView) {
    if (!session || busy) return;
    const next: SessionState = { ...session, rejectedIds: [...new Set([...session.rejectedIds, suggestion.suggestionId])] };
    setSession(next);
    setReplacingId(suggestion.suggestionId);
    setError(null);
    const result = await callSuggest(sessionRequest(next));
    if (!result) return;
    setReplacingId(null);

    if (!result.ok) {
      const remaining = suggestions.filter((s) => s.suggestionId !== suggestion.suggestionId);
      setSuggestions(remaining);
      setError({ message: errorMessage(result.error), retry: () => void refillSession(next) });
      return;
    }

    const response = result.value;
    setSession({ ...next, sessionId: response.sessionId });
    setMeta({ notice: response.notice, softPreferencesDegraded: response.softPreferencesDegraded });
    const others = suggestions.filter((s) => s.suggestionId !== suggestion.suggestionId);
    const shownIds = new Set(others.map((s) => s.suggestionId));
    const shownNames = new Set(others.map((s) => normalizeName(s.name)));
    const rejected = new Set(next.rejectedIds);
    const replacement = response.suggestions.find(
      (s) => !shownIds.has(s.suggestionId) && !rejected.has(s.suggestionId) && !shownNames.has(normalizeName(s.name)),
    );
    if (replacement) {
      setSuggestions(suggestions.map((s) => (s.suggestionId === suggestion.suggestionId ? replacement : s)));
    } else {
      setSuggestions(others);
      toast.show({ message: 'No other new ideas this time. Try a different note or mood.', tone: 'info' });
    }
  }

  /** Like/dislike. The pending value shows immediately and is only confirmed once the API call succeeds. */
  async function sendFeedback(suggestion: SuggestionView, value: FeedbackValue) {
    const id = suggestion.suggestionId;
    if (pendingFeedback[id] || feedback[id] === value) return;
    setPendingFeedback((p) => ({ ...p, [id]: value }));
    try {
      await api.sendFeedback({ item: suggestion.name, value });
      setFeedback((f) => ({ ...f, [id]: value }));
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setPendingFeedback(({ [id]: _, ...rest }) => rest);
    }
  }

  async function accept(suggestion: SuggestionView) {
    const id = suggestion.suggestionId;
    if (accepted.has(id) || accepting.has(id)) return;
    setAccepting((s) => new Set(s).add(id));
    try {
      await api.recordAcceptance({ mealId: id });
      setAccepted((s) => new Set(s).add(id));
      toast.show({ message: `${suggestion.name} accepted. Sous will suggest meals like this more often.`, tone: 'success' });
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: 'error' });
    } finally {
      setAccepting((s) => {
        const copy = new Set(s);
        copy.delete(id);
        return copy;
      });
    }
  }

  const voiceSlot: SuggestVoiceSlot = {
    targetOperation: {
      type: 'context',
      ...(session ? { sessionId: session.sessionId, rejectedSuggestionIds: session.rejectedIds } : {}),
      ...(presets.length > 0 ? { presets } : {}),
    },
    disabled: busy || Boolean(conflict),
    setContextInput: setContext,
    showResult: (response, contextInput) => {
      setLoading(false);
      setError(null);
      setContext(contextInput);
      applyFresh(response, { ...(contextInput ? { contextInput } : {}), ...(presets.length > 0 ? { presets } : {}) });
    },
  };

  const hasResults = suggestions.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">What should we cook?</h1>
        <p className="mt-1.5 text-text-muted">Pick a mood, add a note, and Sous suggests a few meals.</p>
      </div>

      <form
        onSubmit={onSubmit}
        aria-label="Suggestion request"
        className="flex flex-col gap-6 rounded-3xl border border-border bg-surface p-5 shadow-card sm:p-6"
      >
        <PresetChips selected={presets} onChange={setPresets} disabled={busy} />
        <ContextInput value={context} onChange={setContext} action={renderVoiceAction?.(voiceSlot)} />
        <Button
          type="submit"
          size="lg"
          fullWidth
          loading={loading && !hasResults}
          disabled={!canSubmit}
          icon={<ChefHat aria-hidden="true" className="size-5" />}
        >
          {session ? 'Start over with new ideas' : 'Suggest meals'}
        </Button>
      </form>

      <section aria-labelledby="suggestions-heading" className="flex flex-col gap-4">
        <h2
          id="suggestions-heading"
          ref={resultsHeading}
          tabIndex={-1}
          className={cx('text-lg font-semibold tracking-tight outline-none', !hasResults && !loading && !error && 'sr-only')}
        >
          Ideas for you
        </h2>

        {(meta.notice || meta.softPreferencesDegraded) && hasResults && (
          <div className="flex flex-col gap-2">
            {meta.notice && <InfoNote>{meta.notice}</InfoNote>}
            {meta.softPreferencesDegraded && <InfoNote>{DEGRADED_MESSAGE}</InfoNote>}
          </div>
        )}

        {error && <ErrorBanner message={error.message} onRetry={error.retry} retrying={loading} />}

        {loading && !hasResults ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-4">
            <span className="sr-only">Finding meal ideas</span>
            {Array.from({ length: LOADING_CARDS }, (_, i) => (
              <SuggestionCardSkeleton key={i} />
            ))}
          </div>
        ) : hasResults ? (
          <ul className="flex flex-col gap-4">
            {suggestions.map((suggestion) => (
              <li key={suggestion.suggestionId}>
                <SuggestionCard
                  suggestion={suggestion}
                  feedback={feedback[suggestion.suggestionId]}
                  pendingFeedback={pendingFeedback[suggestion.suggestionId]}
                  accepted={accepted.has(suggestion.suggestionId)}
                  accepting={accepting.has(suggestion.suggestionId)}
                  rejecting={replacingId === suggestion.suggestionId}
                  rejectDisabled={busy}
                  onFeedback={(value) => void sendFeedback(suggestion, value)}
                  onAccept={() => void accept(suggestion)}
                  onReject={() => void reject(suggestion)}
                  onRefine={onRefine && session ? () => onRefine(suggestion, session.sessionId) : undefined}
                />
              </li>
            ))}
          </ul>
        ) : (
          !error && (
            <EmptyState
              icon={session ? <RotateCw /> : <Sparkles />}
              title={session ? 'No ideas left on screen' : 'Your ideas will appear here'}
              description={
                session
                  ? 'Ask again with the same mood, or change your note for something different.'
                  : 'Choose a mood or describe what you feel like, then tap Suggest meals.'
              }
              action={
                session ? (
                  <Button variant="secondary" onClick={() => void refillSession(session)}>
                    Show more ideas
                  </Button>
                ) : undefined
              }
            />
          )
        )}
      </section>
    </div>
  );
}

/** Builds the follow-up request for an existing session, replaying its note, Presets, and rejected ids. */
function sessionRequest(session: SessionState): SuggestRequest {
  return {
    sessionId: session.sessionId,
    ...(session.contextInput ? { contextInput: session.contextInput } : {}),
    ...(session.presets ? { presets: session.presets } : {}),
    rejectedSuggestionIds: session.rejectedIds,
  };
}

/** Subdued informational message with an icon. */
function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-2xl bg-surface-2 px-4 py-3 text-sm text-text-muted">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
