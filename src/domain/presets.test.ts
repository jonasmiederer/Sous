import { describe, expect, it } from 'vitest';
import {
  PRESET_CONFLICTS,
  PRESET_DEFINITIONS,
  arePresetsCompatible,
  findPresetConflicts,
  parsePreset,
  presetsConflict,
  validatePresets,
} from './presets.js';
import { PRESETS } from './types.js';

describe('preset definitions', () => {
  it('defines exactly the four named presets, each with a defining attribute', () => {
    expect(Object.keys(PRESET_DEFINITIONS).sort()).toEqual([...PRESETS].sort());
    for (const preset of PRESETS) {
      expect(PRESET_DEFINITIONS[preset].name).toBe(preset);
      expect(PRESET_DEFINITIONS[preset].definingAttribute.length).toBeGreaterThan(0);
    }
  });

  it('parses presets case- and whitespace-insensitively', () => {
    expect(parsePreset('  Fine  Dining ')).toBe('fine dining');
    expect(parsePreset('QUICK')).toBe('quick');
    expect(parsePreset('spicy')).toBeUndefined();
    expect(parsePreset(42)).toBeUndefined();
  });
});

describe('preset conflicts', () => {
  it('conflict lookup is symmetric', () => {
    expect(presetsConflict('quick', 'fine dining')).toBe(true);
    expect(presetsConflict('fine dining', 'quick')).toBe(true);
    expect(presetsConflict('healthy', 'craving')).toBe(false);
    for (const [a, b] of PRESET_CONFLICTS) expect(presetsConflict(b, a)).toBe(true);
  });

  it('finds conflicts regardless of selection order', () => {
    expect(findPresetConflicts(['fine dining', 'healthy', 'quick'])).toEqual([['quick', 'fine dining']]);
    expect(arePresetsCompatible(['healthy', 'quick', 'craving'])).toBe(true);
  });
});

describe('validatePresets', () => {
  it('accepts no presets (no shaping)', () => {
    expect(validatePresets(undefined)).toEqual({ ok: true, presets: [] });
    expect(validatePresets([])).toEqual({ ok: true, presets: [] });
  });

  it('accepts compatible combinations, deduplicated in canonical order', () => {
    expect(validatePresets(['craving', 'Healthy', 'healthy'])).toEqual({
      ok: true,
      presets: ['healthy', 'craving'],
    });
  });

  it('rejects unrecognized presets with every bad value', () => {
    const result = validatePresets(['quick', 'spicy', 'keto']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('UNRECOGNIZED_PRESET');
    if (result.error.code !== 'UNRECOGNIZED_PRESET') return;
    expect(result.error.unrecognized).toEqual(['spicy', 'keto']);
  });

  it('reports unrecognized presets before conflicts', () => {
    const result = validatePresets(['quick', 'fine dining', 'spicy']);
    expect(!result.ok && result.error.code).toBe('UNRECOGNIZED_PRESET');
  });

  it('rejects conflicting presets with the conflicting pair', () => {
    const result = validatePresets(['fine dining', 'quick']);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'PRESET_CONFLICT') throw new Error('expected conflict');
    expect(result.error.pair).toEqual(['quick', 'fine dining']);
    expect(result.error.message).toContain('quick');
  });
});
