/**
 * Adds a dietary constraint (`POST /preferences/constraints`, Requirements
 * 6.5, 6.6, 13.9). Checks run locally first (trimmed, 1–200 code points, no
 * case-insensitive duplicate) with a live counter; the server's
 * `INVALID_DIETARY_CONSTRAINT` reason is mapped to the same messages.
 */
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useApi } from '../../app/ServicesProvider';
import { isApiError } from '../../api/errors';
import type { SavedProfile } from '../../api/types';
import { Button, TextArea } from '../../ui';
import {
  CONSTRAINT_PROBLEM_MESSAGES,
  MAX_DIETARY_CONSTRAINT_LENGTH,
  constraintProblem,
  isConstraintProblem,
} from './constraintValidation';
import { errorMessage } from './preferenceQueries';

export interface ConstraintFormProps {
  /** Constraints already in the profile, for the duplicate check. */
  existing: readonly string[];
  onAdded: (saved: SavedProfile) => void;
}

function serverError(error: unknown): string {
  if (isApiError(error) && error.code === 'INVALID_DIETARY_CONSTRAINT' && isConstraintProblem(error.body?.reason)) {
    return CONSTRAINT_PROBLEM_MESSAGES[error.body.reason];
  }
  return errorMessage(error);
}

export function ConstraintForm({ existing, onAdded }: ConstraintFormProps) {
  const api = useApi();
  const [value, setValue] = useState('');
  const [attempted, setAttempted] = useState(false);
  const add = useMutation({ mutationFn: (constraint: string) => api.addConstraint({ constraint }) });

  const problem = constraintProblem(value, existing);
  // "Empty" is only reported after a submit attempt; the others show as you type.
  const visibleProblem = problem === 'empty' ? (attempted ? problem : null) : problem;
  const error = visibleProblem ? CONSTRAINT_PROBLEM_MESSAGES[visibleProblem] : add.isError ? serverError(add.error) : undefined;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    setAttempted(true);
    if (problem || add.isPending) return;
    add.mutate(value.trim(), {
      onSuccess: (saved) => {
        setValue('');
        setAttempted(false);
        onAdded(saved);
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label="New dietary need">
      <TextArea
        label="Add a dietary need"
        hint="For example “vegetarian”, “no coconut”, or “nut allergy”."
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (add.isError) add.reset();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
        }}
        maxCodePoints={MAX_DIETARY_CONSTRAINT_LENGTH}
        error={error}
        rows={2}
        enterKeyHint="done"
      />
      <div>
        <Button
          type="submit"
          icon={<Plus className="size-4" />}
          loading={add.isPending}
          disabled={problem === 'too_long' || problem === 'duplicate'}
        >
          Add
        </Button>
      </div>
    </form>
  );
}
