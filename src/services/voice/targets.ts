/**
 * Target operations a Voice_Input can feed (Requirement 11.2), validated at
 * `POST /voice` time so an invalid target fails before any transcription.
 *
 *   { type: 'fridge' }
 *   { type: 'context', sessionId?, presets?, rejectedSuggestionIds? }
 *       -> the suggestion request; the Transcript becomes `contextInput`
 *   { type: 'conversation', conversationId }
 */
import { assertKeyComponent, InvalidKeyError } from '../../data/keys.js';
import { validateAdHocRequest } from '../suggestions/validation.js';

export interface ContextTargetFields {
  sessionId?: string;
  presets?: string[];
  rejectedSuggestionIds?: string[];
}

export type TargetOperation =
  | { type: 'fridge' }
  | ({ type: 'context' } & ContextTargetFields)
  | { type: 'conversation'; conversationId: string };

export type TargetValidation =
  | { ok: true; target: TargetOperation }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

const MAX_ID_LENGTH = 128;

function isId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH) return false;
  try {
    assertKeyComponent('id', value);
    return true;
  } catch (err) {
    if (err instanceof InvalidKeyError) return false;
    throw err;
  }
}

const invalid = (message: string): TargetValidation => ({ ok: false, error: { code: 'INVALID_REQUEST', message } });

export function validateTargetOperation(raw: unknown): TargetValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid("targetOperation must be an object with type 'fridge', 'context', or 'conversation'.");
  }
  const t = raw as Record<string, unknown>;
  switch (t.type) {
    case 'fridge':
      return { ok: true, target: { type: 'fridge' } };
    case 'conversation':
      return isId(t.conversationId)
        ? { ok: true, target: { type: 'conversation', conversationId: t.conversationId } }
        : invalid('targetOperation.conversationId must be a valid conversation id.');
    case 'context': {
      if (t.contextInput !== undefined) {
        return invalid('targetOperation must not include contextInput; the Transcript is the context input.');
      }
      const fields: ContextTargetFields = {};
      if (t.sessionId !== undefined) fields.sessionId = t.sessionId as string;
      if (t.presets !== undefined) fields.presets = t.presets as string[];
      if (t.rejectedSuggestionIds !== undefined) fields.rejectedSuggestionIds = t.rejectedSuggestionIds as string[];
      // Same validation the typed request gets (shape, presets, ids), minus the transcript.
      const check = validateAdHocRequest(fields);
      if (!check.ok) {
        const { code, message, details } = check.error;
        return { ok: false, error: details === undefined ? { code, message } : { code, message, details } };
      }
      const target: TargetOperation = { type: 'context' };
      if (check.value.sessionId !== undefined) target.sessionId = check.value.sessionId;
      if (check.value.presets.length > 0) target.presets = [...check.value.presets];
      if (check.value.rejectedSuggestionIds.length > 0) target.rejectedSuggestionIds = [...check.value.rejectedSuggestionIds];
      return { ok: true, target };
    }
    default:
      return invalid("targetOperation.type must be 'fridge', 'context', or 'conversation'.");
  }
}
