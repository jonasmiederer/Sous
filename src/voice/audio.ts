/**
 * Voice_Input audio validation (Requirements 11.1, 11.4, 14.4, 14.6, 14.7).
 *
 * Accepted_Audio_Formats are encodings Amazon Transcribe Streaming accepts
 * directly. They go to transcription without conversion:
 *
 *   content type                              encoding   default sample rate
 *   audio/ogg (codecs=opus or none), audio/opus  ogg-opus   48000
 *   audio/flac, audio/x-flac                     flac       16000
 *   audio/pcm, audio/l16 (16-bit LE mono)        pcm        16000
 *
 * Convertible_Audio_Formats are containers some browsers record when they
 * cannot encode PCM themselves. The Voice Service converts them server-side
 * (ffmpeg, see audioConverter.ts) to 16 kHz mono 16-bit LE PCM:
 *
 *   audio/webm, video/webm      -> webm (EBML header 1A 45 DF A3)
 *   audio/mp4, audio/x-m4a      -> mp4  ('ftyp' at bytes 4-7)
 *
 * All payloads are checked for their magic bytes, so a mislabelled file is
 * rejected before transcription and before any conversion process starts.
 * Any other content type is rejected as unsupported.
 */

export type AudioEncoding = 'pcm' | 'ogg-opus' | 'flac';
/** Convertible_Audio_Format containers (converted server-side, see audioConverter.ts). */
export type AudioContainer = 'webm' | 'mp4';

/** Max decoded audio size. ~30s of 16 kHz 16-bit PCM; far longer for Opus/FLAC. */
export const MAX_AUDIO_BYTES = 1_000_000;
export const MIN_SAMPLE_RATE_HZ = 8_000;
export const MAX_SAMPLE_RATE_HZ = 48_000;

const DEFAULT_SAMPLE_RATE: Readonly<Record<AudioEncoding, number>> = {
  'ogg-opus': 48_000,
  flac: 16_000,
  pcm: 16_000,
};

export interface ValidatedAudio {
  bytes: Uint8Array;
  /** Normalized content type stored with the S3 object. */
  contentType: string;
  encoding: AudioEncoding;
  sampleRateHertz: number;
}

export interface ConvertibleAudio {
  bytes: Uint8Array;
  container: AudioContainer;
}

export type AudioValidationErrorCode = 'INVALID_REQUEST' | 'UNSUPPORTED_AUDIO' | 'AUDIO_TOO_LARGE';

type AudioValidationError = { ok: false; error: { code: AudioValidationErrorCode; message: string } };

export type AudioValidationResult = { ok: true; audio: ValidatedAudio } | AudioValidationError;

export type IncomingAudioValidationResult =
  | { ok: true; audio: ValidatedAudio }
  | { ok: true; convertible: ConvertibleAudio }
  | AudioValidationError;

export type ContentTypeClass =
  | { kind: 'accepted'; encoding: AudioEncoding }
  | { kind: 'convertible'; container: AudioContainer };

function parseContentType(contentType: string): { rawType: string; params: string[] } {
  const [rawType = '', ...params] = contentType.toLowerCase().split(';').map((p) => p.trim());
  return { rawType, params };
}

