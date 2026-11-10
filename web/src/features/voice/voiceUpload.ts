/**
 * Pure helpers for turning a finished recording into a `POST /voice` body
 * (Requirements 14.1, 14.2) and for the recording countdown (14.3).
 */
import type { SubmitVoiceRequest, VoiceTargetOperation } from '../../api/types';
import type { RecordingResult } from '../../voice/recorder';

/** Server MAX_TRANSCRIPT_LENGTH for a corrected Transcript. */
export const MAX_TRANSCRIPT_CODE_POINTS = 2_000;

/** Base64 without `FileReader`; chunked so large buffers don't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * PCM uploads declare `audio/pcm` at 16 kHz; fallback uploads declare the
 * container the browser recorded (`audio/ogg`, `audio/webm`, `audio/mp4`).
 */
export function buildSubmitVoiceRequest(result: RecordingResult, targetOperation: VoiceTargetOperation): SubmitVoiceRequest {
  const audio = bytesToBase64(result.bytes);
  if (result.contentType === 'audio/pcm') {
    return { audio, contentType: 'audio/pcm', sampleRateHertz: 16000, targetOperation };
  }
  return { audio, contentType: result.contentType, targetOperation };
}

/** Whole seconds left, rounded up so the countdown reads 0:30 at the start and 0:00 only at the end. */
export function secondsLeft(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** `27_400` → `0:28`. */
export function formatCountdown(remainingMs: number): string {
  const total = secondsLeft(remainingMs);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
