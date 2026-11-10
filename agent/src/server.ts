/**
 * HTTP server of the Suggestion_Agent container (design.md, "AgentCore
 * Runtime HTTP contract"; Requirements 8.2, 12.1, 12.3, 12.13, 12.14).
 *
 * Contract source, checked for task 19.15: AgentCore developer guide,
 * "HTTP protocol contract"
 * (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html):
 * - the container listens on host 0.0.0.0, port 8080, and is built for ARM64;
 * - `POST /invocations` takes JSON and returns JSON (or SSE);
 * - `GET /ping` returns `200` with `{"status":"Healthy"|"HealthyBusy"}` and an
 *   optional `time_of_last_update` (Unix seconds). The guide says to set that
 *   field only when the status changes: a timestamp that advances on every
 *   ping keeps the session from ever going idle. The status here never
 *   changes, so the field is the server start time.
 * - A container `4xx`/`5xx` reaches the caller as `RuntimeClientError`
 *   (HTTP 424). `AgentCoreRuntimeClient.invoke` therefore maps every error
 *   response below to `invocation_failed`, and its own deadline yields
 *   `timeout`. The error bodies are for CloudWatch and direct callers only.
 *
 * Routes:
 * | `GET /ping`          | `200 {"status":"Healthy","time_of_last_update":<start, epoch s>}` |
 * | `POST /invocations`  | `200` exactly the AgentResponse JSON for the mode (parses with
 * |                      | `parseAgentResponse`), or an error body                       |
 * | anything else        | `404 {"error":{"code":"NOT_FOUND"}}`                           |
 *
 * Error bodies are `{"error":{"code","message"}}`:
 * | 400 INVALID_REQUEST     | invalid JSON or `parseAgentRequest` failure (no model or memory call) |
 * | 413 PAYLOAD_TOO_LARGE   | body above 512 KB                                                     |
 * | 500 GENERATION_FAILED   | output still nonconforming after the repair call, or internal error  |
 * | 504 GENERATION_TIMEOUT  | the mode budget ran out                                              |
 * Only the 400 message is specific (it names the invalid field). 500 and 504
 * use fixed messages so model output never leaves the container.
 *
 * Logs: one JSON line per `/invocations` or unknown-route request with
 * method, route, status, durationMs, and, when known, mode, modelCalls, and
 * the soft-preference origin. `/ping` is not logged (it is polled). Logs
 * never contain request bodies, Context_Input, turns, preference statements,
 * or model output.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { generate as defaultGenerate, type GenerateDeps, type GenerateResult } from './generate.js';
import { parseAgentRequest, type AgentRequest } from './requestParser.js';

/** Request body limit for `POST /invocations` (design.md: 512 KB). */
export const MAX_BODY_BYTES = 512 * 1024;

/** Upper bound for a whole request; above the largest mode budget (26 s). */
export const REQUEST_TIMEOUT_MS = 35_000;

export type ErrorCode = 'INVALID_REQUEST' | 'PAYLOAD_TOO_LARGE' | 'GENERATION_FAILED' | 'GENERATION_TIMEOUT' | 'NOT_FOUND';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  msg: string;
  [key: string]: unknown;
}

export interface ServerDeps extends GenerateDeps {
  /** Receives one structured log record per logged request (default: JSON line on stdout). */
  log?: (line: LogLine) => void;
  /** Wall clock in epoch ms, used for the `/ping` timestamp (default `Date.now`). */
  wallClock?: () => number;
  /** Generation pipeline (default `generate`); injectable for tests. */
  generate?: (request: AgentRequest, deps: GenerateDeps) => Promise<GenerateResult>;
}

export function defaultLog(line: LogLine): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`);
}

class PayloadTooLargeError extends Error {}

/** Read the body up to `limit` bytes; rejects with PayloadTooLargeError beyond it. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new PayloadTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  };
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: ErrorCode, message: string, close = false): void {
  sendJson(res, status, { error: { code, message } }, close);
}

const GENERATION_STATUS: Record<'GENERATION_FAILED' | 'GENERATION_TIMEOUT', { status: number; message: string }> = {
  GENERATION_FAILED: { status: 500, message: 'The model output did not conform to the response contract.' },
  GENERATION_TIMEOUT: { status: 504, message: 'The generation budget expired.' },
};

/** Create the agent HTTP server (not yet listening). */
export function createServer(deps: ServerDeps): Server {
  const log = deps.log ?? defaultLog;
  const wallClock = deps.wallClock ?? Date.now;
  const runGenerate = deps.generate ?? defaultGenerate;
  const generateDeps: GenerateDeps = {
    model: deps.model,
    softPreferences: deps.softPreferences,
    config: deps.config,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const ping = JSON.stringify({ status: 'Healthy', time_of_last_update: Math.floor(wallClock() / 1000) });

  async function handleInvocation(req: IncomingMessage, res: ServerResponse, record: Record<string, unknown>): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        record.status = 413;
        // Discard the rest of an oversized upload; the connection closes after the reply.
        req.resume();
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${MAX_BODY_BYTES} bytes.`, true);
        return;
      }
      throw err;
    }

    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      record.status = 400;
      sendError(res, 400, 'INVALID_REQUEST', 'Request body is not valid JSON.');
      return;
    }

    const parsed = parseAgentRequest(value);
    if (!parsed.ok) {
      record.status = 400;
      sendError(res, 400, 'INVALID_REQUEST', parsed.message);
      return;
    }
    const request = parsed.request;
    record.mode = request.mode;

    const result = await runGenerate(request, generateDeps);
    record.modelCalls = result.meta.modelCalls;
    record.softPreferences = result.meta.softPreferences;
    if (result.ok) {
      record.status = 200;
      sendJson(res, 200, result.response);
      return;
    }
    const mapped = GENERATION_STATUS[result.code];
    record.status = mapped.status;
    record.errorCode = result.code;
    sendError(res, mapped.status, result.code, mapped.message);
  }

  const server = createHttpServer((req, res) => {
    const started = performance.now();
    const path = (req.url ?? '/').split('?', 1)[0];
    const method = req.method ?? 'GET';

    if (path === '/ping' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(ping) });
      res.end(ping);
      return;
    }

    const record: Record<string, unknown> = { method, route: path === '/invocations' ? '/invocations' : 'other' };
    const finish = (): void => {
      const status = typeof record.status === 'number' ? record.status : 500;
      log({
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        msg: 'request',
        ...record,
        status,
        durationMs: Math.round(performance.now() - started),
      });
    };

    if (path !== '/invocations' || method !== 'POST') {
      record.status = 404;
      req.resume();
      sendError(res, 404, 'NOT_FOUND', 'Not found.');
      finish();
      return;
    }

    handleInvocation(req, res, record)
      .catch((err: unknown) => {
        record.status = 500;
        record.errorCode = 'GENERATION_FAILED';
        record.errorName = err instanceof Error ? err.name : typeof err;
        if (!res.headersSent) sendError(res, 500, 'GENERATION_FAILED', 'Internal error.');
        else res.destroy();
      })
      .finally(finish);
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(server.headersTimeout, REQUEST_TIMEOUT_MS);
  return server;
}

/**
 * Stop accepting connections, let in-flight requests finish, and resolve
 * once the server is closed. Connections still open after `graceMs` are
 * destroyed.
 */
export function shutdown(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
