/**
 * Generation pipeline of the Suggestion_Agent (design.md, "Generation
 * pipeline" and "Structured output, validation, and repair";
 * Requirements 12.1, 12.2, 12.4–12.6, 12.8–12.13).
 *
 * soft preferences -> prompt -> model -> parse + contract checks -> at most
 * one repair call -> response.
 *
 * - Soft_Preferences come from the request when it carries
 *   `householdPreferenceMemory` (even an empty array); otherwise memory is
 *   read exactly once at `{householdId}`. A failed read degrades to none.
 * - Each model call chain makes at most two calls: the first call and one
 *   repair call that carries the validator message. Plans are split into
 *   chunks of `planChunkDays`, generated concurrently, each chain with its
 *   own repair allowance. Any failed chunk fails the whole plan; no partial
 *   plan is ever returned.
 * - The repair call runs only if enough budget remains (3 s for ad hoc and
 *   refine, 8 s for a plan chunk). All model calls share an AbortSignal tied
 *   to the mode budget.
 * - A success response always passes `parseAgentResponseValue` for its mode.
 */

import type { AgentMode } from '../../src/agent/payload.js';
import {
  parseAgentResponseValue,
  type AdHocAgentResponse,
  type AgentMeal,
  type AgentResponse,
  type PlanAgentResponse,
  type RefineAgentResponse,
} from '../../src/agent/responses.js';
import { createBudget, type Budget, type MonotonicClock } from './budget.js';
import type { AgentConfig } from './config.js';
import { checkAdHocResponse, checkPlanChunk, checkRefineResponse, type CheckResult } from './contractChecks.js';
import {
  SUBMIT_RESPONSE_TOOL_NAME,
  type JsonSchema,
  type ModelClient,
  type ModelMessage,
  type StructuredRequest,
  type StructuredResult,
} from './model/modelClient.js';
import { buildPlanOutlineSystemPrompt, buildSystemPrompt, buildUserMessage, type PlanChunk } from './prompts.js';
import type { AgentRequest, SoftPreferenceEntry } from './requestParser.js';
import { planOutlineSchema, responseSchema } from './schemas.js';
import type { SoftPreferenceSource } from './softPreferences.js';

/** Minimum remaining budget for a repair call (design.md). */
export const MIN_REPAIR_BUDGET_MS: Readonly<{ single: number; planChunk: number }> = {
  single: 3_000,
  planChunk: 8_000,
};

export const MAX_OUTPUT_TOKENS = {
  perSuggestion: 900,
  perPlanDay: 800,
  perOutlineDay: 40,
  refine: 4_000,
  overhead: 300,
} as const;

export const MODEL_TEMPERATURE = 0.5;

export type GenerateErrorCode = 'GENERATION_FAILED' | 'GENERATION_TIMEOUT';

export type SoftPreferenceOrigin = 'request' | 'memory' | 'degraded';

export interface GenerateMeta {
  /** Total model calls made for this request (all chunks). */
  modelCalls: number;
  softPreferences: SoftPreferenceOrigin;
  /** Last model SDK/service error (name and message, never request content), if any. */
  modelError?: string;
}

export type GenerateResult =
  | { ok: true; response: AgentResponse; meta: GenerateMeta }
  | { ok: false; code: GenerateErrorCode; message: string; meta: GenerateMeta };

export interface GenerateDeps {
  model: ModelClient;
  softPreferences: SoftPreferenceSource;
  config: AgentConfig;
  /** Monotonic clock in ms (default `performance.now`). */
  now?: MonotonicClock;
}

const TOOL_DESCRIPTION = 'Submit the response. This is the only way to answer.';

type ChainResult<T> = { ok: true; value: T } | { ok: false; code: GenerateErrorCode; message: string };

interface ChainSpec<T> {
  mode: AgentMode;
  system: string;
  userText: string;
  schema: JsonSchema;
  maxTokens: number;
  minRepairMs: number;
  check: (document: unknown) => CheckResult<T>;
}

interface ChainContext {
  model: ModelClient;
  budget: Budget;
  /** Aborted when the budget expires or (plans) another chunk fails. */
  signal: AbortSignal;
  /** Model call count, plus the last SDK/service error (name and message only) for the request log. */
  counter: { calls: number; lastModelError?: string };
}

