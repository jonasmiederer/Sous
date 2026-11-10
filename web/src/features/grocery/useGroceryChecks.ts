/**
 * Check-off state for a Grocery_List, kept on the device (Requirement 13.13).
 *
 * Stored under `sous.grocery.v1.{householdId}.{planId}` as
 * `{ generatedAt, checked: string[] }`, where each checked value is the entry
 * key `${name}|${unit}`. State saved for a different `generatedAt` belongs to
 * an older list and is ignored, so regenerating the list resets the checks.
 * Every storage access is guarded: without storage the checks still work for
 * the current page, they are just not remembered.
 */
import { useCallback, useState } from 'react';
import { useServices } from '../../app/ServicesProvider';
import { groceryChecksKey } from '../../auth/session';

export interface StoredGroceryChecks {
  generatedAt: string;
  checked: string[];
}

/** Checked entry keys stored for this list version, or an empty set. */
export function readGroceryChecks(storage: Storage | undefined, key: string, generatedAt: string): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(key);
    if (raw === null) return new Set();
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return new Set();
    const stored = value as Partial<StoredGroceryChecks>;
    if (stored.generatedAt !== generatedAt || !Array.isArray(stored.checked)) return new Set();
    return new Set(stored.checked.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
}

export function writeGroceryChecks(storage: Storage | undefined, key: string, value: StoredGroceryChecks): void {
  if (!storage) return;
  try {
    if (value.checked.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: keep the in-memory state only.
  }
}

export interface GroceryChecks {
  isChecked(entryKey: string): boolean;
  toggle(entryKey: string): void;
  /** Unchecks everything for this list. */
  reset(): void;
  checked: ReadonlySet<string>;
}

interface ChecksState {
  id: string;
  checked: Set<string>;
}

/**
 * Check-off state for one list. Pass `generatedAt` of the loaded list, or
 * undefined while no list is loaded (nothing is read or written then).
 */
export function useGroceryChecks(householdId: string | null, planId: string, generatedAt: string | undefined): GroceryChecks {
  const { storage } = useServices();
  const key = householdId ? groceryChecksKey(householdId, planId) : undefined;
  const id = key && generatedAt ? `${key}@${generatedAt}` : '';
  const load = (): ChecksState => ({
    id,
    checked: key && generatedAt ? readGroceryChecks(storage, key, generatedAt) : new Set(),
  });
  const [state, setState] = useState<ChecksState>(load);

  // A different list (household, plan, or regeneration): reload during render.
  let current = state;
  if (state.id !== id) {
    current = load();
    setState(current);
  }

  const toggle = useCallback(
    (entryKey: string) => {
      if (!key || !generatedAt) return;
      setState((prev) => {
        const base = prev.id === id ? prev.checked : readGroceryChecks(storage, key, generatedAt);
        const next = new Set(base);
        if (next.has(entryKey)) next.delete(entryKey);
        else next.add(entryKey);
        writeGroceryChecks(storage, key, { generatedAt, checked: [...next] });
        return { id, checked: next };
      });
    },
    [storage, key, generatedAt, id],
  );

  const reset = useCallback(() => {
    if (!key || !generatedAt) return;
    writeGroceryChecks(storage, key, { generatedAt, checked: [] });
    setState({ id, checked: new Set() });
  }, [storage, key, generatedAt, id]);

  const checked = current.checked;
  return { checked, isChecked: (entryKey) => checked.has(entryKey), toggle, reset };
}
