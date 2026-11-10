/**
 * Voice Service core (Requirements 11.1-11.7).
 *
 * POST /voice  { audio (base64), contentType, sampleRateHertz?, languageCode?, targetOperation }
 *   1. Validate the target operation and the audio before any AWS call.
 *      Accepted_Audio_Formats go straight to step 2. WebM/MP4 recordings are
 *      converted to 16 kHz mono PCM by the injected AudioConverter with a
 *      budget of min(5 s, remaining - 5 s) (14.5, 14.9); conversion failure ->
 *      AUDIO_CONVERSION_FAILED, oversized output -> AUDIO_TOO_LARGE, budget
 *      exceeded -> VOICE_TIMEOUT. Only the converted PCM is stored in S3.
 *   2. Within one 15-second budget (11.5), in parallel:
 *      - store the audio in S3 at `households/{householdId}/voice/{voiceId}`;
 *      - transcribe it with Amazon Transcribe Streaming (11.7).
 *   3. Empty/whitespace transcript or transcription failure -> VOICE_NOT_UNDERSTOOD
 *      with a retry prompt (11.4); budget exceeded -> VOICE_TIMEOUT (11.5).
 *   4. On success, write a pending VOICE#{voiceId} record in the
 *      Active_Household partition and return the Transcript for confirmation.
 *      Nothing is applied to any target operation yet (11.3).
 *
 *   Failed attempts write no VOICE record and change no stored data. The only
 *   possible side effect is the audio object, which may already be in S3; it
 *   is never read back and the bucket lifecycle rule expires it.
 *
 * POST /voice/{id}/confirm  { transcript? }
 *   1. Load VOICE#{id} from the Active_Household partition only (11.6). A
 *      record of another Household, or of another User in this Household, is
 *      reported as not found.
 *   2. Reject unless status is pending and the record has not expired.
 *   3. Claim the record (status -> confirmed) with a version-conditional write,
 *      so a Transcript is applied at most once even under concurrent confirms.
 *   4. Dispatch the confirmed Transcript (the User's correction, if supplied)
 *      to the target operation as equivalent typed input (11.1).
 *   5. If the target operation rejects the input, the claim is released
 *      (status back to pending) so the User can correct and confirm again.
 */
import { randomUUID } from 'node:crypto';

import { assertKeyComponent, InvalidKeyError } from '../../data/keys.js';
import type { HouseholdRepository, StoredRecord } from '../../data/repository.js';
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { HouseholdId } from '../../domain/types.js';
import { MAX_AUDIO_BYTES, validateIncomingAudio, type ConvertibleAudio, type ValidatedAudio } from '../../voice/audio.js';
import type { AudioConverter } from '../../voice/audioConverter.js';
import { audioObjectKey, type AudioStore } from '../../voice/audioStore.js';
import type { Transcriber } from '../../voice/transcriber.js';
import type { DispatchError, DispatchOutcome, TranscriptDispatcher } from './dispatcher.js';
import { validateTargetOperation, type TargetOperation } from './targets.js';

/** Voice_Input bound: Transcript or error within 15 seconds (Requirement 11.5). */
export const VOICE_DEADLINE_MS = 15_000;
/** A pending Transcript can be confirmed for this long. */
export const VOICE_PENDING_TTL_SECONDS = 60 * 60;
/** DynamoDB TTL attribute on VOICE# items (epoch seconds). */
export const VOICE_TTL_ATTRIBUTE = 'ttl';
/** Maximum length of a confirmed (possibly corrected) Transcript. */
export const MAX_TRANSCRIPT_LENGTH = 2_000;
export const DEFAULT_LANGUAGE_CODE = 'en-US';
/** Upper bound on server-side audio conversion (Requirement 14.9). */
export const MAX_CONVERSION_MS = 5_000;
/** Time kept back from the 15 s deadline for upload + transcription after conversion. */
export const POST_CONVERSION_RESERVE_MS = 5_000;
/** Conversion is not attempted when less than this would be available for it. */
export const MIN_CONVERSION_MS = 1_000;
/** Converted PCM is always 16 kHz mono 16-bit little-endian. */
export const CONVERTED_SAMPLE_RATE_HZ = 16_000;