const TIMEOUT: ChainResult<never> = { ok: false, code: 'GENERATION_TIMEOUT', message: 'Generation budget expired.' };

async function callModel(ctx: ChainContext, request: StructuredRequest): Promise<StructuredResult> {
  ctx.counter.calls++;
  let result: StructuredResult;
  try {
    result = await ctx.model.generateStructured(request);
  } catch (err) {
    result = { ok: false, reason: 'model_error', message: err instanceof Error ? err.message : 'model call failed' };
  }
  if (!result.ok && result.reason === 'model_error') ctx.counter.lastModelError = result.message;
  return result;
}

/** Validate one model result; returns the checked value or a validator message. */
function evaluate<T>(result: StructuredResult, spec: ChainSpec<T>): CheckResult<T> {
  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === 'no_structured_output'
          ? `no ${SUBMIT_RESPONSE_TOOL_NAME} tool call was made; answer only by calling the ${SUBMIT_RESPONSE_TOOL_NAME} tool`
          : `the previous attempt failed (${result.reason})`,
    };
  }
  const parsed = parseAgentResponseValue(spec.mode, result.document);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return spec.check(parsed.value);
}

/** Messages for the single repair call (design.md, "Repair"). */
function repairMessages(userText: string, previous: StructuredResult, message: string): ModelMessage[] {
  const correction = `Your previous response did not conform: ${message}. Call ${SUBMIT_RESPONSE_TOOL_NAME} again with a corrected response.`;
  if (previous.ok && previous.toolUseId !== undefined) {
    return [
      { role: 'user', content: [{ type: 'text', text: userText }] },
      { role: 'assistant', content: [{ type: 'tool_use', toolUseId: previous.toolUseId, input: previous.document }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: previous.toolUseId, status: 'error', text: correction }] },
    ];
  }
  // No tool call to answer: restate the request with the correction in the same user turn.
  return [{ role: 'user', content: [{ type: 'text', text: userText }, { type: 'text', text: correction }] }];
}

function timedOut(ctx: ChainContext): boolean {
  return ctx.budget.expired() || ctx.budget.signal.aborted;
}

/** One model call plus at most one repair call (Property 36). */
async function runChain<T>(ctx: ChainContext, spec: ChainSpec<T>): Promise<ChainResult<T>> {
  const base = {
    system: spec.system,
    tool: { name: SUBMIT_RESPONSE_TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: spec.schema },
    maxTokens: spec.maxTokens,
    temperature: MODEL_TEMPERATURE,
    signal: ctx.signal,
  } as const;

  if (timedOut(ctx)) return TIMEOUT;
  const first = await callModel(ctx, {
    ...base,
    messages: [{ role: 'user', content: [{ type: 'text', text: spec.userText }] }],
  });
  if (timedOut(ctx)) return TIMEOUT;
  if (ctx.signal.aborted) return { ok: false, code: 'GENERATION_FAILED', message: 'Generation was cancelled.' };
  const firstCheck = evaluate(first, spec);
  if (firstCheck.ok) return firstCheck;

  if (ctx.budget.remainingMs() < spec.minRepairMs) {
    return { ok: false, code: 'GENERATION_FAILED', message: `Nonconforming output and no budget for a repair call: ${firstCheck.message}` };
  }
  const second = await callModel(ctx, { ...base, messages: repairMessages(spec.userText, first, firstCheck.message) });
  if (timedOut(ctx)) return TIMEOUT;
  if (ctx.signal.aborted) return { ok: false, code: 'GENERATION_FAILED', message: 'Generation was cancelled.' };
  const secondCheck = evaluate(second, spec);
  if (secondCheck.ok) return secondCheck;
  return { ok: false, code: 'GENERATION_FAILED', message: `Output still nonconforming after repair: ${secondCheck.message}` };
}

