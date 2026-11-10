import { useEffect, useSyncExternalStore } from 'react';
import { useToast } from './Toast';
import { getPendingUpdate, subscribeToUpdates } from './updateAvailable';

export const UPDATE_TOAST_ID = 'pwa-update-available';

/** Shows a sticky "Update available" toast once a new service worker is waiting. */
export function UpdateAvailableToast() {
  const toast = useToast();
  const apply = useSyncExternalStore(subscribeToUpdates, getPendingUpdate, () => null);

  useEffect(() => {
    if (!apply) return;
    toast.show({
      id: UPDATE_TOAST_ID,
      message: 'A new version of Sous is available.',
      durationMs: null,
      action: { label: 'Reload', onAction: () => void apply() },
    });
  }, [apply, toast]);

  return null;
}
