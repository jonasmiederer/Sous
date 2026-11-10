/**
 * Client-side checks for the Suggest now form (Requirements 13.9, 13.10).
 * They mirror the server: Context_Input is limited to 500 code points
 * (`characterLength` in src/services/suggestions/validation.ts), and Preset
 * conflicts come from the shared `validatePresets`.
 */
import { validatePresets } from '@sous/domain/presets';
import type { Preset } from '@sous/domain/types';
import { codePointLength } from '../../ui';

export const CONTEXT_INPUT_MAX = 500;

/** True when the note must be blocked before submission. */
export function isContextInputTooLong(value: string): boolean {
  return codePointLength(value) > CONTEXT_INPUT_MAX;
}

/** The conflicting pair reported by `validatePresets`, or `undefined` when the selection is valid. */
export function presetConflict(presets: readonly Preset[]): readonly [Preset, Preset] | undefined {
  const result = validatePresets([...presets]);
  return !result.ok && result.error.code === 'PRESET_CONFLICT' ? result.error.pair : undefined;
}

/** Every Preset that is part of some conflicting pair in the selection. */
export function conflictingPresets(presets: readonly Preset[]): ReadonlySet<Preset> {
  const result = validatePresets([...presets]);
  return new Set(!result.ok && result.error.code === 'PRESET_CONFLICT' ? result.error.conflicts.flat() : []);
}

export function presetLabel(preset: Preset): string {
  return preset === 'fine dining' ? 'Fine dining' : preset.charAt(0).toUpperCase() + preset.slice(1);
}

/** "Quick and Fine dining can't be combined." */
export function conflictMessage(pair: readonly [Preset, Preset]): string {
  return `${presetLabel(pair[0])} and ${presetLabel(pair[1])} can\u2019t be combined.`;
}
