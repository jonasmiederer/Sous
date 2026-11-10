/**
 * Preset toggles for plan generation and day edits. Conflicts come from the
 * shared `validatePresets`, so the client blocks exactly what the server
 * would reject (Requirement 13.10). Kept local to plans on purpose; the
 * Suggest screen has its own chips.
 */
import { useId } from 'react';
import { PRESETS, type Preset } from '@sous/domain/types';
import { PRESET_DEFINITIONS, validatePresets } from '@sous/domain/presets';
import { Chip } from '../../ui';

export function presetLabel(preset: Preset): string {
  return preset === 'fine dining' ? 'Fine dining' : preset.charAt(0).toUpperCase() + preset.slice(1);
}

/** The conflicting pair in a selection, if any. */
export function presetConflict(selected: readonly Preset[]): [Preset, Preset] | undefined {
  const result = validatePresets(selected);
  return !result.ok && result.error.code === 'PRESET_CONFLICT' ? result.error.pair : undefined;
}

export interface PlanPresetPickerProps {
  value: Preset[];
  onChange: (next: Preset[]) => void;
  label?: string;
  disabled?: boolean;
}

export function PlanPresetPicker({ value, onChange, label = 'Mood', disabled }: PlanPresetPickerProps) {
  const conflictId = useId();
  const conflict = presetConflict(value);
  return (
    <fieldset className="flex flex-col" disabled={disabled}>
      <legend className="mb-3 text-sm font-medium">
        {label} <span className="font-normal text-text-muted">(optional)</span>
      </legend>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const invalid = conflict?.includes(preset) ?? false;
          return (
            <Chip
              key={preset}
              pressed={value.includes(preset)}
              onPressedChange={(pressed) =>
                onChange(pressed ? PRESETS.filter((p) => p === preset || value.includes(p)) : value.filter((p) => p !== preset))
              }
              invalid={invalid}
              title={PRESET_DEFINITIONS[preset].description}
              aria-describedby={invalid ? conflictId : undefined}
            >
              {presetLabel(preset)}
            </Chip>
          );
        })}
      </div>
      {conflict && (
        <p id={conflictId} className="mt-3 text-sm font-medium text-danger">
          {presetLabel(conflict[0])} and {presetLabel(conflict[1])} can&rsquo;t be combined.
        </p>
      )}
    </fieldset>
  );
}
