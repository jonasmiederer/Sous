/**
 * Dialog for one plan-day edit (Requirements 3.6, 13.12):
 *
 * - `replace`: `PUT /plans/{id}/days/{day}`; the agent picks a new Meal, steered by an optional note and Presets.
 * - `add`: `POST /plans/{id}/days` for an unassigned date in or next to the range.
 * - `remove`: `DELETE /plans/{id}/days/{day}` after a confirmation.
 *
 * Other days are never touched; the server changes only the named day.
 */
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Preset } from '@sous/domain/types';
import { useApi } from '../../app/ServicesProvider';
import type { IsoDate, PlanEditResult } from '../../api/types';
import { Button, Dialog, ErrorBanner, TextArea, isOverLimit } from '../../ui';
import { CONTROL_CLASS } from '../../ui/Field';
import { PlanPresetPicker, presetConflict } from './PlanPresetPicker';
import { PLAN_CONTEXT_MAX, dayLabel } from './dates';
import { errorCode, errorMessage } from './planQueries';

export type DayEditorMode = 'replace' | 'add' | 'remove';

export interface DayEditorProps {
  open: boolean;
  mode: DayEditorMode;
  planId: string;
  /** The day being replaced or removed, or the preselected day to add. */
  day: IsoDate;
  /** Current Meal name for replace and remove. */
  mealName?: string;
  /** Choices for `add`; defaults to just `day`. */
  addableDays?: IsoDate[];
  onClose: () => void;
  onDone: (result: PlanEditResult) => void;
  /** Called instead of showing the error inline when someone else changed the plan. */
  onConflict?: () => void;
}

interface EditVariables {
  day: IsoDate;
  contextInput: string;
  presets: Preset[];
}

const TITLES: Record<DayEditorMode, string> = {
  replace: 'Swap this meal',
  add: 'Add a meal',
  remove: 'Remove this meal?',
};

export function DayEditor(props: DayEditorProps) {
  // Remount per opening so the form starts fresh.
  if (!props.open) return null;
  return <DayEditorDialog key={`${props.mode}:${props.day}`} {...props} />;
}

function DayEditorDialog({ mode, planId, day, mealName, addableDays, onClose, onDone, onConflict }: DayEditorProps) {
  const api = useApi();
  const [selectedDay, setSelectedDay] = useState<IsoDate>(day);
  const [contextInput, setContextInput] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);

  const edit = useMutation<PlanEditResult, unknown, EditVariables>({
    mutationFn: ({ day: target, contextInput: note, presets: selected }) => {
      const options = {
        ...(note.trim() ? { contextInput: note.trim() } : {}),
        ...(selected.length > 0 ? { presets: selected } : {}),
      };
      if (mode === 'remove') return api.removeDay(planId, target);
      if (mode === 'add') return api.addDay(planId, { day: target, ...options });
      return api.replaceDay(planId, target, options);
    },
    onSuccess: (result) => onDone(result),
    onError: (error) => {
      if (errorCode(error) === 'PLAN_CONFLICT' && onConflict) onConflict();
    },
  });

  const tooLong = isOverLimit(contextInput, PLAN_CONTEXT_MAX);
  const conflict = presetConflict(presets);
  const choices = addableDays && addableDays.length > 0 ? addableDays : [day];
  const showError = edit.isError && !(errorCode(edit.error) === 'PLAN_CONFLICT' && onConflict);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (edit.isPending || tooLong || conflict) return;
    edit.mutate({ day: selectedDay, contextInput, presets });
  }

  const formId = `day-editor-${mode}`;
  const description =
    mode === 'remove'
      ? `${mealName ?? 'The meal'} on ${dayLabel(day)} will be taken off the plan. The other days stay as they are.`
      : mode === 'replace'
        ? `Sous will pick something new for ${dayLabel(day)}${mealName ? ` instead of ${mealName}` : ''}. The other days stay as they are.`
        : 'Sous will pick a meal for the day you choose.';

  return (
    <Dialog
      open
      onClose={() => {
        if (!edit.isPending) onClose();
      }}
      title={TITLES[mode]}
      description={description}
      placement="sheet"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={edit.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={mode === 'remove' ? 'danger' : 'primary'}
            loading={edit.isPending}
            disabled={tooLong || Boolean(conflict)}
          >
            {mode === 'remove' ? 'Remove' : mode === 'add' ? 'Add meal' : 'Swap meal'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-5 pb-2">
        {showError && <ErrorBanner message={errorMessage(edit.error)} />}
        {edit.isPending && mode !== 'remove' && (
          <p role="status" className="text-sm text-text-muted">
            Finding a good fit… this can take a few seconds.
          </p>
        )}
        {mode === 'add' && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="day-editor-date" className="text-sm font-medium">
              Day
            </label>
            <select
              id="day-editor-date"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
              disabled={edit.isPending}
              className={`${CONTROL_CLASS} min-h-11 py-2`}
            >
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {dayLabel(choice)}
                </option>
              ))}
            </select>
          </div>
        )}
        {mode !== 'remove' && (
          <>
            <TextArea
              label="Note for Sous"
              optional
              rows={2}
              placeholder="Something lighter, no oven, a fish dish…"
              value={contextInput}
              onChange={(e) => setContextInput(e.target.value)}
              maxCodePoints={PLAN_CONTEXT_MAX}
              disabled={edit.isPending}
            />
            <PlanPresetPicker value={presets} onChange={setPresets} disabled={edit.isPending} />
          </>
        )}
      </form>
    </Dialog>
  );
}
