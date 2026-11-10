import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pcmCaptureWorkletUrl', () => ({
  pcmCaptureWorkletUrl: '/assets/pcm-capture.worklet.js',
  loadPcmCaptureWorklet: vi.fn(() => Promise.resolve()),
}));

import {
  MAX_FALLBACK_BYTES,
  MAX_PCM_BYTES,
  MAX_RECORDING_MS,
  createRecorder,
  pickFallbackMimeType,
  type AudioContextLike,
  type BlobLike,
  type MediaRecorderLike,
  type MediaStreamLike,
  type MessagePortLike,
  type RecorderDeps,
  type RecorderSnapshot,
} from './recorder';
import { PCM_CAPTURE_PROCESSOR_NAME } from './pcmCaptureProtocol';

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

class FakeAudioContext implements AudioContextLike {
  static instances: FakeAudioContext[] = [];
  readonly sampleRate = 48_000;
  state = 'running';
  readonly destination = { kind: 'destination' };
  readonly audioWorklet = { addModule: vi.fn() };
  readonly source = node();
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return this.source;
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = [];
  readonly posted: unknown[] = [];
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly port: MessagePortLike = {
    onmessage: null,
    postMessage: (message: unknown) => {
      this.posted.push(message);
      if ((message as { type?: string }).type === 'flush') {
        queueMicrotask(() => this.emit({ type: 'flushed' }));
      }
    },
  };
  constructor(
    readonly context: AudioContextLike,
    readonly name: string,
  ) {
    FakeWorkletNode.instances.push(this);
  }
  emit(data: unknown): void {
    this.port.onmessage?.({ data });
  }
  emitChunk(byteLength: number, fill = 1): void {
    this.emit({ type: 'chunk', buffer: new Uint8Array(byteLength).fill(fill).buffer });
  }
}

