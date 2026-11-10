/**
 * In-process SuggestionAgentClient for tests. No model, no network.
 *
 * - Records a deep copy of every payload and its options, so tests can assert
 *   exactly what was sent (e.g. Property 19 profile snapshot, Property 34
 *   namespace).
 * - Responses come from a per-mode handler; the default handlers return
 *   minimal well-formed responses. A handler may return a full
 *   AgentInvocationResult to simulate timeout / invocation_failed /
 *   invalid_response, or throw to simulate an unexpected error.
 * - Timeout clamping uses the same `effectiveTimeoutMs` as the real client.
 */

import type { AdHocPayload, AgentPayload, PlanPayload, RefinePayload } from '../../src/agent/payload.js';
import type {
  AdHocAgentResponse,
  AgentResponseFor,
  PlanAgentResponse,
  RefineAgentResponse,
} from '../../src/agent/responses.js';
import {
  effectiveTimeoutMs,
  type AgentInvocationError,
  type AgentInvocationResult,
  type InvokeOptions,
  type SuggestionAgentClient,
} from '../../src/agent/runtimeClient.js';

type HandlerResult<R> = R | AgentInvocationResult<R> | Promise<R | AgentInvocationResult<R>>;

export interface FakeAgentHandlers {
  ad_hoc?: (payload: AdHocPayload) => HandlerResult<AdHocAgentResponse>;
  plan?: (payload: PlanPayload) => HandlerResult<PlanAgentResponse>;
  refine?: (payload: RefinePayload) => HandlerResult<RefineAgentResponse>;
}

export interface RecordedInvocation {
  payload: AgentPayload;
  options: InvokeOptions;
  effectiveTimeoutMs: number;
}

const sampleMeal = (name: string) => ({
  name,
  ingredients: [{ name: 'rice', quantity: 1, unit: 'cup' }],
  steps: ['Cook.'],
  attributes: [],
});

const defaultHandlers: Required<FakeAgentHandlers> = {
  ad_hoc: () => ({ mode: 'ad_hoc', suggestions: [sampleMeal('Fake Meal')] }),
  plan: (p) => ({ mode: 'plan', meals: Array.from({ length: p.rangeDays }, (_, i) => sampleMeal(`Fake Meal ${i + 1}`)) }),
  refine: () => ({ mode: 'refine', outcome: 'clarification', message: 'Could you clarify?' }),
};

function isResult<R>(v: R | AgentInvocationResult<R>): v is AgentInvocationResult<R> {
  return typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { ok: unknown }).ok === 'boolean';
}

export class FakeSuggestionAgentClient implements SuggestionAgentClient {
  readonly calls: RecordedInvocation[] = [];
  private handlers: Required<FakeAgentHandlers>;

  constructor(handlers: FakeAgentHandlers = {}) {
    this.handlers = { ...defaultHandlers, ...handlers };
  }

  setHandlers(handlers: FakeAgentHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** Makes every subsequent call fail with the given error. */
  failWith(error: AgentInvocationError): void {
    const fail = () => ({ ok: false as const, error });
    this.handlers = { ad_hoc: fail, plan: fail, refine: fail };
  }

  get lastPayload(): AgentPayload | undefined {
    return this.calls.at(-1)?.payload;
  }

  async invoke<P extends AgentPayload>(
    payload: P,
    options: InvokeOptions = {},
  ): Promise<AgentInvocationResult<AgentResponseFor<P>>> {
    const timeoutMs = effectiveTimeoutMs(options.timeoutMs);
    this.calls.push({ payload: structuredClone(payload), options: { ...options }, effectiveTimeoutMs: timeoutMs });

    const handler = this.handlers[payload.mode] as (p: P) => HandlerResult<AgentResponseFor<P>>;
    const out = await handler(structuredClone(payload));
    return isResult(out) ? out : { ok: true, response: structuredClone(out) };
  }
}
