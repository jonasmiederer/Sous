/**
 * AudioWorklet processor `sous-pcm-capture` (Requirement 14.1).
 *
 * Runs in AudioWorkletGlobalScope. For every render quantum it downmixes the
 * microphone input to mono, resamples it from the context rate to 16 kHz, and
 * encodes Int16 LE. Encoded bytes are batched into chunks of
 * PCM_CHUNK_SAMPLES samples and posted to the main thread as transferable
 * ArrayBuffers.
 *
 * Load it through `pcmCaptureWorkletUrl.ts`, which imports this file with
 * Vite's `?worker&url` suffix so it is bundled as its own same-origin script.
 */
import { createResampler, downmix, floatToInt16LE, TARGET_SAMPLE_RATE } from './pcmEncoder';
import {
  PCM_CAPTURE_PROCESSOR_NAME,
  PCM_CHUNK_SAMPLES,
  type PcmCaptureCommand,
  type PcmCaptureEvent,
} from './pcmCaptureProtocol';

// Minimal AudioWorkletGlobalScope types. lib.dom does not declare them, and
// they are read from globalThis rather than declared globally so they do not
// leak into the main-thread code that shares this tsconfig.
interface AudioWorkletProcessorBase {
  readonly port: MessagePort;
}
interface AudioWorkletScope {
  readonly sampleRate: number;
  readonly AudioWorkletProcessor: new () => AudioWorkletProcessorBase;
  registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessorBase): void;
}

const scope = globalThis as unknown as AudioWorkletScope;

class PcmCaptureProcessor extends scope.AudioWorkletProcessor {
  private readonly resampler = createResampler(scope.sampleRate, TARGET_SAMPLE_RATE);
  private pending = new Float32Array(PCM_CHUNK_SAMPLES);
  private pendingLength = 0;
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<PcmCaptureCommand>) => {
      if (event.data?.type === 'flush') this.flush();
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      // downmix copies, so the engine-owned input buffers are never retained.
      this.append(this.resampler.process(downmix(channels)));
    }
    return true;
  }

  private append(samples: Float32Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, PCM_CHUNK_SAMPLES - this.pendingLength);
      this.pending.set(samples.subarray(offset, offset + take), this.pendingLength);
      this.pendingLength += take;
      offset += take;
      if (this.pendingLength === PCM_CHUNK_SAMPLES) this.postPending();
    }
  }

  private postPending(): void {
    if (this.pendingLength === 0) return;
    const bytes = floatToInt16LE(this.pending.subarray(0, this.pendingLength));
    this.pendingLength = 0;
    const message: PcmCaptureEvent = { type: 'chunk', buffer: bytes.buffer as ArrayBuffer };
    this.port.postMessage(message, [message.buffer]);
  }

  private flush(): void {
    if (this.stopped) return;
    this.append(this.resampler.flush());
    this.postPending();
    this.stopped = true;
    const message: PcmCaptureEvent = { type: 'flushed' };
    this.port.postMessage(message);
  }
}

scope.registerProcessor(PCM_CAPTURE_PROCESSOR_NAME, PcmCaptureProcessor);
