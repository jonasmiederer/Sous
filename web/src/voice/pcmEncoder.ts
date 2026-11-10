/**
 * Pure, DOM-free PCM encoding helpers shared by the AudioWorklet
 * (`pcm-capture.worklet.ts`) and tests (Requirement 14.1).
 *
 * Pipeline per render quantum: `downmix` -> `Resampler.process` ->
 * `floatToInt16LE`. The output is 16 kHz mono 16-bit little-endian PCM, the
 * format the Voice Service accepts as `audio/pcm` with `sampleRateHertz` 16000.
 */

export const TARGET_SAMPLE_RATE = 16_000;
export const MIN_INPUT_SAMPLE_RATE = 8_000;
export const MAX_INPUT_SAMPLE_RATE = 96_000;

/**
 * Averages the channels of one block into a new mono buffer. The result is
 * always a fresh array, because the audio engine reuses its input buffers
 * between render quanta. Channels of unequal length are cut to the shortest.
 */
export function downmix(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (first === undefined) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(first);

  let length = first.length;
  for (const channel of channels) length = Math.min(length, channel.length);

  const out = new Float32Array(length);
  const count = channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] as number;
    out[i] = sum / count;
  }
  return out;
}

/** Streaming sample-rate converter. State carries across `process` calls. */
export interface Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** Converts the next block of input and returns every completed output sample. */
  process(input: Float32Array): Float32Array;
  /** Emits the output samples still pending at the end of the stream and resets the state. */
  flush(): Float32Array;
  /** Drops all pending state. */
  reset(): void;
}

function normalizeRate(rate: number, name: string): number {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${rate}`);
  }
  // AudioContext rates are integers in practice; rounding lets the resampler
  // work in exact integer time units.
  return Math.round(rate);
}

/**
 * Creates a streaming resampler from `inputRate` to `outputRate` (16 kHz by
 * default).
 *
 * Time is measured in exact integer units: one input sample lasts
 * `outputRate` units and one output sample lasts `inputRate` units, so the
 * fractional position carried between blocks never drifts.
 *
 * - Downsampling (and equal rates): each output sample is the box average of
 *   the input over its output step, with fractional weights at the window
 *   edges. The box filter is the low-pass that limits aliasing.
 * - Upsampling (for example 8 kHz): linear interpolation between neighbouring
 *   input samples.
 *
 * Feeding the input in any split into blocks yields exactly the same output as
 * feeding it at once. After `flush`, the total output length is
 * `ceil(totalInputFrames * outputRate / inputRate)`.
 */
export function createResampler(inputRate: number, outputRate: number = TARGET_SAMPLE_RATE): Resampler {
  const inRate = normalizeRate(inputRate, 'inputRate');
  const outRate = normalizeRate(outputRate, 'outputRate');
  return inRate < outRate ? new LinearUpsampler(inRate, outRate) : new BoxDownsampler(inRate, outRate);
}

class BoxDownsampler implements Resampler {
  /** Units of input accumulated into the current output window (0 <= filled < inputRate). */
  private filled = 0;
  /** Weighted sum of the input in the current output window. */
  private acc = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    const window = this.inputRate;
    const sampleUnits = this.outputRate;
    const maxOut = Math.floor((this.filled + input.length * sampleUnits) / window);
    const out = new Float32Array(maxOut);
    let written = 0;
    let filled = this.filled;
    let acc = this.acc;

    for (let i = 0; i < input.length; i++) {
      const x = input[i] as number;
      let remaining = sampleUnits;
      while (remaining > 0) {
        const take = Math.min(remaining, window - filled);
        acc += x * take;
        filled += take;
        remaining -= take;
        if (filled === window) {
          out[written++] = acc / window;
          acc = 0;
          filled = 0;
        }
      }
    }

    this.filled = filled;
    this.acc = acc;
    return written === out.length ? out : out.subarray(0, written);
  }

  flush(): Float32Array {
    const out = this.filled > 0 ? Float32Array.of(this.acc / this.filled) : new Float32Array(0);
    this.reset();
    return out;
  }

  reset(): void {
    this.filled = 0;
    this.acc = 0;
  }
}

class LinearUpsampler implements Resampler {
  /** The last input sample seen, or undefined before the first one. */
  private prev: number | undefined;
  /** Position of the next output sample, in units after `prev` (0 <= pos). */
  private pos = 0;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {}

  process(input: Float32Array): Float32Array {
    const span = this.outputRate; // units between two input samples
    const step = this.inputRate; // units between two output samples
    const out = new Float32Array(Math.ceil(((input.length + 1) * span) / step) + 1);
    let written = 0;
    let prev = this.prev;
    let pos = this.pos;

    for (let i = 0; i < input.length; i++) {
      const x = input[i] as number;
      if (prev !== undefined) {
        // Emit every output sample that lies in [prev, x).
        while (pos < span) {
          out[written++] = prev + ((x - prev) * pos) / span;
          pos += step;
        }
        pos -= span;
      }
      prev = x;
    }

    this.prev = prev;
    this.pos = pos;
    return out.subarray(0, written);
  }

  flush(): Float32Array {
    const prev = this.prev;
    const span = this.outputRate;
    const step = this.inputRate;
    let count = 0;
    if (prev !== undefined) {
      // The last input sample covers [prev, prev + span); hold its value there.
      for (let pos = this.pos; pos < span; pos += step) count++;
    }
    const out = new Float32Array(count).fill(prev ?? 0);
    this.reset();
    return out;
  }

  reset(): void {
    this.prev = undefined;
    this.pos = 0;
  }
}

/**
 * Converts float samples to signed 16-bit little-endian bytes. Values are
 * clamped to [-1, 1] and scaled by 32767 (positive) or 32768 (negative). NaN
 * becomes 0. A DataView is used so the byte order is little-endian on every
 * platform.
 */
export function floatToInt16LE(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, floatSampleToInt16(samples[i] as number), true);
  }
  return bytes;
}

/** Clamps and scales one float sample to the Int16 range. */
export function floatSampleToInt16(sample: number): number {
  if (Number.isNaN(sample)) return 0;
  const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}
