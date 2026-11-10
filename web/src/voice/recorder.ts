/**
 * Voice recorder state machine (Requirements 14.1–14.3).
 *
 * Primary path: getUserMedia → AudioContext (device rate) → `sous-pcm-capture`
 * AudioWorklet, which posts 16 kHz mono Int16 LE chunks. Fallback path, used
 * when AudioWorklet is unavailable or the worklet fails to load: MediaRecorder
 * with the first supported of Ogg/Opus, WebM/Opus, WebM, MP4.
 *
 * States: idle → requesting-permission → recording → stopping → done | error | cancelled.
 * A recording stops by itself after MAX_RECORDING_MS or, on the PCM path,
 * after MAX_PCM_BYTES; the captured audio is kept. Fallback blobs larger than
 * MAX_FALLBACK_BYTES are refused so they are never uploaded.
 *
 * Framework-free: every browser API is injectable so the module runs in jsdom
 * with fakes. `subscribe` + `getSnapshot` fit React's `useSyncExternalStore`.
 *
 * `start()` must be called synchronously from the user gesture (click/tap):
 * the AudioContext is created before the first `await`, which iOS requires.
 */
import { TARGET_SAMPLE_RATE } from './pcmEncoder';
import {
  PCM_CAPTURE_PROCESSOR_NAME,
  type PcmCaptureCommand,
  type PcmCaptureEvent,
} from './pcmCaptureProtocol';
import { loadPcmCaptureWorklet } from './pcmCaptureWorkletUrl';

export const MAX_RECORDING_MS = 30_000;
/** 30 s × 16,000 samples × 2 bytes; below the server's 1,000,000-byte limit. */
export const MAX_PCM_BYTES = 960_000;
/** Server MAX_AUDIO_BYTES; larger fallback recordings are never uploaded. */
export const MAX_FALLBACK_BYTES = 1_000_000;
/** Recordings shorter than this are reported as too short. */
export const MIN_RECORDING_MS = 300;
/** Fallback container preference (Requirement 14.2). */
export const FALLBACK_MIME_TYPES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;
/** How often `remainingMs` is refreshed while recording. */
export const TICK_MS = 250;
/** Safety bound for the worklet's `flushed` reply after a flush command. */
export const FLUSH_TIMEOUT_MS = 1_000;

export type RecorderState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'stopping'
  | 'done'
  | 'error'
  | 'cancelled';

export type RecorderMode = 'pcm' | 'fallback';
export type StopReason = 'user' | 'time-limit' | 'size-limit';

export type RecordingResult =
  | { contentType: 'audio/pcm'; sampleRateHertz: 16000; bytes: Uint8Array; durationMs: number; stopReason: StopReason }
  | { contentType: string; sampleRateHertz?: undefined; bytes: Uint8Array; durationMs: number; stopReason: StopReason };

export type RecorderErrorCode =
  | 'permission-denied'
  | 'no-microphone'
  | 'unsupported'
  | 'too-large'
  | 'too-short'
  | 'failed';

export interface RecorderError {
  code: RecorderErrorCode;
  message: string;
}

export const RECORDER_ERROR_MESSAGES: Record<RecorderErrorCode, string> = {
  'permission-denied':
    'Microphone access was blocked. Allow microphone access in your browser settings, or type instead.',
  'no-microphone': 'No microphone was found. Connect a microphone, or type instead.',
  unsupported: "This browser can't record audio. You can type instead.",
  'too-large': 'That recording is too long to send. Try a shorter one.',
  'too-short': 'That recording was too short. Hold on a little longer and try again.',
  failed: "Recording didn't work. Please try again, or type instead.",
};

export interface RecorderSnapshot {
  readonly state: RecorderState;
  readonly mode?: RecorderMode;
  /** Remaining recording time, for the countdown (Requirement 14.3). */
  readonly remainingMs: number;
  readonly result?: RecordingResult;
  readonly error?: RecorderError;
}

// ---- Minimal structural types for the injected browser APIs ----

