/**
 * Voice input button (Requirements 11.1–11.4, 13.15, 14.1–14.3).
 *
 * Flow: tap the mic → a dialog shows the countdown while recording → Stop
 * (or the 30 s limit) uploads the audio with `POST /voice` → the
 * TranscriptDialog shows the Transcript for correction → Confirm calls
 * `POST /voice/{id}/confirm` with the edited text and hands the result to
 * `onConfirmed`. Cancel at any point applies nothing.
 *
 * Errors: microphone permission, missing microphone, and unsupported
 * browsers come from the recorder and are shown with a "type instead" hint.
 * Server errors such as VOICE_NOT_UNDERSTOOD and AUDIO_CONVERSION_FAILED
 * show their message with a "Record again" button. A failed target
 * operation keeps the TranscriptDialog open so the User can fix the text.
 *
 * `recorder.start()` runs synchronously inside the click handler, because
 * iOS only allows an AudioContext to start from a user gesture.
 */
import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import { Mic, RotateCw, Square } from 'lucide-react';
import { useApi } from '../../app/ServicesProvider';
import { isApiError } from '../../api/errors';
import type { ConfirmVoiceResponse, PendingTranscript, VoiceTargetOperation } from '../../api/types';
import { Button, Dialog, IconButton, Spinner, type IconButtonProps } from '../../ui';
import {
  MAX_RECORDING_MS,
  RECORDER_ERROR_MESSAGES,
  createRecorder,
  type Recorder,
  type RecorderSnapshot,
  type RecordingResult,
} from '../../voice/recorder';
import { TranscriptDialog } from './TranscriptDialog';
import { MAX_TRANSCRIPT_CODE_POINTS, buildSubmitVoiceRequest, formatCountdown, secondsLeft } from './voiceUpload';

/** Creates a recorder; injectable so tests can supply a fake. */
export type RecorderFactory = () => Recorder;

export interface VoiceButtonProps {
  /** Accessible name of the mic button, for example "Speak your fridge items". */
  label: string;
  /** Title of the recording dialog. */
  title: string;
  /** Hint shown while recording, for example what to say. */
  description?: string;
  /** Description of the TranscriptDialog: what Confirm will do. */
  confirmDescription?: string;
  confirmLabel?: string;
  /** Resolved after recording stops and before upload (chat starts its Conversation here). */
  resolveTarget: () => VoiceTargetOperation | Promise<VoiceTargetOperation>;
  /** Called once the Transcript was confirmed and applied on the server. */
  onConfirmed: (response: ConfirmVoiceResponse) => void;
  disabled?: boolean;
  /** Limit for the editable transcript, counted in code points. */
  maxTranscriptCodePoints?: number;
  variant?: IconButtonProps['variant'];
  /** For tests; defaults to the browser recorder. */
  createRecorder?: RecorderFactory;
}

/**
 * Where the user is in the flow: idle -> recording -> uploading -> review
 * (editing and confirming the transcript). `error` can follow recording,
 * uploading, or confirming; `canRetry` says whether "Record again" is offered.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; snapshot: RecorderSnapshot }
  | { kind: 'uploading' }
  | { kind: 'review'; pending: PendingTranscript; confirming: boolean; error?: string }
  | { kind: 'error'; message: string; canRetry: boolean };

const GENERIC_UPLOAD_ERROR = "We couldn't process that recording. Please try recording again.";
/** Confirmation errors after which the recording can't be used any more. */
const RECORD_AGAIN_CODES = new Set(['VOICE_EXPIRED', 'VOICE_NOT_FOUND', 'VOICE_ALREADY_CONFIRMED']);

/** User-safe text for an API error; anything else gets the generic recording message. */
function errorText(error: unknown): string {
  return isApiError(error) ? error.userMessage : GENERIC_UPLOAD_ERROR;
}

/** Keeps keys inside the voice dialogs from reaching an enclosing dialog (the chat sheet). */
function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

