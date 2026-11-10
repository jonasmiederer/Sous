import { describe, expect, it } from 'vitest';
import { createResampler, downmix, floatSampleToInt16, floatToInt16LE } from './pcmEncoder';

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function runChunked(rate: number, input: Float32Array, blockSize: number): Float32Array {
  const resampler = createResampler(rate, 16_000);
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += blockSize) {
    parts.push(resampler.process(input.subarray(i, i + blockSize)));
  }
  parts.push(resampler.flush());
  return concat(parts);
}

function sine(rate: number, frames: number, hz = 440): Float32Array {
  return Float32Array.from({ length: frames }, (_, i) => 0.8 * Math.sin((2 * Math.PI * hz * i) / rate));
}

describe('downmix', () => {
  it('averages channels into a new buffer', () => {
    const left = Float32Array.of(1, 0.5, -1);
    const right = Float32Array.of(0, 0.5, 1);
    expect(Array.from(downmix([left, right]))).toEqual([0.5, 0.5, 0]);
  });

  it('copies a single channel and handles no channels', () => {
    const mono = Float32Array.of(0.25, -0.25);
    const out = downmix([mono]);
    expect(out).not.toBe(mono);
    expect(Array.from(out)).toEqual([0.25, -0.25]);
    expect(downmix([]).length).toBe(0);
  });
});

describe('createResampler', () => {
  it.each([8_000, 16_000, 22_050, 44_100, 48_000, 96_000])(
    'produces the expected sample count at %i Hz',
    (rate) => {
      const frames = rate; // one second of audio
      const out = runChunked(rate, sine(rate, frames), 128);
      expect(Math.abs(out.length - Math.round((frames * 16_000) / rate))).toBeLessThanOrEqual(1);
    },
  );

  it.each([8_000, 44_100, 48_000])('gives the same output for any block split at %i Hz', (rate) => {
    const input = sine(rate, 5_000);
    const whole = runChunked(rate, input, input.length);
    expect(Array.from(runChunked(rate, input, 128))).toEqual(Array.from(whole));
    expect(Array.from(runChunked(rate, input, 37))).toEqual(Array.from(whole));
  });

  it('keeps constant input constant', () => {
    for (const rate of [8_000, 44_100, 48_000]) {
      const out = runChunked(rate, new Float32Array(1_000).fill(0.3), 128);
      expect(out.every((v) => v === Math.fround(0.3))).toBe(true);
    }
  });

  it('averages each 48 kHz output step over three input samples', () => {
    const resampler = createResampler(48_000);
    expect(Array.from(resampler.process(Float32Array.of(0, 0.5, 1, 1, 1, 1)))).toEqual([0.5, 1]);
  });

  it('interpolates linearly when upsampling from 8 kHz', () => {
    const resampler = createResampler(8_000);
    const out = concat([resampler.process(Float32Array.of(0, 1)), resampler.flush()]);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
  });

  it('rejects invalid rates', () => {
    expect(() => createResampler(0)).toThrow(RangeError);
    expect(() => createResampler(Number.NaN)).toThrow(RangeError);
  });
});

describe('floatToInt16LE', () => {
  it('clamps, scales, and writes little-endian bytes', () => {
    const bytes = floatToInt16LE(Float32Array.of(1, -1, 0, 2, -2, 0.5));
    expect(bytes.length).toBe(12);
    const view = new DataView(bytes.buffer);
    const values = Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true));
    expect(values).toEqual([32767, -32768, 0, 32767, -32768, 16384]);
    // 32767 = 0x7FFF -> low byte first.
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0xff, 0x7f]);
  });

  it('maps NaN to 0', () => {
    expect(floatSampleToInt16(Number.NaN)).toBe(0);
  });
});
