/**
 * Suggestion_Agent client. The only path to generation is the Bedrock
 * AgentCore Runtime `InvokeAgentRuntime` API (Requirements 8.2, 8.3).
 *
 * Every invocation is capped at 30 seconds (Requirement 8.4). Callers may pass
 * a tighter deadline (10s ad hoc, 15s chat, 28s plan); a looser one is
 * clamped to 30s.
 * The deadline covers both the request and reading the response body, and is
 * enforced with an AbortController plus a timer race so it holds even if the
 * transport is slow to honor the abort.
 *
 * Services depend on the `SuggestionAgentClient` interface so property tests
 * can substitute test/fakes/fakeSuggestionAgentClient.ts.
 */

import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandInput,
  type InvokeAgentRuntimeCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';

import { encodePayload, type AgentPayload } from './payload.js';
import { parseAgentResponse, type AgentResponseFor } from './responses.js';

/** Hard upper bound on any agent invocation (Requirement 8.4). */
export const AGENT_INVOCATION_HARD_CAP_MS = 30_000;
/** User-facing bounds enforced by the calling services. */
export const AD_HOC_DEADLINE_MS = 10_000;
export const CHAT_DEADLINE_MS = 15_000;
/**
 * Plans stay synchronous behind the 30s API Gateway integration limit, so the
 * plan deadline leaves ~2s for the conditional write and the response
 * (Requirements 3.4, 8.4; design "Plan generation and the 30 s API Gateway limit").
 */
export const PLAN_DEADLINE_MS = 28_000;

/** AgentCore requires runtimeSessionId to be at least 33 characters. */
export const MIN_RUNTIME_SESSION_ID_LENGTH = 33;

export type AgentInvocationError =
  | { kind: 'timeout'; timeoutMs: number; message: string }
  | { kind: 'invocation_failed'; message: string; cause?: unknown }
  | { kind: 'invalid_response'; message: string };

export type AgentInvocationResult<R> = { ok: true; response: R } | { ok: false; error: AgentInvocationError };

export interface InvokeOptions {
  /** Deadline in ms; clamped to AGENT_INVOCATION_HARD_CAP_MS. Must be > 0. */
  timeoutMs?: number;
  /** AgentCore session id (>= 33 chars). A fresh one is generated if omitted. */
  runtimeSessionId?: string;
}

export interface SuggestionAgentClient {
  invoke<P extends AgentPayload>(payload: P, options?: InvokeOptions): Promise<AgentInvocationResult<AgentResponseFor<P>>>;
}

/** Resolve the effective deadline: default and ceiling are the 30s hard cap. */
export function effectiveTimeoutMs(requested?: number): number {
  if (requested === undefined) return AGENT_INVOCATION_HARD_CAP_MS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${requested}`);
  }
  return Math.min(requested, AGENT_INVOCATION_HARD_CAP_MS);
}

export function newRuntimeSessionId(): string {
  return `sous-${randomUUID()}`; // 41 chars
}

/** Minimal surface of BedrockAgentCoreClient used here, for injection in tests. */
export interface AgentCoreSender {
  send(
    command: InvokeAgentRuntimeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeAgentRuntimeCommandOutput>;
}

export interface AgentCoreRuntimeClientConfig {
  agentRuntimeArn: string;
  /** Runtime endpoint qualifier (e.g. "DEFAULT"). */
  qualifier?: string;
  /** Defaults to a new BedrockAgentCoreClient using the ambient AWS config. */
  sender?: AgentCoreSender;
}

const TIMED_OUT = Symbol('timed-out');

export class AgentCoreRuntimeClient implements SuggestionAgentClient {
  private readonly sender: AgentCoreSender;

  constructor(private readonly config: AgentCoreRuntimeClientConfig) {
    if (!config.agentRuntimeArn) throw new Error('agentRuntimeArn is required');
    this.sender = config.sender ?? (new BedrockAgentCoreClient({}) as AgentCoreSender);
  }

  /** The exact InvokeAgentRuntime input for a payload (exposed for testing). */
  buildCommandInput(payload: AgentPayload, runtimeSessionId: string): InvokeAgentRuntimeCommandInput {
    if (runtimeSessionId.length < MIN_RUNTIME_SESSION_ID_LENGTH) {
      throw new RangeError(`runtimeSessionId must be at least ${MIN_RUNTIME_SESSION_ID_LENGTH} characters`);
    }
    const input: InvokeAgentRuntimeCommandInput = {
      agentRuntimeArn: this.config.agentRuntimeArn,
      runtimeSessionId,
      contentType: 'application/json',
      accept: 'application/json',
      payload: encodePayload(payload),
    };
    if (this.config.qualifier) input.qualifier = this.config.qualifier;
    return input;
  }

  async invoke<P extends AgentPayload>(
    payload: P,
    options: InvokeOptions = {},
  ): Promise<AgentInvocationResult<AgentResponseFor<P>>> {
    const timeoutMs = effectiveTimeoutMs(options.timeoutMs);
    const command = new InvokeAgentRuntimeCommand(
      this.buildCommandInput(payload, options.runtimeSessionId ?? newRuntimeSessionId()),
    );

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMED_OUT);
      }, timeoutMs);
    });

    const call = (async (): Promise<string> => {
      const output = await this.sender.send(command, { abortSignal: controller.signal });
      if (!output.response) throw new MissingBodyError();
      return output.response.transformToString('utf-8');
    })();

    let text: string | typeof TIMED_OUT;
    try {
      text = await Promise.race([call, deadline]);
    } catch (err) {
      if (controller.signal.aborted) return timeout(timeoutMs);
      if (err instanceof MissingBodyError) return { ok: false, error: { kind: 'invalid_response', message: err.message } };
      return {
        ok: false,
        error: { kind: 'invocation_failed', message: err instanceof Error ? err.message : String(err), cause: err },
      };
    } finally {
      clearTimeout(timer);
    }

    if (text === TIMED_OUT) {
      call.catch(() => undefined); // the aborted call may still reject later
      return timeout(timeoutMs);
    }

    const parsed = parseAgentResponse(payload.mode, text);
    if (!parsed.ok) return { ok: false, error: { kind: 'invalid_response', message: parsed.message } };
    return { ok: true, response: parsed.value as AgentResponseFor<P> };
  }
}

class MissingBodyError extends Error {
  constructor() {
    super('agent returned no response body');
  }
}

function timeout(timeoutMs: number): { ok: false; error: AgentInvocationError } {
  return { ok: false, error: { kind: 'timeout', timeoutMs, message: `agent did not respond within ${timeoutMs} ms` } };
}
