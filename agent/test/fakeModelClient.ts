/**
 * Scripted `ModelClient` for agent unit and property tests (design.md,
 * "Properties 36–51"). Each call returns the next scripted step and records
 * the request it received. A step may be a fixed result or a function of the
 * request (for deterministic models that echo the prompt). When the script
 * runs out, `fallback` is used; without one, the call fails the test.
 */

import type { ModelClient, StructuredRequest, StructuredResult } from '../src/model/modelClient.js';

export type FakeModelStep = StructuredResult | ((request: StructuredRequest, callIndex: number) => StructuredResult);

export interface FakeModelClientOptions {
  /** Used once the script is exhausted. */
  fallback?: FakeModelStep;
  /**
   * Resolve each call only after this many ms, or until the request's signal
   * aborts (then `aborted` is returned). Uses real timers; tests may use fake ones.
   */
  delayMs?: number;
}

export class FakeModelClient implements ModelClient {
  readonly requests: StructuredRequest[] = [];
  private readonly script: FakeModelStep[];

  constructor(
    script: readonly FakeModelStep[] = [],
    private readonly options: FakeModelClientOptions = {},
  ) {
    this.script = [...script];
  }

  get callCount(): number {
    return this.requests.length;
  }

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    const callIndex = this.requests.length;
    this.requests.push(request);
    if (request.signal.aborted) return abortedResult();

    const step = this.script.shift() ?? this.options.fallback;
    if (step === undefined) throw new Error(`FakeModelClient: no scripted result for call ${callIndex}`);

    if (this.options.delayMs !== undefined && this.options.delayMs > 0) {
      const completed = await waitOrAbort(this.options.delayMs, request.signal);
      if (!completed) return abortedResult();
    }
    return typeof step === 'function' ? step(request, callIndex) : step;
  }
}

/** A successful result carrying `document`. */
export function okResult(document: unknown, toolUseId = 'tooluse-fake'): StructuredResult {
  return { ok: true, document, toolUseId };
}

export function failedResult(
  reason: 'no_structured_output' | 'model_error' | 'aborted',
  message = `fake ${reason}`,
): StructuredResult {
  return { ok: false, reason, message };
}

function abortedResult(): StructuredResult {
  return failedResult('aborted', 'model call aborted');
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