export const VOICE_SORT_KEY_PREFIX = 'VOICE#';

/** Sort key of a Voice_Input record within a Household partition. */
export function voiceSortKey(voiceId: string): string {
  return VOICE_SORT_KEY_PREFIX + assertKeyComponent('voiceId', voiceId);
}

export const RETRY_PROMPT = 'Please try recording again.';

export type VoiceErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_AUDIO'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_CONVERSION_FAILED'
  | 'VOICE_NOT_UNDERSTOOD'
  | 'VOICE_TIMEOUT'
  | 'AUDIO_UPLOAD_FAILED'
  | 'SAVE_DID_NOT_COMPLETE'
  | 'VOICE_NOT_FOUND'
  | 'VOICE_ALREADY_CONFIRMED'
  | 'VOICE_EXPIRED'
  | 'TARGET_OPERATION_FAILED';

export interface VoiceError {
  code: VoiceErrorCode;
  message: string;
  /** True when the User should record again (11.4, 11.5). */
  retry?: boolean;
  /** Present for TARGET_OPERATION_FAILED: the target operation's own error. */
  targetError?: DispatchError;
  details?: unknown;
}

export type VoiceFailure = { ok: false; error: VoiceError };

export type VoiceStatus = 'pending' | 'confirmed';

export interface VoiceRecord extends Record<string, unknown> {
  voiceId: string;
  householdId: HouseholdId;
  createdByUserId: string;
  transcript: string;
  targetOperation: TargetOperation;
  status: VoiceStatus;
  audioKey: string;
  contentType: string;
  languageCode: string;
  createdAt: string;
  /** ISO time after which the record can no longer be confirmed. */
  expiresAt: string;
  ttl: number;
  confirmedTranscript?: string;
  confirmedAt?: string;
}

export interface PendingTranscript {
  voiceId: string;
  transcript: string;
  targetOperation: TargetOperation;
  status: 'pending';
  expiresAt: string;
}

export type SubmitVoiceResult = { ok: true; value: PendingTranscript } | VoiceFailure;

export type ConfirmVoiceResult =
  | {
      ok: true;
      value: { voiceId: string; transcript: string; targetOperation: TargetOperation; result: unknown };
    }
  | VoiceFailure;

export interface VoiceServiceDeps {
  /** Returns a repository bound to the given (already authorized) Household. */
  repositoryFor: (householdId: HouseholdId) => HouseholdRepository;
  transcriber: Transcriber;
  audioStore: AudioStore;
  dispatcher: TranscriptDispatcher;
  /**
   * Converts WebM/MP4 recordings to 16 kHz mono PCM (Requirement 14.5). When
   * absent, Convertible_Audio_Formats are rejected as UNSUPPORTED_AUDIO.
   */
  audioConverter?: AudioConverter;
  /** Milliseconds since the epoch. */
  now?: () => number;
  newId?: () => string;
  /** Defaults to and may not exceed VOICE_DEADLINE_MS. */
  deadlineMs?: number;
}

const fail = (code: VoiceErrorCode, message: string, extra: Partial<VoiceError> = {}): VoiceFailure => ({
  ok: false,
  error: { code, message, ...extra },
});

const notUnderstood = (): VoiceFailure =>
  fail('VOICE_NOT_UNDERSTOOD', `The voice input could not be understood. ${RETRY_PROMPT}`, { retry: true });

const timedOut = (deadlineMs: number): VoiceFailure =>
  fail('VOICE_TIMEOUT', `The voice input was not transcribed within ${deadlineMs / 1000} seconds. ${RETRY_PROMPT}`, {
    retry: true,
  });

