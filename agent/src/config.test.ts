import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, MAX_BUDGET_MS } from './config.js';

const BASE = { MODEL_ID: 'model-x', BEDROCK_REGION: 'eu-west-1', MEMORY_ID: 'mem-1' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(BASE);
    expect(config).toEqual({
      port: 8080,
      modelId: 'model-x',
      bedrockRegion: 'eu-west-1',
      memoryId: 'mem-1',
      budgetsMs: { ad_hoc: 8_000, refine: 13_000, plan: 26_000 },
      adHocSuggestionCount: 2,
      planChunkDays: 4,
    });
  });

  it('reads optional and overridden values', () => {
    const config = loadConfig({
      ...BASE,
      PORT: '9000',
      MEMORY_PREFERENCE_STRATEGY_ID: 'strat-1',
      AD_HOC_SUGGESTION_COUNT: '3',
      PLAN_CHUNK_DAYS: '7',
      AD_HOC_BUDGET_MS: '5000',
    });
    expect(config.port).toBe(9000);
    expect(config.memoryPreferenceStrategyId).toBe('strat-1');
    expect(config.adHocSuggestionCount).toBe(3);
    expect(config.planChunkDays).toBe(7);
    expect(config.budgetsMs.ad_hoc).toBe(5000);
  });

  it('caps budgets at the Requirement 12.13 limits', () => {
    const config = loadConfig({ ...BASE, AD_HOC_BUDGET_MS: '60000', REFINE_BUDGET_MS: '99999', PLAN_BUDGET_MS: '30000' });
    expect(config.budgetsMs).toEqual(MAX_BUDGET_MS);
  });

  it('falls back to AWS_REGION', () => {
    const { BEDROCK_REGION: _, ...rest } = BASE;
    expect(loadConfig({ ...rest, AWS_REGION: 'us-east-1' }).bedrockRegion).toBe('us-east-1');
  });

  it.each([
    [{ MODEL_ID: undefined }],
    [{ MEMORY_ID: '  ' }],
    [{ BEDROCK_REGION: undefined }],
    [{ AD_HOC_SUGGESTION_COUNT: '0' }],
    [{ AD_HOC_SUGGESTION_COUNT: '4' }],
    [{ PLAN_CHUNK_DAYS: '8' }],
    [{ PLAN_CHUNK_DAYS: '2.5' }],
    [{ PORT: 'abc' }],
    [{ PLAN_BUDGET_MS: '0' }],
    [{ REFINE_BUDGET_MS: '-1' }],
  ])('rejects %o', (override) => {
    expect(() => loadConfig({ ...BASE, ...override })).toThrow(ConfigError);
  });
});