/** Mic button that owns the whole record, review, and confirm flow described above. */
export function VoiceButton({
  label,
  title,
  description,
  confirmDescription,
  confirmLabel,
  disabled = false,
  maxTranscriptCodePoints = MAX_TRANSCRIPT_CODE_POINTS,
  variant = 'secondary',
  ...callbacks
}: VoiceButtonProps) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Latest callbacks, read at call time, so async work started earlier never uses stale props.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const recorderRef = useRef<Recorder | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const stopRef = useRef<HTMLButtonElement>(null);

  /** Stops listening to the current recorder without cancelling it. */
  function detachRecorder() {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    recorderRef.current = null;
  }

  /** Releases everything in flight: the recorder (and microphone) and any pending upload. */
  function teardown() {
    const recorder = recorderRef.current;
    detachRecorder();
    recorder?.cancel();
    abortRef.current?.abort();
    abortRef.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      teardown();
    };
    // teardown only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Resolves the target operation, uploads the audio, and moves to review.
   * Results are dropped if the user cancelled or the component unmounted.
   */
  async function upload(result: RecordingResult) {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'uploading' });
    try {
      const targetOperation = await callbacksRef.current.resolveTarget();
      if (controller.signal.aborted) return;
      const pending = await api.submitVoice(buildSubmitVoiceRequest(result, targetOperation), { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setPhase({ kind: 'review', pending, confirming: false });
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      setPhase({ kind: 'error', message: errorText(error), canRetry: true });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** Maps recorder states to dialog phases. Ignores events from a recorder that is no longer current. */
  function onSnapshot(recorder: Recorder, snapshot: RecorderSnapshot) {
    if (recorderRef.current !== recorder || !mounted.current) return;
    switch (snapshot.state) {
      case 'requesting-permission':
      case 'recording':
      case 'stopping':
        setPhase({ kind: 'recording', snapshot });
        return;
      case 'done':
        detachRecorder();
        if (snapshot.result) void upload(snapshot.result);
        else setPhase({ kind: 'error', message: RECORDER_ERROR_MESSAGES.failed, canRetry: true });
        return;
      case 'error': {
        detachRecorder();
        const code = snapshot.error?.code ?? 'failed';
        setPhase({ kind: 'error', message: snapshot.error?.message ?? RECORDER_ERROR_MESSAGES.failed, canRetry: code !== 'unsupported' });
        return;
      }
      case 'cancelled':
        detachRecorder();
        setPhase({ kind: 'idle' });
        return;
      default:
        return;
    }
  }

  /** Must run inside the click handler (see the module comment). */
  function startRecording() {
    teardown();
    let recorder: Recorder;
    try {
      recorder = (callbacksRef.current.createRecorder ?? createRecorder)();
    } catch {
      setPhase({ kind: 'error', message: RECORDER_ERROR_MESSAGES.unsupported, canRetry: false });
      return;
    }
    recorderRef.current = recorder;
    unsubscribeRef.current = recorder.subscribe((snapshot) => onSnapshot(recorder, snapshot));
    setPhase({ kind: 'recording', snapshot: { state: 'requesting-permission', remainingMs: MAX_RECORDING_MS } });
    void recorder.start();
  }

  /** User pressed Stop; the recorder's `done` snapshot then triggers the upload. */
  function stopRecording() {
    void recorderRef.current?.stop();
  }

  /** Cancel from any phase: nothing is applied. */
  function close() {
    teardown();
    setPhase({ kind: 'idle' });
  }

  /**
   * Sends the (possibly edited) transcript. If the recording is no longer
   * usable (expired, missing, already confirmed) show an error; any other
   * failure keeps the review dialog open so the text can be fixed.
   */
  async function confirm(pending: PendingTranscript, transcript: string) {
    setPhase({ kind: 'review', pending, confirming: true });
    try {
      const response = await api.confirmVoice(pending.voiceId, { transcript });
      if (!mounted.current) return;
      setPhase({ kind: 'idle' });
      callbacksRef.current.onConfirmed(response);
    } catch (error) {
      if (!mounted.current) return;
      if (isApiError(error) && RECORD_AGAIN_CODES.has(error.code)) {
        setPhase({ kind: 'error', message: error.userMessage, canRetry: error.code !== 'VOICE_ALREADY_CONFIRMED' });
      } else {
        setPhase({ kind: 'review', pending, confirming: false, error: errorText(error) });
      }
    }
  }

  const recordingOpen = phase.kind === 'recording' || phase.kind === 'uploading' || phase.kind === 'error';

  return (
    <>
      <IconButton label={label} icon={<Mic />} variant={variant} onClick={startRecording} disabled={disabled || phase.kind !== 'idle'} />
      <div className="contents" onKeyDown={stopPropagation}>
        <Dialog
          open={recordingOpen}
          onClose={close}
          title={title}
          description={phase.kind === 'recording' ? description : undefined}
          closeLabel="Cancel recording"
          initialFocusRef={stopRef}
          footer={<RecordingFooter phase={phase} stopRef={stopRef} onStop={stopRecording} onCancel={close} onRetry={startRecording} />}
        >
          <RecordingBody phase={phase} />
        </Dialog>
        {phase.kind === 'review' && (
          <TranscriptDialog
            key={phase.pending.voiceId}
            open
            transcript={phase.pending.transcript}
            description={confirmDescription}
            confirmLabel={confirmLabel}
            maxCodePoints={maxTranscriptCodePoints}
            confirming={phase.confirming}
            error={phase.error}
            onCancel={close}
            onConfirm={(text) => void confirm(phase.pending, text)}
          />
        )}
      </div>
    </>
  );
}

/** Dialog content for the recording, waiting, uploading, and error phases. */
function RecordingBody({ phase }: { phase: Phase }) {
  if (phase.kind === 'error') {
    return (
      <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm text-text">
        {phase.message}
      </p>
    );
  }
  if (phase.kind === 'uploading' || (phase.kind === 'recording' && phase.snapshot.state === 'stopping')) {
    return (
      <div className="flex items-center gap-3 py-4 text-text-muted">
        <Spinner label={null} />
        <p role="status">Working out what you said…</p>
      </div>
    );
  }
  if (phase.kind !== 'recording') return null;
  if (phase.snapshot.state === 'requesting-permission') {
    return (
      <div className="flex items-center gap-3 py-4 text-text-muted">
        <Spinner label={null} />
        <p role="status">Waiting for microphone access…</p>
      </div>
    );
  }
  const remainingMs = phase.snapshot.remainingMs;
  const seconds = secondsLeft(remainingMs);
  const progress = Math.min(100, Math.max(0, (remainingMs / MAX_RECORDING_MS) * 100));
  return (
    <div className="flex flex-col items-center gap-4 py-4">
      <p role="status" className="inline-flex items-center gap-2 text-sm font-medium text-danger">
        <span aria-hidden="true" className="size-2.5 rounded-full bg-danger motion-safe:animate-pulse" />
        Recording
      </p>
      <p
        role="timer"
        aria-live="off"
        aria-label={`${seconds} ${seconds === 1 ? 'second' : 'seconds'} left`}
        className="text-4xl font-semibold tabular-nums tracking-tight"
      >
        {formatCountdown(remainingMs)}
      </p>
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-center text-sm text-text-muted">Recording stops by itself after 30 seconds.</p>
    </div>
  );
}

/** Dialog actions: Stop while recording; "Type instead"/"Record again" after an error. */
function RecordingFooter({
  phase,
  stopRef,
  onStop,
  onCancel,
  onRetry,
}: {
  phase: Phase;
  stopRef: RefObject<HTMLButtonElement | null>;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (phase.kind === 'error') {
    return (
      <>
        <Button variant="secondary" onClick={onCancel} autoFocus={!phase.canRetry}>
          {phase.canRetry ? 'Type instead' : 'Close'}
        </Button>
        {phase.canRetry && (
          <Button onClick={onRetry} icon={<RotateCw aria-hidden="true" className="size-4" />} autoFocus>
            Record again
          </Button>
        )}
      </>
    );
  }
  const recording = phase.kind === 'recording' && phase.snapshot.state === 'recording';
  return (
    <>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      {recording && (
        <Button ref={stopRef} onClick={onStop} icon={<Square aria-hidden="true" className="size-4" />}>
          Stop and transcribe
        </Button>
      )}
    </>
  );
}
