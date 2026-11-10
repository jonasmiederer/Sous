/**
 * Preset definitions, recognition, and conflict detection (Requirements 5.1,
 * 5.5, 5.6).
 *
 * Each of the four named Presets has one defining attribute. Conflicts are
 * declared explicitly in PRESET_CONFLICTS rather than inferred, so detection
 * is deterministic: a combination conflicts iff it contains both members of
 * at least one declared pair.
 *
 * Currently only `quick` and `fine dining` conflict. `quick` requires a
 * total preparation time of at most 30 minutes, while `fine dining` requires
 * an elaborate, multi-component, restaurant-style preparation, which this
 * system treats as taking longer than 30 minutes. All other pairs can be met
 * by a single Meal (for example, a healthy dish that satisfies a craving).
 */

import { PRESETS, type Preset } from './types.js';

export interface PresetDefinition {
  readonly name: Preset;
  /** The attribute a Meal must reflect when this Preset is selected (5.2). */
  readonly definingAttribute: string;
  readonly description: string;
}

export const PRESET_DEFINITIONS: Readonly<Record<Preset, PresetDefinition>> = {
  healthy: {
    name: 'healthy',
    definingAttribute: 'nutritious',
    description: 'Balanced, nutrient-dense meal, low in added sugar and saturated fat.',
  },
  quick: {
    name: 'quick',
    definingAttribute: 'under-30-minutes',
    description: 'Total preparation and cooking time of 30 minutes or less.',
  },
  craving: {
    name: 'craving',
    definingAttribute: 'satisfies-craving',
    description: 'Matches the craving described in the Context_Input, e.g. comfort food.',
  },
  'fine dining': {
    name: 'fine dining',
    definingAttribute: 'restaurant-quality',
    description: 'Elaborate, restaurant-style preparation and plating; takes over 30 minutes.',
  },
};

/** Unordered pairs of Presets whose defining attributes cannot be jointly met. */
export const PRESET_CONFLICTS: ReadonlyArray<readonly [Preset, Preset]> = [['quick', 'fine dining']];

export type PresetErrorCode = 'UNRECOGNIZED_PRESET' | 'PRESET_CONFLICT';

export type PresetError =
  | { code: 'UNRECOGNIZED_PRESET'; message: string; unrecognized: string[] }
  | {
      code: 'PRESET_CONFLICT';
      message: string;
      /** The first conflicting pair, in PRESETS order. */
      pair: [Preset, Preset];
      /** Every conflicting pair in the selection. */
      conflicts: Array<[Preset, Preset]>;
    };

export type PresetValidationResult = { ok: true; presets: Preset[] } | { ok: false; error: PresetError };

/** Trim, collapse inner whitespace, lower-case. "  Fine  Dining " -> "fine dining". */
function normalizePresetInput(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Resolve a raw value to a Preset, or undefined if it is not one of the four. */
export function parsePreset(value: unknown): Preset | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizePresetInput(value);
  return (PRESETS as readonly string[]).includes(normalized) ? (normalized as Preset) : undefined;
}

/** Symmetric check: true iff {a, b} is a declared conflicting pair. */
export function presetsConflict(a: Preset, b: Preset): boolean {
  return PRESET_CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}
/** All declared conflicting pairs contained in the given set of Presets. */
export function findPresetConflicts(presets: readonly Preset[]): Array<[Preset, Preset]> {
  const selected = new Set(presets);
  const order = (p: Preset) => PRESETS.indexOf(p);
  return PRESET_CONFLICTS.filter(([a, b]) => selected.has(a) && selected.has(b)).map(([a, b]) =>
    order(a) <= order(b) ? [a, b] : [b, a],
  );
}

export function arePresetsCompatible(presets: readonly Preset[]): boolean {
  return findPresetConflicts(presets).length === 0;
}

/**
 * Validate a requested preset selection before any generation.
 * - Absent or empty input is valid and yields no Presets (5.3).
 * - Any value that is not one of the four named Presets is rejected (5.6).
 * - A combination containing a declared conflict is rejected (5.5).
 * Duplicates are collapsed; the result keeps PRESETS order.
 */
export function validatePresets(input: readonly unknown[] | undefined | null): PresetValidationResult {
  const values = input ?? [];
  const unrecognized: string[] = [];
  const recognized = new Set<Preset>();

  for (const value of values) {
    const preset = parsePreset(value);
    if (preset === undefined) unrecognized.push(String(value));
    else recognized.add(preset);
  }

  if (unrecognized.length > 0) {
    return {
      ok: false,
      error: {
        code: 'UNRECOGNIZED_PRESET',
        message: `Unrecognized preset(s): ${unrecognized.join(', ')}. Allowed presets: ${PRESETS.join(', ')}.`,
        unrecognized,
      },
    };
  }

  const presets = PRESETS.filter((p) => recognized.has(p));
  const conflicts = findPresetConflicts(presets);
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: {
        code: 'PRESET_CONFLICT',
        message: `Presets conflict: ${conflicts.map(([a, b]) => `${a} + ${b}`).join('; ')}.`,
        pair: conflicts[0] as [Preset, Preset],
        conflicts,
      },
    };
  }

  return { ok: true, presets };
}
