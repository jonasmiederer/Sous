/**
 * The selected Active_Household, stored per User under
 * `sous.activeHousehold.v1.{userId}` (Requirements 13.5, 13.6).
 *
 * Framework-free so the API client can read it synchronously for the
 * `X-Active-Household` header. Callers store a value only after
 * `PUT /session/active-household` confirmed the membership.
 */
import { activeHouseholdKey } from '../auth/session';

export interface ActiveHouseholdStore {
  /** The selected Household for the signed-in User, or null. */
  get(): string | null;
  set(householdId: string): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
  /** Re-reads storage and notifies listeners, e.g. after the signed-in User changed. */
  refresh(): void;
}

export function createActiveHouseholdStore(storage: Storage, getUserId: () => string | undefined): ActiveHouseholdStore {
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      const userId = getUserId();
      if (!userId) return null;
      try {
        const value = storage.getItem(activeHouseholdKey(userId));
        return value && value.trim() !== '' ? value : null;
      } catch {
        return null;
      }
    },
    set(householdId) {
      const userId = getUserId();
      if (!userId) return;
      storage.setItem(activeHouseholdKey(userId), householdId);
      notify();
    },
    clear() {
      const userId = getUserId();
      if (userId) {
        try {
          storage.removeItem(activeHouseholdKey(userId));
        } catch {
          // Storage unavailable.
        }
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: notify,
  };
}
