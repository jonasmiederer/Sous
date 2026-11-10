/**
 * Create a Household (Requirements 10.1, 13.6). The creator becomes its owner;
 * on success the households list is refreshed and `onCreated` runs.
 */
import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/ServicesProvider';
import { useSession } from '../../auth/SessionProvider';
import { householdsQueryKey } from '../../household/ActiveHouseholdProvider';
import type { Household } from '../../api/types';
import { Button, ErrorBanner, TextField } from '../../ui';
import { HOUSEHOLD_NAME_MAX, errorText } from './shared';

export interface CreateHouseholdProps {
  /** Runs after the Household exists and the list has been invalidated. */
  onCreated?: (household: Household) => void | Promise<void>;
  label?: string;
}

/** Name field plus Create button. Length is validated on submit; `maxLength` is looser so over-long input can still be seen and corrected. */
export function CreateHousehold({ onCreated, label = 'New household name' }: CreateHouseholdProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return setNameError('Give your household a name.');
    if (trimmed.length > HOUSEHOLD_NAME_MAX) return setNameError(`Keep the name to ${HOUSEHOLD_NAME_MAX} characters or fewer.`);
    setNameError(undefined);
    setError(undefined);
    setPending(true);
    try {
      const created = await api.createHousehold({ name: trimmed });
      setName('');
      await queryClient.invalidateQueries({ queryKey: householdsQueryKey(session?.user.userId) });
      await onCreated?.(created.household);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          label={label}
          containerClassName="flex-1"
          placeholder="e.g. The Garcias"
          maxLength={HOUSEHOLD_NAME_MAX + 20}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
        />
        <Button type="submit" loading={pending} icon={<Plus aria-hidden="true" className="size-4" />} className="sm:mt-7">
          Create
        </Button>
      </form>
    </div>
  );
}
