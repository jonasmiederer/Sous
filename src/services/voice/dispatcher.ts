/**
 * TranscriptDispatcher: applies a confirmed Transcript to its target
 * operation as the equivalent typed input (Requirements 11.1, 11.2).
 *
 * One function per target type. Each receives the authorized
 * Active_Household scope, so the target operation is scoped exactly as a
 * typed request from the same User would be (Requirement 11.6).
 *
 * Adapters:
 * - context:      SuggestionService.suggest(scope, { ...fields, contextInput: transcript })
 * - conversation: ConversationService.sendMessage(conversationId, transcript)
 * - fridge:       parse the transcript into items (pluggable parser), then
 *                 delegate to an injected `recordFridge(scope, items)`. That
 *                 function is the Fridge Service's typed `PUT /fridge` entry
 *                 point (task 11.1) and is wired in at composition time; the
 *                 Fridge Service performs its own validation, including the
 *                 zero-valid-items rejection that preserves the prior
 *                 inventory (Requirement 4.4).
 *
 * Dispatch outcomes carry an optional HTTP status hint taken from the target
 * service's own status table, so a voice-confirmed request fails the same way
 * the typed request would.
 */
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { Ingredient } from '../../domain/types.js';
import { ERROR_STATUS as CONVERSATION_ERROR_STATUS, type ConversationServiceFactory } from '../conversations/handlers.js';
import { SUGGESTION_ERROR_STATUS } from '../suggestions/errors.js';
import type { SuggestionService } from '../suggestions/suggestionService.js';
import { parseFridgeTranscript, type FridgeTranscriptParser } from './fridgeParser.js';
import type { ContextTargetFields } from './targets.js';

export interface DispatchError {
  code: string;
  message: string;
  /** HTTP status the typed request would have returned. */
  status?: number;
  details?: unknown;
}

export type DispatchOutcome = { ok: true; value: unknown } | { ok: false; error: DispatchError };

export interface TranscriptDispatcher {
  fridge(scope: ActiveHouseholdScope, transcript: string): Promise<DispatchOutcome>;
  context(scope: ActiveHouseholdScope, transcript: string, fields: ContextTargetFields): Promise<DispatchOutcome>;
  conversation(scope: ActiveHouseholdScope, transcript: string, conversationId: string): Promise<DispatchOutcome>;
}

/** Context_Input adapter over the Suggestion Service. */
export function suggestionContextDispatch(service: Pick<SuggestionService, 'suggest'>): TranscriptDispatcher['context'] {
  return async (scope, transcript, fields) => {
    const result = await service.suggest(scope, { ...fields, contextInput: transcript });
    if (result.ok) return { ok: true, value: result.value };
    const { code, message, ...rest } = result.error;
    return { ok: false, error: { code, message, status: SUGGESTION_ERROR_STATUS[code], details: rest } };
  };
}

/** Conversation refinement adapter over the Conversation Service. */
export function conversationMessageDispatch(factory: ConversationServiceFactory): TranscriptDispatcher['conversation'] {
  return async (scope, transcript, conversationId) => {
    const result = await factory(scope).sendMessage(conversationId, transcript);
    if (!result.ok) {
      const { code, message } = result.error;
      return { ok: false, error: { code, message, status: CONVERSATION_ERROR_STATUS[code] } };
    }
    return result.outcome === 'clarification'
      ? { ok: true, value: { outcome: 'clarification', message: result.message } }
      : { ok: true, value: { outcome: 'updated', artifact: result.artifact } };
  };
}

/**
 * The Fridge Service contract this adapter needs: record `items` as the
 * Active_Household's Fridge_Inventory, exactly as `PUT /fridge { items }`
 * would, returning that operation's result.
 */
export type RecordFridge = (scope: ActiveHouseholdScope, items: Ingredient[]) => Promise<DispatchOutcome>;

export function fridgeRecordingDispatch(deps: {
  recordFridge: RecordFridge;
  parse?: FridgeTranscriptParser;
}): TranscriptDispatcher['fridge'] {
  const parse = deps.parse ?? parseFridgeTranscript;
  return async (scope, transcript) => deps.recordFridge(scope, parse(transcript));
}

export function createTranscriptDispatcher(parts: TranscriptDispatcher): TranscriptDispatcher {
  return { fridge: parts.fridge, context: parts.context, conversation: parts.conversation };
}
