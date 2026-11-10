import { describe, expect, it } from 'vitest';

import { InMemoryTableClient } from '../../../test/fakes/inMemoryTableClient.js';
import { HouseholdRepository } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { Ingredient } from '../../domain/types.js';
import { MAX_AUDIO_BYTES } from '../../voice/audio.js';
import { FakeAudioConverter } from '../../voice/audioConverter.js';
import { InMemoryAudioStore } from '../../voice/audioStore.js';
import { FakeTranscriber, TranscriptionError } from '../../voice/transcriber.js';
import {
  fridgeRecordingDispatch,
  suggestionContextDispatch,
  type DispatchOutcome,
  type TranscriptDispatcher,
} from './dispatcher.js';
import { createVoiceHandlers } from './handlers.js';
import { VOICE_PENDING_TTL_SECONDS, VoiceService, voiceSortKey, type VoiceServiceDeps } from './service.js';

const alice: ActiveHouseholdScope = { userId: 'alice', householdId: 'hh1', role: 'owner' };
const bob: ActiveHouseholdScope = { userId: 'bob', householdId: 'hh1', role: 'member' };
const mallory: ActiveHouseholdScope = { userId: 'alice', householdId: 'hh2', role: 'owner' };

const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 7)]).toString('base64');

function submitBody(targetOperation: unknown = { type: 'fridge' }, extra: Record<string, unknown> = {}) {
  return { audio: OGG, contentType: 'audio/ogg; codecs=opus', targetOperation, ...extra };
}

interface Dispatched {
  type: string;
  scope: ActiveHouseholdScope;
  transcript: string;
  extra?: unknown;
}

function setup(overrides: Partial<VoiceServiceDeps> & { dispatchResult?: DispatchOutcome } = {}) {
  const table = new InMemoryTableClient();
  const audioStore = new InMemoryAudioStore();
  const transcriber = FakeTranscriber.returning('two liters of milk and 6 eggs');
  const dispatched: Dispatched[] = [];
  const result = overrides.dispatchResult ?? { ok: true, value: { applied: true } };
  const dispatcher: TranscriptDispatcher = {
    fridge: async (scope, transcript) => (dispatched.push({ type: 'fridge', scope, transcript }), result),
    context: async (scope, transcript, extra) => (dispatched.push({ type: 'context', scope, transcript, extra }), result),
    conversation: async (scope, transcript, extra) =>
      (dispatched.push({ type: 'conversation', scope, transcript, extra }), result),
  };
  let clock = Date.parse('2025-01-01T00:00:00Z');
  let ids = 0;
  const service = new VoiceService({
    repositoryFor: (id) => new HouseholdRepository(table, id),
    transcriber,
    audioStore,
    dispatcher,
    now: () => clock,
    newId: () => `v${++ids}`,
    ...overrides,
  });
  return {
    table,
    audioStore,
    transcriber,
    dispatched,
    service,
    advance: (ms: number) => (clock += ms),
    voiceItems: () => table.dump().filter((i) => i.SK.startsWith('VOICE#')),
  };
}

