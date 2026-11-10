/**
 * Lambda entry point for the Voice Service routes.
 *
 *   POST /voice               upload + transcribe (Amazon Transcribe Streaming)
 *   POST /voice/{id}/confirm  dispatch the confirmed Transcript
 *
 * Confirmed Transcripts are applied through the same services as the typed
 * requests, scoped to the same Active_Household:
 *   fridge        FridgeService.replaceInventory  (PUT /fridge)
 *   context       SuggestionService.suggest       (POST /suggestions)
 *   conversation  ConversationService.sendMessage (POST /conversations/{id}/messages)
 *
 * Environment: TABLE_NAME, AUDIO_BUCKET_NAME, AGENT_RUNTIME_ARN, MEMORY_ID,
 * EVENT_BUS_NAME, FFMPEG_PATH (optional; when unset, WebM/MP4 recordings are
 * rejected as UNSUPPORTED_AUDIO instead of being converted).
 */
import { randomUUID } from 'node:crypto';
import { HouseholdRepository } from '../../data/repository.js';
import { FfmpegAudioConverter } from '../../voice/audioConverter.js';
import { S3AudioStore } from '../../voice/audioStore.js';
import { StreamingTranscriber } from '../../voice/transcriber.js';
import { conversationServiceFactory } from '../conversations/handlers.js';
import { publishPlanRefinement } from '../conversations/planEvents.js';
import { FRIDGE_ERROR_STATUS, fridgeServiceFactory } from '../fridge/handlers.js';
import { EventBridgePlanEventPublisher } from '../plans/events.js';
import {
  createActiveHouseholdResolver,
  requireEnv,
  scopedRouter,
  withActiveHousehold,
  type AuthorizedApiEvent,
  type HttpResponse,
} from '../shared/authorization/index.js';
import { agentFromEnv, memoryFromEnv, tableFromEnv } from '../shared/runtime.js';
import { SuggestionService } from '../suggestions/suggestionService.js';
import {
  conversationMessageDispatch,
  createTranscriptDispatcher,
  fridgeRecordingDispatch,
  suggestionContextDispatch,
  type RecordFridge,
} from './dispatcher.js';
import { createVoiceHandlers, type HttpRequest } from './handlers.js';
import { VoiceService } from './service.js';

function build(): (event: AuthorizedApiEvent) => Promise<HttpResponse> {
  const table = tableFromEnv();
  const agent = agentFromEnv();
  const memory = memoryFromEnv();
  const repositoryFor = (householdId: string) => new HouseholdRepository(table, householdId);
  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  const logConversionFailure = (entry: object) => console.warn(JSON.stringify(entry));

  const fridgeFor = fridgeServiceFactory({ tableClient: table });
  const recordFridge: RecordFridge = async (scope, items) => {
    const result = await fridgeFor(scope).replaceInventory({ items });
    if (result.ok) return { ok: true, value: result.value };
    const { code, message } = result.error;
    return { ok: false, error: { code, message, status: FRIDGE_ERROR_STATUS[code] } };
  };

  const dispatcher = createTranscriptDispatcher({
    fridge: fridgeRecordingDispatch({ recordFridge }),
    context: suggestionContextDispatch(
      new SuggestionService({ repositoryFor, agent, memory, now: Date.now, newId: randomUUID }),
    ),
    conversation: conversationMessageDispatch(
      conversationServiceFactory({
        table,
        agent,
        memory,
        onPlanChanged: publishPlanRefinement(
          new EventBridgePlanEventPublisher({ eventBusName: requireEnv('EVENT_BUS_NAME') }),
        ),
      }),
    ),
  });

  const voice = createVoiceHandlers(
    new VoiceService({
      repositoryFor,
      transcriber: new StreamingTranscriber(),
      audioStore: new S3AudioStore(requireEnv('AUDIO_BUCKET_NAME')),
      dispatcher,
      ...(ffmpegPath ? { audioConverter: new FfmpegAudioConverter({ ffmpegPath, log: logConversionFailure }) } : {}),
    }),
  );
  const asRequest = (event: AuthorizedApiEvent): HttpRequest => ({
    body: event.body ?? null,
    ...(event.isBase64Encoded !== undefined ? { isBase64Encoded: event.isBase64Encoded } : {}),
    pathParameters: event.pathParameters ?? null,
  });

  return withActiveHousehold(
    createActiveHouseholdResolver(table),
    scopedRouter({
      'POST /voice': (event, scope) => voice.submit(asRequest(event), scope),
      'POST /voice/{id}/confirm': (event, scope) => voice.confirm(asRequest(event), scope),
    }),
  );
}

let cached: ((event: AuthorizedApiEvent) => Promise<HttpResponse>) | undefined;
export async function handler(event: AuthorizedApiEvent): Promise<HttpResponse> {
  cached ??= build();
  return cached(event);
}
