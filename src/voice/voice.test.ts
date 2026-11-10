import { describe, expect, it } from 'vitest';

import { encodingForContentType, MAX_AUDIO_BYTES, validateAudio } from './audio.js';
import { audioObjectKey } from './audioStore.js';
import { StreamingTranscriber, TranscriptionError } from './transcriber.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('validateAudio', () => {
  it('maps allowed content types to Transcribe Streaming encodings', () => {
    expect(encodingForContentType('audio/ogg; codecs=opus')).toBe('ogg-opus');
    expect(encodingForContentType('audio/x-flac')).toBe('flac');
    expect(encodingForContentType('audio/L16')).toBe('pcm');
    expect(encodingForContentType('audio/ogg; codecs=vorbis')).toBeUndefined();
    expect(encodingForContentType('audio/webm')).toBeUndefined();
  });

  it('accepts PCM with an explicit sample rate', () => {
    const res = validateAudio({ audioBase64: b64(Buffer.alloc(32)), contentType: 'audio/pcm', sampleRateHertz: 8000 });
    expect(res).toMatchObject({ ok: true, audio: { encoding: 'pcm', sampleRateHertz: 8000, contentType: 'audio/pcm' } });
  });

  it('rejects empty, oversized, mislabelled, and bad sample-rate audio', () => {
    expect(validateAudio({ audioBase64: '', contentType: 'audio/pcm' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(
      validateAudio({ audioBase64: b64(Buffer.alloc(MAX_AUDIO_BYTES + 10)), contentType: 'audio/pcm' }),
    ).toMatchObject({ ok: false, error: { code: 'AUDIO_TOO_LARGE' } });
    expect(validateAudio({ audioBase64: b64('not ogg'), contentType: 'audio/ogg' })).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_AUDIO' },
    });
    expect(validateAudio({ audioBase64: b64('fLaC....'), contentType: 'audio/flac', sampleRateHertz: 100 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
  });
});

describe('audioObjectKey', () => {
  it('builds a Household-prefixed key and rejects unsafe ids', () => {
    expect(audioObjectKey('hh1', 'v1')).toBe('households/hh1/voice/v1');
    expect(() => audioObjectKey('hh1/../hh2', 'v1')).toThrow();
    expect(() => audioObjectKey('hh1', '')).toThrow();
  });
});

describe('StreamingTranscriber', () => {
  function clientReturning(events: unknown[]) {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { input: { AudioStream: AsyncIterable<unknown> } }) => {
        for await (const e of command.input.AudioStream) sent.push(e);
        return {
          TranscriptResultStream: (async function* () {
            yield* events;
          })(),
        };
      },
    };
    return { client: client as never, sent };
  }

  const request = { audio: new Uint8Array(20), encoding: 'pcm' as const, sampleRateHertz: 16000, languageCode: 'en-US' };

  it('streams audio in chunks and joins final results, ignoring partials', async () => {
    const { client, sent } = clientReturning([
      { TranscriptEvent: { Transcript: { Results: [{ IsPartial: true, Alternatives: [{ Transcript: 'two li' }] }] } } },
      { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, Alternatives: [{ Transcript: 'two liters of milk' }] }] } } },
      { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, Alternatives: [{ Transcript: 'and eggs.' }] }] } } },
    ]);
    const text = await new StreamingTranscriber(client, 8).transcribe(request, { signal: new AbortController().signal });
    expect(text).toBe('two liters of milk and eggs.');
    expect(sent).toHaveLength(3);
  });

  it('throws on a stream exception event', async () => {
    const { client } = clientReturning([{ BadRequestException: { message: 'bad' } }]);
    await expect(
      new StreamingTranscriber(client).transcribe(request, { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(TranscriptionError);
  });
});