export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
}
export interface AudioNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: unknown;
  readonly audioWorklet?: unknown;
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike;
  resume?(): Promise<void>;
  close(): Promise<void>;
}
export interface MessagePortLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}
export interface AudioWorkletNodeLike extends AudioNodeLike {
  readonly port: MessagePortLike;
}
export interface BlobLike {
  readonly size: number;
  readonly type: string;
}
export interface MediaRecorderLike {
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((event: { data: BlobLike }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}
export interface MediaRecorderCtorLike {
  new (stream: MediaStreamLike, options?: { mimeType?: string }): MediaRecorderLike;
  isTypeSupported(mimeType: string): boolean;
}

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStreamLike>;
  AudioContext?: new () => AudioContextLike;
  AudioWorkletNode?: new (
    context: AudioContextLike,
    name: string,
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletNodeLike;
  MediaRecorder?: MediaRecorderCtorLike;
  loadWorklet?: (context: AudioContextLike) => Promise<void>;
  /** Concatenates fallback chunks; defaults to `new Blob(parts, { type })`. */
  makeBlob?: (parts: BlobLike[], type: string) => BlobLike;
  /** Reads a blob's bytes; defaults to `blob.arrayBuffer()`. */
  readBlob?: (blob: BlobLike) => Promise<Uint8Array>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface Recorder {
  getSnapshot(): RecorderSnapshot;
  subscribe(listener: (snapshot: RecorderSnapshot) => void): () => void;
  /** Call from the user gesture. Resolves once recording has started or failed. */
  start(): Promise<void>;
  /** Resolves with the final snapshot (done, error, or cancelled). */
  stop(): Promise<RecorderSnapshot>;
  /** Discards any audio, releases the microphone, and moves to `cancelled`. */
  cancel(): void;
}

export const AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
};

/** Returns the first supported fallback MIME type, or undefined. */
export function pickFallbackMimeType(isTypeSupported: (mimeType: string) => boolean): string | undefined {
  return FALLBACK_MIME_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** `audio/webm;codecs=opus` → `audio/webm`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Maps getUserMedia rejections to recorder error codes. */
export function classifyMediaError(error: unknown): RecorderErrorCode {
  const name = (error as { name?: unknown } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-microphone';
    case 'NotSupportedError':
      return 'unsupported';
    default:
      return 'failed';
  }
}

function recorderError(code: RecorderErrorCode): RecorderError {
  return { code, message: RECORDER_ERROR_MESSAGES[code] };
}

/**
 * Fills in real browser APIs for anything not injected. Missing APIs (no
 * microphone support, no MediaRecorder) stay `undefined`; `start()` checks for
 * them and reports `unsupported`. `webkitAudioContext` covers older Safari.
 */
function resolveDefaults(deps: RecorderDeps): Required<RecorderDeps> {
  const g = globalThis as unknown as Record<string, unknown>;
  const mediaDevices = (g.navigator as { mediaDevices?: MediaDevices } | undefined)?.mediaDevices;
  return {
    getUserMedia:
      deps.getUserMedia ??
      (mediaDevices?.getUserMedia
        ? (c) => mediaDevices.getUserMedia(c) as Promise<MediaStreamLike>
        : (undefined as never)),
    AudioContext: deps.AudioContext ?? ((g.AudioContext ?? g.webkitAudioContext) as never),
    AudioWorkletNode: deps.AudioWorkletNode ?? (g.AudioWorkletNode as never),
    MediaRecorder: deps.MediaRecorder ?? (g.MediaRecorder as never),
    loadWorklet: deps.loadWorklet ?? ((ctx) => loadPcmCaptureWorklet(ctx as unknown as BaseAudioContext)),
    makeBlob: deps.makeBlob ?? ((parts, type) => new Blob(parts as Blob[], { type })),
    readBlob: deps.readBlob ?? (async (blob) => new Uint8Array(await (blob as Blob).arrayBuffer())),
    now: deps.now ?? (() => performance.now()),
    setTimeout: deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
    clearTimeout: deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>)),
    setInterval: deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms)),
    clearInterval: deps.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>)),
  };
}

/**
 * Joins PCM chunks into one buffer, truncated to `limit` bytes. The length is
 * rounded down to an even number so a 16-bit sample is never split.
 */
