import { describe, expect, it } from 'vitest';
import { PRESETS, areCompatible, canonicalUnit, compatibilityKey, isPreset } from '../src/domain/index.js';
import { MIN_NUM_RUNS, PBT_NUM_RUNS, assertProperty, fc, propertyTag } from './pbt.js';

describe('scaffolding sanity', () => {
  it('pbt harness defaults to at least 100 runs and builds tags', () => {
    expect(PBT_NUM_RUNS).toBeGreaterThanOrEqual(MIN_NUM_RUNS);
    expect(propertyTag(22, 'Compatible occurrences are summed')).toBe(
      'Feature: meal-planner, Property 22: Compatible occurrences are summed',
    );
  });

  it('defines exactly the four named presets', () => {
    expect([...PRESETS]).toEqual(['healthy', 'quick', 'craving', 'fine dining']);
    expect(isPreset('quick')).toBe(true);
    expect(isPreset('spicy')).toBe(false);
  });
});

describe('unit compatibility', () => {
  it('maps aliases to canonical units', () => {
    expect(canonicalUnit('Grams')).toBe('g');
    expect(canonicalUnit(' tablespoons ')).toBe('tbsp');
    expect(canonicalUnit('')).toBe('piece');
  });

  it('treats same name + same canonical unit as compatible', () => {
    expect(areCompatible({ name: 'Flour', unit: 'g' }, { name: ' flour ', unit: 'grams' })).toBe(true);
  });

  it('treats different units or names as incompatible (no conversion)', () => {
    expect(areCompatible({ name: 'flour', unit: 'g' }, { name: 'flour', unit: 'kg' })).toBe(false);
    expect(areCompatible({ name: 'flour', unit: 'g' }, { name: 'sugar', unit: 'g' })).toBe(false);
  });

  it('compatibilityKey agrees with areCompatible', () => {
    const units = fc.constantFrom('g', 'grams', 'kg', 'cup', 'cups', 'tbsp', 'ml', '', 'pinch', 'weird');
    const names = fc.constantFrom('flour', 'Flour', ' sugar', 'egg', 'Egg ');
    const item = fc.record({ name: names, unit: units });
    assertProperty(
      fc.property(item, item, (a, b) => {
        expect(compatibilityKey(a) === compatibilityKey(b)).toBe(areCompatible(a, b));
      }),
    );
  });
});