const conversionFailed = (): VoiceFailure =>
  fail('AUDIO_CONVERSION_FAILED', `The recording could not be processed. ${RETRY_PROMPT}`, { retry: true });

const LANGUAGE_CODE = /^[a-z]{2}-[A-Z]{2}$/;

function asObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function isValidVoiceId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 128 || id.includes('/')) return false;
  try {
    assertKeyComponent('voiceId', id);
    return true;
  } catch (err) {
    if (err instanceof InvalidKeyError) return false;
    throw err;
  }
}

export class VoiceService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly deadlineMs: number;

  constructor(private readonly deps: VoiceServiceDeps) {
    const deadline = deps.deadlineMs ?? VOICE_DEADLINE_MS;
    if (!Number.isFinite(deadline) || deadline <= 0 || deadline > VOICE_DEADLINE_MS) {
      throw new RangeError(`deadlineMs must be in (0, ${VOICE_DEADLINE_MS}]`);
    }
    this.deadlineMs = deadline;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  private repo(scope: ActiveHouseholdScope): HouseholdRepository {
    const repo = this.deps.repositoryFor(scope.householdId);
    if (repo.householdId !== scope.householdId) {
      throw new Error('repositoryFor returned a repository bound to a different Household');
    }
    return repo;
  }

  /** POST /voice: store and transcribe audio; return the Transcript for confirmation. */
  async submit(scope: ActiveHouseholdScope, body: unknown): Promise<SubmitVoiceResult> {
    const startedAt = this.now();
    const b = asObject(body);
    if (!b) return fail('INVALID_REQUEST', 'The request body must be a JSON object.');

    const target = validateTargetOperation(b.targetOperation);
    if (!target.ok) {
      return fail('INVALID_REQUEST', target.error.message, { details: { targetError: target.error } });
    }
    const incoming = validateIncomingAudio({
      audioBase64: b.audio,
      contentType: b.contentType,
      sampleRateHertz: b.sampleRateHertz,
    });
    if (!incoming.ok) return fail(incoming.error.code, incoming.error.message);
    const languageCode = b.languageCode ?? DEFAULT_LANGUAGE_CODE;
    if (typeof languageCode !== 'string' || !LANGUAGE_CODE.test(languageCode)) {
      return fail('INVALID_REQUEST', 'languageCode must look like en-US.');
    }

    // --- Convert WebM/MP4 to PCM within the same 15s budget (14.5, 14.9) --
    // Accepted formats bypass the converter entirely. Only the converted PCM
    // is uploaded to S3; the original container bytes are never stored.
    let audio: ValidatedAudio;
    if ('convertible' in incoming) {
      const converted = await this.convert(incoming.convertible, startedAt);
      if (!converted.ok) return converted;
      audio = converted.audio;
    } else {
      audio = incoming.audio;
    }

    const repo = this.repo(scope);
    const voiceId = this.newId();
    const sk = voiceSortKey(voiceId);
    const audioKey = audioObjectKey(scope.householdId, voiceId);

    // --- Upload + transcribe within the 15s budget ------------------------
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, this.deadlineMs - (this.now() - startedAt)));
    });
    const signal = controller.signal;
    const upload = this.deps.audioStore
      .put({ key: audioKey, body: audio.bytes, contentType: audio.contentType }, { signal })
      .then(
        () => ({ ok: true as const }),
        () => ({ ok: false as const }),
      );
    const transcription = this.deps.transcriber
      .transcribe(
        {
          audio: audio.bytes,
          encoding: audio.encoding,
          sampleRateHertz: audio.sampleRateHertz,
          languageCode,
        },
        { signal },
      )
      .then(
        (text) => ({ ok: true as const, text }),
        () => ({ ok: false as const }),
      );

    let outcome: 'timeout' | [Awaited<typeof upload>, Awaited<typeof transcription>];
    try {
      outcome = await Promise.race([Promise.all([upload, transcription]), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'timeout') {
      controller.abort();
      return timedOut(this.deadlineMs);
    }
    const [uploaded, transcribed] = outcome;
    if (this.now() - startedAt > this.deadlineMs) return timedOut(this.deadlineMs);
    if (!transcribed.ok) return notUnderstood();
    const transcript = transcribed.text.replace(/\s+/g, ' ').trim();
    if (transcript.length === 0) return notUnderstood();
    if (!uploaded.ok) {
      return fail('AUDIO_UPLOAD_FAILED', `The voice input could not be saved. ${RETRY_PROMPT}`, { retry: true });
    }

    // --- Persist the pending Transcript -----------------------------------
    const createdAtMs = startedAt;
    const expiresAtMs = createdAtMs + VOICE_PENDING_TTL_SECONDS * 1000;
    const record: VoiceRecord = {
      voiceId,
      householdId: scope.householdId,
      createdByUserId: scope.userId,
      transcript,
      targetOperation: target.target,
      status: 'pending',
      audioKey,
      contentType: audio.contentType,
      languageCode,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      [VOICE_TTL_ATTRIBUTE]: Math.floor(expiresAtMs / 1000),
    };
    const write = await repo.create(sk, record);
    if (!write.ok) return fail('SAVE_DID_NOT_COMPLETE', write.error.message);

    return {
      ok: true,
      value: { voiceId, transcript, targetOperation: target.target, status: 'pending', expiresAt: record.expiresAt },
    };
  }

  /** POST /voice/{id}/confirm: apply the confirmed Transcript to its target operation. */
  async confirm(scope: ActiveHouseholdScope, voiceId: unknown, body: unknown): Promise<ConfirmVoiceResult> {
    const notFound = fail('VOICE_NOT_FOUND', 'The voice input was not found.');
    if (!isValidVoiceId(voiceId)) return notFound;

    const b = body === undefined || body === null ? {} : asObject(body);
    if (!b) return fail('INVALID_REQUEST', 'The request body must be a JSON object.');
    let correction: string | undefined;
    if (b.transcript !== undefined && b.transcript !== null) {
      if (typeof b.transcript !== 'string') return fail('INVALID_REQUEST', 'transcript must be a string.');
      correction = b.transcript.replace(/\s+/g, ' ').trim();
      if (correction.length === 0) return fail('INVALID_REQUEST', 'The corrected transcript must not be empty.');
      if (correction.length > MAX_TRANSCRIPT_LENGTH) {
        return fail('INVALID_REQUEST', `The transcript must be at most ${MAX_TRANSCRIPT_LENGTH} characters.`);
      }
    }

    const repo = this.repo(scope);
    const stored: StoredRecord<VoiceRecord> | undefined = await repo.get<VoiceRecord>(voiceSortKey(voiceId));
    if (
      !stored ||
      stored.attributes.householdId !== scope.householdId ||
      stored.attributes.createdByUserId !== scope.userId
    ) {
      return notFound;
    }
    const record = stored.attributes;
    if (record.status !== 'pending') {
      return fail('VOICE_ALREADY_CONFIRMED', 'This voice input has already been confirmed.');
    }
    const nowMs = this.now();
    if (nowMs >= Date.parse(record.expiresAt)) {
      return fail('VOICE_EXPIRED', `This voice input has expired. ${RETRY_PROMPT}`, { retry: true });
    }

    const transcript = correction ?? record.transcript;
    const confirmed: VoiceRecord = {
      ...record,
      status: 'confirmed',
      confirmedTranscript: transcript,
      confirmedAt: new Date(nowMs).toISOString(),
    };
    const claim = await repo.replaceIfVersion(stored.sk, stored.version, confirmed);
    if (!claim.ok) {
      // Either a concurrent confirm won, or the write failed; re-read to tell.
      const current = await repo.get<VoiceRecord>(stored.sk).catch(() => undefined);
      return current?.attributes.status === 'confirmed'
        ? fail('VOICE_ALREADY_CONFIRMED', 'This voice input has already been confirmed.')
        : fail('SAVE_DID_NOT_COMPLETE', claim.error.message);
    }

    const target = record.targetOperation;
    let outcome: DispatchOutcome;
    try {
      outcome = await this.dispatch(scope, target, transcript);
    } catch (err) {
      await this.release(repo, stored, record);
      throw err;
    }
    if (!outcome.ok) {
      await this.release(repo, stored, record);
      return fail('TARGET_OPERATION_FAILED', outcome.error.message, { targetError: outcome.error });
    }
    return { ok: true, value: { voiceId, transcript, targetOperation: target, result: outcome.value } };
  }

  /**
   * Converts a WebM/MP4 recording to 16 kHz mono PCM with a budget of
   * min(5 s, remaining − 5 s), leaving time for upload and transcription.
   * Nothing is stored on any failure.
   */
  private async convert(
    input: ConvertibleAudio,
    startedAt: number,
  ): Promise<{ ok: true; audio: ValidatedAudio } | VoiceFailure> {
    const converter = this.deps.audioConverter;
    if (converter === undefined) return fail('UNSUPPORTED_AUDIO', 'Audio must be Ogg/Opus, FLAC, or 16-bit PCM.');

    const remaining = this.deadlineMs - (this.now() - startedAt);
    const budget = Math.min(MAX_CONVERSION_MS, remaining - POST_CONVERSION_RESERVE_MS);
    if (budget < MIN_CONVERSION_MS) return timedOut(this.deadlineMs);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budget);
    });
    let result: Awaited<ReturnType<AudioConverter['convert']>> | 'timeout';
    try {
      result = await Promise.race([
        converter
          .convert(
            { bytes: input.bytes, container: input.container },
            { signal: controller.signal, maxOutputBytes: MAX_AUDIO_BYTES },
          )
          .catch(() => ({ ok: false as const, reason: 'failed' as const })),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (result === 'timeout') {
      controller.abort();
      return timedOut(this.deadlineMs);
    }
    if (!result.ok) {
      switch (result.reason) {
        case 'too_large':
          return fail('AUDIO_TOO_LARGE', `The converted audio must be at most ${MAX_AUDIO_BYTES} bytes. ${RETRY_PROMPT}`, {
            retry: true,
          });
        case 'timeout':
          return timedOut(this.deadlineMs);
        default:
          return conversionFailed();
      }
    }
    // Defensive: never pass malformed PCM to transcription (Property 50).
    const { pcm } = result;
    if (pcm.length > MAX_AUDIO_BYTES) {
      return fail('AUDIO_TOO_LARGE', `The converted audio must be at most ${MAX_AUDIO_BYTES} bytes. ${RETRY_PROMPT}`, {
        retry: true,
      });
    }
    if (pcm.length === 0 || pcm.length % 2 !== 0) return conversionFailed();
    return {
      ok: true,
      audio: { bytes: pcm, encoding: 'pcm', sampleRateHertz: CONVERTED_SAMPLE_RATE_HZ, contentType: 'audio/pcm' },
    };
  }

  private dispatch(scope: ActiveHouseholdScope, target: TargetOperation, transcript: string): Promise<DispatchOutcome> {
    const { dispatcher } = this.deps;
    switch (target.type) {
      case 'fridge':
        return dispatcher.fridge(scope, transcript);
      case 'context': {
        const { type: _type, ...fields } = target;
        return dispatcher.context(scope, transcript, fields);
      }
      case 'conversation':
        return dispatcher.conversation(scope, transcript, target.conversationId);
    }
  }

  /** Best-effort: return a claimed record to pending after the target operation rejected it. */
  private async release(
    repo: HouseholdRepository,
    claimed: StoredRecord<VoiceRecord>,
    original: VoiceRecord,
  ): Promise<void> {
    await repo.replaceIfVersion(claimed.sk, claimed.version + 1, { ...original }).catch(() => undefined);
  }
}