function concatChunks(chunks: Uint8Array[], limit: number): Uint8Array {
  const total = Math.min(
    chunks.reduce((n, c) => n + c.byteLength, 0),
    limit,
  );
  const length = total - (total % 2);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const take = Math.min(chunk.byteLength, length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * One recording attempt's resources. A new `Session` is created per `start()`
 * call, and every async continuation checks `cancelled` and `session === s`
 * so a stale attempt can never overwrite the state of a newer one.
 */
interface Session {
  cancelled: boolean;
  startedAt: number;
  stream?: MediaStreamLike;
  context?: AudioContextLike;
  source?: AudioNodeLike;
  node?: AudioWorkletNodeLike;
  mediaRecorder?: MediaRecorderLike;
  pcmChunks: Uint8Array[];
  pcmBytes: number;
  blobParts: BlobLike[];
  timeout?: unknown;
  interval?: unknown;
  /** Set once stopping begins, so repeated stop calls share one result. */
  stopping?: Promise<RecorderSnapshot>;
  /** Resolvers for the pending flush (PCM) or MediaRecorder stop (fallback) wait. */
  onFlushed?: () => void;
  onMediaStop?: () => void;
}

/** Creates a recorder. Pass `deps` to replace browser APIs, e.g. in tests. */
export function createRecorder(deps: RecorderDeps = {}): Recorder {
  const d = resolveDefaults(deps);
  const listeners = new Set<(snapshot: RecorderSnapshot) => void>();
  let snapshot: RecorderSnapshot = { state: 'idle', remainingMs: MAX_RECORDING_MS };
  let session: Session | undefined;

  /**
   * Publishes a new snapshot to subscribers. `result` and `error` are not
   * carried over, so they only exist on the snapshot that sets them; `mode`
   * and `remainingMs` persist unless overridden.
   */
  function set(next: Partial<RecorderSnapshot> & { state: RecorderState }): void {
    snapshot = {
      state: next.state,
      mode: 'mode' in next ? next.mode : snapshot.mode,
      remainingMs: next.remainingMs ?? snapshot.remainingMs,
      result: next.result,
      error: next.error,
    };
    for (const listener of [...listeners]) listener(snapshot);
  }

  function remaining(s: Session): number {
    return Math.max(0, MAX_RECORDING_MS - (d.now() - s.startedAt));
  }

  /** Stops timers, detaches audio nodes, and releases the microphone and AudioContext. Safe to call more than once. */
  function releaseResources(s: Session): void {
    if (s.timeout !== undefined) d.clearTimeout(s.timeout);
    if (s.interval !== undefined) d.clearInterval(s.interval);
    s.timeout = s.interval = undefined;
    if (s.node) {
      s.node.port.onmessage = null;
      try {
        s.node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (s.source) {
      try {
        s.source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (s.mediaRecorder) {
      s.mediaRecorder.ondataavailable = null;
      s.mediaRecorder.onerror = null;
      s.mediaRecorder.onstop = null;
      if (s.mediaRecorder.state !== 'inactive') {
        try {
          s.mediaRecorder.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    for (const track of s.stream?.getTracks() ?? []) track.stop();
    if (s.context && s.context.state !== 'closed') {
      s.context.close().catch(() => undefined);
    }
    s.stream = s.context = s.source = s.node = s.mediaRecorder = undefined;
  }

  /** Releases resources and enters the `error` state, unless a newer session has taken over. */
  function fail(s: Session, code: RecorderErrorCode): void {
    releaseResources(s);
    if (session === s) set({ state: 'error', error: recorderError(code) });
  }

  /** Starts the hard time limit and the interval that refreshes the countdown. */
  function beginTimers(s: Session): void {
    s.startedAt = d.now();
    s.timeout = d.setTimeout(() => void finish(s, 'time-limit'), MAX_RECORDING_MS);
    s.interval = d.setInterval(() => {
      if (session === s && snapshot.state === 'recording') {
        set({ state: 'recording', remainingMs: remaining(s) });
      }
    }, TICK_MS);
  }

  /**
   * Wires the microphone into the capture worklet and collects the PCM chunks
   * it posts back. Stops itself at `MAX_PCM_BYTES`. Returns false when there is
   * no AudioContext, so the caller can fall back to MediaRecorder.
   */
  async function startPcm(s: Session, stream: MediaStreamLike): Promise<boolean> {
    const context = s.context;
    if (!context) return false;
    const source = context.createMediaStreamSource(stream);
    const node = new d.AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    s.source = source;
    s.node = node;
    node.port.onmessage = (event) => {
      const message = event.data as PcmCaptureEvent;
      if (message?.type === 'chunk') {
        if (session !== s || s.pcmBytes >= MAX_PCM_BYTES) return;
        const chunk = new Uint8Array(message.buffer);
        s.pcmChunks.push(chunk);
        s.pcmBytes += chunk.byteLength;
        if (s.pcmBytes >= MAX_PCM_BYTES) void finish(s, 'size-limit');
      } else if (message?.type === 'flushed') {
        s.onFlushed?.();
      }
    };
    source.connect(node);
    // The processor writes no output, so this only keeps the node pulled by the graph.
    node.connect(context.destination);
    if (context.state === 'suspended' && context.resume) await context.resume();
    return true;
  }

  /** MediaRecorder path: records in the best supported container, emitting a chunk every second. */
  function startFallback(s: Session, stream: MediaStreamLike): void {
    const mimeType = pickFallbackMimeType((t) => d.MediaRecorder.isTypeSupported(t));
    const mediaRecorder = mimeType ? new d.MediaRecorder(stream, { mimeType }) : new d.MediaRecorder(stream);
    s.mediaRecorder = mediaRecorder;
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) s.blobParts.push(event.data);
    };
    mediaRecorder.onerror = () => fail(s, 'failed');
    mediaRecorder.onstop = () => s.onMediaStop?.();
    mediaRecorder.start(1_000);
  }

  /**
   * Begins a recording. Ignored if one is already active. The AudioContext and
   * worklet load are kicked off before the first `await` (user-gesture rule),
   * then the permission prompt runs in parallel with the worklet load. PCM is
   * preferred; if the worklet is unavailable or fails, MediaRecorder is used.
   */
  async function start(): Promise<void> {
    if (snapshot.state === 'requesting-permission' || snapshot.state === 'recording' || snapshot.state === 'stopping') {
      return;
    }
    const s: Session = { cancelled: false, startedAt: d.now(), pcmChunks: [], pcmBytes: 0, blobParts: [] };
    session = s;

    const pcmCapable = typeof d.AudioContext === 'function' && typeof d.AudioWorkletNode === 'function';
    const fallbackCapable = typeof d.MediaRecorder === 'function';
    if (typeof d.getUserMedia !== 'function' || (!pcmCapable && !fallbackCapable)) {
      set({ state: 'error', mode: undefined, remainingMs: MAX_RECORDING_MS, error: recorderError('unsupported') });
      return;
    }

    // Created synchronously inside the user gesture (iOS). Device rate is kept on purpose.
    let workletLoad: Promise<boolean> = Promise.resolve(false);
    if (pcmCapable) {
      try {
        s.context = new d.AudioContext();
        if (s.context.audioWorklet) {
          const context = s.context;
          workletLoad = d.loadWorklet(context).then(
            () => true,
            () => false,
          );
        }
      } catch {
        s.context = undefined;
      }
    }

    set({ state: 'requesting-permission', mode: undefined, remainingMs: MAX_RECORDING_MS });

    let stream: MediaStreamLike;
    try {
      stream = await d.getUserMedia(AUDIO_CONSTRAINTS);
    } catch (error) {
      await workletLoad;
      if (!s.cancelled) fail(s, classifyMediaError(error));
      else releaseResources(s);
      return;
    }
    s.stream = stream;
    const workletReady = await workletLoad;
    if (s.cancelled || session !== s) {
      releaseResources(s);
      return;
    }

    try {
      let mode: RecorderMode;
      if (workletReady && (await startPcm(s, stream))) {
        mode = 'pcm';
      } else {
        if (s.context) {
          s.context.close().catch(() => undefined);
          s.context = undefined;
        }
        if (!fallbackCapable) {
          fail(s, 'unsupported');
          return;
        }
        startFallback(s, stream);
        mode = 'fallback';
      }
      if (s.cancelled || session !== s) {
        releaseResources(s);
        return;
      }
      beginTimers(s);
      set({ state: 'recording', mode, remainingMs: MAX_RECORDING_MS });
    } catch {
      fail(s, 'failed');
    }
  }

  /**
   * Resolves when `register`'s callback fires, or after `FLUSH_TIMEOUT_MS`,
   * whichever comes first, so a lost worklet or MediaRecorder event can't hang a stop.
   */
  function waitFor(s: Session, register: (done: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        d.clearTimeout(guard);
        resolve();
      };
      const guard = d.setTimeout(done, FLUSH_TIMEOUT_MS);
      register(done);
    });
  }

  /** Asks the worklet to flush its buffered samples, then returns all captured PCM bytes. */
  async function collectPcm(s: Session): Promise<Uint8Array> {
    const node = s.node;
    if (node) {
      const flushed = waitFor(s, (done) => (s.onFlushed = done));
      const command: PcmCaptureCommand = { type: 'flush' };
      node.port.postMessage(command);
      await flushed;
    }
    return concatChunks(s.pcmChunks, MAX_PCM_BYTES);
  }

  /** Stops MediaRecorder and returns the recorded bytes, or `'too-large'` if over the upload limit. */
  async function collectFallback(s: Session): Promise<{ bytes: Uint8Array; type: string } | 'too-large'> {
    const mediaRecorder = s.mediaRecorder;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      const stopped = waitFor(s, (done) => (s.onMediaStop = done));
      mediaRecorder.stop();
      await stopped;
    }
    const type = baseMimeType(mediaRecorder?.mimeType || s.blobParts[0]?.type || '');
    const size = s.blobParts.reduce((n, p) => n + p.size, 0);
    if (size > MAX_FALLBACK_BYTES) return 'too-large';
    const blob = d.makeBlob(s.blobParts, type);
    if (blob.size > MAX_FALLBACK_BYTES) return 'too-large';
    return { bytes: await d.readBlob(blob), type };
  }

  /**
   * Common stop path for the user, the time limit, and the size limit.
   * Idempotent: later calls return the same promise. Ends in `done`, or in
   * `error` when the audio is too short, too large, or collection fails.
   */
  function finish(s: Session, reason: StopReason): Promise<RecorderSnapshot> {
    if (s.stopping) return s.stopping;
    if (session !== s || snapshot.state !== 'recording') return Promise.resolve(snapshot);
    const durationMs = Math.min(MAX_RECORDING_MS, d.now() - s.startedAt);
    if (s.timeout !== undefined) d.clearTimeout(s.timeout);
    if (s.interval !== undefined) d.clearInterval(s.interval);
    s.timeout = s.interval = undefined;
    const mode = snapshot.mode;
    set({ state: 'stopping', remainingMs: remaining(s) });

    s.stopping = (async () => {
      try {
        let result: RecordingResult;
        if (mode === 'pcm') {
          const bytes = await collectPcm(s);
          result = { contentType: 'audio/pcm', sampleRateHertz: TARGET_SAMPLE_RATE as 16000, bytes, durationMs, stopReason: reason };
        } else {
          const collected = await collectFallback(s);
          if (collected === 'too-large') {
            if (!s.cancelled) fail(s, 'too-large');
            return snapshot;
          }
          result = { contentType: collected.type, bytes: collected.bytes, durationMs, stopReason: reason };
        }
        if (s.cancelled || session !== s) return snapshot;
        releaseResources(s);
        if (durationMs < MIN_RECORDING_MS || result.bytes.byteLength === 0) {
          set({ state: 'error', error: recorderError('too-short') });
        } else {
          set({ state: 'done', result });
        }
      } catch {
        if (!s.cancelled) fail(s, 'failed');
      }
      return snapshot;
    })();
    return s.stopping;
  }

  /** Aborts an active recording, discarding audio. No effect when idle or already finished. */
  function cancel(): void {
    const s = session;
    if (!s || s.cancelled) return;
    const active =
      snapshot.state === 'requesting-permission' || snapshot.state === 'recording' || snapshot.state === 'stopping';
    if (!active) return;
    s.cancelled = true;
    s.onFlushed?.();
    s.onMediaStop?.();
    releaseResources(s);
    set({ state: 'cancelled', remainingMs: MAX_RECORDING_MS });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    stop() {
      const s = session;
      if (!s) return Promise.resolve(snapshot);
      if (s.stopping) return s.stopping;
      if (snapshot.state === 'requesting-permission') {
        // Nothing recorded yet; treat as cancel.
        cancel();
        return Promise.resolve(snapshot);
      }
      return finish(s, 'user');
    },
    cancel,
  };
}