/** Split `rangeDays` into consecutive chunks of at most `chunkDays` days. */
export function planChunks(rangeDays: number, chunkDays: number): PlanChunk[] {
  if (!Number.isInteger(rangeDays) || rangeDays < 1) throw new RangeError('rangeDays must be a positive integer.');
  if (!Number.isInteger(chunkDays) || chunkDays < 1) throw new RangeError('chunkDays must be a positive integer.');
  const chunks: PlanChunk[] = [];
  for (let firstDay = 1; firstDay <= rangeDays; firstDay += chunkDays) {
    chunks.push({ firstDay, dayCount: Math.min(chunkDays, rangeDays - firstDay + 1) });
  }
  return chunks;
}

async function resolveSoftPreferences(
  request: AgentRequest,
  source: SoftPreferenceSource,
): Promise<{ entries: SoftPreferenceEntry[]; origin: SoftPreferenceOrigin }> {
  if (request.householdPreferenceMemory !== undefined) {
    return { entries: request.householdPreferenceMemory, origin: 'request' };
  }
  try {
    const read = await source.read(request.householdId);
    return read.degraded ? { entries: [], origin: 'degraded' } : { entries: read.entries, origin: 'memory' };
  } catch {
    return { entries: [], origin: 'degraded' };
  }
}

async function generateAdHoc(
  request: Extract<AgentRequest, { mode: 'ad_hoc' }>,
  soft: SoftPreferenceEntry[],
  ctx: ChainContext,
  config: AgentConfig,
): Promise<ChainResult<AdHocAgentResponse>> {
  const count = config.adHocSuggestionCount;
  return runChain<AdHocAgentResponse>(ctx, {
    mode: 'ad_hoc',
    system: buildSystemPrompt('ad_hoc', { suggestionCount: count }),
    userText: buildUserMessage(request, soft),
    schema: responseSchema('ad_hoc'),
    maxTokens: MAX_OUTPUT_TOKENS.overhead + MAX_OUTPUT_TOKENS.perSuggestion * count,
    minRepairMs: MIN_REPAIR_BUDGET_MS.single,
    check: (doc) => checkAdHocResponse(doc as AdHocAgentResponse, request),
  });
}

async function generateRefine(
  request: Extract<AgentRequest, { mode: 'refine' }>,
  soft: SoftPreferenceEntry[],
  ctx: ChainContext,
): Promise<ChainResult<RefineAgentResponse>> {
  return runChain<RefineAgentResponse>(ctx, {
    mode: 'refine',
    system: buildSystemPrompt('refine'),
    userText: buildUserMessage(request, soft),
    schema: responseSchema('refine'),
    maxTokens: MAX_OUTPUT_TOKENS.refine,
    minRepairMs: MIN_REPAIR_BUDGET_MS.single,
    check: (doc) => checkRefineResponse(doc as RefineAgentResponse, request),
  });
}

/** Dish names must differ ignoring case and surrounding whitespace. */
function distinctNames(names: readonly string[]): boolean {
  return new Set(names.map((n) => n.trim().toLowerCase())).size === names.length;
}

/**
 * Chunks are generated concurrently and cannot see each other, so without a
 * shared outline each chunk tends to start with the same dishes. One quick
 * call picks a distinct dish per day for the whole range up front; chunks are
 * then told which dish to write for each of their days. Best effort: a failed
 * or unusable outline returns undefined and chunks run without assignments.
 */
async function planOutline(
  request: Extract<AgentRequest, { mode: 'plan' }>,
  soft: SoftPreferenceEntry[],
  ctx: ChainContext,
): Promise<string[] | undefined> {
  if (timedOut(ctx) || ctx.signal.aborted) return undefined;
  const result = await callModel(ctx, {
    system: buildPlanOutlineSystemPrompt(),
    tool: { name: SUBMIT_RESPONSE_TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: planOutlineSchema(request.rangeDays) },
    messages: [{ role: 'user', content: [{ type: 'text', text: buildUserMessage(request, soft) }] }],
    maxTokens: MAX_OUTPUT_TOKENS.overhead + MAX_OUTPUT_TOKENS.perOutlineDay * request.rangeDays,
    temperature: MODEL_TEMPERATURE,
    signal: ctx.signal,
  });
  if (!result.ok || typeof result.document !== 'object' || result.document === null) return undefined;
  const names = (result.document as { names?: unknown }).names;
  if (!Array.isArray(names) || names.length !== request.rangeDays) return undefined;
  if (!names.every((n): n is string => typeof n === 'string' && n.trim().length > 0)) return undefined;
  const trimmed = names.map((n) => n.trim());
  return distinctNames(trimmed) ? trimmed : undefined;
}

