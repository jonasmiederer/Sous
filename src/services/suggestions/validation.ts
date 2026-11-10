/**
 * Request validation for POST /suggestions. Runs before any storage read or
 * agent invocation, so rejected requests never reach generation
 * (Requirements 4.2, 5.5, 5.6).
 *
 * Request body:
 *   {
 *     sessionId?: string,              // omit to start a new request session
 *     contextInput?: string,           // <= 500 characters (Unicode code points)
 *     presets?: string[],              // subset of the four named Presets
 *     rejectedSuggestionIds?: string[] // ids of this session's suggestions the User rejected
 *   }
 */
import { assertKeyComponent, InvalidKeyError } from '../../data/keys.js';
import { validatePresets } from '../../domain/presets.js';
import type { Preset, SessionId, SuggestionId } from '../../domain/types.js';
import type { SuggestionError } from './errors.js';

export const MAX_CONTEXT_INPUT_LENGTH = 500;
/** Bounded so marking rejections fits in one DynamoDB transaction (100 items). */
export const MAX_REJECTED_IDS_PER_REQUEST = 50;
const MAX_ID_LENGTH = 128;

export interface AdHocSuggestionRequest {
  sessionId?: SessionId;
  contextInput?: string;
  presets?: readonly unknown[];
  rejectedSuggestionIds?: readonly SuggestionId[];
}

export interface ValidatedAdHocRequest {
  /** Absent when the caller starts a new session. */
  sessionId?: SessionId;
  /** Absent when no Context_Input (or only whitespace) was submitted. */
  contextInput?: string;
  presets: Preset[];
  rejectedSuggestionIds: SuggestionId[];
}

export type ValidationResult = { ok: true; value: ValidatedAdHocRequest } | { ok: false; error: SuggestionError };

/** Length in Unicode code points, so an emoji counts as one character. */
export function characterLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

function invalid(message: string): ValidationResult {
  return { ok: false, error: { code: 'INVALID_REQUEST', message } };
}

function isValidId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH) return false;
  try {
    assertKeyComponent('id', value);
    return true;
  } catch (err) {
    if (err instanceof InvalidKeyError) return false;
    throw err;
  }
}

/**
 * Validates the raw (already JSON-decoded) request body. Order: shape,
 * Context_Input length, then Presets (unrecognized before conflict).
 */
export function validateAdHocRequest(body: unknown): ValidationResult {
  if (body === undefined || body === null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) return invalid('The request body must be a JSON object.');
  const b = body as Record<string, unknown>;

  if (b.sessionId !== undefined && !isValidId(b.sessionId)) {
    return invalid(`sessionId must be a non-empty string of at most ${MAX_ID_LENGTH} characters without '#'.`);
  }
  if (b.contextInput !== undefined && b.contextInput !== null && typeof b.contextInput !== 'string') {
    return invalid('contextInput must be a string.');
  }
  if (b.presets !== undefined && b.presets !== null && !Array.isArray(b.presets)) {
    return invalid('presets must be an array of preset names.');
  }
  const rejected = b.rejectedSuggestionIds ?? [];
  if (!Array.isArray(rejected) || !rejected.every(isValidId)) {
    return invalid('rejectedSuggestionIds must be an array of suggestion ids.');
  }
  if (rejected.length > MAX_REJECTED_IDS_PER_REQUEST) {
    return invalid(`At most ${MAX_REJECTED_IDS_PER_REQUEST} rejected suggestions can be sent per request.`);
  }
  if (rejected.length > 0 && b.sessionId === undefined) {
    return invalid('rejectedSuggestionIds requires the sessionId of the session they belong to.');
  }

  const contextInput = typeof b.contextInput === 'string' ? b.contextInput : undefined;
  if (contextInput !== undefined && characterLength(contextInput) > MAX_CONTEXT_INPUT_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'CONTEXT_INPUT_TOO_LONG',
        message: `Context input must be at most ${MAX_CONTEXT_INPUT_LENGTH} characters.`,
        details: { maxLength: MAX_CONTEXT_INPUT_LENGTH, length: characterLength(contextInput) },
      },
    };
  }

  const presetResult = validatePresets((b.presets as unknown[] | null | undefined) ?? []);
  if (!presetResult.ok) {
    const { error } = presetResult;
    return {
      ok: false,
      error:
        error.code === 'UNRECOGNIZED_PRESET'
          ? { code: 'UNRECOGNIZED_PRESET', message: error.message, details: { unrecognized: error.unrecognized } }
          : { code: 'PRESET_CONFLICT', message: error.message, details: { conflicts: error.conflicts } },
    };
  }

  const value: ValidatedAdHocRequest = {
    presets: presetResult.presets,
    rejectedSuggestionIds: [...new Set(rejected as string[])],
  };
  if (typeof b.sessionId === 'string') value.sessionId = b.sessionId;
  if (contextInput !== undefined && contextInput.trim().length > 0) value.contextInput = contextInput;
  return { ok: true, value };
}
