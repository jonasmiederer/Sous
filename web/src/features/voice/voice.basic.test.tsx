import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAppServices } from '../../app/services';
import { ServicesProvider } from '../../app/ServicesProvider';
import { SessionProvider } from '../../auth/SessionProvider';
import { SESSION_STORAGE_KEY, activeHouseholdKey } from '../../auth/session';
import { ActiveHouseholdProvider } from '../../household/ActiveHouseholdProvider';
import {
  HOUSEHOLDS_URL,
  MemoryStorage,
  NOW,
  ONE_HOUSEHOLD,
  TEST_CONFIG,
  fakeFetch,
  renderApp,
  testSession,
  type Routes,
} from '../../test/harness';
import { ToastProvider } from '../../ui';
import { MAX_RECORDING_MS, type Recorder, type RecorderSnapshot, type RecordingResult } from '../../voice/recorder';
import { VoiceButton, buildSubmitVoiceRequest, bytesToBase64, formatCountdown, type VoiceButtonProps } from './index';

const VOICE_URL = `${TEST_CONFIG.apiUrl}/voice`;
const CONFIRM_URL = `${VOICE_URL}/v-1/confirm`;
const PCM: RecordingResult = {
  contentType: 'audio/pcm',
  sampleRateHertz: 16000,
  bytes: new Uint8Array([1, 0, 2, 0]),
  durationMs: 2_000,
  stopReason: 'user',
};

/** A scripted Recorder: tests push snapshots the way the real one would. */
function fakeRecorder(onStop: RecorderSnapshot = { state: 'done', remainingMs: 0, result: PCM }) {
  const listeners = new Set<(s: RecorderSnapshot) => void>();
  let snapshot: RecorderSnapshot = { state: 'idle', remainingMs: MAX_RECORDING_MS };
  const emit = (next: RecorderSnapshot) => {
    snapshot = next;
    for (const l of [...listeners]) l(snapshot);
  };
  const recorder: Recorder & { emit: typeof emit; starts: number } = {
    starts: 0,
    emit,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      recorder.starts += 1;
      emit({ state: 'recording', mode: 'pcm', remainingMs: MAX_RECORDING_MS });
    },
    async stop() {
      emit(onStop);
      return snapshot;
    },
    cancel() {
      emit({ state: 'cancelled', remainingMs: MAX_RECORDING_MS });
    },
  };
  return recorder;
}

function pending(transcript: string) {
  return { voiceId: 'v-1', transcript, targetOperation: { type: 'fridge' }, status: 'pending', expiresAt: '2030-01-01T00:10:00Z' };
}

function renderButton(routes: Routes, props: Partial<VoiceButtonProps> = {}) {
  const storage = new MemoryStorage();
  const session = testSession();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  storage.setItem(activeHouseholdKey(session.user.userId), 'hh-1');
  const net = fakeFetch({ [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD }, ...routes });
  const services = createAppServices({ config: TEST_CONFIG, storage, fetch: net.fetch, now: () => NOW, queryDefaults: { queries: { retry: false } } });
  const recorders: ReturnType<typeof fakeRecorder>[] = [];
  const onConfirmed = vi.fn();
  render(
    <ServicesProvider services={services}>
      <SessionProvider>
        <ActiveHouseholdProvider>
          <ToastProvider>
            <VoiceButton
              label="Speak your fridge items"
              title="Tell Sous what’s in your fridge"
              resolveTarget={() => ({ type: 'fridge' })}
              onConfirmed={onConfirmed}
              createRecorder={() => {
                const r = fakeRecorder();
                recorders.push(r);
                return r;
              }}
              {...props}
            />
          </ToastProvider>
        </ActiveHouseholdProvider>
      </SessionProvider>
    </ServicesProvider>,
  );
  const callsTo = (url: string) => net.calls.filter((c) => c.method === 'POST' && c.url === url);
  return { recorders, onConfirmed, callsTo };
}

describe('voice upload helpers', () => {
  it('encodes PCM uploads as audio/pcm at 16 kHz and fallback uploads with their container type', () => {
    expect(bytesToBase64(new Uint8Array([0, 255, 16]))).toBe('AP8Q');
    expect(buildSubmitVoiceRequest(PCM, { type: 'fridge' })).toEqual({
      audio: 'AQACAA==',
      contentType: 'audio/pcm',
      sampleRateHertz: 16000,
      targetOperation: { type: 'fridge' },
    });
    const ogg: RecordingResult = { contentType: 'audio/ogg', bytes: new Uint8Array([79]), durationMs: 900, stopReason: 'user' };
    expect(buildSubmitVoiceRequest(ogg, { type: 'conversation', conversationId: 'c-1' })).toEqual({
      audio: 'Tw==',
      contentType: 'audio/ogg',
      targetOperation: { type: 'conversation', conversationId: 'c-1' },
    });
  });

  it('formats the countdown in whole seconds, rounded up', () => {
    expect(formatCountdown(30_000)).toBe('0:30');
    expect(formatCountdown(27_400)).toBe('0:28');
    expect(formatCountdown(0)).toBe('0:00');
  });
});

