/**
 * Transcriber: narrow interface over Amazon Transcribe (Requirement 11.7).
 *
 * The production adapter uses Amazon Transcribe Streaming
 * (StartStreamTranscription) over the uploaded audio bytes. Batch
 * Transcribe jobs usually take longer than the 15-second Voice_Input bound
 * (Requirement 11.5) even for short clips, so they are not used.
 *
 * Contract: `transcribe` resolves to the final transcript text (possibly
 * empty) or rejects with an error. It must stop work when `signal` aborts.
 * The caller decides what an empty transcript or an abort means.
 */
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type LanguageCode,
} from '@aws-sdk/client-transcribe-streaming';

import type { AudioEncoding } from './audio.js';

export interface TranscriptionRequest {
  audio: Uint8Array;
  encoding: AudioEncoding;
  sampleRateHertz: number;
  /** BCP-47 code such as `en-US`. */
  languageCode: string;
}

export interface Transcriber {
  transcribe(request: TranscriptionRequest, options: { signal: AbortSignal }): Promise<string>;
}

export class TranscriptionError extends Error {
  override readonly name = 'TranscriptionError';
}

/** Audio is sent in chunks of this size; Transcribe Streaming caps event size well above it. */
export const AUDIO_CHUNK_BYTES = 8 * 1024;

async function* audioEvents(audio: Uint8Array, chunkBytes: number): AsyncGenerator<AudioStream> {
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    yield { AudioEvent: { AudioChunk: audio.subarray(offset, offset + chunkBytes) } };
  }
}

/** Amazon Transcribe Streaming adapter. Joins the final (non-partial) results. */
export class StreamingTranscriber implements Transcriber {
  constructor(
    private readonly client: Pick<TranscribeStreamingClient, 'send'> = new TranscribeStreamingClient({}),
    private readonly chunkBytes: number = AUDIO_CHUNK_BYTES,
  ) {}

  async transcribe(request: TranscriptionRequest, options: { signal: AbortSignal }): Promise<string> {
    const output = await this.client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: request.languageCode as LanguageCode,
        MediaEncoding: request.encoding,
        MediaSampleRateHertz: request.sampleRateHertz,
        AudioStream: audioEvents(request.audio, this.chunkBytes),
      }),
      { abortSignal: options.signal },
    );
    const parts: string[] = [];
    for await (const event of output.TranscriptResultStream ?? []) {
      if (options.signal.aborted) throw new TranscriptionError('Transcription aborted');
      if (event.TranscriptEvent !== undefined) {
        for (const result of event.TranscriptEvent.Transcript?.Results ?? []) {
          const text = result.IsPartial ? undefined : result.Alternatives?.[0]?.Transcript;
          if (text) parts.push(text.trim());
        }
        continue;
      }
      // Any other member is a service exception event (bad request, limit, ...).
      const kind = Object.keys(event).find((k) => (event as unknown as Record<string, unknown>)[k] !== undefined) ?? 'Unknown';
      throw new TranscriptionError(`Transcription stream failed: ${kind}`);
    }
    return parts.filter((p) => p.length > 0).join(' ');
  }
}

/**
 * In-memory Transcriber for tests and local runs. `respond` decides the
 * outcome per call; by default it returns `text`. A response of `'hang'`
 * never settles until the signal aborts.
 */
export class FakeTranscriber implements Transcriber {
  readonly calls: TranscriptionRequest[] = [];

  constructor(
    private respond: (request: TranscriptionRequest) => string | Error | 'hang' | Promise<string> = () => '',
  ) {}

  static returning(text: string): FakeTranscriber {
    return new FakeTranscriber(() => text);
  }

  setResponse(respond: (request: TranscriptionRequest) => string | Error | 'hang' | Promise<string>): void {
    this.respond = respond;
  }

  async transcribe(request: TranscriptionRequest, options: { signal: AbortSignal }): Promise<string> {
    this.calls.push(request);
    const outcome = this.respond(request);
    if (outcome === 'hang') {
      return new Promise<string>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new TranscriptionError('aborted')), { once: true });
      });
    }
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}