async function generatePlan(
  request: Extract<AgentRequest, { mode: 'plan' }>,
  soft: SoftPreferenceEntry[],
  ctx: ChainContext,
  config: AgentConfig,
  cancelAll: () => void,
): Promise<ChainResult<PlanAgentResponse>> {
  const system = buildSystemPrompt('plan');
  let chunks = planChunks(request.rangeDays, config.planChunkDays);
  if (chunks.length > 1) {
    const outline = await planOutline(request, soft, ctx);
    if (outline !== undefined) {
      chunks = chunks.map((c) => ({ ...c, assignedNames: outline.slice(c.firstDay - 1, c.firstDay - 1 + c.dayCount) }));
    }
  }
  if (timedOut(ctx)) return TIMEOUT;
  let firstFailure: ChainResult<never> | undefined;

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const result = await runChain<PlanAgentResponse>(ctx, {
        mode: 'plan',
        system,
        userText: buildUserMessage(request, soft, chunk),
        schema: responseSchema('plan', { dayCount: chunk.dayCount }),
        maxTokens: MAX_OUTPUT_TOKENS.overhead + MAX_OUTPUT_TOKENS.perPlanDay * chunk.dayCount,
        minRepairMs: MIN_REPAIR_BUDGET_MS.planChunk,
        check: (doc) => checkPlanChunk(doc as PlanAgentResponse, chunk.dayCount, request),
      });
      if (!result.ok && firstFailure === undefined) {
        firstFailure = result;
        cancelAll(); // no partial plan: stop the other chunks
      }
      return result;
    }),
  );

  if (firstFailure !== undefined) return firstFailure;
  const meals: AgentMeal[] = [];
  for (const result of results) {
    if (!result.ok) return { ok: false, code: 'GENERATION_FAILED', message: result.message };
    meals.push(...result.value.meals);
  }
  if (meals.length !== request.rangeDays) {
    return { ok: false, code: 'GENERATION_FAILED', message: `merged plan has ${meals.length} meals, expected ${request.rangeDays}` };
  }
  return { ok: true, value: { mode: 'plan', meals } };
}

/** Run the generation pipeline for an already validated request. Never throws for model or memory failures. */
export async function generate(request: AgentRequest, deps: GenerateDeps): Promise<GenerateResult> {
  const budget = createBudget(deps.config.budgetsMs[request.mode], deps.now);
  const controller = new AbortController();
  const onBudgetAbort = (): void => controller.abort(budget.signal.reason);
  budget.signal.addEventListener('abort', onBudgetAbort, { once: true });
  const counter: ChainContext['counter'] = { calls: 0 };
  let origin: SoftPreferenceOrigin = 'request';
  const meta = (): GenerateMeta => ({
    modelCalls: counter.calls,
    softPreferences: origin,
    ...(counter.lastModelError !== undefined ? { modelError: counter.lastModelError } : {}),
  });

  try {
    const soft = await resolveSoftPreferences(request, deps.softPreferences);
    origin = soft.origin;
    const ctx: ChainContext = { model: deps.model, budget, signal: controller.signal, counter };

    let result: ChainResult<AgentResponse>;
    switch (request.mode) {
      case 'ad_hoc':
        result = await generateAdHoc(request, soft.entries, ctx, deps.config);
        break;
      case 'plan':
        result = await generatePlan(request, soft.entries, ctx, deps.config, () => controller.abort());
        break;
      case 'refine':
        result = await generateRefine(request, soft.entries, ctx);
        break;
    }
    if (!result.ok) return { ok: false, code: result.code, message: result.message, meta: meta() };

    // Defense in depth for Property 36: never return a body the callers cannot parse.
    const final = parseAgentResponseValue(request.mode, result.value);
    if (!final.ok) return { ok: false, code: 'GENERATION_FAILED', message: final.message, meta: meta() };
    return { ok: true, response: final.value, meta: meta() };
  } finally {
    budget.signal.removeEventListener('abort', onBudgetAbort);
    budget.dispose();
  }
}