/** Maps a Content-Type to a Transcribe Streaming encoding, or undefined if not allowed. */
export function encodingForContentType(contentType: string): AudioEncoding | undefined {
  const { rawType, params } = parseContentType(contentType);
  const codecs = params.find((p) => p.startsWith('codecs='))?.slice('codecs='.length).replace(/"/g, '');
  switch (rawType) {
    case 'audio/ogg':
      return codecs === undefined || codecs === 'opus' ? 'ogg-opus' : undefined;
    case 'audio/opus':
      return 'ogg-opus';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    case 'audio/pcm':
    case 'audio/l16':
      return 'pcm';
    default:
      return undefined;
  }
}

/** Maps a Content-Type to a Convertible_Audio_Format container, or undefined. Parameters are ignored. */
function containerForContentType(contentType: string): AudioContainer | undefined {
  switch (parseContentType(contentType).rawType) {
    case 'audio/webm':
    case 'video/webm':
      return 'webm';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'mp4';
    default:
      return undefined;
  }
}

/**
 * Classifies a declared Content-Type as an Accepted_Audio_Format (with its
 * Transcribe encoding), a Convertible_Audio_Format (with its container), or
 * neither (undefined).
 */
export function classifyContentType(contentType: string): ContentTypeClass | undefined {
  const encoding = encodingForContentType(contentType);
  if (encoding !== undefined) return { kind: 'accepted', encoding };
  const container = containerForContentType(contentType);
  if (container !== undefined) return { kind: 'convertible', container };
  return undefined;
}

function hasMagic(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

function hasContainerMagic(bytes: Uint8Array, container: AudioContainer): boolean {
  if (container === 'webm') {
    return bytes.length >= EBML_MAGIC.length && EBML_MAGIC.every((b, i) => bytes[i] === b);
  }
  // ISO BMFF: 4-byte box size, then the 'ftyp' box type at bytes 4-7.
  return bytes.length >= 8 && hasMagic(bytes.subarray(4, 8), 'ftyp');
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const invalid = (code: AudioValidationErrorCode, message: string): AudioValidationError => ({
  ok: false,
  error: { code, message },
});

/** Decodes non-empty base64 audio, enforcing MAX_AUDIO_BYTES before and after decoding. */
function decodeAudio(audioBase64: unknown): { ok: true; bytes: Uint8Array } | AudioValidationError {
  if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
    return invalid('INVALID_REQUEST', 'audio must be a non-empty base64 string.');
  }
  // Reject before decoding so an oversized body costs no allocation.
  if (Math.floor((audioBase64.length * 3) / 4) > MAX_AUDIO_BYTES + 2) {
    return invalid('AUDIO_TOO_LARGE', `Audio must be at most ${MAX_AUDIO_BYTES} bytes.`);
  }
  if (!BASE64.test(audioBase64)) {
    return invalid('INVALID_REQUEST', 'audio must be a non-empty base64 string.');
  }
  const bytes = new Uint8Array(Buffer.from(audioBase64, 'base64'));
  if (bytes.length === 0) return invalid('INVALID_REQUEST', 'audio must be a non-empty base64 string.');
  if (bytes.length > MAX_AUDIO_BYTES) {
    return invalid('AUDIO_TOO_LARGE', `Audio must be at most ${MAX_AUDIO_BYTES} bytes.`);
  }
  return { ok: true, bytes };
}

function validateAccepted(
  encoding: AudioEncoding,
  input: { audioBase64: unknown; sampleRateHertz?: unknown },
): AudioValidationResult {
  const decoded = decodeAudio(input.audioBase64);
  if (!decoded.ok) return decoded;
  const { bytes } = decoded;
  if (encoding === 'ogg-opus' && !hasMagic(bytes, 'OggS')) {
    return invalid('UNSUPPORTED_AUDIO', 'The audio is not a valid Ogg file.');
  }
  if (encoding === 'flac' && !hasMagic(bytes, 'fLaC')) {
    return invalid('UNSUPPORTED_AUDIO', 'The audio is not a valid FLAC file.');
  }

  let sampleRateHertz = DEFAULT_SAMPLE_RATE[encoding];
  if (input.sampleRateHertz !== undefined && input.sampleRateHertz !== null) {
    const rate = input.sampleRateHertz;
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < MIN_SAMPLE_RATE_HZ || rate > MAX_SAMPLE_RATE_HZ) {
      return invalid(
        'INVALID_REQUEST',
        `sampleRateHertz must be an integer between ${MIN_SAMPLE_RATE_HZ} and ${MAX_SAMPLE_RATE_HZ}.`,
      );
    }
    sampleRateHertz = rate;
  }

  const contentType = encoding === 'ogg-opus' ? 'audio/ogg' : encoding === 'flac' ? 'audio/flac' : 'audio/pcm';
  return { ok: true, audio: { bytes, contentType, encoding, sampleRateHertz } };
}

/**
 * Validates base64-encoded audio plus its declared content type and optional
 * sample rate. Only Accepted_Audio_Formats pass. Rejects empty, oversized,
 * unsupported, or mislabelled audio.
 */
export function validateAudio(input: {
  audioBase64: unknown;
  contentType: unknown;
  sampleRateHertz?: unknown;
}): AudioValidationResult {
  if (typeof input.contentType !== 'string' || input.contentType.trim() === '') {
    return invalid('INVALID_REQUEST', 'contentType is required.');
  }
  const encoding = encodingForContentType(input.contentType);
  if (encoding === undefined) {
    return invalid('UNSUPPORTED_AUDIO', 'Audio must be Ogg/Opus, FLAC, or 16-bit PCM.');
  }
  return validateAccepted(encoding, input);
}

/**
 * Validates an incoming Voice_Input that may be an Accepted_Audio_Format or a
 * Convertible_Audio_Format. Accepted formats get exactly the `validateAudio`
 * checks and result. Convertible formats get the same base64 and size checks
 * plus a container magic-byte check, and return the raw bytes and detected
 * container for conversion. `sampleRateHertz` is ignored for convertible input.
 */
export function validateIncomingAudio(input: {
  audioBase64: unknown;
  contentType: unknown;
  sampleRateHertz?: unknown;
}): IncomingAudioValidationResult {
  if (typeof input.contentType !== 'string' || input.contentType.trim() === '') {
    return invalid('INVALID_REQUEST', 'contentType is required.');
  }
  const cls = classifyContentType(input.contentType);
  if (cls === undefined) {
    return invalid('UNSUPPORTED_AUDIO', 'Audio must be Ogg/Opus, FLAC, 16-bit PCM, WebM, or MP4.');
  }
  if (cls.kind === 'accepted') return validateAccepted(cls.encoding, input);

  const decoded = decodeAudio(input.audioBase64);
  if (!decoded.ok) return decoded;
  if (!hasContainerMagic(decoded.bytes, cls.container)) {
    return invalid(
      'UNSUPPORTED_AUDIO',
      cls.container === 'webm' ? 'The audio is not a valid WebM file.' : 'The audio is not a valid MP4 file.',
    );
  }
  return { ok: true, convertible: { bytes: decoded.bytes, container: cls.container } };
}
