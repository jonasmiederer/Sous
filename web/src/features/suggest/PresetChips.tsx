import { useId } from 'react';
import { Clock, Flame, Leaf, Sparkles } from 'lucide-react';
import { PRESET_DEFINITIONS } from '@sous/domain/presets';
import { PRESETS, type Preset } from '@sous/domain/types';
import { Chip } from '../../ui';
import { conflictMessage, conflictingPresets, presetConflict, presetLabel } from './validation';

const ICONS: Record<Preset, typeof Leaf> = {
  healthy: Leaf,
  quick: Clock,
  craving: Flame,
  'fine dining': Sparkles,
};

export interface PresetChipsProps {
  selected: readonly Preset[];
  onChange: (presets: Preset[]) => void;
  disabled?: boolean;
}

/**
 * Toggle chips for the four Presets. Each change is checked with the shared
 * `validatePresets`; a conflict marks every chip involved and names the pair
 * (Requirements 5.5, 13.10). The parent disables submit with `presetConflict`.
 */
export function PresetChips({ selected, onChange, disabled }: PresetChipsProps) {
  const headingId = useId();
  const conflictId = useId();
  const pair = presetConflict(selected);
  const invalid = conflictingPresets(selected);

  function toggle(preset: Preset, pressed: boolean) {
    // Keep PRESETS order so requests are stable regardless of click order.
    const next = new Set(selected);
    if (pressed) next.add(preset);
    else next.delete(preset);
    onChange(PRESETS.filter((p) => next.has(p)));
  }

  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-sm font-medium">
        Mood
      </h2>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const Icon = ICONS[preset];
          return (
            <Chip
              key={preset}
              pressed={selected.includes(preset)}
              onPressedChange={(pressed) => toggle(preset, pressed)}
              invalid={invalid.has(preset)}
              disabled={disabled}
              icon={<Icon aria-hidden="true" />}
              title={PRESET_DEFINITIONS[preset].description}
              aria-describedby={invalid.has(preset) ? conflictId : undefined}
            >
              {presetLabel(preset)}
            </Chip>
          );
        })}
      </div>
      {pair && (
        <p id={conflictId} className="text-sm font-medium text-danger">
          {conflictMessage(pair)} Deselect one to continue.
        </p>
      )}
    </div>
  );
}
