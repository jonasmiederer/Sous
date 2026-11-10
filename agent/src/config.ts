/**
 * Suggestion_Agent configuration from environment variables
 * (design.md, "Suggestion_Agent implementation"). Pure: reads only the
 * `env` record passed in.
 *
 * Budgets are measured from request receipt and are capped at the
 * Requirement 12.13 limits: a configured value above a cap is lowered to it.
 */

import type { AgentMode } from '../../src/agent/payload.js';

/** Upper bounds per mode in milliseconds (Requirement 12.13). */
export const MAX_BUDGET_MS: Readonly<Record<AgentMode, number>> = {
  ad_hoc: 8_000,
  refine: 13_000,
  plan: 26_000,
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_AD_HOC_SUGGESTION_COUNT = 2;
export const DEFAULT_PLAN_CHUNK_DAYS = 4;

export interface AgentConfig {
  port: number;
  modelId: string;
  bedrockRegion: string;
  memoryId: string;
  memoryPreferenceStrategyId?: string;
  budgetsMs: Record<AgentMode, number>;
  /** Suggestions requested from the model in ad hoc mode, 1–3. */
  adHocSuggestionCount: number;
  /** Maximum days per plan chunk, 1–7. */
  planChunkDays: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: Env, name: string): string {
  const value = nonEmpty(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required.`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = nonEmpty(env, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

/** A positive integer number of milliseconds, lowered to `cap` when larger. */
function budget(env: Env, name: string, cap: number): number {
  const raw = nonEmpty(env, name);
  if (raw === undefined) return cap;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new ConfigError(`${name} must be a positive integer (ms).`);
  return Math.min(Number(raw), cap);
}

export function loadConfig(env: Env = process.env): AgentConfig {
  const bedrockRegion = nonEmpty(env, 'BEDROCK_REGION') ?? nonEmpty(env, 'AWS_REGION');
  if (bedrockRegion === undefined) throw new ConfigError('BEDROCK_REGION (or AWS_REGION) is required.');
  const config: AgentConfig = {
    port: integer(env, 'PORT', DEFAULT_PORT, 1, 65_535),
    modelId: required(env, 'MODEL_ID'),
    bedrockRegion,
    memoryId: required(env, 'MEMORY_ID'),
    budgetsMs: {
      ad_hoc: budget(env, 'AD_HOC_BUDGET_MS', MAX_BUDGET_MS.ad_hoc),
      refine: budget(env, 'REFINE_BUDGET_MS', MAX_BUDGET_MS.refine),
      plan: budget(env, 'PLAN_BUDGET_MS', MAX_BUDGET_MS.plan),
    },
    adHocSuggestionCount: integer(env, 'AD_HOC_SUGGESTION_COUNT', DEFAULT_AD_HOC_SUGGESTION_COUNT, 1, 3),
    planChunkDays: integer(env, 'PLAN_CHUNK_DAYS', DEFAULT_PLAN_CHUNK_DAYS, 1, 7),
  };
  const strategyId = nonEmpty(env, 'MEMORY_PREFERENCE_STRATEGY_ID');
  if (strategyId !== undefined) config.memoryPreferenceStrategyId = strategyId;
  return config;
}
