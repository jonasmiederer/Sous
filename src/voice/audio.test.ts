import { describe, expect, it } from 'vitest';
import { classifyContentType, MAX_AUDIO_BYTES, validateAudio, validateIncomingAudio } from './audio.js';

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString('base64');
const EBML = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
const MP4 = Uint8Array.from([0x00, 0x00, 0x00, 0x20, ...Buffer.from('ftypisom'), 0x00, 0x00]);

describe('classifyContentType', () => {
  it('classifies accepted, convertible, and unsupported content types', () => {
    expect(classifyContentType('audio/ogg; codecs=opus')).toEqual({ kind: 'accepted', encoding: 'ogg-opus' });
    expect(classifyContentType('audio/pcm')).toEqual({ kind: 'accepted', encoding: 'pcm' });
    expect(classifyContentType('audio/flac')).toEqual({ kind: 'accepted', encoding: 'flac' });
    expect(classifyContentType('audio/webm')).toEqual({ kind: 'convertible', container: 'webm' });
    expect(classifyContentType('video/webm')).toEqual({ kind: 'convertible', container: 'webm' });
    expect(classifyContentType('Audio/WebM; codecs="opus"')).toEqual({ kind: 'convertible', container: 'webm' });
    expect(classifyContentType('audio/mp4')).toEqual({ kind: 'convertible', container: 'mp4' });
    expect(classifyContentType('audio/x-m4a')).toEqual({ kind: 'convertible', container: 'mp4' });
    expect(classifyContentType('audio/mpeg')).toBeUndefined();
    expect(classifyContentType('video/mp4')).toBeUndefined();
    expect(classifyContentType('audio/ogg; codecs=vorbis')).toBeUndefined();
  });
});

describe('validateIncomingAudio', () => {
  it('returns convertible bytes and container for WebM and MP4 with matching magic bytes', () => {
    expect(validateIncomingAudio({ audioBase64: b64(EBML), contentType: 'audio/webm;codecs=opus' })).toEqual({
      ok: true,
      convertible: { bytes: EBML, container: 'webm' },
    });
    expect(validateIncomingAudio({ audioBase64: b64(MP4), contentType: 'audio/mp4' })).toEqual({
      ok: true,
      convertible: { bytes: MP4, container: 'mp4' },
    });
  });

  it('ignores sampleRateHertz for convertible input', () => {
    const res = validateIncomingAudio({ audioBase64: b64(EBML), contentType: 'video/webm', sampleRateHertz: 'bogus' });
    expect(res).toMatchObject({ ok: true, convertible: { container: 'webm' } });
  });

  it('rejects convertible input whose leading bytes do not match the declared container', () => {
    const cases = [
      { audioBase64: b64(MP4), contentType: 'audio/webm' },
      { audioBase64: b64(EBML), contentType: 'audio/x-m4a' },
      { audioBase64: b64('OggS....'), contentType: 'audio/mp4' },
      { audioBase64: b64(EBML.subarray(0, 3)), contentType: 'audio/webm' },
      { audioBase64: b64(MP4.subarray(0, 7)), contentType: 'audio/mp4' },
    ];
    for (const input of cases) {
      expect(validateIncomingAudio(input)).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_AUDIO' } });
    }
  });

  it('rejects content types that are neither accepted nor convertible', () => {
    expect(validateIncomingAudio({ audioBase64: b64(EBML), contentType: 'audio/mpeg' })).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_AUDIO' },
    });
    expect(validateIncomingAudio({ audioBase64: b64(EBML), contentType: '' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('applies the base64 and size checks to convertible input', () => {
    expect(validateIncomingAudio({ audioBase64: '', contentType: 'audio/webm' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(validateIncomingAudio({ audioBase64: '!!not base64!!', contentType: 'audio/webm' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    const big = new Uint8Array(MAX_AUDIO_BYTES + 1);
    big.set(EBML);
    expect(validateIncomingAudio({ audioBase64: b64(big), contentType: 'audio/webm' })).toMatchObject({
      ok: false,
      error: { code: 'AUDIO_TOO_LARGE' },
    });
  });

  it('matches validateAudio exactly for accepted formats', () => {
    const inputs = [
      { audioBase64: b64(new Uint8Array(32)), contentType: 'audio/pcm', sampleRateHertz: 8000 },
      { audioBase64: b64('OggS rest'), contentType: 'audio/ogg' },
      { audioBase64: b64('not flac'), contentType: 'audio/flac' },
      { audioBase64: b64(new Uint8Array(4)), contentType: 'audio/l16', sampleRateHertz: 100 },
    ];
    for (const input of inputs) expect(validateIncomingAudio(input)).toEqual(validateAudio(input));
  });
});
