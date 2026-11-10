/**
 * Thin API Gateway handlers for the Voice Service.
 *
 *   POST /voice               { audio, contentType, sampleRateHertz?, languageCode?, targetOperation }
 *   POST /voice/{id}/confirm  { transcript? }
 *
 * Each handler receives an Active_Household scope that the authorizer layer
 * (task 15.1) has already verified.
 */
import type { ActiveHouseholdScope } from '../../domain/household.js';
import type { VoiceError, VoiceErrorCode, VoiceService } from './service.js';

export interface HttpRequest {
  body?: string | null;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined> | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export const VOICE_ERROR_STATUS: Readonly<Record<VoiceErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_AUDIO: 415,
  AUDIO_TOO_LARGE: 413,
  AUDIO_CONVERSION_FAILED: 422,
  VOICE_NOT_UNDERSTOOD: 422,
  VOICE_TIMEOUT: 504,
  AUDIO_UPLOAD_FAILED: 503,
  SAVE_DID_NOT_COMPLETE: 503,
  VOICE_NOT_FOUND: 404,
  VOICE_ALREADY_CONFIRMED: 409,
  VOICE_EXPIRED: 410,
  TARGET_OPERATION_FAILED: 422,
};

function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function errorResponse(error: VoiceError): HttpResponse {
  const status =
    error.code === 'TARGET_OPERATION_FAILED' && error.targetError?.status !== undefined
      ? error.targetError.status
      : VOICE_ERROR_STATUS[error.code];
  return json(status, { error });
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseBody(req: HttpRequest): Parsed {
  if (req.body === undefined || req.body === null || req.body === '') return { ok: true, value: undefined };
  const text = req.isBase64Encoded ? Buffer.from(req.body, 'base64').toString('utf-8') : req.body;
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

const badJson = () => json(400, { error: { code: 'INVALID_REQUEST', message: 'The request body must be valid JSON.' } });

async function guarded(run: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await run();
  } catch {
    return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong; nothing was changed.' } });
  }
}

export function createVoiceHandlers(service: VoiceService) {
  return {
    submit: (req: HttpRequest, scope: ActiveHouseholdScope) =>
      guarded(async () => {
        const body = parseBody(req);
        if (!body.ok) return badJson();
        const result = await service.submit(scope, body.value);
        return result.ok ? json(200, result.value) : errorResponse(result.error);
      }),

    confirm: (req: HttpRequest, scope: ActiveHouseholdScope) =>
      guarded(async () => {
        const body = parseBody(req);
        if (!body.ok) return badJson();
        const result = await service.confirm(scope, req.pathParameters?.id, body.value);
        return result.ok ? json(200, result.value) : errorResponse(result.error);
      }),
  };
}
