import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvokeAgentRuntimeCommand, type InvokeAgentRuntimeCommandOutput } from '@aws-sdk/client-bedrock-agentcore';
import { FakeSuggestionAgentClient } from '../../test/fakes/fakeSuggestionAgentClient.js';
import { buildAdHocPayload, buildPlanPayload } from './payload.js';
import {
  AGENT_INVOCATION_HARD_CAP_MS,
  AgentCoreRuntimeClient,
  effectiveTimeoutMs,
  newRuntimeSessionId,
  PLAN_DEADLINE_MS,
  type AgentCoreSender,
} from './runtimeClient.js';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/sous-agent';
const adHoc = buildAdHocPayload({ householdId: 'hh-1', preferenceProfile: null, presets: ['quick'] });
const okBody = JSON.stringify({
  mode: 'ad_hoc',
  suggestions: [{ name: 'Toast', ingredients: [{ name: 'bread', quantity: 2, unit: 'slice' }], steps: ['Toast it'] }],
});

function output(body: string | undefined): InvokeAgentRuntimeCommandOutput {
  return {
    contentType: 'application/json',
    response: body === undefined ? undefined : ({ transformToString: async () => body } as never),
    $metadata: {},
  };
}

/** Sender that records calls and resolves with `body`, or never resolves when `hang`. */
function sender(opts: { body?: string; hang?: boolean; error?: Error }) {
  const calls: Array<{ command: InvokeAgentRuntimeCommand; signal?: AbortSignal }> = [];
  const s: AgentCoreSender = {
    send(command, options) {
      calls.push({ command, signal: options?.abortSignal });
      if (opts.error) return Promise.reject(opts.error);
      if (opts.hang) return new Promise(() => undefined);
      return Promise.resolve(output(opts.body));
    },
  };
  return { s, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('effectiveTimeoutMs', () => {
  it('defaults to and clamps at the 30s hard cap', () => {
    expect(effectiveTimeoutMs()).toBe(30_000);
    expect(effectiveTimeoutMs(60_000)).toBe(30_000);
    expect(effectiveTimeoutMs(10_000)).toBe(10_000);
  });
  it('keeps the plan deadline at 28s, under the unchanged 30s hard cap', () => {
    expect(AGENT_INVOCATION_HARD_CAP_MS).toBe(30_000);
    expect(PLAN_DEADLINE_MS).toBe(28_000);
    expect(effectiveTimeoutMs(PLAN_DEADLINE_MS)).toBe(28_000);
  });
  it('rejects non-positive or non-finite deadlines', () => {
    expect(() => effectiveTimeoutMs(0)).toThrow(RangeError);
    expect(() => effectiveTimeoutMs(Number.NaN)).toThrow(RangeError);
  });
});

describe('AgentCoreRuntimeClient', () => {
  it('sends InvokeAgentRuntime with the JSON payload and parses the response', async () => {
    const { s, calls } = sender({ body: okBody });
    const client = new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, qualifier: 'DEFAULT', sender: s });
    const sessionId = newRuntimeSessionId();

    const r = await client.invoke(adHoc, { runtimeSessionId: sessionId });

    expect(r.ok && r.response.suggestions[0]?.name).toBe('Toast');
    expect(calls).toHaveLength(1);
    const { command } = calls[0]!;
    expect(command).toBeInstanceOf(InvokeAgentRuntimeCommand);
    expect(command.input).toMatchObject({
      agentRuntimeArn: ARN,
      qualifier: 'DEFAULT',
      runtimeSessionId: sessionId,
      contentType: 'application/json',
      accept: 'application/json',
    });
    const sent = JSON.parse(new TextDecoder().decode(command.input.payload as Uint8Array));
    expect(sent).toEqual(adHoc);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('generates a runtime session id of at least 33 chars', async () => {
    const { s, calls } = sender({ body: okBody });
    await new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: s }).invoke(adHoc);
    expect(calls[0]!.command.input.runtimeSessionId!.length).toBeGreaterThanOrEqual(33);
  });

  it('maps a deadline breach to timeout and aborts the request', async () => {
    const { s, calls } = sender({ hang: true });
    const client = new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: s });
    const r = await client.invoke(adHoc, { timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout', timeoutMs: 20 } });
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  it('enforces the 30s hard cap even when a longer deadline is requested', async () => {
    vi.useFakeTimers();
    const { s } = sender({ hang: true });
    const client = new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: s });
    const pending = client.invoke(adHoc, { timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(AGENT_INVOCATION_HARD_CAP_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'timeout', timeoutMs: 30_000 } });
  });

  it('maps an abort-induced SDK rejection to timeout', async () => {
    const s: AgentCoreSender = {
      send: (_c, o) =>
        new Promise((_res, rej) => o?.abortSignal?.addEventListener('abort', () => rej(new Error('Request aborted')))),
    };
    const r = await new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: s }).invoke(adHoc, { timeoutMs: 10 });
    expect(r).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('maps SDK errors to invocation_failed', async () => {
    const err = new Error('ThrottlingException');
    const { s } = sender({ error: err });
    const r = await new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: s }).invoke(adHoc);
    expect(r).toEqual({ ok: false, error: { kind: 'invocation_failed', message: 'ThrottlingException', cause: err } });
  });

  it('maps malformed or missing bodies to invalid_response', async () => {
    const bad = await new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: sender({ body: '{"mode":"plan"}' }).s }).invoke(
      adHoc,
    );
    expect(bad).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });

    const empty = await new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: sender({}).s }).invoke(adHoc);
    expect(empty).toMatchObject({ ok: false, error: { kind: 'invalid_response', message: 'agent returned no response body' } });
  });

  it('rejects short runtime session ids', () => {
    const client = new AgentCoreRuntimeClient({ agentRuntimeArn: ARN, sender: sender({}).s });
    expect(() => client.buildCommandInput(adHoc, 'short')).toThrow(RangeError);
  });
});

describe('FakeSuggestionAgentClient', () => {
  it('records deep-copied payloads and returns default responses per mode', async () => {
    const fake = new FakeSuggestionAgentClient();
    const plan = buildPlanPayload({ householdId: 'hh-1', preferenceProfile: null, rangeDays: 3 });
    const r = await fake.invoke(plan, { timeoutMs: 45_000 });
    expect(r.ok && r.response.meals).toHaveLength(3);
    plan.presets.push('healthy');
    expect(fake.lastPayload?.presets).toEqual([]);
    expect(fake.calls[0]!.effectiveTimeoutMs).toBe(30_000);
  });

  it('can simulate failures', async () => {
    const fake = new FakeSuggestionAgentClient();
    fake.failWith({ kind: 'timeout', timeoutMs: 10_000, message: 'slow' });
    expect(await fake.invoke(adHoc)).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });
});