describe('VoiceService.submit', () => {
  it('stores audio under the Household prefix and returns a pending Transcript without applying it', async () => {
    const t = setup();
    const res = await t.service.submit(alice, submitBody());
    expect(res).toMatchObject({
      ok: true,
      value: { voiceId: 'v1', transcript: 'two liters of milk and 6 eggs', status: 'pending', targetOperation: { type: 'fridge' } },
    });
    expect([...t.audioStore.objects.keys()]).toEqual(['households/hh1/voice/v1']);
    expect(t.transcriber.calls[0]).toMatchObject({ encoding: 'ogg-opus', sampleRateHertz: 48000, languageCode: 'en-US' });
    const [item] = t.voiceItems();
    expect(item).toMatchObject({ PK: 'HH#hh1', SK: 'VOICE#v1', status: 'pending', createdByUserId: 'alice' });
    expect(item!.ttl).toBe(Date.parse('2025-01-01T00:00:00Z') / 1000 + VOICE_PENDING_TTL_SECONDS);
    expect(t.dispatched).toEqual([]);
  });

  it.each([
    ['empty transcript', () => '   '],
    ['transcription failure', () => new TranscriptionError('bad audio')],
  ])('%s -> VOICE_NOT_UNDERSTOOD with retry prompt and no VOICE record', async (_label, respond) => {
    const t = setup();
    t.transcriber.setResponse(respond);
    const res = await t.service.submit(alice, submitBody());
    expect(res).toMatchObject({ ok: false, error: { code: 'VOICE_NOT_UNDERSTOOD', retry: true } });
    expect(res.ok || res.error.message).toMatch(/try recording again/);
    expect(t.voiceItems()).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it('times out at the deadline with no VOICE record', async () => {
    const t = setup({ deadlineMs: 30 });
    t.transcriber.setResponse(() => 'hang');
    const res = await t.service.submit(alice, submitBody());
    expect(res).toMatchObject({ ok: false, error: { code: 'VOICE_TIMEOUT', retry: true } });
    expect(t.voiceItems()).toEqual([]);
  });

  it('rejects invalid audio and targets before transcribing', async () => {
    const t = setup();
    expect(await t.service.submit(alice, submitBody({ type: 'fridge' }, { contentType: 'audio/webm' }))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_AUDIO' },
    });
    expect(await t.service.submit(alice, submitBody({ type: 'fridge' }, { audio: '' }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(await t.service.submit(alice, submitBody({ type: 'context', presets: ['spicy'] }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(await t.service.submit(alice, submitBody({ type: 'conversation' }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(t.transcriber.calls).toEqual([]);
    expect(t.audioStore.objects.size).toBe(0);
  });

  it('reports an audio upload failure and writes no VOICE record', async () => {
    const t = setup();
    t.audioStore.failNext();
    expect(await t.service.submit(alice, submitBody())).toMatchObject({ ok: false, error: { code: 'AUDIO_UPLOAD_FAILED' } });
    expect(t.voiceItems()).toEqual([]);
  });
});

describe('VoiceService.submit with server-side conversion', () => {
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]).toString('base64');
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]).toString('base64');
  const PCM = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const convertibleBody = (audio: string, contentType: string) => ({ audio, contentType, targetOperation: { type: 'fridge' } });

  it('converts WebM to 16 kHz PCM, then uploads and transcribes only the PCM', async () => {
    const converter = new FakeAudioConverter([{ ok: true, pcm: PCM }]);
    const t = setup({ audioConverter: converter });
    const res = await t.service.submit(alice, convertibleBody(WEBM, 'audio/webm;codecs=opus'));
    expect(res).toMatchObject({ ok: true, value: { voiceId: 'v1', status: 'pending' } });
    expect(converter.calls).toHaveLength(1);
    expect(converter.calls[0]!.input.container).toBe('webm');
    expect(converter.calls[0]!.options.maxOutputBytes).toBe(MAX_AUDIO_BYTES);
    expect(t.transcriber.calls[0]).toMatchObject({ encoding: 'pcm', sampleRateHertz: 16000, audio: PCM });
    expect(t.audioStore.objects.get('households/hh1/voice/v1')).toEqual({ body: PCM, contentType: 'audio/pcm' });
    expect(t.voiceItems()[0]).toMatchObject({ contentType: 'audio/pcm' });
  });

  it('detects the mp4 container', async () => {
    const converter = new FakeAudioConverter([{ ok: true, pcm: PCM }]);
    const t = setup({ audioConverter: converter });
    expect(await t.service.submit(alice, convertibleBody(MP4, 'audio/mp4'))).toMatchObject({ ok: true });
    expect(converter.calls[0]!.input.container).toBe('mp4');
  });

  it('never calls the converter for accepted formats or mislabelled containers', async () => {
    const converter = new FakeAudioConverter([{ ok: true, pcm: PCM }]);
    const t = setup({ audioConverter: converter });
    expect(await t.service.submit(alice, submitBody())).toMatchObject({ ok: true });
    expect(await t.service.submit(alice, convertibleBody(OGG, 'audio/webm'))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_AUDIO' },
    });
    expect(converter.calls).toEqual([]);
  });

  it('rejects convertible input as UNSUPPORTED_AUDIO when no converter is configured', async () => {
    const t = setup();
    expect(await t.service.submit(alice, convertibleBody(WEBM, 'audio/webm'))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_AUDIO' },
    });
    expect(t.transcriber.calls).toEqual([]);
  });

  it.each([
    ['failed', 'AUDIO_CONVERSION_FAILED', 422],
    ['too_large', 'AUDIO_TOO_LARGE', 413],
    ['timeout', 'VOICE_TIMEOUT', 504],
  ] as const)('converter %s -> %s (%i) with retry prompt and nothing stored', async (reason, code, status) => {
    const t = setup({ audioConverter: new FakeAudioConverter([{ ok: false, reason }]) });
    const res = await createVoiceHandlers(t.service).submit({ body: JSON.stringify(convertibleBody(WEBM, 'audio/webm')) }, alice);
    expect(res.statusCode).toBe(status);
    const body = JSON.parse(res.body) as { error: { code: string; retry: boolean; message: string } };
    expect(body.error).toMatchObject({ code, retry: true });
    expect(body.error.message).toMatch(/try recording again/);
    expect(t.transcriber.calls).toEqual([]);
    expect(t.audioStore.objects.size).toBe(0);
    expect(t.voiceItems()).toEqual([]);
  });

  it('rejects odd-length converter output as AUDIO_CONVERSION_FAILED', async () => {
    const t = setup({ audioConverter: new FakeAudioConverter([{ ok: true, pcm: new Uint8Array([1, 2, 3]) }]) });
    expect(await t.service.submit(alice, convertibleBody(WEBM, 'audio/webm'))).toMatchObject({
      ok: false,
      error: { code: 'AUDIO_CONVERSION_FAILED' },
    });
    expect(t.transcriber.calls).toEqual([]);
  });

  it('gives the converter min(5 s, remaining - 5 s) and aborts it at that budget', async () => {
    let signal: AbortSignal | undefined;
    const converter = new FakeAudioConverter([
      (_input, options) => {
        signal = options.signal;
        return new Promise(() => undefined); // never settles
      },
    ]);
    const t = setup({ audioConverter: converter, deadlineMs: 6_100 });
    const started = performance.now();
    const res = await t.service.submit(alice, convertibleBody(WEBM, 'audio/webm'));
    const elapsed = performance.now() - started;
    expect(res).toMatchObject({ ok: false, error: { code: 'VOICE_TIMEOUT' } });
    expect(signal?.aborted).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(3_000);
    expect(t.voiceItems()).toEqual([]);
  });

  it('returns VOICE_TIMEOUT without converting when less than 1 s would remain for conversion', async () => {
    const converter = new FakeAudioConverter([{ ok: true, pcm: PCM }]);
    const t = setup({ audioConverter: converter, deadlineMs: 5_500 });
    expect(await t.service.submit(alice, convertibleBody(WEBM, 'audio/webm'))).toMatchObject({
      ok: false,
      error: { code: 'VOICE_TIMEOUT' },
    });
    expect(converter.calls).toEqual([]);
  });
});

describe('VoiceService.confirm', () => {
  it('dispatches the corrected Transcript once, scoped to the Active_Household', async () => {
    const t = setup();
    await t.service.submit(alice, submitBody());
    const res = await t.service.confirm(alice, 'v1', { transcript: '  2 liters of milk ' });
    expect(res).toMatchObject({ ok: true, value: { voiceId: 'v1', transcript: '2 liters of milk', result: { applied: true } } });
    expect(t.dispatched).toEqual([{ type: 'fridge', scope: alice, transcript: '2 liters of milk' }]);
    expect(t.voiceItems()[0]).toMatchObject({ status: 'confirmed', confirmedTranscript: '2 liters of milk' });

    expect(await t.service.confirm(alice, 'v1', {})).toMatchObject({ ok: false, error: { code: 'VOICE_ALREADY_CONFIRMED' } });
    expect(t.dispatched).toHaveLength(1);
  });

  it('passes context fields and conversation id through to the target operation', async () => {
    const t = setup();
    await t.service.submit(alice, submitBody({ type: 'context', presets: ['quick'], sessionId: 's1' }));
    await t.service.submit(alice, submitBody({ type: 'conversation', conversationId: 'c1' }));
    await t.service.confirm(alice, 'v1', undefined);
    await t.service.confirm(alice, 'v2', undefined);
    expect(t.dispatched.map((d) => [d.type, d.transcript, d.extra])).toEqual([
      ['context', 'two liters of milk and 6 eggs', { presets: ['quick'], sessionId: 's1' }],
      ['conversation', 'two liters of milk and 6 eggs', 'c1'],
    ]);
  });

  it('treats another Household or another User as not found and dispatches nothing', async () => {
    const t = setup();
    await t.service.submit(alice, submitBody());
    expect(await t.service.confirm(mallory, 'v1', {})).toMatchObject({ ok: false, error: { code: 'VOICE_NOT_FOUND' } });
    expect(await t.service.confirm(bob, 'v1', {})).toMatchObject({ ok: false, error: { code: 'VOICE_NOT_FOUND' } });
    expect(await t.service.confirm(alice, 'nope', {})).toMatchObject({ ok: false, error: { code: 'VOICE_NOT_FOUND' } });
    expect(await t.service.confirm(alice, 'a#b', {})).toMatchObject({ ok: false, error: { code: 'VOICE_NOT_FOUND' } });
    expect(t.dispatched).toEqual([]);
  });

  it('rejects expired records', async () => {
    const t = setup();
    await t.service.submit(alice, submitBody());
    t.advance(VOICE_PENDING_TTL_SECONDS * 1000);
    expect(await t.service.confirm(alice, 'v1', {})).toMatchObject({ ok: false, error: { code: 'VOICE_EXPIRED' } });
    expect(t.dispatched).toEqual([]);
  });

  it('releases the record back to pending when the target operation rejects the input', async () => {
    const t = setup({
      dispatchResult: { ok: false, error: { code: 'no_valid_items', message: 'At least one item is required.', status: 400 } },
    });
    await t.service.submit(alice, submitBody());
    const res = await t.service.confirm(alice, 'v1', {});
    expect(res).toMatchObject({ ok: false, error: { code: 'TARGET_OPERATION_FAILED', targetError: { status: 400 } } });
    expect(t.voiceItems()[0]).toMatchObject({ status: 'pending' });
    expect(t.voiceItems()[0]!.confirmedTranscript).toBeUndefined();
  });
});

describe('dispatcher adapters', () => {
  it('fridge adapter parses the Transcript and delegates to recordFridge', async () => {
    const recorded: Ingredient[][] = [];
    const fridge = fridgeRecordingDispatch({
      recordFridge: async (_scope, items) => (recorded.push(items), { ok: true, value: { items } }),
    });
    await fridge(alice, '2 liters of milk, a dozen eggs and some cheese');
    expect(recorded).toEqual([
      [
        { name: 'milk', quantity: 2, unit: 'l' },
        { name: 'eggs', quantity: 12, unit: 'piece' },
        { name: 'cheese', quantity: 1, unit: 'piece' },
      ],
    ]);
  });

  it('context adapter sends the Transcript as contextInput and maps errors with their status', async () => {
    const bodies: unknown[] = [];
    const context = suggestionContextDispatch({
      suggest: async (_scope, body) => {
        bodies.push(body);
        return { ok: false, error: { code: 'CONTEXT_INPUT_TOO_LONG', message: 'too long' } };
      },
    });
    const out = await context(alice, 'pasta tonight', { presets: ['quick'] });
    expect(bodies).toEqual([{ presets: ['quick'], contextInput: 'pasta tonight' }]);
    expect(out).toMatchObject({ ok: false, error: { code: 'CONTEXT_INPUT_TOO_LONG', status: 400 } });
  });
});

describe('voice handlers', () => {
  it('maps submit and confirm results to HTTP responses', async () => {
    const t = setup();
    const handlers = createVoiceHandlers(t.service);
    const submitted = await handlers.submit({ body: JSON.stringify(submitBody()) }, alice);
    expect(submitted.statusCode).toBe(200);
    expect(JSON.parse(submitted.body)).toMatchObject({ voiceId: 'v1', status: 'pending' });

    expect((await handlers.submit({ body: '{' }, alice)).statusCode).toBe(400);
    expect((await handlers.confirm({ pathParameters: { id: 'v1' } }, mallory)).statusCode).toBe(404);
    expect((await handlers.confirm({ pathParameters: { id: 'v1' } }, alice)).statusCode).toBe(200);
    expect((await handlers.confirm({ pathParameters: { id: 'v1' } }, alice)).statusCode).toBe(409);
    expect(t.table.dump().find((i) => i.SK === voiceSortKey('v1'))).toMatchObject({ status: 'confirmed' });
  });
});