describe('VoiceButton', () => {
  it('records with a countdown, uploads PCM, and confirms the corrected transcript', async () => {
    const user = userEvent.setup();
    const { recorders, onConfirmed, callsTo } = renderButton({
      [`POST ${VOICE_URL}`]: { body: pending('six eggs and milk') },
      [`POST ${CONFIRM_URL}`]: (call) => ({
        body: { voiceId: 'v-1', transcript: (call.body as { transcript: string }).transcript, targetOperation: { type: 'fridge' }, result: {} },
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Speak your fridge items' }));
    expect(await screen.findByRole('timer')).toHaveTextContent('0:30');
    act(() => recorders[0]!.emit({ state: 'recording', mode: 'pcm', remainingMs: 26_500 }));
    expect(screen.getByRole('timer')).toHaveTextContent('0:27');
    expect(screen.getByRole('timer')).toHaveAccessibleName('27 seconds left');

    await user.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    const field = await screen.findByLabelText('Transcript');
    expect(field).toHaveValue('six eggs and milk');
    expect(callsTo(VOICE_URL)[0]!.body).toEqual({
      audio: 'AQACAA==',
      contentType: 'audio/pcm',
      sampleRateHertz: 16000,
      targetOperation: { type: 'fridge' },
    });
    expect(callsTo(CONFIRM_URL)).toHaveLength(0);

    await user.clear(field);
    await user.type(field, 'six eggs and oat milk');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(callsTo(CONFIRM_URL)[0]!.body).toEqual({ transcript: 'six eggs and oat milk' });
    expect(onConfirmed.mock.calls[0]![0]).toMatchObject({ transcript: 'six eggs and oat milk' });
    expect(screen.queryByLabelText('Transcript')).not.toBeInTheDocument();
  });

  it('applies nothing when the transcript is cancelled', async () => {
    const user = userEvent.setup();
    const { onConfirmed, callsTo } = renderButton({ [`POST ${VOICE_URL}`]: { body: pending('pasta') } });
    await user.click(screen.getByRole('button', { name: 'Speak your fridge items' }));
    await user.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await screen.findByLabelText('Transcript');
    await user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    expect(screen.queryByLabelText('Transcript')).not.toBeInTheDocument();
    expect(callsTo(CONFIRM_URL)).toHaveLength(0);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    ['VOICE_NOT_UNDERSTOOD', 422, "We couldn't make out what you said. Please try recording again."],
    ['AUDIO_CONVERSION_FAILED', 422, "We couldn't process that recording. Please try recording again."],
  ])('shows a retry prompt for %s and records again', async (code, status, message) => {
    const user = userEvent.setup();
    const { recorders, onConfirmed } = renderButton({ [`POST ${VOICE_URL}`]: { status, body: { error: { code, retry: true } } } });
    await user.click(screen.getByRole('button', { name: 'Speak your fridge items' }));
    await user.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    await user.click(screen.getByRole('button', { name: 'Record again' }));
    expect(recorders).toHaveLength(2);
    expect(recorders[1]!.starts).toBe(1);
    expect(await screen.findByRole('timer')).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('keeps the transcript open when the target operation fails', async () => {
    const user = userEvent.setup();
    const { onConfirmed } = renderButton({
      [`POST ${VOICE_URL}`]: { body: pending('nothing useful') },
      [`POST ${CONFIRM_URL}`]: {
        status: 422,
        body: { error: { code: 'TARGET_OPERATION_FAILED', targetError: { code: 'INVALID_REQUEST', message: 'x' } } },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Speak your fridge items' }));
    await user.click(await screen.findByRole('button', { name: 'Stop and transcribe' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Transcript')).toHaveValue('nothing useful');
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('explains a blocked microphone', async () => {
    const user = userEvent.setup();
    const denied: Recorder = {
      ...fakeRecorder(),
      getSnapshot: () => ({ state: 'idle', remainingMs: MAX_RECORDING_MS }),
    };
    let listener: ((s: RecorderSnapshot) => void) | undefined;
    denied.subscribe = (l) => ((listener = l), () => (listener = undefined));
    denied.start = async () =>
      listener?.({ state: 'error', remainingMs: MAX_RECORDING_MS, error: { code: 'permission-denied', message: 'Microphone access was blocked.' } });
    renderButton({}, { createRecorder: () => denied });
    await user.click(screen.getByRole('button', { name: 'Speak your fridge items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was blocked.');
    expect(screen.getByRole('button', { name: 'Type instead' })).toBeInTheDocument();
  });
});

describe('voice entry points', () => {
  const session = testSession();
  const base: Routes = { [`GET ${HOUSEHOLDS_URL}`]: { body: ONE_HOUSEHOLD } };

  it('offers voice on the fridge editor and explains when the browser cannot record', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/fridge',
      session,
      activeHouseholdId: 'hh-1',
      routes: { ...base, [`GET ${TEST_CONFIG.apiUrl}/fridge`]: { body: { inventory: null, version: 0 } } },
    });
    // jsdom has no getUserMedia, so the real recorder reports an unsupported browser.
    await user.click(await screen.findByRole('button', { name: 'Speak your fridge items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This browser can't record audio. You can type instead.");
    expect(screen.queryByRole('button', { name: 'Record again' })).not.toBeInTheDocument();
  });

  it('offers voice next to the suggestion note', async () => {
    renderApp({ path: '/', session, activeHouseholdId: 'hh-1', routes: base });
    expect(await screen.findByRole('button', { name: 'Speak your note' })).toBeInTheDocument();
  });
});