function makeFakeMediaRecorder(supported: string[], blobSize = 1_000) {
  class FakeMediaRecorder implements MediaRecorderLike {
    static instances: FakeMediaRecorder[] = [];
    static isTypeSupported = (type: string) => supported.includes(type);
    state = 'inactive';
    readonly mimeType: string;
    ondataavailable: ((event: { data: BlobLike }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(
      readonly stream: MediaStreamLike,
      options?: { mimeType?: string },
    ) {
      this.mimeType = options?.mimeType ?? 'audio/mp4';
      FakeMediaRecorder.instances.push(this);
    }
    start(): void {
      this.state = 'recording';
    }
    stop(): void {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(blobSize)], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  return FakeMediaRecorder;
}

interface Harness {
  deps: RecorderDeps;
  stream: FakeStream;
  getUserMedia: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<RecorderDeps> = {}): Harness {
  const stream = new FakeStream();
  const getUserMedia = vi.fn(() => Promise.resolve(stream as MediaStreamLike));
  const deps: RecorderDeps = {
    getUserMedia,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode as unknown as RecorderDeps['AudioWorkletNode'],
    MediaRecorder: makeFakeMediaRecorder(['audio/webm;codecs=opus', 'audio/webm']),
    loadWorklet: () => Promise.resolve(),
    now: () => Date.now(),
    ...overrides,
  };
  return { deps, stream, getUserMedia };
}

const lastContext = () => FakeAudioContext.instances.at(-1)!;
const lastNode = () => FakeWorkletNode.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeWorkletNode.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pickFallbackMimeType', () => {
  it('prefers Ogg/Opus, then WebM/Opus, WebM, and MP4', () => {
    expect(pickFallbackMimeType(() => true)).toBe('audio/ogg;codecs=opus');
    expect(pickFallbackMimeType((t) => t !== 'audio/ogg;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(pickFallbackMimeType((t) => t === 'audio/webm' || t === 'audio/mp4')).toBe('audio/webm');
    expect(pickFallbackMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickFallbackMimeType(() => false)).toBeUndefined();
  });
});

describe('createRecorder PCM path', () => {
  it('creates the AudioContext synchronously on start and records 16 kHz PCM', async () => {
    const { deps, stream } = harness();
    const recorder = createRecorder(deps);
    const states: string[] = [];
    recorder.subscribe((s) => states.push(s.state));

    const started = recorder.start();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(recorder.getSnapshot().state).toBe('requesting-permission');
    await started;

    expect(recorder.getSnapshot()).toMatchObject({ state: 'recording', mode: 'pcm', remainingMs: MAX_RECORDING_MS });
    expect(lastNode().name).toBe(PCM_CAPTURE_PROCESSOR_NAME);
    expect(lastContext().source.connect).toHaveBeenCalledWith(lastNode());

    await vi.advanceTimersByTimeAsync(1_000);
    lastNode().emitChunk(4_096, 1);
    lastNode().emitChunk(4_096, 2);
    const final = await recorder.stop();

    expect(lastNode().posted).toEqual([{ type: 'flush' }]);
    expect(final.state).toBe('done');
    expect(final.result).toMatchObject({ contentType: 'audio/pcm', sampleRateHertz: 16000, stopReason: 'user' });
    expect(final.result!.bytes.byteLength).toBe(8_192);
    expect(final.result!.bytes[0]).toBe(1);
    expect(final.result!.bytes[8_191]).toBe(2);
    expect(stream.tracks[0]!.stopped).toBe(true);
    expect(lastContext().state).toBe('closed');
    expect(states).toEqual(['requesting-permission', 'recording', 'recording', 'recording', 'recording', 'recording', 'stopping', 'done']);
  });

  it('counts down remainingMs and stops by itself at 30 s, keeping the audio', async () => {
    const { deps, stream } = harness();
    const recorder = createRecorder(deps);
    await recorder.start();
    lastNode().emitChunk(4_096);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(recorder.getSnapshot().remainingMs).toBe(20_000);

    await vi.advanceTimersByTimeAsync(20_000);
    const snap = recorder.getSnapshot();
    expect(snap.state).toBe('done');
    expect(snap.result).toMatchObject({ stopReason: 'time-limit', durationMs: MAX_RECORDING_MS });
    expect(snap.result!.bytes.byteLength).toBe(4_096);
    expect(stream.tracks[0]!.stopped).toBe(true);
  });

  it('stops at 960,000 PCM bytes and truncates to the limit', async () => {
    const { deps } = harness();
    const recorder = createRecorder(deps);
    await recorder.start();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 240; i += 1) lastNode().emitChunk(4_096);
    await vi.advanceTimersByTimeAsync(0);

    const snap = recorder.getSnapshot();
    expect(snap.state).toBe('done');
    expect(snap.result!.stopReason).toBe('size-limit');
    expect(snap.result!.bytes.byteLength).toBe(MAX_PCM_BYTES);
  });

  it('reports a recording under 0.3 s as too short', async () => {
    const { deps } = harness();
    const recorder = createRecorder(deps);
    await recorder.start();
    lastNode().emitChunk(64);
    await vi.advanceTimersByTimeAsync(100);
    const final = await recorder.stop();
    expect(final.state).toBe('error');
    expect(final.error?.code).toBe('too-short');
  });
});

describe('createRecorder fallback path', () => {
  it('uses MediaRecorder when AudioWorkletNode is unavailable and uploads the base type', async () => {
    const MediaRecorder = makeFakeMediaRecorder(['audio/ogg;codecs=opus', 'audio/webm'], 2_000);
    const { deps, stream } = harness({ AudioWorkletNode: undefined, MediaRecorder });
    const recorder = createRecorder(deps);
    await recorder.start();

    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(recorder.getSnapshot()).toMatchObject({ state: 'recording', mode: 'fallback' });
    expect(MediaRecorder.instances[0]!.mimeType).toBe('audio/ogg;codecs=opus');

    await vi.advanceTimersByTimeAsync(2_000);
    const final = await recorder.stop();
    expect(final.state).toBe('done');
    expect(final.result).toMatchObject({ contentType: 'audio/ogg', stopReason: 'user' });
    expect(final.result!.sampleRateHertz).toBeUndefined();
    expect(final.result!.bytes.byteLength).toBe(2_000);
    expect(stream.tracks[0]!.stopped).toBe(true);
  });

  it('falls back when the worklet fails to load and closes the unused context', async () => {
    const MediaRecorder = makeFakeMediaRecorder(['audio/mp4']);
    const { deps } = harness({ loadWorklet: () => Promise.reject(new Error('blocked')), MediaRecorder });
    const recorder = createRecorder(deps);
    await recorder.start();

    expect(lastContext().state).toBe('closed');
    expect(FakeWorkletNode.instances).toHaveLength(0);
    expect(recorder.getSnapshot().mode).toBe('fallback');
    expect(MediaRecorder.instances[0]!.mimeType).toBe('audio/mp4');
  });

  it('refuses a fallback recording larger than 1,000,000 bytes', async () => {
    const MediaRecorder = makeFakeMediaRecorder(['audio/webm'], MAX_FALLBACK_BYTES + 1);
    const { deps, stream } = harness({ AudioWorkletNode: undefined, MediaRecorder });
    const recorder = createRecorder(deps);
    await recorder.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const final = await recorder.stop();

    expect(final.state).toBe('error');
    expect(final.error?.code).toBe('too-large');
    expect(final.result).toBeUndefined();
    expect(stream.tracks[0]!.stopped).toBe(true);
  });
});

describe('createRecorder errors and cancel', () => {
  it('maps a denied permission to permission-denied and closes the context', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const { deps } = harness({ getUserMedia: () => Promise.reject(denied) });
    const recorder = createRecorder(deps);
    await recorder.start();

    expect(recorder.getSnapshot().state).toBe('error');
    expect(recorder.getSnapshot().error?.code).toBe('permission-denied');
    expect(recorder.getSnapshot().error?.message).toMatch(/microphone/i);
    expect(lastContext().state).toBe('closed');
  });

  it('reports unsupported when getUserMedia is missing', async () => {
    vi.stubGlobal('navigator', {});
    const { deps } = harness({ getUserMedia: undefined });
    const recorder = createRecorder(deps);
    try {
      await recorder.start();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(recorder.getSnapshot().error?.code).toBe('unsupported');
  });

  it('reports unsupported when neither AudioWorklet nor MediaRecorder exists', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('AudioWorkletNode', undefined);
    vi.stubGlobal('MediaRecorder', undefined);
    try {
      const { deps } = harness();
      const recorder = createRecorder({ getUserMedia: deps.getUserMedia });
      await recorder.start();
      expect(recorder.getSnapshot().error?.code).toBe('unsupported');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancel while recording discards audio and releases the microphone and context', async () => {
    const { deps, stream } = harness();
    const recorder = createRecorder(deps);
    await recorder.start();
    lastNode().emitChunk(4_096);
    recorder.cancel();

    const snap: RecorderSnapshot = recorder.getSnapshot();
    expect(snap.state).toBe('cancelled');
    expect(snap.result).toBeUndefined();
    expect(stream.tracks[0]!.stopped).toBe(true);
    expect(lastContext().state).toBe('closed');
    await vi.advanceTimersByTimeAsync(MAX_RECORDING_MS);
    expect(recorder.getSnapshot().state).toBe('cancelled');
  });

  it('cancel during the permission prompt stops the stream once granted', async () => {
    let grant!: (s: MediaStreamLike) => void;
    const stream = new FakeStream();
    const { deps } = harness({ getUserMedia: () => new Promise((resolve) => (grant = resolve)) });
    const recorder = createRecorder(deps);
    const started = recorder.start();
    recorder.cancel();
    grant(stream);
    await started;

    expect(recorder.getSnapshot().state).toBe('cancelled');
    expect(stream.tracks[0]!.stopped).toBe(true);
    expect(FakeWorkletNode.instances).toHaveLength(0);
  });

  it('can record again after a finished recording', async () => {
    const { deps } = harness();
    const recorder = createRecorder(deps);
    await recorder.start();
    recorder.cancel();
    await recorder.start();
    expect(recorder.getSnapshot()).toMatchObject({ state: 'recording', result: undefined, error: undefined });
  });
});
